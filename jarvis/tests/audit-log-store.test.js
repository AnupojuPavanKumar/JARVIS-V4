'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAuditLogStore,
} = require('../backend/security/audit-log-store');
const { createAuditRedactor } = require('../backend/security/audit-redaction');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-store-test-'));
}

function auditDir(root) {
  return path.join(root, 'security-audit');
}

function listAuditFiles(root) {
  const dir = auditDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^audit-\d{8}(?:-\d{2})?\.jsonl$/.test(name)).sort();
}

function fakeSafeStorage({ available = true, backend = 'dpapi' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from(`JARVIS-TEST:${value}`, 'utf8'),
    decryptString: buffer => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('JARVIS-TEST:')) throw new Error('Not a test ciphertext');
      return text.slice('JARVIS-TEST:'.length);
    },
  };
}

function deterministicNow(start = '2026-11-04T12:00:00.000Z') {
  let clock = new Date(start);
  return {
    now: () => clock,
    set(value) { clock = new Date(value); },
  };
}

function makeStore(root, options = {}) {
  return createAuditLogStore({
    userDataPath: root,
    safeStorage: options.safeStorage || fakeSafeStorage(),
    now: options.now || deterministicNow().now,
    logger: { error() {}, warn() {}, log() {} },
    ...options,
  });
}

test('audit store writes encrypted records and reads them after restart', async t => {
  const root = tempDir();
  const clock = deterministicNow();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = makeStore(root, { now: clock.now });
  const status = await store.init();
  assert.equal(status.durable, true);
  assert.equal(status.mode, 'durable');

  store.append({
    ts: '2026-11-04T12:00:01.000Z',
    action: 'RUN_COMMAND',
    detail: 'git status',
    verdict: 'ALLOWED',
  });
  store.append({
    ts: '2026-11-04T12:00:02.000Z',
    action: 'CAPABILITY_GRANT',
    detail: 'terminal (current session)',
    verdict: 'GRANTED',
  });
  const flushed = await store.flush();
  store.dispose();
  assert.equal(flushed.durable, true);

  const files = listAuditFiles(root);
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(auditDir(root), files[0]), 'utf8');
  assert.equal(raw.includes('RUN_COMMAND'), false);
  assert.equal(raw.includes('git status'), false);
  assert.equal(raw.includes('CAPABILITY_GRANT'), false);

  const restarted = makeStore(root, { now: clock.now });
  const restartedStatus = await restarted.init();
  assert.equal(restartedStatus.durable, true);
  assert.equal(restartedStatus.integrity, 'ok');
  const read = restarted.read({ limit: 500 });
  assert.equal(read.ok, true);
  assert.equal(read.durable, true);
  assert.equal(read.integrity, 'ok');
  assert.equal(read.warning, null);
  assert.deepEqual(read.entries.map(entry => entry.action), [
    'RUN_COMMAND',
    'CAPABILITY_GRANT',
  ]);
  assert.match(read.data, /RUN_COMMAND/);
  assert.match(read.data, /git status/);
  restarted.dispose();
});

test('audit store skips a corrupt record and reports possible modification', async t => {
  const root = tempDir();
  const clock = deterministicNow();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = makeStore(root, { now: clock.now });
  await store.init();
  store.append({ ts: '2026-11-04T12:00:01.000Z', action: 'A', detail: 'first', verdict: 'OK' });
  store.append({ ts: '2026-11-04T12:00:02.000Z', action: 'B', detail: 'second', verdict: 'OK' });
  await store.flush();
  store.dispose();

  const file = path.join(auditDir(root), listAuditFiles(root)[0]);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  lines[0] = Buffer.from('corrupt-line', 'utf8').toString('base64');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const restarted = makeStore(root, { now: clock.now });
  await restarted.init();
  const read = restarted.read({ limit: 500 });
  assert.equal(read.ok, true);
  assert.equal(read.integrity, 'suspect');
  assert.match(read.warning, /modification or corruption/i);
  assert.equal(read.corruptLines, 1);
  assert.deepEqual(read.entries.map(entry => entry.action), ['B']);
  restarted.dispose();
});

test('audit store detects a truncated tail from the head checkpoint', async t => {
  const root = tempDir();
  const clock = deterministicNow();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = makeStore(root, { now: clock.now });
  await store.init();
  store.append({ ts: '2026-11-04T12:00:01.000Z', action: 'A', detail: 'first', verdict: 'OK' });
  store.append({ ts: '2026-11-04T12:00:02.000Z', action: 'B', detail: 'second', verdict: 'OK' });
  await store.flush();
  store.dispose();

  const file = path.join(auditDir(root), listAuditFiles(root)[0]);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, `${lines[0]}\n`, 'utf8');

  const restarted = makeStore(root, { now: clock.now });
  const status = await restarted.init();
  assert.equal(status.integrity, 'truncated');
  const read = restarted.read({ limit: 500 });
  assert.equal(read.ok, true);
  assert.equal(read.integrity, 'truncated');
  assert.match(read.warning, /truncated/i);
  assert.deepEqual(read.entries.map(entry => entry.action), ['A']);
  restarted.dispose();
});

test('audit store rotates by date and size without losing chain order', async t => {
  const root = tempDir();
  const clock = deterministicNow('2026-11-04T23:59:00.000Z');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = makeStore(root, { now: clock.now, maxFileBytes: 1 });
  await store.init();
  store.append({ ts: '2026-11-04T23:59:01.000Z', action: 'A', detail: 'one', verdict: 'OK' });
  store.append({ ts: '2026-11-04T23:59:02.000Z', action: 'B', detail: 'two', verdict: 'OK' });
  await store.flush();
  clock.set('2026-11-05T00:01:00.000Z');
  store.append({ ts: '2026-11-05T00:01:01.000Z', action: 'C', detail: 'three', verdict: 'OK' });
  await store.flush();
  store.dispose();

  const files = listAuditFiles(root);
  assert.ok(files.some(name => name.startsWith('audit-20261104')), files.join(','));
  assert.ok(files.some(name => name.startsWith('audit-20261105')), files.join(','));
  assert.ok(files.length >= 3, files.join(','));

  const restarted = makeStore(root, { now: clock.now, maxFileBytes: 1 });
  await restarted.init();
  const read = restarted.read({ limit: 500 });
  assert.equal(read.ok, true);
  assert.equal(read.integrity, 'ok');
  assert.ok(read.entries.some(entry => entry.action === 'AUDIT_ROTATE'));
  assert.deepEqual(
    read.entries.filter(entry => entry.action !== 'AUDIT_ROTATE').map(entry => entry.action),
    ['A', 'B', 'C']
  );
  restarted.dispose();
});

test('audit store prunes only matching oldest files and preserves unrelated files', async t => {
  const root = tempDir();
  const clock = deterministicNow();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(auditDir(root), { recursive: true });
  fs.writeFileSync(path.join(auditDir(root), 'keep-me.txt'), 'unrelated', 'utf8');

  const store = makeStore(root, { now: clock.now, maxFileBytes: 1, maxFiles: 2 });
  await store.init();
  for (let index = 0; index < 5; index += 1) {
    store.append({
      ts: `2026-11-04T12:00:0${index}.000Z`,
      action: 'EVENT',
      detail: `record ${index}`,
      verdict: 'OK',
    });
  }
  await store.flush();
  store.dispose();

  assert.equal(fs.existsSync(path.join(auditDir(root), 'keep-me.txt')), true);
  assert.equal(listAuditFiles(root).length, 2);
  const restarted = makeStore(root, { now: clock.now, maxFileBytes: 1, maxFiles: 2 });
  await restarted.init();
  const read = restarted.read({ limit: 500 });
  assert.equal(read.ok, true);
  assert.equal(read.integrity, 'ok');
  assert.ok(read.entries.some(entry => entry.action === 'AUDIT_PRUNE'));
  assert.ok(read.entries.some(entry => entry.action === 'EVENT'));
  assert.equal(read.entries[read.entries.length - 1].action, 'AUDIT_PRUNE');
  restarted.dispose();
});

test('audit store refuses to write plaintext when safeStorage is unavailable', async t => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failures = [];

  const store = makeStore(root, {
    safeStorage: fakeSafeStorage({ available: false }),
    onFailure: (error, status) => failures.push({ error, status }),
  });
  const status = await store.init();
  assert.equal(status.durable, false);
  assert.equal(status.mode, 'memory');
  assert.match(status.warning, /unavailable/i);
  assert.equal(fs.existsSync(auditDir(root)), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status.durable, false);

  assert.equal(store.append({ action: 'A', detail: 'one', verdict: 'OK' }), false);
  assert.equal(fs.existsSync(auditDir(root)), false);
  store.dispose();
});

test('audit store rejects the basic_text safeStorage backend', async t => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failures = [];

  const store = makeStore(root, {
    safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
    onFailure: error => failures.push(error),
  });
  const status = await store.init();
  assert.equal(status.durable, false);
  assert.match(status.reason, /basic_text/i);
  assert.equal(fs.existsSync(auditDir(root)), false);
  assert.equal(failures.length, 1);
  store.dispose();
});

test('audit store fails closed on a write error and stops accepting records', async t => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failures = [];

  const store = makeStore(root, {
    onFailure: (error, status) => failures.push({ error, status }),
  });
  await store.init();
  const originalAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('disk full'); };
  try {
    store.append({ action: 'A', detail: 'one', verdict: 'OK' });
    await store.flush();
  } finally {
    fs.appendFileSync = originalAppend;
  }

  const status = store.status();
  assert.equal(status.durable, false);
  assert.equal(status.mode, 'memory');
  assert.match(status.reason, /disk full/i);
  assert.equal(failures.length, 1);
  assert.equal(store.append({ action: 'B', detail: 'two', verdict: 'OK' }), false);
  store.dispose();
});

test('audit store preserves append order under a burst', async t => {
  const root = tempDir();
  const clock = deterministicNow();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = makeStore(root, { now: clock.now });
  await store.init();
  for (let index = 0; index < 120; index += 1) {
    store.append({
      ts: `2026-11-04T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
      action: `EVENT_${index}`,
      detail: `record ${index}`,
      verdict: 'OK',
    });
  }
  await store.flush();
  store.dispose();

  const restarted = makeStore(root, { now: clock.now });
  await restarted.init();
  const read = restarted.read({ limit: 500 });
  assert.equal(read.ok, true);
  assert.equal(read.integrity, 'ok');
  assert.deepEqual(
    read.entries.map(entry => entry.action),
    Array.from({ length: 120 }, (_, index) => `EVENT_${index}`)
  );
  restarted.dispose();
});

test('audit redaction removes secrets, PINs, and home paths before logging', () => {
  const redactor = createAuditRedactor({
    homeDir: 'C:\\Users\\Pavan',
    userDataPath: 'C:\\Users\\Pavan\\AppData\\Roaming\\jarvis-ai-os',
  });
  const entry = redactor.sanitizeAuditEntry(
    'RUN_COMMAND',
    'password=hunter2 token: abc123 Authorization: Bearer eyJhbGciOi.secret ' +
      'api_key="key-value" C:\\Users\\Pavan\\project\\file.txt ' +
      'C:\\Users\\Pavan\\AppData\\Roaming\\jarvis-ai-os\\history ' +
      'https://user:pass@example.test/path?token=query-secret',
    'ALLOWED'
  );
  assert.equal(entry.detail.includes('hunter2'), false);
  assert.equal(entry.detail.includes('abc123'), false);
  assert.equal(entry.detail.includes('eyJhbGciOi.secret'), false);
  assert.equal(entry.detail.includes('key-value'), false);
  assert.equal(entry.detail.includes('Pavan'), false);
  assert.equal(entry.detail.includes('query-secret'), false);
  assert.match(entry.detail, /%USERPROFILE%/);
  assert.match(entry.detail, /%APPDATA%\\jarvis-ai-os/);
  assert.match(entry.detail, /\[redacted\]/);

  const auth = redactor.sanitizeAuditEntry('AUTH_VERIFY', 'PIN 4821 failed', 'FAIL');
  assert.equal(auth.detail.includes('4821'), false);
  assert.match(auth.detail, /\*\*\*\*/);

  const bounded = redactor.sanitizeAuditEntry('X'.repeat(200), 'Y'.repeat(900), 'Z'.repeat(100));
  assert.equal(bounded.action.length, 80);
  assert.equal(bounded.detail.length, 500);
  assert.equal(bounded.verdict.length, 40);
});
