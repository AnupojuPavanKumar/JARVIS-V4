'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerSecurityController = require('../backend/controllers/SecurityController');
const registerSystemController = require('../backend/controllers/SystemController');
const registerWindowController = require('../backend/controllers/WindowController');
const {
  CAPABILITIES,
  createCapabilityStore,
  buildConsentRequest,
} = require('../backend/security/capability-store');
const { createSessionState } = require('../backend/security/session-state');
const { attachRendererSessionGuards } = require('../backend/security/renderer-guards');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-capability-test-'));
}

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    on(channel, listener) { listeners.set(channel, listener); },
    invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, payload);
    },
    send(channel, ...args) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`No listener for ${channel}`);
      return listener({}, ...args);
    },
    handlers,
    listeners,
  };
}

function fakeDialog(response = 1) {
  const calls = [];
  return {
    calls,
    response,
    async showMessageBox(_window, options) {
      calls.push(options);
      return { response: this.response };
    },
  };
}

function fakeWindow() {
  return { isDestroyed: () => false };
}

function harness(overrides = {}) {
  const dir = overrides.dir || tempDir();
  const ipcMain = fakeIpc();
  const sessionState = overrides.sessionState || createSessionState({ initial: 'unlocked' });
  const audits = [];
  const store = overrides.store || createCapabilityStore({
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    now: overrides.now || (() => Date.now()),
  });
  const dialog = overrides.dialog || fakeDialog(1);
  registerSecurityController({
    ipcMain,
    app: { getPath: () => dir },
    dialog,
    mainWindowProvider: () => fakeWindow(),
    secAudit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    sessionState,
    capabilityStore: store,
  });
  return { dir, ipcMain, sessionState, store, dialog, audits };
}

test('P0-4 broker: frozen capability set, TTL expiry, one-shot use, and revocation', () => {
  assert.equal(Object.isFrozen(CAPABILITIES), true);
  const expectedOneShot = {
    terminal: false,
    'screen-capture': true,
    microphone: true,
    'project-files': false,
    'export-save': true,
  };
  for (const capability of Object.values(CAPABILITIES)) {
    assert.equal(Object.isFrozen(capability), true);
    assert.equal(capability.risk === 'high' || capability.risk === 'medium', true);
    assert.equal(capability.oneShot, expectedOneShot[capability.id], capability.id);
  }
  assert.throws(() => { CAPABILITIES.terminal.scope = 'all'; }, TypeError);

  let now = 1_000_000;
  const audits = [];
  const store = createCapabilityStore({
    now: () => now,
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
  });

  assert.equal(store.isGranted('terminal'), false);
  store.grant('terminal');
  assert.equal(store.isGranted('terminal'), true);
  now += CAPABILITIES.terminal.ttlMs + 1;
  assert.equal(store.isGranted('terminal'), false);
  assert.ok(audits.some(entry => entry.action === 'CAPABILITY_EXPIRE' && /terminal/.test(entry.detail)));

  store.grant('screen-capture');
  assert.equal(store.consume('screen-capture'), true);
  assert.equal(store.consume('screen-capture'), false);
  assert.ok(audits.some(entry => entry.action === 'CAPABILITY_USE' && /screen-capture/.test(entry.detail)));

  store.grant('terminal');
  store.revokeAll('test boundary');
  assert.equal(store.snapshot().terminal.granted, false);
  assert.ok(audits.some(entry => entry.action === 'CAPABILITY_REVOKE' && /test boundary/.test(entry.detail)));

  assert.throws(() => store.grant('all-permissions'), /Unknown capability/);
});

test('P0-4 consent text is main-owned and includes capability, scope, risk, duration, and data', () => {
  const consent = buildConsentRequest('terminal');
  assert.deepEqual(consent.buttons, ['Allow', 'Deny']);
  assert.equal(consent.defaultId, 1);
  assert.equal(consent.cancelId, 1);
  assert.match(consent.message, /terminal command execution/i);
  assert.match(consent.detail, /Scope: current unlocked session/i);
  assert.match(consent.detail, /Risk: HIGH/i);
  assert.match(consent.detail, /Duration: up to 30 minutes/i);
  assert.match(consent.detail, /Data access:/i);
  assert.match(consent.detail, /page cannot save or change it/i);
  assert.throws(() => buildConsentRequest('microphone'), /not directly requestable/);
  assert.throws(() => buildConsentRequest('anything'), /Unknown capability/);
});

test('P0-4 renderer cannot save arbitrary security configuration', async t => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  assert.equal(h.ipcMain.handlers.has('sec-config-save'), false);
  assert.equal(h.ipcMain.handlers.has('sec-config-load'), false);
  assert.equal(h.ipcMain.handlers.has('security-get'), true);
  assert.equal(h.ipcMain.handlers.has('security-request'), true);
  assert.equal(h.ipcMain.handlers.has('security-revoke'), true);

  const preload = read('preload.js');
  assert.doesNotMatch(preload, /secConfigSave|secConfigLoad|sec-config-save|sec-config-load/);
  assert.match(preload, /securityGet:/);
  assert.match(preload, /securityRequest:/);
  assert.match(preload, /securityRevoke:/);

  const renderer = read('renderer/renderer.js');
  assert.doesNotMatch(renderer, /secConfigSave|secConfigLoad|sec-config-save|sec-config-load/);
  assert.match(renderer, /JarvisSec\.request\("terminal"\)/);
  assert.match(renderer, /JarvisSec\.request\("screen-capture"\)/);

  const policy = read('backend/security/ipc-session-policy.js');
  assert.doesNotMatch(policy, /sec-config-(?:save|load)/);
  assert.match(policy, /'security-get'/);
  assert.match(policy, /'security-request'/);
  assert.match(policy, /'security-revoke'/);
});

test('P0-4 native denial leaves capability state unchanged', async t => {
  const h = harness({ dialog: fakeDialog(1) });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const before = await h.ipcMain.invoke('security-get');
  assert.equal(before.ok, true);
  assert.equal(before.capabilities.terminal.granted, false);

  const denied = await h.ipcMain.invoke('security-request', { capability: 'terminal' });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.equal(denied.capabilities.terminal.granted, false);
  assert.equal(h.store.isGranted('terminal'), false);
  assert.equal(h.dialog.calls.length, 1);

  const after = await h.ipcMain.invoke('security-get');
  assert.equal(after.capabilities.terminal.granted, false);
});

test('P0-4 native approval grants only the requested capability', async t => {
  const h = harness({ dialog: fakeDialog(0) });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const result = await h.ipcMain.invoke('security-request', { capability: 'terminal' });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.terminal.granted, true);
  assert.equal(result.capabilities['screen-capture'].granted, false);
  assert.equal(h.dialog.calls.length, 1);
  assert.match(h.dialog.calls[0].detail, /terminal command execution/i);

  const screen = await h.ipcMain.invoke('security-request', { capability: 'screen-capture' });
  assert.equal(screen.ok, true);
  assert.equal(screen.capabilities['screen-capture'].granted, true);
  assert.equal(h.dialog.calls.length, 2);

  const revoked = await h.ipcMain.invoke('security-revoke', { capability: 'screen-capture' });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.capabilities['screen-capture'].granted, false);
  assert.equal(revoked.capabilities.terminal.granted, true);

  const all = await h.ipcMain.invoke('security-revoke', { all: true });
  assert.equal(all.ok, true);
  assert.equal(all.capabilities.terminal.granted, false);
});

test('P0-4 capability requests are denied outside a privileged session', async t => {
  const locked = createSessionState({ initial: 'locked' });
  const h = harness({ sessionState: locked, dialog: fakeDialog(0) });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const result = await h.ipcMain.invoke('security-request', { capability: 'terminal' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unlock/i);
  assert.equal(h.store.isGranted('terminal'), false);
  assert.equal(h.dialog.calls.length, 0);
});

test('P0-4 legacy sec-config cannot authorize terminal or screen capture', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'sec-config.json'), JSON.stringify({
    terminalEnabled: true,
    screenCaptureEnabled: true,
    blockWritesOutsideWorkspace: false,
  }));

  const h = harness({ dir, dialog: fakeDialog(0) });
  const first = await h.ipcMain.invoke('security-get');
  assert.equal(first.ok, true);
  assert.equal(first.legacy.detected, true);
  assert.equal(first.legacy.terminalRequested, true);
  assert.equal(first.legacy.screenCaptureRequested, true);
  assert.equal(first.legacy.ignored, true);
  assert.equal(first.capabilities.terminal.granted, false);
  assert.equal(first.capabilities['screen-capture'].granted, false);
  assert.equal(h.store.isGranted('terminal'), false);
  assert.equal(h.dialog.calls.length, 1);
  assert.match(h.dialog.calls[0].message, /cannot grant capabilities/i);
  assert.match(h.dialog.calls[0].detail, /terminal command execution/);
  assert.match(h.dialog.calls[0].detail, /screen capture/);

  const second = await h.ipcMain.invoke('security-get');
  assert.equal(second.ok, true);
  assert.equal(second.legacy.noticeAcknowledged, true);
  assert.equal(h.dialog.calls.length, 1, 'legacy notice is shown once');
  assert.equal(h.store.isGranted('terminal'), false);
});

test('P0-4 terminal commands require the terminal grant and a privileged session', async t => {
  const dir = tempDir();
  const ipcMain = fakeIpc();
  const audits = [];
  const sessionState = createSessionState({ initial: 'unlocked' });
  const store = createCapabilityStore({ audit: () => {} });
  const commandDialog = fakeDialog(1);
  registerSystemController({
    ipcMain,
    app: { getPath: () => dir, getVersion: () => 'test' },
    mainWindowProvider: () => fakeWindow(),
    secAudit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    secCheckRate: () => true,
    capabilityStore: store,
    sessionState,
    nativeDialog: commandDialog,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const denied = await ipcMain.invoke('run-command', 'whoami');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /main-process consent/i);
  assert.ok(audits.some(entry => /terminal capability not granted/.test(entry.verdict)));

  store.grant('terminal');
  const cancelled = await ipcMain.invoke('run-command', 'echo non-allowlisted');
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled by user/i);
  assert.equal(commandDialog.calls.length, 1);
  assert.match(commandDialog.calls[0].detail, /echo non-allowlisted/);
  assert.match(commandDialog.calls[0].detail, /non-allowlisted command|Classifier result/i);

  const blocked = await ipcMain.invoke('run-command', 'git --git-dir=C:\\other status');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /security policy/i);
  assert.equal(commandDialog.calls.length, 1, 'blocked commands never reach the confirmation dialog');

  sessionState.lock('test lock');
  const locked = await ipcMain.invoke('run-command', 'whoami');
  assert.equal(locked.ok, false);
  assert.match(locked.error, /Unlock JARVIS/i);
});

test('P0-4 screen capture requires a fresh grant, consumes it, and is denied while locked', async t => {
  const ipcMain = fakeIpc();
  const sessionState = createSessionState({ initial: 'unlocked' });
  const now = () => Date.now();
  const store = createCapabilityStore({ now });
  let providerCalls = 0;
  registerWindowController({
    ipcMain,
    app: { quit: () => {} },
    mainWindowProvider: () => fakeWindow(),
    secAudit: () => {},
    capabilityStore: store,
    sessionState,
    screenCaptureProvider: async () => {
      providerCalls += 1;
      return [{
        name: 'Screen 1',
        thumbnail: { toJPEG: () => Buffer.from('jpeg-bytes') },
      }];
    },
  });

  const denied = await ipcMain.invoke('capture-screen');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /fresh main-process approval/i);
  assert.equal(providerCalls, 0);

  store.grant('screen-capture');
  const captured = await ipcMain.invoke('capture-screen');
  assert.equal(captured.ok, true);
  assert.equal(captured.data, Buffer.from('jpeg-bytes').toString('base64'));
  assert.equal(providerCalls, 1);

  const second = await ipcMain.invoke('capture-screen');
  assert.equal(second.ok, false, 'one approval permits one capture');
  assert.equal(providerCalls, 1);

  store.grant('screen-capture');
  sessionState.lock('test lock');
  const locked = await ipcMain.invoke('capture-screen');
  assert.equal(locked.ok, false);
  assert.match(locked.error, /Unlock JARVIS/i);
  assert.equal(providerCalls, 1);
});

test('P0-4 renderer boundaries revoke grants even in an explicit no-lock install', () => {
  const state = createSessionState({ initial: 'no-lock' });
  const listeners = new Map();
  const webContents = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
  };
  const bounds = [];
  attachRendererSessionGuards(webContents, {
    sessionState: state,
    approvedRendererUrl: 'file:///C:/JARVIS/renderer/index.html',
    onBoundary: reason => bounds.push(reason),
  }).install();

  for (const fn of listeners.get('did-start-navigation') || []) {
    fn({}, 'file:///C:/JARVIS/renderer/index.html', false, true);
  }
  for (const fn of listeners.get('render-process-gone') || []) {
    fn({}, { reason: 'crashed' });
  }
  for (const fn of listeners.get('destroyed') || []) {
    fn();
  }
  assert.equal(state.state, 'no-lock');
  assert.equal(bounds.length, 3);
  assert.match(bounds[0], /navigation/i);
  assert.match(bounds[1], /renderer gone/i);
  assert.match(bounds[2], /destroyed/i);
});

test('P0-4 main revokes grants on hide, lock, renderer boundaries, and quit', () => {
  const main = read('main.js');
  assert.match(main, /function lockSessionForHide\(\) \{[\s\S]*?capabilityStore\.revokeAll\('window hidden'\)/);
  assert.match(main, /view\.locked && previous !== view\.state[\s\S]*?capabilityStore\.revokeAll\('session locked'\)/);
  assert.match(main, /onBoundary: reason => \{\s*capabilityStore\.revokeAll\(`renderer boundary: \$\{reason\}`\)/);
  assert.match(main, /app\.on\('before-quit'[\s\S]*?capabilityStore\.revokeAll\('app quit'\)/);
  assert.doesNotMatch(main, /liveSecConfig/);
  assert.doesNotMatch(main, /sec-config\.json[\s\S]{0,200}terminalEnabled/);
});
