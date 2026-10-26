'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUTH_STATUS,
  authBackupPath,
  authFilePath,
  authRatePath,
  createPinRateLimiter,
  hashesEqual,
  readAuth,
  resetAuth,
  verifyPin,
  writePin,
  writeSkipPin,
} = require('../backend/auth/auth-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auth-test-'));
}

test('auth store: missing file is classified as first-run missing, not a PIN', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = await readAuth(dir);
  assert.equal(auth.ok, true);
  assert.equal(auth.status, AUTH_STATUS.MISSING);
  assert.equal(auth.exists, false);
  assert.equal(auth.hasPin, false);
  assert.equal(auth.skipPin, false);
});

test('auth store: PIN is hashed with a random salt and never stored as plaintext', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await writePin(dir, '4821');
  assert.equal(result.ok, true);

  const raw = fs.readFileSync(authFilePath(dir), 'utf8');
  assert.equal(raw.includes('4821'), false);
  assert.equal(fs.statSync(authFilePath(dir)).isFile(), true);

  const auth = await readAuth(dir);
  assert.equal(auth.status, AUTH_STATUS.USABLE_PIN);
  assert.equal(auth.hasPin, true);
  assert.equal(auth.skipPin, false);
  assert.equal(typeof auth.data.hash, 'string');
  assert.equal(typeof auth.data.salt, 'string');

  const good = await verifyPin(dir, '4821');
  assert.equal(good.ok, true);
  const bad = await verifyPin(dir, '1111');
  assert.equal(bad.ok, false);
  assert.equal(hashesEqual('abcd', 'abce'), false);
});

test('auth store: explicit skip is never a successful PIN verification', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written = await writeSkipPin(dir);
  assert.equal(written.ok, true);

  const auth = await readAuth(dir);
  assert.equal(auth.ok, true);
  assert.equal(auth.status, AUTH_STATUS.EXPLICIT_SKIP);
  assert.equal(auth.skipPin, true);
  assert.equal(auth.hasPin, false);

  const pin = await verifyPin(dir, '0000');
  assert.equal(pin.ok, false);
  assert.equal(pin.status, AUTH_STATUS.EXPLICIT_SKIP);
  const empty = await verifyPin(dir, '');
  assert.equal(empty.ok, false);
});

test('auth store: corrupt and placeholder records are never treated as missing or no-lock', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(authFilePath(dir), '{not-json', { mode: 0o600 });
  let auth = await readAuth(dir);
  assert.equal(auth.ok, false);
  assert.equal(auth.status, AUTH_STATUS.CORRUPT);
  assert.equal(auth.exists, true);
  let pin = await verifyPin(dir, '1234');
  assert.equal(pin.ok, false);

  fs.writeFileSync(authFilePath(dir), JSON.stringify({ hash: 'dummy', salt: 'dummy' }), { mode: 0o600 });
  auth = await readAuth(dir);
  assert.equal(auth.ok, false);
  assert.equal(auth.status, AUTH_STATUS.CORRUPT);
  assert.equal(auth.skipPin, false);
  pin = await verifyPin(dir, '1234');
  assert.equal(pin.ok, false);

  fs.writeFileSync(authFilePath(dir), JSON.stringify({ skipPin: true, hash: 'a'.repeat(64) }), { mode: 0o600 });
  auth = await readAuth(dir);
  assert.equal(auth.status, AUTH_STATUS.CORRUPT);
});

test('auth store: live corruption recovers the last-known-good backup instead of setup', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await writePin(dir, '4821')).ok, true);
  assert.equal((await writePin(dir, '1111')).ok, true);
  assert.equal(fs.existsSync(authBackupPath(dir)), true);

  fs.writeFileSync(authFilePath(dir), '{"version":1,"hash":', { mode: 0o600 });
  const auth = await readAuth(dir);
  assert.equal(auth.ok, true);
  assert.equal(auth.status, AUTH_STATUS.USABLE_PIN);
  assert.equal(auth.recoveredFromBackup, true);

  assert.equal((await verifyPin(dir, '4821')).ok, true);
  assert.equal((await verifyPin(dir, '1111')).ok, false);
});

test('auth store: a failed atomic replace leaves the previous PIN usable', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await writePin(dir, '4821')).ok, true);
  const failed = await writePin(dir, '1111', {
    beforeReplace: async () => { throw new Error('simulated crash before rename'); },
  });
  assert.equal(failed.ok, false);

  const auth = await readAuth(dir);
  assert.equal(auth.ok, true);
  assert.equal(auth.status, AUTH_STATUS.USABLE_PIN);
  assert.equal(auth.recoveredFromBackup, false);
  assert.equal((await verifyPin(dir, '4821')).ok, true);
  assert.equal((await verifyPin(dir, '1111')).ok, false);
  assert.equal(
    fs.readdirSync(dir).some(name => name.includes('.tmp-')),
    false,
    'failed writes clean up their temporary files'
  );
});

test('auth store: reset removes PIN, backup, and persisted limiter state', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await writePin(dir, '4821')).ok, true);
  const limiter = createPinRateLimiter({ userDataPath: dir });
  await limiter.recordFailure();
  assert.equal(fs.existsSync(authRatePath(dir)), true);

  assert.equal((await resetAuth(dir)).ok, true);
  assert.equal(fs.existsSync(authFilePath(dir)), false);
  assert.equal(fs.existsSync(authBackupPath(dir)), false);
  assert.equal(fs.existsSync(authRatePath(dir)), false);
  const auth = await readAuth(dir);
  assert.equal(auth.status, AUTH_STATUS.MISSING);
});

test('auth store: PIN failures persist across limiter restarts and expire after the window', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let clock = 1_000_000;
  const now = () => clock;
  const limiter = createPinRateLimiter({ userDataPath: dir, now });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await limiter.check()).allowed, true);
    const recorded = await limiter.recordFailure();
    assert.equal(recorded.ok, true);
    clock += 1000;
  }
  assert.equal((await limiter.check()).allowed, false);

  const restarted = createPinRateLimiter({ userDataPath: dir, now });
  const blocked = await restarted.check();
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.failures, 5);
  assert.equal(blocked.remaining, 0);

  clock += 15 * 60 * 1000 + 1;
  assert.equal((await restarted.check()).allowed, true);

  await restarted.recordFailure();
  assert.equal((await restarted.check()).allowed, true);
  assert.equal((await restarted.clear()).ok, true);
  const afterClear = createPinRateLimiter({ userDataPath: dir, now });
  assert.equal((await afterClear.check()).allowed, true);
});

test('auth store: corrupt limiter metadata fails closed', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(authRatePath(dir), '{bad-json', { mode: 0o600 });

  const limiter = createPinRateLimiter({ userDataPath: dir });
  const check = await limiter.check();
  assert.equal(check.allowed, false);
  assert.equal(check.blocked, true);
  assert.equal(check.degraded, true);
  assert.match(check.error, /unreadable|invalid/i);

  const restarted = createPinRateLimiter({ userDataPath: dir });
  assert.equal((await restarted.check()).allowed, false);
});

test('auth store: persisted failure timestamps stay bounded', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const limiter = createPinRateLimiter({ userDataPath: dir, now: () => clock });
  for (let i = 0; i < 8; i += 1) {
    await limiter.recordFailure();
    clock += 1000;
  }
  const raw = JSON.parse(fs.readFileSync(authRatePath(dir), 'utf8'));
  assert.equal(raw.failures.length <= 5, true);
  assert.equal(raw.version, 1);
});
