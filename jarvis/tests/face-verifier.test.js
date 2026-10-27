'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createFaceVerifierSurface } = require('../backend/face/face-verifier');

const ROOT = path.join(__dirname, '..');
const VERIFIER_ROOT = path.join(ROOT, 'renderer', 'verifier');
const QUIET_LOGGER = { log() {}, warn() {}, error() {} };

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.sent = [];
    this.windowOpenHandler = null;
    this.stopped = false;
  }

  isDestroyed() { return this.destroyed; }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }

  send(channel, payload) { this.sent.push({ channel, payload }); }

  stop() { this.stopped = true; }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new FakeWebContents();
    this.loadedFile = null;
    this.menu = undefined;
    this.skipTaskbar = null;
    this.ignoreMouse = null;
    this.alwaysOnTop = null;
  }

  isDestroyed() { return this.destroyed; }
  setMenu(menu) { this.menu = menu; }
  setSkipTaskbar(value) { this.skipTaskbar = value; }
  setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
  setAlwaysOnTop(value) { this.alwaysOnTop = value; }

  async loadFile(filePath) {
    this.loadedFile = filePath;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.webContents.emit('destroyed');
    this.emit('closed');
  }
}

function makeSurface(options = {}) {
  const windows = [];
  const stops = [];
  function BrowserWindow(settings) {
    const win = new FakeBrowserWindow(settings);
    windows.push(win);
    return win;
  }
  const surface = createFaceVerifierSurface({
    BrowserWindow,
    session: options.session === undefined ? { partition: 'face-verifier' } : options.session,
    rootDir: ROOT,
    logger: QUIET_LOGGER,
    onUnexpectedStop: reason => stops.push(reason),
    ...options,
  });
  return { surface, windows, stops };
}

function challenge(overrides = {}) {
  return {
    purpose: 'unlock',
    nonce: 'a'.repeat(64),
    deadline: Date.now() + 5000,
    modelBaseUrl: 'http://127.0.0.1:43210/models/',
    ...overrides,
  };
}

test('face verifier: hidden window is sandboxed with its own preload and session', async t => {
  const h = makeSurface();
  t.after(() => h.surface.stop('test-done'));
  assert.equal(h.surface.isAvailable(), true);

  const result = await h.surface.start(challenge());
  assert.equal(result.ok, true);
  assert.equal(h.windows.length, 1);

  const win = h.windows[0];
  assert.equal(win.options.show, false);
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.loadedFile, path.join(VERIFIER_ROOT, 'face-verifier.html'));

  const prefs = win.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.backgroundThrottling, false);
  assert.equal(prefs.preload, path.join(VERIFIER_ROOT, 'face-verifier-preload.js'));
  assert.equal(prefs.preload, h.surface.getPreloadPath());
  assert.deepEqual(prefs.session, { partition: 'face-verifier' });

  const startMessage = win.webContents.sent.find(message => message.channel === 'face-verifier-start');
  assert.ok(startMessage);
  assert.equal(startMessage.payload.nonce, 'a'.repeat(64));
  assert.equal(startMessage.payload.purpose, 'unlock');
  assert.equal(startMessage.payload.modelBaseUrl, 'http://127.0.0.1:43210/models/');
  assert.equal(typeof startMessage.payload.deadline, 'number');
});

test('face verifier: start validates purpose, nonce, and availability', async t => {
  const h = makeSurface();
  t.after(() => h.surface.stop('test-done'));

  assert.equal((await h.surface.start(challenge({ purpose: 'other' }))).ok, false);
  assert.equal((await h.surface.start(challenge({ nonce: 'short' }))).ok, false);

  const unavailable = makeSurface({ session: null });
  const blocked = await unavailable.surface.start(challenge());
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /unavailable/);
  assert.equal(unavailable.windows.length, 0);
});

test('face verifier: navigation, popups, and webview attachment are blocked', async t => {
  const h = makeSurface();
  t.after(() => h.surface.stop('test-done'));
  await h.surface.start(challenge());
  const win = h.windows[0];

  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'https://evil.example' }), { action: 'deny' });

  const navigate = win.webContents.listeners('will-navigate')[0];
  let prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'https://evil.example/');
  assert.equal(prevented, true);
  assert.equal(win.webContents.stopped, true);
  assert.equal(win.destroyed, true);
  assert.deepEqual(h.stops, ['navigation-blocked']);

  const h2 = makeSurface();
  t.after(() => h2.surface.stop('test-done'));
  await h2.surface.start(challenge());
  const attach = h2.windows[0].webContents.listeners('will-attach-webview')[0];
  let attachPrevented = false;
  attach({ preventDefault: () => { attachPrevented = true; } });
  assert.equal(attachPrevented, true);
  assert.deepEqual(h2.stops, ['webview-attach']);
});

test('face verifier: explicit stop does not report an unexpected stop', async t => {
  const h = makeSurface();
  t.after(() => h.surface.stop('test-done'));
  await h.surface.start(challenge());
  const win = h.windows[0];
  h.surface.stop('user-cancelled');
  assert.equal(win.destroyed, true);
  assert.deepEqual(h.stops, []);
  assert.equal(h.surface.getWebContents(), null);
  assert.ok(win.webContents.sent.some(message => (
    message.channel === 'face-verifier-stop' && message.payload.reason === 'user-cancelled'
  )));
});

test('face verifier: a new attempt replaces the old window without a false failure', async t => {
  const h = makeSurface();
  t.after(() => h.surface.stop('test-done'));
  await h.surface.start(challenge());
  const first = h.windows[0];
  await h.surface.start(challenge({ purpose: 'enroll' }));
  assert.equal(first.destroyed, true);
  assert.deepEqual(h.stops, []);
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[1].webContents.sent[0].payload.purpose, 'enroll');
});

test('face verifier: the main-owned deadline stops the surface and reports expiry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { now: 1_000_000 };
  const h = makeSurface({ maxLifetimeMs: 25, expiryGraceMs: 0, now: () => clock.now });
  t.after(() => h.surface.stop('test-done'));
  const result = await h.surface.start(challenge({ deadline: clock.now + 20 }));
  assert.equal(result.ok, true);
  t.mock.timers.tick(1100);
  assert.deepEqual(h.stops, ['expired']);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.surface.getWebContents(), null);
});

test('face verifier: assets and local file paths stay inside the trusted verifier surface', () => {
  const surface = makeSurface().surface;
  assert.equal(surface.getPagePath(), path.join(VERIFIER_ROOT, 'face-verifier.html'));
  assert.equal(surface.getPreloadPath(), path.join(VERIFIER_ROOT, 'face-verifier-preload.js'));
  assert.match(surface.getApprovedUrl(), /^file:\/\/\/.*\/renderer\/verifier\/face-verifier\.html$/);
  assert.equal(fs.existsSync(surface.getPagePath()), true);
  assert.equal(fs.existsSync(surface.getPreloadPath()), true);
});

test('face verifier page: capture is local and never persisted or sent as frames', () => {
  const js = fs.readFileSync(path.join(VERIFIER_ROOT, 'face-verifier.js'), 'utf8');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '');
  const html = fs.readFileSync(path.join(VERIFIER_ROOT, 'face-verifier.html'), 'utf8');
  const preload = fs.readFileSync(path.join(VERIFIER_ROOT, 'face-verifier-preload.js'), 'utf8');

  for (const pattern of [
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\btoDataURL\b/,
    /\bMediaRecorder\b/,
    /\bcanvas\.toBlob\b/,
    /\bwriteFile\b/,
    /\bipcRenderer\b/,
  ]) {
    assert.doesNotMatch(code, pattern, String(pattern));
  }
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);
  assert.doesNotMatch(preload, /['"]jarvis['"]/);
  assert.match(code, /getUserMedia\(\{\s*audio:\s*false/);
  assert.match(code, /state\.stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(code, /window\.faceVerifier\?\.reportResult\?\.\(payload\)/);
});
