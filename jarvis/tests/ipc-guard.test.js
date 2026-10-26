'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionState, SESSION_STATES } = require('../backend/security/session-state');
const { createIpcGuard } = require('../backend/security/ipc-guard');

const APPROVED_URL = 'file:///C:/JARVIS/renderer/index.html';

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    on(channel, listener) { listeners.set(channel, listener); },
    async invoke(channel, event, ...args) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener(event, ...args);
    },
    send(channel, event, ...args) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`No listener for ${channel}`);
      return listener(event, ...args);
    },
    handlers,
    listeners,
  };
}

function makeHarness({ initial = SESSION_STATES.UNLOCKED, strictPolicy = true } = {}) {
  const ipcMain = fakeIpc();
  const sessionState = createSessionState({ initial });
  const audits = [];
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  };
  const frame = {
    url: APPROVED_URL,
    isDestroyed: () => false,
  };
  mainWindow.webContents.mainFrame = frame;
  mainWindow.webContents.url = APPROVED_URL;
  const event = {
    sender: mainWindow.webContents,
    senderFrame: frame,
    returnValue: undefined,
  };
  const guard = createIpcGuard({
    ipcMain,
    getMainWindow: () => mainWindow,
    approvedRendererUrl: APPROVED_URL,
    sessionState,
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    strictPolicy,
  });
  guard.install();
  return { ipcMain, sessionState, mainWindow, frame, event, audits, guard };
}

test('IPC guard: valid main-frame sender executes an allowed handler', async () => {
  const h = makeHarness();
  let calls = 0;
  h.ipcMain.handle('fs-read', async () => { calls += 1; return { ok: true }; });
  const result = await h.ipcMain.invoke('fs-read', h.event, 'C:\\file.txt');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('IPC guard: locked session denies privileged invoke without executing it', async () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let calls = 0;
  h.ipcMain.handle('fs-read', async () => { calls += 1; return { ok: true }; });
  const result = await h.ipcMain.invoke('fs-read', h.event);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_LOCKED');
  assert.equal(result.state, 'locked');
  assert.equal(calls, 0);
  assert.ok(h.audits.some(entry => entry.action === 'IPC_SESSION_BLOCK'));
});

test('IPC guard: subframes, destroyed frames, wrong webContents, and bad URLs are denied', async () => {
  const h = makeHarness();
  let calls = 0;
  h.ipcMain.handle('fs-read', async () => { calls += 1; });
  const cases = [
    { ...h.event, senderFrame: { url: APPROVED_URL, isDestroyed: () => false } },
    { ...h.event, senderFrame: { url: APPROVED_URL, isDestroyed: () => true } },
    { ...h.event, sender: { isDestroyed: () => false, mainFrame: h.frame } },
    { ...h.event, senderFrame: { ...h.frame, url: `${APPROVED_URL}?evil=1` } },
    { ...h.event, senderFrame: { ...h.frame, url: 'file:///C:/JARVIS/renderer/evil.html' } },
    { ...h.event, senderFrame: null },
  ];
  for (const event of cases) {
    const result = await h.ipcMain.invoke('fs-read', event);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'untrusted sender');
  }
  assert.equal(calls, 0);
});

test('IPC guard: missing main window and unknown channels fail closed', async () => {
  const h = makeHarness({ strictPolicy: false });
  let calls = 0;
  h.ipcMain.handle('fs-read', async () => { calls += 1; });
  h.mainWindow.isDestroyed = () => true;
  const noWindow = await h.ipcMain.invoke('fs-read', h.event);
  assert.equal(noWindow.ok, false);

  h.ipcMain.handle('made-up-channel', async () => { calls += 1; });
  const unknown = await h.ipcMain.invoke('made-up-channel', h.event);
  assert.equal(unknown.ok, false);
  assert.equal(calls, 0);
});

test('IPC guard: send-style channels are denied without invoking listeners', () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let calls = 0;
  h.ipcMain.on('open-external', () => { calls += 1; });
  h.ipcMain.send('open-external', h.event, 'https://example.com');
  assert.equal(calls, 0);
  assert.equal(h.event.returnValue.ok, false);
});

test('IPC guard: strict registration fails when a channel has no policy entry', () => {
  const h = makeHarness();
  assert.throws(
    () => h.ipcMain.handle('made-up-channel', () => {}),
    /No IPC policy entry/
  );
});

test('IPC guard: lock-screen allowlist executes only the intended channels', async () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let authLoads = 0;
  let terminalCalls = 0;
  h.ipcMain.handle('auth-load', async () => { authLoads += 1; return { ok: true }; });
  h.ipcMain.handle('run-command', async () => { terminalCalls += 1; });
  assert.equal((await h.ipcMain.invoke('auth-load', h.event)).ok, true);
  assert.equal((await h.ipcMain.invoke('run-command', h.event, 'whoami')).ok, false);
  assert.equal(authLoads, 1);
  assert.equal(terminalCalls, 0);
});
