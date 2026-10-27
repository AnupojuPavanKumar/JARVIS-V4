'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerFileController = require('../backend/controllers/FileController');
const { createProjectRegistry } = require('../backend/security/project-registry');

function fakeIpc() {
  const handlers = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, payload);
    },
    handlers,
  };
}

function fakeDialog({ openPaths = [], savePath = null } = {}) {
  const calls = [];
  return {
    calls,
    async showOpenDialog(_window, options) {
      calls.push({ type: 'open', options });
      return { canceled: openPaths.length === 0, filePaths: [...openPaths] };
    },
    async showSaveDialog(_window, options) {
      calls.push({ type: 'save', options });
      return savePath ? { canceled: false, filePath: savePath } : { canceled: true, filePath: null };
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-project-controller-'));
}

function createProjectFixture() {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log("project");\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=do-not-read\n');
  fs.writeFileSync(path.join(root, 'credentials.json'), '{"password":"secret"}\n');
  fs.writeFileSync(path.join(root, 'src', 'secrets.json'), '{"token":"secret"}\n');
  fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ssh', 'known_hosts'), 'example.com ssh-rsa AAAA\n');
  fs.writeFileSync(path.join(root, 'id_rsa_backup'), 'PRIVATE KEY\n');
  fs.writeFileSync(path.join(root, 'id_ed25519_backup'), 'PRIVATE KEY\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  return root;
}

function harness({ openPaths = [], savePath = null } = {}) {
  const userData = tempDir();
  const ipcMain = fakeIpc();
  const nativeDialog = fakeDialog({ openPaths, savePath });
  const audits = [];
  const projectRegistry = createProjectRegistry({
    audit: (...args) => audits.push(args),
  });
  const api = registerFileController({
    ipcMain,
    app: { getPath: () => userData },
    mainWindowProvider: () => ({ isDestroyed: () => false }),
    secAudit: (...args) => audits.push(args),
    projectRegistry,
    nativeDialog,
  });
  return { userData, ipcMain, nativeDialog, audits, projectRegistry, api };
}

test('project controller: project-open uses the native picker and returns a bounded, secret-free model', async t => {
  const root = createProjectFixture();
  const h = harness({ openPaths: [root] });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(h.userData, { recursive: true, force: true });
  });

  const opened = await h.ipcMain.invoke('project-open');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(h.nativeDialog.calls.length, 1);
  assert.equal(h.nativeDialog.calls[0].options.properties.includes('openDirectory'), true);
  assert.equal(opened.name, path.basename(fs.realpathSync.native(root)));
  assert.match(opened.projectId, /^prj_/);
  assert.match(opened.token, /^[a-f0-9]{64}$/);
  assert.equal(Array.isArray(opened.files), true);
  assert.equal(opened.fileCount, 2);
  assert.equal(opened.files.some(file => file.relativePath === '.env'), false);
  assert.equal(opened.files.some(file => file.relativePath === 'credentials.json'), false);
  assert.equal(opened.files.some(file => file.relativePath === 'src/secrets.json'), false);
  assert.equal(opened.files.some(file => file.relativePath === 'id_rsa_backup'), false);
  assert.equal(opened.files.some(file => file.relativePath === 'id_ed25519_backup'), false);
  assert.equal(opened.files.some(file => file.relativePath.startsWith('.ssh/')), false);
  assert.equal(opened.files.some(file => file.relativePath.includes('node_modules')), false);
  assert.equal(opened.excludedCount, 6);
  assert.ok(opened.files.every(file => !file.content.includes('do-not-read')));
  assert.equal(opened.truncated, false);

  const listed = await h.ipcMain.invoke('project-list', {
    projectId: opened.projectId,
    token: opened.token,
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.files.length, opened.files.length);

  const read = await h.ipcMain.invoke('project-read-file', {
    projectId: opened.projectId,
    token: opened.token,
    relativePath: 'src\\app.js',
  });
  assert.equal(read.ok, true);
  assert.equal(read.relativePath, 'src/app.js');
  assert.match(read.data, /console\.log/);

  for (const relativePath of [
    '../outside.txt',
    '.env',
    'credentials.json',
    'src/secrets.json',
    'id_rsa_backup',
    'id_ed25519_backup',
    '.ssh/known_hosts',
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\x.txt',
    'src/app.js:stream',
  ]) {
    const denied = await h.ipcMain.invoke('project-read-file', {
      projectId: opened.projectId,
      token: opened.token,
      relativePath,
    });
    assert.equal(denied.ok, false, relativePath);
  }

  const wrongToken = await h.ipcMain.invoke('project-read-file', {
    projectId: opened.projectId,
    token: 'wrong',
    relativePath: 'src/app.js',
  });
  assert.equal(wrongToken.ok, false);

  const closed = await h.ipcMain.invoke('project-close', {
    projectId: opened.projectId,
    token: opened.token,
  });
  assert.equal(closed.ok, true);
  const afterClose = await h.ipcMain.invoke('project-read-file', {
    projectId: opened.projectId,
    token: opened.token,
    relativePath: 'src/app.js',
  });
  assert.equal(afterClose.ok, false);
});

test('project controller: cancellation is explicit and unsafe picked roots are rejected', async t => {
  const cancelled = harness();
  t.after(() => fs.rmSync(cancelled.userData, { recursive: true, force: true }));
  const cancelResult = await cancelled.ipcMain.invoke('project-open');
  assert.equal(cancelResult.ok, false);
  assert.equal(cancelResult.cancelled, true);

  const unsafe = harness({ openPaths: ['\\\\server\\share'] });
  t.after(() => fs.rmSync(unsafe.userData, { recursive: true, force: true }));
  const unsafeResult = await unsafe.ipcMain.invoke('project-open');
  assert.equal(unsafeResult.ok, false);
  assert.match(unsafeResult.error, /UNC and device/i);
});

test('project controller: large projects are capped rather than unbounded', async t => {
  const root = tempDir();
  for (let index = 0; index < 60; index += 1) {
    fs.writeFileSync(path.join(root, `file-${String(index).padStart(2, '0')}.txt`), `file ${index}`);
  }
  const h = harness({ openPaths: [root] });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(h.userData, { recursive: true, force: true });
  });

  const opened = await h.ipcMain.invoke('project-open');
  assert.equal(opened.ok, true);
  assert.equal(opened.fileCount, 50);
  assert.equal(opened.truncated, true);
});

test('project controller: images are readable only after the native image picker', async t => {
  const h = harness();
  const image = path.join(h.userData, 'sample.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(image, bytes);
  h.nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] });
  t.after(() => fs.rmSync(h.userData, { recursive: true, force: true }));

  const arbitrary = await h.ipcMain.invoke('fs-read-binary', image);
  assert.equal(arbitrary.ok, false);

  const picked = await h.ipcMain.invoke('open-image-dialog');
  assert.equal(picked.ok, true);
  const read = await h.ipcMain.invoke('fs-read-binary', picked.filePath);
  assert.equal(read.ok, true);
  assert.equal(read.mimeType, 'image/png');
  assert.equal(read.data, bytes.toString('base64'));
});

test('project controller: renderer logs use a fixed main-owned path', async t => {
  const h = harness();
  t.after(() => fs.rmSync(h.userData, { recursive: true, force: true }));

  const result = await h.ipcMain.invoke('renderer-log-write', 'renderer failure\n');
  assert.equal(result.ok, true);
  assert.equal(
    fs.readFileSync(path.join(h.userData, 'renderer_errors.log'), 'utf8'),
    'renderer failure\n'
  );

  const oversized = await h.ipcMain.invoke('renderer-log-write', 'x'.repeat(256 * 1024 + 1));
  assert.equal(oversized.ok, false);
});
