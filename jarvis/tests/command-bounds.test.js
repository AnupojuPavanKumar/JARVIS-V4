'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerSystemController = require('../backend/controllers/SystemController');
const { createCapabilityStore } = require('../backend/security/capability-store');
const { createProjectRegistry } = require('../backend/security/project-registry');
const { createSessionState } = require('../backend/security/session-state');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    on(channel, listener) { listeners.set(channel, listener); },
    invoke(channel, ...args) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, ...args);
    },
    handlers,
    listeners,
  };
}

function fakeDialog({ response = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async showMessageBox(_window, options) {
      calls.push(options);
      return { response };
    },
  };
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function nodeCommand(script) {
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

function harness({ dialogResponse = 0 } = {}) {
  const userData = tempDir('jarvis-command-bounds-');
  const ipcMain = fakeIpc();
  const audits = [];
  const dialog = fakeDialog({ response: dialogResponse });
  const openedUrls = [];
  const externalShell = {
    async openExternal(url) { openedUrls.push(url); },
  };
  const sessionState = createSessionState({ initial: 'unlocked' });
  const capabilityStore = createCapabilityStore({ audit: () => {} });
  capabilityStore.grant('terminal');
  const projectRegistry = createProjectRegistry({
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
  });

  registerSystemController({
    ipcMain,
    app: { getPath: () => userData, getVersion: () => 'test' },
    mainWindowProvider: () => ({ isDestroyed: () => false }),
    secAudit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    secCheckRate: () => true,
    capabilityStore,
    sessionState,
    nativeDialog: dialog,
    externalShell,
    projectRegistry,
  });

  return {
    userData, ipcMain, audits, dialog, externalShell, openedUrls,
    sessionState, capabilityStore, projectRegistry,
  };
}

function makeProject() {
  const root = tempDir('jarvis-command-project-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log("fixture");\n');
  return root;
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function samePath(actual, expected) {
  return path.resolve(actual).toLowerCase() === fs.realpathSync.native(expected).toLowerCase();
}

test('P1-3: raw, traversing, absolute, and stale-token working directories are rejected', async t => {
  const h = harness();
  const root = makeProject();
  const outside = tempDir('jarvis-command-outside-');
  t.after(() => cleanup(h.userData, root, outside));

  const record = h.projectRegistry.open(root);

  const raw = await h.ipcMain.invoke('run-command', 'whoami', { cwd: outside });
  assert.equal(raw.ok, false);
  assert.match(raw.error, /Raw working directories are not allowed/i);

  const rawString = await h.ipcMain.invoke('run-command', 'whoami', outside);
  assert.equal(rawString.ok, false);
  assert.match(rawString.error, /Raw working directories are not allowed/i);

  for (const relativePath of ['../outside', 'src/../../outside', path.join(outside, 'x')]) {
    const denied = await h.ipcMain.invoke('run-command', 'whoami', {
      projectId: record.projectId,
      token: record.token,
      relativePath,
    });
    assert.equal(denied.ok, false, relativePath);
  }

  const stale = await h.ipcMain.invoke('run-command', 'whoami', {
    projectId: 'prj_not_active',
    token: record.token,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /no longer active/i);

  const badToken = await h.ipcMain.invoke('run-command', 'whoami', {
    projectId: record.projectId,
    token: 'wrong-token',
  });
  assert.equal(badToken.ok, false);
  assert.match(badToken.error, /not open|invalid/i);

  assert.equal(h.dialog.calls.length, 0, 'cwd validation happens before any confirmation');
});

test('P1-3: project token binds commands to the project root and approved subdirectories', async t => {
  const h = harness();
  const root = makeProject();
  t.after(() => cleanup(h.userData, root));

  const record = h.projectRegistry.open(root);
  const rootRun = await h.ipcMain.invoke('run-command', nodeCommand('process.stdout.write(process.cwd())'), {
    projectId: record.projectId,
    token: record.token,
  });
  assert.equal(rootRun.ok, true, JSON.stringify(rootRun));
  assert.equal(samePath(rootRun.stdout.trim(), root), true);

  const subRun = await h.ipcMain.invoke('run-command', nodeCommand('process.stdout.write(process.cwd())'), {
    projectId: record.projectId,
    token: record.token,
    relativePath: 'src',
  });
  assert.equal(subRun.ok, true, JSON.stringify(subRun));
  assert.equal(samePath(subRun.stdout.trim(), path.join(root, 'src')), true);

  // With no explicit cwd, main defaults to the active project root, never the
  // renderer process's current directory.
  const defaultRun = await h.ipcMain.invoke('run-command', nodeCommand('process.stdout.write(process.cwd())'));
  assert.equal(defaultRun.ok, true, JSON.stringify(defaultRun));
  assert.equal(samePath(defaultRun.stdout.trim(), root), true);

  assert.equal(h.dialog.calls.length, 3, 'only non-allowlisted commands ask for confirmation');
  assert.match(h.dialog.calls[0].detail, /Executable:/);
  assert.match(h.dialog.calls[0].detail, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.ok(h.audits.some(entry => entry.action === 'RUN_COMMAND'
    && /process\.execPath|node/i.test(entry.detail)
    && entry.detail.toLowerCase().includes(root.toLowerCase())));
});

test('P1-3: without a project, commands run in the main-owned app workspace', async t => {
  const h = harness();
  const expected = path.join(h.userData, 'workspace');
  t.after(() => cleanup(h.userData));

  const result = await h.ipcMain.invoke('run-command', nodeCommand('process.stdout.write(process.cwd())'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(samePath(result.stdout.trim(), expected), true);
});

test('P1-3: symlinked working directories are rejected', async t => {
  const h = harness();
  const root = makeProject();
  const outside = tempDir('jarvis-command-symlink-target-');
  const link = path.join(root, 'linked');
  let created = false;
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    created = true;
  } catch (_) {
    // Some Windows configurations do not permit symlink creation.
  }
  t.after(() => cleanup(h.userData, root, outside));

  if (!created) {
    t.skip('directory symlinks are not available on this host');
    return;
  }

  const record = h.projectRegistry.open(root);
  const result = await h.ipcMain.invoke('run-command', 'whoami', {
    projectId: record.projectId,
    token: record.token,
    relativePath: 'linked',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic link/i);
});

test('P1-3: timeout terminates the command and reports a bounded timeout', async t => {
  const h = harness();
  t.after(() => cleanup(h.userData));

  const started = Date.now();
  const result = await h.ipcMain.invoke(
    'run-command',
    nodeCommand('setTimeout(function () {}, 10000)'),
    { timeout: 250 }
  );
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /timed out after 250 ms/i);
  assert.ok(elapsed < 5000, `timeout returned too slowly: ${elapsed} ms`);
});

test('P1-3: timeout kills the child process tree', async t => {
  const h = harness();
  const dir = tempDir('jarvis-command-tree-');
  const pidFile = path.join(dir, 'grandchild.pid');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, `
const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(child.pid));
setTimeout(() => {}, 30000);
`);
  t.after(() => {
    try {
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
      }
    } catch (_) {}
    cleanup(h.userData, dir);
  });

  const result = await h.ipcMain.invoke(
    'run-command',
    `${quote(process.execPath)} ${quote(runner)} ${quote(pidFile)}`,
    { timeout: 1500 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);

  let grandchildPid = null;
  for (let attempt = 0; attempt < 20 && grandchildPid === null; attempt += 1) {
    if (fs.existsSync(pidFile)) {
      grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!Number.isInteger(grandchildPid) || grandchildPid <= 0) {
    t.skip('the test runner did not report its child PID in time');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  let alive = true;
  try { process.kill(grandchildPid, 0); } catch (_) { alive = false; }
  assert.equal(alive, false, `grandchild process ${grandchildPid} survived the timeout`);
});

test('P1-3: output flooding is truncated, terminated, and bounded', async t => {
  const h = harness();
  t.after(() => cleanup(h.userData));

  const script = "process.stdout.write('x'.repeat(700000)), setTimeout(function () {}, 10000)";
  const result = await h.ipcMain.invoke('run-command', nodeCommand(script), { timeout: 10000 });

  assert.equal(result.ok, false);
  assert.equal(result.outputLimitExceeded, true);
  assert.match(result.error, /output exceeded/i);
  assert.ok(
    Buffer.byteLength(result.stdout, 'utf8') <= 512 * 1024,
    `stdout was not capped: ${Buffer.byteLength(result.stdout, 'utf8')} bytes`
  );
});

test('P1-3: command type, length, quoting, and timeout are validated before execution', async t => {
  const h = harness();
  t.after(() => cleanup(h.userData));

  const notString = await h.ipcMain.invoke('run-command', null);
  assert.equal(notString.ok, false);
  assert.match(notString.error, /must be a string/i);

  const tooLong = await h.ipcMain.invoke('run-command', `echo ${'x'.repeat(4096)}`);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /too long/i);

  const multiline = await h.ipcMain.invoke('run-command', 'echo one\necho two');
  assert.equal(multiline.ok, false);
  assert.match(multiline.error, /single command line/i);

  const malformed = await h.ipcMain.invoke('run-command', 'echo "unterminated');
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /unterminated quote/i);

  const badTimeout = await h.ipcMain.invoke('run-command', 'whoami', { timeout: 0 });
  assert.equal(badTimeout.ok, false);
  assert.match(badTimeout.error, /positive integer/i);

  const clamped = await h.ipcMain.invoke('run-command', nodeCommand('0'), { timeout: 99999999 });
  assert.equal(clamped.ok, true, JSON.stringify(clamped));
  assert.match(h.dialog.calls.at(-1).detail, /Timeout: 120000 ms/);

  assert.equal(h.dialog.calls.length, 1, 'invalid commands never reach the confirmation dialog');
});

test('P1-3: locked sessions cannot execute commands even with a live project token', async t => {
  const h = harness();
  const root = makeProject();
  t.after(() => cleanup(h.userData, root));

  const record = h.projectRegistry.open(root);
  h.sessionState.lock('test lock');

  const result = await h.ipcMain.invoke('run-command', 'whoami', {
    projectId: record.projectId,
    token: record.token,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unlock JARVIS/i);
  assert.equal(h.dialog.calls.length, 0);
});

test('P1-3: the internal allowlist still runs without a confirmation dialog', async t => {
  if (process.platform !== 'win32') {
    t.skip('tasklist is Windows-only');
    return;
  }
  const h = harness();
  t.after(() => cleanup(h.userData));

  const result = await h.ipcMain.invoke('run-command', 'tasklist /FO CSV /NH');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.stdout.length > 0);
  assert.equal(h.dialog.calls.length, 0);
});

test('P1-1: system-command external opens use the reviewed confirmation path', async t => {
  const h = harness();
  t.after(() => cleanup(h.userData));

  const search = await h.ipcMain.invoke('system-command', 'search', 'jarvis security');
  assert.equal(search.ok, true, JSON.stringify(search));
  assert.equal(h.openedUrls.length, 1);
  assert.match(h.openedUrls[0], /^https:\/\/www\.google\.com\/search\?q=jarvis%20security$/);
  assert.equal(h.dialog.calls.length, 1, 'system commands always confirm');
  assert.ok(h.audits.some(entry => entry.action === 'OPEN_EXTERNAL'
    && entry.detail.includes('system-command')
    && entry.verdict === 'ALLOWED'));
  assert.ok(h.audits.some(entry => entry.action === 'SYSTEM_CMD_OPEN_URL'
    && entry.verdict === 'ALLOWED'));

  // The command path always asks, even for an origin already approved by a
  // click-driven external link.
  const direct = await h.ipcMain.invoke('system-command', 'open-url', 'https://example.com/page');
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(h.dialog.calls.length, 2);
  assert.equal(h.openedUrls.length, 2);

  const credentials = await h.ipcMain.invoke('system-command', 'open-url', 'https://user:pass@example.com/');
  assert.equal(credentials.ok, false);
  assert.equal(h.openedUrls.length, 2, 'rejected URLs never reach the OS');
  assert.equal(h.dialog.calls.length, 2, 'invalid URLs are rejected before confirmation');
});

test('P1-1: cancelling the system-command confirmation never opens the link', async t => {
  const h = harness({ dialogResponse: 1 });
  t.after(() => cleanup(h.userData));

  const result = await h.ipcMain.invoke('system-command', 'open-url', 'https://example.com');
  assert.equal(result.ok, false);
  assert.equal(h.openedUrls.length, 0);
  assert.equal(h.dialog.calls.length, 1);
  assert.ok(h.audits.some(entry => entry.action === 'OPEN_EXTERNAL'
    && entry.verdict === 'CANCELLED'));
});
