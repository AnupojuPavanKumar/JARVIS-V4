'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionState, SESSION_STATES } = require('../backend/security/session-state');
const { createIpcGuard } = require('../backend/security/ipc-guard');

const APPROVED_URL = 'file:///C:/JARVIS/renderer/index.html';
const VERIFIER_URL = 'file:///C:/JARVIS/renderer/verifier/face-verifier.html';

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

function makeHarness({ initial = SESSION_STATES.UNLOCKED, strictPolicy = true, hasVerifier = true } = {}) {
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
  const verifierContents = {
    isDestroyed: () => false,
  };
  const verifierFrame = {
    url: VERIFIER_URL,
    isDestroyed: () => false,
  };
  verifierContents.mainFrame = verifierFrame;
  verifierContents.url = VERIFIER_URL;
  const verifierEvent = {
    sender: verifierContents,
    senderFrame: verifierFrame,
    returnValue: undefined,
  };
  const guard = createIpcGuard({
    ipcMain,
    getMainWindow: () => mainWindow,
    approvedRendererUrl: APPROVED_URL,
    getVerifierWebContents: () => (hasVerifier ? verifierContents : null),
    approvedVerifierUrl: VERIFIER_URL,
    sessionState,
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    strictPolicy,
  });
  guard.install();
  return {
    ipcMain,
    sessionState,
    mainWindow,
    frame,
    event,
    audits,
    guard,
    verifierContents,
    verifierFrame,
    verifierEvent,
  };
}

test('IPC guard: valid main-frame sender executes an allowed handler', async () => {
  const h = makeHarness();
  let calls = 0;
  h.ipcMain.handle('project-list', async () => { calls += 1; return { ok: true }; });
  const result = await h.ipcMain.invoke('project-list', h.event, 'C:\\file.txt');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('IPC guard: locked session denies privileged invoke without executing it', async () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let calls = 0;
  h.ipcMain.handle('project-list', async () => { calls += 1; return { ok: true }; });
  const result = await h.ipcMain.invoke('project-list', h.event);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_LOCKED');
  assert.equal(result.state, 'locked');
  assert.equal(calls, 0);
  assert.ok(h.audits.some(entry => entry.action === 'IPC_SESSION_BLOCK'));
});

test('IPC guard: subframes, destroyed frames, wrong webContents, and bad URLs are denied', async () => {
  const h = makeHarness();
  let calls = 0;
  h.ipcMain.handle('project-list', async () => { calls += 1; });
  const cases = [
    { ...h.event, senderFrame: { url: APPROVED_URL, isDestroyed: () => false } },
    { ...h.event, senderFrame: { url: APPROVED_URL, isDestroyed: () => true } },
    { ...h.event, sender: { isDestroyed: () => false, mainFrame: h.frame } },
    { ...h.event, senderFrame: { ...h.frame, url: `${APPROVED_URL}?evil=1` } },
    { ...h.event, senderFrame: { ...h.frame, url: 'file:///C:/JARVIS/renderer/evil.html' } },
    { ...h.event, senderFrame: null },
  ];
  for (const event of cases) {
    const result = await h.ipcMain.invoke('project-list', event);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'untrusted sender');
  }
  assert.equal(calls, 0);
});

test('IPC guard: missing main window and unknown channels fail closed', async () => {
  const h = makeHarness({ strictPolicy: false });
  let calls = 0;
  h.ipcMain.handle('project-list', async () => { calls += 1; });
  h.mainWindow.isDestroyed = () => true;
  const noWindow = await h.ipcMain.invoke('project-list', h.event);
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

test('IPC guard: only the exact verifier webContents may submit a face result', async () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let results = 0;
  h.ipcMain.handle('face-verifier-result', async () => {
    results += 1;
    return { ok: true };
  });

  const allowed = await h.ipcMain.invoke('face-verifier-result', h.verifierEvent, { nonce: 'a' });
  assert.equal(allowed.ok, true);
  assert.equal(results, 1);

  const fromMain = await h.ipcMain.invoke('face-verifier-result', h.event, { nonce: 'a' });
  assert.equal(fromMain.ok, false);
  assert.equal(fromMain.error, 'untrusted sender');
  assert.equal(results, 1);

  const noVerifier = makeHarness({ initial: SESSION_STATES.LOCKED, hasVerifier: false });
  noVerifier.ipcMain.handle('face-verifier-result', async () => { results += 1; });
  const missing = await noVerifier.ipcMain.invoke('face-verifier-result', noVerifier.verifierEvent, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-verifier');
  assert.equal(results, 1);
});

test('IPC guard: verifier and renderer surfaces cannot use each other\'s channels', async () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let statusCalls = 0;
  let resultCalls = 0;
  h.ipcMain.handle('face-status', async () => { statusCalls += 1; return { ok: true }; });
  h.ipcMain.handle('face-verifier-result', async () => { resultCalls += 1; return { ok: true }; });

  assert.equal((await h.ipcMain.invoke('face-status', h.event)).ok, true);
  assert.equal(statusCalls, 1);

  const verifierStatus = await h.ipcMain.invoke('face-status', h.verifierEvent);
  assert.equal(verifierStatus.ok, false);
  assert.equal(verifierStatus.error, 'untrusted sender');
  assert.equal(statusCalls, 1);

  const mainResult = await h.ipcMain.invoke('face-verifier-result', h.event, {});
  assert.equal(mainResult.ok, false);
  assert.equal(mainResult.error, 'untrusted sender');
  assert.equal(resultCalls, 0);

  const verifierResult = await h.ipcMain.invoke('face-verifier-result', h.verifierEvent, {});
  assert.equal(verifierResult.ok, true);
  assert.equal(resultCalls, 1);
});

test('IPC guard: verifier subframes, wrong URLs, and destroyed senders are denied', async () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let results = 0;
  h.ipcMain.handle('face-verifier-result', async () => { results += 1; return { ok: true }; });

  const cases = [
    { ...h.verifierEvent, senderFrame: { url: VERIFIER_URL, isDestroyed: () => false } },
    { ...h.verifierEvent, senderFrame: { url: VERIFIER_URL, isDestroyed: () => true } },
    { ...h.verifierEvent, senderFrame: { ...h.verifierFrame, url: `${VERIFIER_URL}?evil=1` } },
    { ...h.verifierEvent, senderFrame: { ...h.verifierFrame, url: 'file:///C:/JARVIS/renderer/index.html' } },
    { ...h.verifierEvent, senderFrame: null },
    { ...h.verifierEvent, sender: h.mainWindow.webContents },
  ];
  for (const event of cases) {
    const result = await h.ipcMain.invoke('face-verifier-result', event, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'untrusted sender');
  }
  assert.equal(results, 0);
});

test('IPC guard: verifier channels are denied outside challenge-capable states', async () => {
  for (const state of [SESSION_STATES.BOOTING, SESSION_STATES.SETUP, SESSION_STATES.ERROR]) {
    const h = makeHarness({ initial: state });
    let results = 0;
    h.ipcMain.handle('face-verifier-result', async () => { results += 1; return { ok: true }; });
    const result = await h.ipcMain.invoke('face-verifier-result', h.verifierEvent, {});
    assert.equal(result.ok, false, state);
    assert.equal(result.code, 'SESSION_LOCKED', state);
    assert.equal(results, 0, state);
  }
});

test('IPC guard: verifier progress is a send channel restricted to the verifier surface', () => {
  const h = makeHarness({ initial: SESSION_STATES.LOCKED });
  let messages = 0;
  h.ipcMain.on('face-verifier-progress', () => { messages += 1; });

  h.ipcMain.send('face-verifier-progress', h.verifierEvent, { message: 'POSITION YOUR FACE' });
  assert.equal(messages, 1);

  h.ipcMain.send('face-verifier-progress', h.event, { message: 'spoofed' });
  assert.equal(messages, 1);
  assert.equal(h.event.returnValue.ok, false);

  const h2 = makeHarness({ initial: SESSION_STATES.SETUP });
  h2.ipcMain.on('face-verifier-progress', () => { messages += 1; });
  h2.ipcMain.send('face-verifier-progress', h2.verifierEvent, { message: 'setup' });
  assert.equal(messages, 1);
  assert.equal(h2.verifierEvent.returnValue.code, 'SESSION_LOCKED');
});
