'use strict';

// Face verifier smoke test.
//
//   electron tests/electron-face-verifier-smoke.js
//
// Uses Chromium's fake camera device to exercise the real hidden verifier
// surface: sandboxed preload, camera permission restricted to the verifier,
// main-renderer camera denial, bundled-model loading over loopback, and the
// nonce-bound progress/result channels.

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFaceVerifierSurface, FACE_VERIFIER_PARTITION } = require('../backend/face/face-verifier');
const { FaceModelServer } = require('../backend/face/face-model-server');
const { normalizeMediaTypes, decideMediaPermission } = require('../backend/voice/media-permission');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-face-verifier-smoke-'));
app.setPath('userData', userDataDir);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(predicate, timeoutMs = 30000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function cameraProbe(webContents) {
  return webContents.executeJavaScript(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      const tracks = stream.getVideoTracks();
      const settings = tracks[0]?.getSettings?.() || {};
      tracks.forEach(track => track.stop());
      return { ok: true, width: settings.width || 0, height: settings.height || 0 };
    } catch (error) {
      return { ok: false, name: error?.name || 'Error', message: String(error?.message || error).slice(0, 180) };
    }
  })()`);
}

let mainWindow = null;
let surface = null;
let modelServer = null;
let exitCode = 1;
let verifierCameraArmed = false;
let unexpectedStop = null;
let lastResult = null;
const progress = [];

async function run() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const cameraPolicy = (webContents, permission, details = {}) => decideMediaPermission({
    permission,
    isMainRenderer: !!mainWindow && webContents === mainWindow.webContents,
    isVerifier: !!surface && surface.isSender(webContents),
    mediaTypes: normalizeMediaTypes(details),
    cameraArmed: verifierCameraArmed,
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    callback(cameraPolicy(webContents, permission, details));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details = {}) => (
    cameraPolicy(webContents, permission, details)
  ));

  modelServer = new FaceModelServer({
    modelsDir: path.join(__dirname, '..', 'renderer', 'vendor', 'human', 'models'),
    logger: { log() {}, warn() {}, error() {} },
  });
  await modelServer.start();
  check('bundled face models are available over loopback', Boolean(modelServer.getBaseUrl()));

  const fixturePath = path.join(userDataDir, 'camera-probe.html');
  fs.writeFileSync(fixturePath, '<!doctype html><meta charset="utf-8"><title>camera probe</title>');
  await mainWindow.loadURL(pathToFileURL(fixturePath).href);

  verifierCameraArmed = true;
  const mainCamera = await cameraProbe(mainWindow.webContents);
  check('the main renderer is denied camera access even while the verifier lease is armed', mainCamera.ok === false, JSON.stringify(mainCamera));

  const verifierSession = session.fromPartition(FACE_VERIFIER_PARTITION);
  surface = createFaceVerifierSurface({
    BrowserWindow,
    session: verifierSession,
    rootDir: path.join(__dirname, '..'),
    logger: { log() {}, warn() {}, error() {} },
    onUnexpectedStop: reason => { unexpectedStop = reason; },
  });
  check('the trusted verifier surface is available', surface.isAvailable() === true);

  verifierSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const allowed = decideMediaPermission({
      permission,
      isVerifier: surface.isSender(webContents),
      mediaTypes: normalizeMediaTypes(details),
      cameraArmed: verifierCameraArmed,
    });
    callback(allowed);
  });
  verifierSession.setPermissionCheckHandler((webContents, permission, _origin, details = {}) => (
    decideMediaPermission({
      permission,
      isVerifier: surface.isSender(webContents),
      mediaTypes: normalizeMediaTypes(details),
      cameraArmed: verifierCameraArmed,
    })
  ));

  ipcMain.on('face-verifier-progress', (_event, payload = {}) => {
    if (payload && typeof payload.message === 'string') progress.push(payload);
  });
  ipcMain.handle('face-verifier-result', async (_event, payload = {}) => {
    lastResult = payload;
    return { ok: true };
  });

  const first = await surface.start({
    purpose: 'unlock',
    nonce: randomBytes(32).toString('hex'),
    deadline: Date.now() + 45000,
    modelBaseUrl: modelServer.getBaseUrl(),
  });
  check('the verifier window starts with a main-owned challenge', first.ok === true, JSON.stringify(first));

  const webContents = surface.getWebContents();
  check('the verifier webContents exists', Boolean(webContents));

  const bridge = await webContents.executeJavaScript(`(() => ({
    bridge: typeof window.faceVerifier,
    methods: Object.keys(window.faceVerifier || {}).sort(),
    jarvis: typeof window.jarvis,
    requireType: typeof require,
    processType: typeof process,
    humanType: typeof window.Human?.Human,
    video: Boolean(document.getElementById('verifier-video')),
  }))()`);
  check('the verifier has its own minimal preload bridge', bridge.bridge === 'object', JSON.stringify(bridge));
  check('the verifier bridge exposes only the four verifier methods', JSON.stringify(bridge.methods) === JSON.stringify([
    'onStart', 'onStop', 'reportProgress', 'reportResult',
  ]), JSON.stringify(bridge.methods));
  check('the verifier cannot reach the JARVIS bridge', bridge.jarvis === 'undefined');
  check('the verifier is sandboxed without Node globals', bridge.requireType === 'undefined' && bridge.processType === 'undefined');
  check('the verifier page loads the bundled Human library', bridge.humanType === 'function');
  check('the verifier owns the camera video element', bridge.video === true);

  const cameraReady = await waitFor(
    () => progress.some(item => /REQUESTING LOCAL CAMERA|LOADING LOCAL FACE ENGINE|POSITION YOUR FACE|SHOW ONE FACE/.test(item.message)),
    20000,
    'verifier camera/model progress'
  );
  check('the verifier receives camera progress through its preload', cameraReady === true);
  check('the verifier does not report a startup failure', !lastResult || !lastResult.error, JSON.stringify(lastResult));

  const modelReady = await waitFor(
    () => progress.some(item => /POSITION YOUR FACE|SHOW ONE FACE/.test(item.message)),
    45000,
    'verifier model load'
  );
  check('the verifier loads bundled models from the loopback server', modelReady === true, JSON.stringify(progress.slice(-4)));
  check('the verifier did not report a model or camera failure', !lastResult || !lastResult.error, JSON.stringify(lastResult));
  check('no unexpected verifier stop occurred', !unexpectedStop, String(unexpectedStop));

  surface.stop('smoke-done');
  await wait(100);
  check('the verifier window closes on explicit stop', surface.getWebContents() === null);

  // A second attempt is started with the camera lease disarmed. The verifier
  // page must fail closed rather than retaining the prior permission/stream.
  verifierCameraArmed = false;
  lastResult = null;
  progress.length = 0;
  const second = await surface.start({
    purpose: 'unlock',
    nonce: randomBytes(32).toString('hex'),
    deadline: Date.now() + 10000,
    modelBaseUrl: modelServer.getBaseUrl(),
  });
  check('a second verifier attempt can start after disarm', second.ok === true, JSON.stringify(second));
  const denied = await waitFor(() => lastResult, 10000, 'disarmed verifier result');
  check('the verifier camera is denied when the lease is not armed', typeof denied.error === 'string' && /Camera unavailable/.test(denied.error), JSON.stringify(denied));

  surface.stop('smoke-done');
  console.log('PASS — isolated face verifier fake-camera smoke checks');
  exitCode = 0;
}

app.whenReady()
  .then(run)
  .catch(error => {
    console.error(`FAIL — ${error && error.stack || error}`);
    exitCode = 1;
  })
  .finally(async () => {
    try { surface?.stop?.('cleanup'); } catch (_) {}
    try { modelServer?.stop?.(); } catch (_) {}
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch (_) {}
    await wait(100);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    app.exit(exitCode);
  });
