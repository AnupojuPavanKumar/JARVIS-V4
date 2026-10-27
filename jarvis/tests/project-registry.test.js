'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createProjectRegistry,
  normalizeRelativePath,
} = require('../backend/security/project-registry');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-project-registry-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log("ok");');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{"token":"secret"}');
  return dir;
}

test('project registry: tokens are main-issued and path resolution stays inside the root', t => {
  const dir = tempProject();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audits = [];
  const registry = createProjectRegistry({ audit: (...args) => audits.push(args) });
  const record = registry.open(dir);

  assert.match(record.projectId, /^prj_[a-f0-9]{24}$/);
  assert.match(record.token, /^[a-f0-9]{64}$/);
  assert.equal(record.rootPath, fs.realpathSync.native(dir));
  assert.equal(registry.get(record.projectId, record.token).projectId, record.projectId);
  assert.equal(registry.get(record.projectId, 'bad-token'), null);

  const inside = registry.resolve(record.projectId, record.token, 'src/app.js', { allowEmpty: false });
  assert.equal(inside.ok, true);
  assert.equal(inside.relativePath, 'src/app.js');
  assert.equal(fs.readFileSync(inside.targetPath, 'utf8'), 'console.log("ok");');

  for (const relativePath of [
    '../outside.txt',
    'src/../../outside.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '\\\\server\\share\\file.txt',
    '\\\\?\\C:\\Windows\\win.ini',
    'src/app.js:stream',
    '/etc/passwd',
    'src\u0000/app.js',
  ]) {
    assert.equal(
      registry.resolve(record.projectId, record.token, relativePath).ok,
      false,
      relativePath
    );
  }

  assert.equal(registry.resolve(record.projectId, 'wrong-token', 'src/app.js').ok, false);
  assert.ok(audits.some(entry => entry[0] === 'PROJECT_OPEN'));
});

test('project registry: close and replacement revoke the prior token', t => {
  const first = tempProject();
  const second = tempProject();
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  const registry = createProjectRegistry();
  const a = registry.open(first);
  const b = registry.open(second);

  assert.equal(registry.get(a.projectId, a.token), null);
  assert.equal(registry.resolve(a.projectId, a.token, 'src/app.js').ok, false);
  assert.equal(registry.get(b.projectId, b.token).projectId, b.projectId);
  assert.equal(registry.close(b.projectId, b.token), true);
  assert.equal(registry.size(), 0);
});

test('project registry: rejects non-directory and unsafe roots', () => {
  const registry = createProjectRegistry();
  assert.throws(() => registry.open('relative/project'), /absolute/i);
  assert.throws(() => registry.open('\\\\server\\share'), /UNC and device/i);
  assert.throws(() => registry.open('\\\\?\\C:\\Windows'), /UNC and device/i);
});

test('project registry: relative path normalization rejects traversal and unsafe syntax', () => {
  assert.deepEqual(
    normalizeRelativePath('src\\components\\App.tsx'),
    { ok: true, relativePath: 'src/components/App.tsx', segments: ['src', 'components', 'App.tsx'] }
  );
  for (const value of ['..', '../x', 'src/../x', 'C:/x', '\\\\x\\y', 'src:x', 'src\u0000x']) {
    assert.equal(normalizeRelativePath(value).ok, false, String(value));
  }
});
