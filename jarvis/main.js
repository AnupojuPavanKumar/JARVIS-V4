// ═══════════════════════════════════════════════════════════════
// JARVIS — Main Process (Electron)
// Handles: window management, system tray, global shortcuts,
//          IPC for file system, terminal, history
// ═══════════════════════════════════════════════════════════════

const {
  app, BrowserWindow, ipcMain, globalShortcut, session, safeStorage,
  Tray, Menu, nativeImage, shell, dialog, Notification, powerMonitor, clipboard
} = require('electron');

const _path = require('path');
const _url = require('url');

// IPC sender validation is installed later (lines ~95) after mainWindow is known.

// Pin the Windows AppUserModelId before any notification or login-item call.
// Electron's getLoginItemSettings() compares the Run registry value against
// this id; a custom `name` passed to setLoginItemSettings() is invisible to
// that readback and made the background-presence toggle snap back off.
if (process.platform === 'win32') {
  app.setAppUserModelId('JARVIS');
}

// LOW-02 fix: --expose_gc removed (was leaking V8 internals to renderer context)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048');
// Fix "GPU Cache Creation failed" — point disk cache to a writable user-data dir
app.commandLine.appendSwitch('disk-cache-dir', require('path').join(require('os').homedir(), '.jarvis-cache'));
// Force high performance dedicated GPU instead of integrated graphics
app.commandLine.appendSwitch('force_high_performance_gpu');
// Fix GPU shader cache crashes on some Windows NVIDIA drivers
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync } = require('child_process');
const os = require('os');
const http = require('http');
const https = require('https');
const JarvisMemory = require('./memory');
const { MemoryStore } = require('./core/memory/memory-store');
const { Scheduler } = require('./core/scheduler/scheduler');
const { ElectronBrowserDriver } = require('./backend/browser/electron-browser-driver');
const { parseAllowedOrigins } = require('./core/browser/browser-policy');
const { IntegrationStore } = require('./core/integrations/integration-store');
const { FixtureProvider } = require('./core/integrations/fixture-provider');
const { IntegrationService } = require('./core/integrations/integration-service');
const { createSafeStorageVault } = require('./backend/integrations/safe-storage-vault');
const { DocumentIndex } = require('./core/documents/document-index');
const { AmbientService } = require('./backend/ambient/ambient-service');
const { FaceProfileStore } = require('./backend/face/face-profile-store');
const { FaceModelServer } = require('./backend/face/face-model-server');
const { createFaceVerifierSurface, FACE_VERIFIER_PARTITION } = require('./backend/face/face-verifier');
const { createVoicePolicy } = require('./backend/voice/voice-policy');
const { normalizeMediaTypes, decideMediaPermission } = require('./backend/voice/media-permission');
const { getAuthStatus } = require('./backend/auth/auth-store');
const { createSessionState } = require('./backend/security/session-state');
const { createCapabilityStore } = require('./backend/security/capability-store');
const { createAuditLogStore } = require('./backend/security/audit-log-store');
const { createAuditRedactor } = require('./backend/security/audit-redaction');
const { createIpcGuard } = require('./backend/security/ipc-guard');
const { createProjectRegistry } = require('./backend/security/project-registry');
const { attachRendererSessionGuards } = require('./backend/security/renderer-guards');

// Keep the existing development data directory when running the packaged
// JARVIS.exe. Electron would otherwise switch from `jarvis-ai-os` to a
// product-name folder and strand the user's PIN, face profile, memory, and
// scheduler data. Tests and explicit --user-data-dir launches keep their own
// isolated paths.
if (process.env.JARVIS_TEST_MODE !== '1' && !app.commandLine.hasSwitch('user-data-dir')) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'jarvis-ai-os'));
  } catch (error) {
    console.error('[MAIN] Could not pin the JARVIS user data directory:', error.message);
  }
}

// ─── State ───────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
app.isQuitting = false;
const notifiedApprovals = new Set();
const notifiedOutcomes = new Set();
let memoryStore = null;
let scheduler = null;
let browserDriver = null;
let integrationService = null;
let documentIndex = null;
let ambientService = null;
let faceProfileStore = null;
let faceModelServer = null;
let faceVerifier = null;
let faceController = null;
let faceCameraArmedUntil = 0;
let voicePolicy = null;
const faceEnrollmentState = { active: false, until: 0 };
let sessionState = null;
const DEFAULT_TRAY_TOOLTIP = 'JARVIS — AI Operating System  [Ctrl+Space]';

// A second launch (for example, from the Start menu while JARVIS is already
// resident in the tray) must focus the existing instance instead of creating a
// duplicate scheduler, browser, or task runtime. Tests use isolated user-data
// directories and skip the lock so their multiple Electron processes can run.
const singleInstanceLock = process.env.JARVIS_TEST_MODE === '1'
  ? true
  : app.requestSingleInstanceLock();
if (singleInstanceLock) {
  app.on('second-instance', () => {
    if (app.isReady()) focusExistingInstance();
    else app.whenReady().then(focusExistingInstance).catch(() => {});
  });
} else {
  app.quit();
}

// ─── Security Rate Limiting ──────────────────────────────────────────
const rateLimits = {};
function secCheckRate(action, limitPerMin) {
  const now = Date.now();
  if (!rateLimits[action]) rateLimits[action] = [];
  rateLimits[action] = rateLimits[action].filter(t => now - t < 60000);
  if (rateLimits[action].length >= limitPerMin) return false;
  rateLimits[action].push(now);
  return true;
}

// ─── Security Audit Log ─────────────────────────────────────────────
// The 1,000-entry ring backs the fast last-20 UI. Every sanitized record is
// also queued for the encrypted durable store under userData/security-audit.
const _secAuditLog = [];
const AUDIT_FAIL_CLOSED_CAPABILITIES = Object.freeze([
  'terminal',
  'screen-capture',
  'export-save',
]);

const auditUserDataPath = (() => {
  try { return app.getPath('userData'); } catch (_) {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'jarvis-ai-os');
  }
})();

const auditRedactor = createAuditRedactor({
  homeDir: os.homedir(),
  userDataPath: auditUserDataPath,
});

const auditLogStore = createAuditLogStore({
  userDataPath: auditUserDataPath,
  safeStorage,
  logger: console,
  onFailure: (error, status) => handleAuditFailure(error, status),
});

// Declared before the audit store can initialize so a startup failure can
// safely revoke the scoped capabilities without a temporal-dead-zone error.
let capabilityStore = null;

function handleAuditFailure(error, status = null) {
  const reason = error && error.message
    ? error.message
    : (status && status.reason) || 'durable audit unavailable';
  for (const capabilityId of AUDIT_FAIL_CLOSED_CAPABILITIES) {
    try { capabilityStore?.revoke(capabilityId, 'audit log unavailable'); } catch (_) {}
  }
  try {
    secAudit(
      'AUDIT_FAIL_CLOSED',
      `${reason}; terminal, screen-capture, and export-save disabled`,
      'FAIL_CLOSED'
    );
  } catch (_) {}
}

function secAudit(action, detail, verdict) {
  const sanitized = auditRedactor.sanitizeAuditEntry(action, detail, verdict);
  const entry = { ts: new Date().toISOString(), ...sanitized };
  _secAuditLog.push(entry);
  if (_secAuditLog.length > 1000) _secAuditLog.shift(); // ring-buffer cap
  console.log(`[SEC] ${entry.verdict} | ${entry.action} | ${entry.detail}`);
  try { auditLogStore.append(entry); } catch (_) {}
}

// Grants live only in main memory. They are never loaded from renderer data or
// the legacy security settings file.
capabilityStore = createCapabilityStore({ audit: secAudit });

// Project roots and tokens live only in main. A renderer reload, hide, or lock
// revokes every token so a stale page cannot keep reading a project.
const projectRegistry = createProjectRegistry({ audit: secAudit });
function revokeProjectAccess(reason) {
  try { projectRegistry.closeAll(reason); } catch (_) {}
}

// ─── Main-owned session state and default-deny IPC ────────────────────────
// The exact approved entry document, not a path prefix. Subframes, destroyed
// frames, unknown channels, and every channel without a policy entry are denied.
const _approvedRendererUrl = _url.pathToFileURL(_path.join(__dirname, 'renderer', 'index.html')).href;
const _approvedVerifierUrl = _url.pathToFileURL(_path.join(__dirname, 'renderer', 'verifier', 'face-verifier.html')).href;

sessionState = createSessionState({
  initial: 'booting',
  audit: secAudit,
});

const ipcGuard = createIpcGuard({
  ipcMain,
  getMainWindow: () => mainWindow,
  approvedRendererUrl: _approvedRendererUrl,
  getVerifierWebContents: () => (faceVerifier ? faceVerifier.getWebContents() : null),
  approvedVerifierUrl: _approvedVerifierUrl,
  sessionState,
  audit: secAudit,
  strictPolicy: !app.isPackaged,
});
ipcGuard.install();

// ─── Session Lock / Media Permission Boundary ────────────────────
// The face camera is armed only for a short, explicit unlock or enrollment
// attempt. The microphone is armed only after the user explicitly enables the
// local wake word or push-to-talk. Every other renderer permission request is
// denied. These are convenience/privacy gates, not OS-level security boundaries.
function armFaceCamera(durationMs = 15000) {
  const bounded = Math.min(Math.max(Number(durationMs) || 15000, 1000), 30000);
  faceCameraArmedUntil = Date.now() + bounded;
}

function disarmFaceCamera() {
  faceCameraArmedUntil = 0;
}

function faceCameraIsArmed() {
  return Date.now() < faceCameraArmedUntil;
}

function installMediaPermissionHandlers() {
  const ses = session.defaultSession;
  if (!ses) return;
  ses.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const isMainRenderer = !!mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents;
    const mediaTypes = normalizeMediaTypes(details);
    const allowed = decideMediaPermission({
      permission,
      isMainRenderer,
      mediaTypes,
      microphoneArmed: !!voicePolicy && voicePolicy.isCaptureActive({ webContentsId: webContents.id }),
    });
    if (!allowed) {
      secAudit('PERMISSION_BLOCK', permission || 'unknown', 'BLOCKED');
    }
    callback(allowed);
  });
  ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => {
    const isMainRenderer = !!mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents;
    return decideMediaPermission({
      permission,
      isMainRenderer,
      mediaTypes: normalizeMediaTypes(details),
      microphoneArmed: !!voicePolicy && voicePolicy.isCaptureActive({ webContentsId: webContents.id }),
    });
  });
}

// The verifier has its own ephemeral session. Only the exact hidden verifier
// webContents may receive camera permission, and only while the main-owned
// camera lease is active. The main renderer never reaches this handler.
function installVerifierMediaPermissionHandlers() {
  if (!faceVerifier) return false;
  const ses = faceVerifier.getSession();
  if (!ses || typeof ses.setPermissionRequestHandler !== 'function') return false;
  const decide = (webContents, permission, details = {}) => {
    const isVerifier = faceVerifier.isSender(webContents);
    const allowed = decideMediaPermission({
      permission,
      isMainRenderer: false,
      isVerifier,
      mediaTypes: normalizeMediaTypes(details),
      cameraArmed: faceCameraIsArmed(),
    });
    if (!allowed) {
      secAudit('PERMISSION_BLOCK', `verifier:${permission || 'unknown'}`, 'BLOCKED');
    }
    return allowed;
  };
  ses.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    callback(decide(webContents, permission, details));
  });
  ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => (
    decide(webContents, permission, details)
  ));
  return true;
}

function initializeFaceVerifier() {
  try {
    faceVerifier = createFaceVerifierSurface({
      BrowserWindow,
      session: session.fromPartition(FACE_VERIFIER_PARTITION),
      rootDir: __dirname,
      logger: console,
      onUnexpectedStop: reason => {
        try { faceController?.handleVerifierStopped?.(reason); } catch (error) {
          secAudit('FACE_VERIFIER_STOP', error.message, 'ERROR');
        }
      },
    });
    if (!installVerifierMediaPermissionHandlers()) {
      faceVerifier = null;
      secAudit('FACE_VERIFIER_INIT', 'permission handler unavailable', 'ERROR');
    }
  } catch (error) {
    faceVerifier = null;
    secAudit('FACE_VERIFIER_INIT', error.message, 'ERROR');
  }
}

function sendRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch (_) { /* window may be closing */ }
}

// Main-owned microphone revocation. The renderer is told to tear down its
// stream or re-arm only when the main policy still permits wake-word capture.
function revokeVoiceAccess(reason) {
  try { voicePolicy?.revokeAll(reason); } catch (_) { /* best effort */ }
  sendRenderer('voice-capture-revoked', { reason });
}

function sendAuthState() {
  if (!sessionState) return;
  sendRenderer('auth-state', sessionState.snapshot());
}

function broadcastAppVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const visible = mainWindow.isVisible();
  sendRenderer('app-visibility', {
    visible,
    focused: mainWindow.isFocused(),
    session: sessionState ? sessionState.snapshot() : null,
  });
  sendAuthState();
  if (visible && sessionState && sessionState.locked) {
    sendRenderer('auth-lock');
  }
}

function lockSessionForHide() {
  capabilityStore.revokeAll('window hidden');
  revokeProjectAccess('window hidden');
  revokeVoiceAccess('window-hidden');
  if (!sessionState || !sessionState.locked) {
    if (sessionState && sessionState.state === 'unlocked') {
      sessionState.lock('window hidden');
    }
  }
  if (!sessionState || sessionState.state === 'no-lock') return;
  faceEnrollmentState.active = false;
  faceEnrollmentState.until = 0;
  disarmFaceCamera();
  try { faceController?.cancelVerifier?.('window-hidden'); } catch (_) { /* best effort */ }
  sendRenderer('auth-lock');
  sendAuthState();
}

if (sessionState) {
  sessionState.subscribe((view, previous) => {
    if (view.locked && previous !== view.state) {
      capabilityStore.revokeAll('session locked');
      faceEnrollmentState.active = false;
      faceEnrollmentState.until = 0;
      disarmFaceCamera();
      revokeProjectAccess('session locked');
      try { faceController?.cancelVerifier?.('session-locked'); } catch (_) { /* best effort */ }
      revokeVoiceAccess('session-locked');
      sendRenderer('auth-lock');
    }
    sendRenderer('auth-state', view);
  });
}

// ─── Window Factory ──────────────────────────────────────────────
function createWindow({ startHidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    frame: false,
    backgroundColor: '#020b14',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The trusted renderer must not be able to attach guest web content.
      // renderer-guards also denies will-attach-webview as a second barrier.
      webviewTag: false,
      // CRIT-01 fix: webSecurity restored. Ollama API is called via IPC not
      // directly from the renderer, so this will not break core functionality.
      webSecurity: true,
      // Keep the local VAD timer responsive while JARVIS is visible but not
      // focused. Main-owned microphone policy still denies capture while the
      // window is hidden, so the renderer tears the stream down on hide.
      backgroundThrottling: false,
    },
    show: false,
  });

  // Renderer-boundary guards are independent of page JS: a reload, crash,
  // destroyed frame, or navigation to an unapproved URL locks the session.
  attachRendererSessionGuards(mainWindow.webContents, {
    sessionState,
    approvedRendererUrl: _approvedRendererUrl,
    audit: secAudit,
    isQuitting: () => app.isQuitting,
    onBoundary: reason => {
      capabilityStore.revokeAll(`renderer boundary: ${reason}`);
      revokeProjectAccess(`renderer boundary: ${reason}`);
    },
    onLock: reason => {
      faceEnrollmentState.active = false;
      faceEnrollmentState.until = 0;
      disarmFaceCamera();
      try { faceController?.cancelVerifier?.('renderer-boundary'); } catch (_) { /* best effort */ }
      revokeVoiceAccess('renderer-boundary');
      secAudit('SESSION_BOUNDARY_LOCK', reason, 'LOCK');
    },
  }).install();

  // Allow CDN + localhost/127.0.0.1 for Ollama
  // unsafe-eval was removed: every privileged expression evaluator has
  // been replaced with a sandboxed parser. inline event handlers remain
  // (see index.html) — eliminating them requires a refactor.
  // CSP: unsafe-eval removed — both calculator paths now use a safe
  // recursive-descent parser (no new Function / eval anywhere).
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "connect-src 'self' https: http://127.0.0.1:*; " +
          "font-src 'self' https://fonts.gstatic.com data:; " +
          "img-src 'self' data: https:; " +
          "media-src 'self' data: blob:; " +
          "worker-src 'self' blob:; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "script-src 'self';"
        ]
      }
    });
  });

  // Load renderer raw source
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER] ${message}`);
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    broadcastAppVisibility();
    sendAuthState();
  });

  mainWindow.once('ready-to-show', () => {
    if (startHidden) {
      console.log('[MAIN] JARVIS started hidden in the tray.');
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Hide to tray instead of quitting. Reopening from the tray requires the
  // configured PIN/face lock, even if the scheduler kept running in the
  // background while the window was hidden.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('show', () => {
    broadcastAppVisibility();
  });

  mainWindow.on('hide', () => {
    if (!app.isQuitting) lockSessionForHide();
    broadcastAppVisibility();
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', 'normal'));
  mainWindow.on('focus', () => {
    try { mainWindow.flashFrame(false); } catch (_) {}
    try { if (tray) tray.setToolTip(DEFAULT_TRAY_TOOLTIP); } catch (_) {}
  });
}

// ─── System Tray ─────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '⬡  Show JARVIS',
      click: () => { mainWindow?.show(); mainWindow?.focus(); }
    },
    {
      label: '    Hide JARVIS',
      click: () => mainWindow?.hide()
    },
    { type: 'separator' },
    {
      label: '✕  Quit',
      click: () => { app.isQuitting = true; app.quit(); }
    }
  ]);

  tray.setToolTip(DEFAULT_TRAY_TOOLTIP);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow?.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.flashFrame(false);
  if (tray) tray.setToolTip(DEFAULT_TRAY_TOOLTIP);
}

// The second-instance event can arrive while startup is still awaiting memory
// or controller registration. Retry briefly rather than dropping the user's
// request to open the existing JARVIS window.
function focusExistingInstance(attempt = 0) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }
  if (attempt < 40) {
    setTimeout(() => focusExistingInstance(attempt + 1), 250);
  }
}

// A scheduler/task approval can arrive while JARVIS is hidden in the tray.
// The renderer already posts an in-app message and toast; when the window is
// not focused, also surface a native Windows notification and flash the
// taskbar so the pending decision is not silently missed.
function notifyApproval(taskId, approval) {
  if (!approval || !approval.id || notifiedApprovals.has(approval.id)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const focused = mainWindow.isVisible() && mainWindow.isFocused();
  if (focused) return;

  notifiedApprovals.add(approval.id);
  const tool = String(approval.toolCall?.tool || 'a tool').slice(0, 80);
  const reason = approval.reason ? ` (${String(approval.reason).slice(0, 120)})` : '';
  const title = 'JARVIS — Approval required';
  const body = `A background task needs permission to run ${tool}${reason}. Open JARVIS to approve or deny.`;

  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title,
        body,
        icon: path.join(__dirname, 'assets', 'icon.png'),
      });
      notification.on('click', () => {
        focusMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent-task-event', {
            taskId,
            type: 'approval.focus',
            at: new Date().toISOString(),
            data: { approvalId: approval.id },
          });
        }
      });
      notification.on('failed', (_event, error) => {
        console.warn('[AGENT] Native approval notification failed:', error || 'unknown error');
      });
      notification.show();
      console.log(`[AGENT] Native approval notification shown for ${tool}.`);
    }
  } catch (error) {
    console.warn('[AGENT] Could not show native approval notification:', error.message);
  }

  try {
    if (tray) tray.setToolTip(`JARVIS — approval required: ${tool}`);
    mainWindow.flashFrame(true);
  } catch (_) {}
}

function showNativeNotification(title, body, onClick = null) {
  if (!Notification.isSupported()) return false;
  try {
    const notification = new Notification({
      title,
      body,
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    if (typeof onClick === 'function') notification.on('click', onClick);
    notification.on('failed', (_event, error) => {
      console.warn('[JARVIS] Native notification failed:', error || 'unknown error');
    });
    notification.show();
    return true;
  } catch (error) {
    console.warn('[JARVIS] Could not show native notification:', error.message);
    return false;
  }
}

function windowIsFocused() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused());
}

function notifyTaskOutcome(task) {
  if (!task || !task.id || !['completed', 'failed'].includes(task.status)) return;
  if (windowIsFocused()) return;
  const key = `${task.id}:${task.status}`;
  if (notifiedOutcomes.has(key)) return;
  notifiedOutcomes.add(key);

  const goal = String(task.goal || 'Background task').slice(0, 100);
  const detail = task.status === 'completed'
    ? String(task.result || 'Task completed.').replace(/\s+/g, ' ').slice(0, 180)
    : String(task.error || 'Task failed.').replace(/\s+/g, ' ').slice(0, 180);
  const title = task.status === 'completed' ? 'JARVIS — Task completed' : 'JARVIS — Task failed';
  const body = `${goal}\n${detail}`;
  showNativeNotification(title, body, focusMainWindow);
  try {
    if (tray) tray.setToolTip(task.status === 'completed'
      ? `JARVIS — completed: ${goal}`
      : `JARVIS — failed: ${goal}`);
  } catch (_) {}
}

function handleSchedulerEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (!['run.failed', 'run.retry', 'run.deferred'].includes(event.type)) return;
  const job = event.job || {};
  const run = event.run || {};
  if (event.type === 'run.deferred') {
    try {
      if (tray) tray.setToolTip(`JARVIS — scheduled task deferred: ${job.name || job.id}`);
    } catch (_) {}
    return;
  }

  const key = `${run.id || job.id}:${event.type}`;
  if (notifiedOutcomes.has(key)) return;
  notifiedOutcomes.add(key);
  if (windowIsFocused()) return;

  const title = event.type === 'run.retry'
    ? 'JARVIS — Scheduled task retry'
    : 'JARVIS — Scheduled task failed';
  const body = `${String(job.name || job.id || 'Scheduled task').slice(0, 100)}\n${String(event.error || 'The scheduled run failed.').slice(0, 180)}`;
  showNativeNotification(title, body, focusMainWindow);
  try { if (tray) tray.setToolTip(`${title.replace('JARVIS — ', '')}: ${job.name || job.id}`); } catch (_) {}
}

function handleAgentEvent(event) {
  if (!event || !event.taskId) return;
  const data = event.data || {};
  const pending = Array.isArray(data.task?.approvals)
    ? data.task.approvals.find(candidate => candidate && candidate.status === 'pending')
    : null;
  const approval = data.approval || pending;
  if (approval) notifyApproval(event.taskId, approval);
  if (data.task) notifyTaskOutcome(data.task);
}

// The renderer discovers persisted pending approvals when it attaches tasks
// after a restart. Those were never emitted by AgentRuntime, so this bridge
// lets it request the same native alert; notifyApproval() deduplicates by
// approval id against the live event path. Registered before the window is
// created so a fast-starting renderer cannot miss the handler.
ipcMain.on('agent-approval-notify', (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object') return;
  const taskId = typeof payload.taskId === 'string' ? payload.taskId.slice(0, 200) : '';
  const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId.slice(0, 160) : '';
  if (!/^task_[A-Za-z0-9_]+$/.test(taskId) || !approvalId) return;
  const tool = typeof payload.tool === 'string' && payload.tool.trim()
    ? payload.tool.trim().slice(0, 80)
    : 'a tool';
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 160) : '';
  notifyApproval(taskId, { id: approvalId, toolCall: { tool }, reason });
});

// ─── App Lifecycle ───────────────────────────────────────────────


if (singleInstanceLock) {
app.whenReady().then(async () => {
  // Ensure history directory exists
  const histDir = path.join(app.getPath('userData'), 'history');
  fs.mkdirSync(histDir, { recursive: true });

  // Start the durable audit log before any controller can grant a sensitive
  // capability. If OS encryption is unavailable, the store stays memory-only
  // and SecurityController denies terminal, screen capture, and export-save.
  try {
    const auditStatus = await auditLogStore.init();
    if (auditStatus && auditStatus.durable) {
      secAudit(
        'AUDIT_STORE_READY',
        `${auditStatus.files} file(s), ${auditStatus.bytes} bytes`,
        'OK'
      );
    } else {
      secAudit(
        'AUDIT_STORE_UNAVAILABLE',
        (auditStatus && (auditStatus.reason || auditStatus.warning)) || 'unknown reason',
        'FAIL_CLOSED'
      );
    }
  } catch (error) {
    secAudit('AUDIT_STORE_INIT', error.message, 'FAIL_CLOSED');
  }

  // The local voice opt-in, capture grants, and transcription leases live in
  // main. The renderer can never supply a lock-screen flag or its own duration.
  try {
    voicePolicy = createVoicePolicy({
      baseDir: app.getPath('userData'),
      audit: secAudit,
      getSessionLocked: () => !!(sessionState && sessionState.locked),
      isWindowVisible: () => !!(
        mainWindow
        && !mainWindow.isDestroyed()
        && mainWindow.isVisible()
      ),
    });
  } catch (error) {
    voicePolicy = null;
    secAudit('VOICE_POLICY_INIT', error.message, 'ERROR');
  }

  // Background presence is initialized before the window so a login launch can
  // honor the "start hidden" preference. The scheduler is attached later, once
  // the durable runtime has been registered.
  try {
    ambientService = new AmbientService({
      app,
      powerMonitor,
      mainWindowProvider: () => mainWindow,
      configPath: path.join(app.getPath('userData'), 'ambient-config.json'),
      audit: secAudit,
      logger: console,
      platform: process.platform,
      argv: process.argv,
    });
    await ambientService.init();
  } catch (error) {
    ambientService = null;
    console.error('[MAIN] Could not initialize background presence:', error);
  }

  // Initialize conversation history and the one unified memory-record store.
  try {
    JarvisMemory.init(app.getPath('userData'));
    memoryStore = new MemoryStore({ baseDir: app.getPath('userData') });
    await memoryStore.init();
    console.log('[MAIN] JARVIS unified memory initialized successfully.');
  } catch (err) {
    console.error('[MAIN] FATAL ERROR initializing memory:', err);
  }

  // Face unlock is local-only. The model server serves bundled model weights
  // over an ephemeral loopback port; the profile store encrypts embeddings with
  // safeStorage and never writes raw camera frames.
  try {
    faceProfileStore = new FaceProfileStore({
      app,
      safeStorage,
      audit: secAudit,
      logger: console,
    });
  } catch (error) {
    faceProfileStore = null;
    secAudit('FACE_STORE_INIT', error.message, 'ERROR');
  }
  try {
    faceModelServer = new FaceModelServer({
      modelsDir: path.join(__dirname, 'renderer', 'vendor', 'human', 'models'),
      logger: console,
    });
    await faceModelServer.start();
  } catch (error) {
    faceModelServer = null;
    secAudit('FACE_MODEL_INIT', error.message, 'ERROR');
  }
  try {
    const auth = await getAuthStatus(app.getPath('userData'));
    const face = faceProfileStore ? await faceProfileStore.getStatus() : { enrolled: false };
    sessionState.initialize({
      auth,
      faceEnrolled: !!(face && face.enrolled),
    });
  } catch (error) {
    sessionState.initialize({ auth: null, readError: error.message });
    secAudit('SESSION_LOCK_INIT', error.message, 'ERROR');
  }
  installMediaPermissionHandlers();
  initializeFaceVerifier();

  // Register IPC controllers only after the unified store exists. Registering
  // at module load would capture a null store before app.whenReady().
  try {
    await registerControllersAndScheduler();
  } catch (err) {
    console.error('[MAIN] FATAL ERROR registering controllers:', err);
  }

  // Legacy sec-config.json is intentionally not loaded into live policy. The
  // SecurityController reports it as untrusted information and requires fresh
  // native consent before any terminal or screen capability is granted.

  let appConfig = { embeddingModel: 'all-minilm', textModel: 'llama3.1:8b' };
  try {
    const fp = path.join(app.getPath('userData'), 'app-config.json');
    if (fs.existsSync(fp)) {
      const cfg = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (cfg.embeddingModel) appConfig.embeddingModel = cfg.embeddingModel;
      if (cfg.textModel) appConfig.textModel = cfg.textModel;
    } else {
      fs.writeFileSync(fp, JSON.stringify(appConfig, null, 2));
    }
  } catch (e) { console.error('Error loading app config', e); }

  // Check Ollama Models & Notify Online Status
  let ollamaAnnounced = false;
  function probeOllama(attempt = 1) {
    const req = http.get('http://127.0.0.1:11434/api/tags', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (!ollamaAnnounced && mainWindow && !mainWindow.isDestroyed()) {
            ollamaAnnounced = true;
            mainWindow.webContents.send('ollama-online');
          }
          const json = JSON.parse(data);
          const installed = (json.models || []).map(m => m.name.split(':')[0]); // strip tags
          const missing = [];
          if (!installed.includes(appConfig.embeddingModel.split(':')[0])) missing.push(appConfig.embeddingModel);
          // Text model check handled dynamically by the frontend UI
          
          if (missing.length > 0) {
            console.error(`[OLLAMA] WARNING: Required models missing: ${missing.join(', ')}. Please run 'ollama pull <model>'.`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('show-toast', { title: 'Missing Models', message: `Please pull: ${missing.join(', ')}`, type: 'error' });
            }
          } else {
            console.log('[OLLAMA] All required models are installed.');
          }
        } catch (e) {}
      });
    });
    req.on('error', () => {
      if (attempt < 15) {
        setTimeout(() => probeOllama(attempt + 1), 2000);
      } else {
        console.log('[OLLAMA] Failed to connect to Ollama API for startup check.');
      }
    });
  }
  setTimeout(() => probeOllama(), 2000);

  const startHidden = ambientService ? ambientService.shouldStartHidden() : false;
  createWindow({ startHidden });
  createTray();

  // Global hotkey: Ctrl+Space to toggle JARVIS
  globalShortcut.register('Control+Space', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Global hotkey: Ctrl+Shift+Space for Push-to-Listen
  globalShortcut.register('Control+Shift+Space', () => {
    if (!mainWindow) return;
    // Show window if hidden so user can see it listening
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.webContents.send('toggle-voice');
  });
});
}

// Windows shutdown/logoff and app.quit() must be allowed to close the window
// instead of being intercepted by the close-to-tray behavior.
app.on('before-quit', () => {
  app.isQuitting = true;
  capabilityStore.revokeAll('app quit');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // before-quit emits capability revocations. Flush after those events so a
  // clean quit does not drop the final audit records.
  try { auditLogStore.flushSync(); } catch (_) {}
  try { auditLogStore.dispose(); } catch (_) {}
  try { voicePolicy?.revokeAll('app-quit'); } catch (_) {}
  try { faceController?.cancelVerifier?.('app-quit'); } catch (_) {}
  try { faceVerifier?.stop?.('app-quit'); } catch (_) {}
  try { ambientService?.dispose(); } catch (_) {}
  try { scheduler?.shutdown(); } catch (_) {}
  try { browserDriver?.close(); } catch (_) {}
  try { faceModelServer?.stop(); } catch (_) {}
});

// Keep alive in tray — never quit on all-windows-closed
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// ═══════════════════════════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════════════════════════


const registerAgentController = require('./backend/controllers/AgentController');
const registerAIController = require('./backend/controllers/AIController');
const registerAmbientController = require('./backend/controllers/AmbientController');
const registerBrowserController = require('./backend/controllers/BrowserController');
const registerIntegrationController = require('./backend/controllers/IntegrationController');
const registerDocumentController = require('./backend/controllers/DocumentController');
const registerFaceController = require('./backend/controllers/FaceController');
const registerFileController = require('./backend/controllers/FileController');
const registerKnowledgeController = require('./backend/controllers/KnowledgeController');
const registerMemoryController = require('./backend/controllers/MemoryController');
const registerSchedulerController = require('./backend/controllers/SchedulerController');
const registerSecurityController = require('./backend/controllers/SecurityController');
const registerSystemController = require('./backend/controllers/SystemController');
const registerWindowController = require('./backend/controllers/WindowController');
const registerClipboardController = require('./backend/controllers/ClipboardController');
const registerVoiceController = require('./backend/controllers/VoiceController');

async function registerControllersAndScheduler() {
  const mainWindowProvider = () => mainWindow;

  // The browser is a hidden, isolated Electron window. It is separate from the
  // JARVIS renderer and uses an ephemeral session partition, so clearing it
  // cannot affect the main app session or its local preferences.
  if (process.env.JARVIS_BROWSER_ENABLED !== '0') {
    browserDriver = new ElectronBrowserDriver({
      BrowserWindow,
      session,
      app,
      artifactsDir: path.join(app.getPath('userData'), 'browser-artifacts'),
      allowedOrigins: parseAllowedOrigins(process.env.JARVIS_BROWSER_ALLOWED_ORIGINS),
      audit: secAudit,
    });
  }

  // Personal integrations start with local fixtures. A real provider can replace
  // FixtureProvider without changing the tool schema, scope checks, or approvals.
  if (process.env.JARVIS_INTEGRATIONS_ENABLED !== '0') {
    try {
      const integrationBase = path.join(app.getPath('userData'), 'integrations');
      const integrationStore = new IntegrationStore({ baseDir: integrationBase });
      await integrationStore.init();
      let integrationVault = null;
      try {
        integrationVault = createSafeStorageVault({
          safeStorage,
          filePath: path.join(app.getPath('userData'), 'integration-secrets.json'),
        });
        await integrationVault.init();
      } catch (error) {
        secAudit('INTEGRATION_VAULT_UNAVAILABLE', error.message, 'WARN');
        integrationVault = null;
      }
      integrationService = new IntegrationService({
        store: integrationStore,
        provider: new FixtureProvider({ store: integrationStore }),
        vault: integrationVault,
        audit: secAudit,
      });
    } catch (error) {
      secAudit('INTEGRATION_INIT_ERROR', error.message, 'ERROR');
      integrationService = null;
    }
  }

  registerBrowserController({ ipcMain, browserDriver, secAudit });
  registerIntegrationController({ ipcMain, integrationService, secAudit });

  if (process.env.JARVIS_DOCUMENTS_ENABLED !== '0') {
    try {
      documentIndex = new DocumentIndex({
        baseDir: path.join(app.getPath('userData'), 'documents'),
      });
      await documentIndex.init();
    } catch (error) {
      secAudit('DOCUMENT_INIT_ERROR', error.message, 'ERROR');
      documentIndex = null;
    }
  }
  registerDocumentController({
    ipcMain,
    documentIndex,
    dialog,
    mainWindowProvider,
    secAudit,
  });

  const aiController = registerAIController({
    ipcMain,
    app,
    mainWindowProvider,
    secAudit,
    secCheckRate,
    voicePolicy,
  });
  if (voicePolicy) {
    registerVoiceController({
      ipcMain,
      voicePolicy,
      mainWindowProvider,
      secAudit,
      sendRenderer,
      transcriptionStatus: aiController && aiController.getWhisperStatus,
    });
  } else {
    secAudit('VOICE_CONTROLLER_INIT', 'voice policy unavailable', 'ERROR');
  }
  const agentControllerApi = registerAgentController({
    ipcMain, app, mainWindowProvider, secAudit, secCheckRate,
    onAgentEvent: handleAgentEvent,
    browserDriver,
    integrationService,
    documentIndex,
    memoryStore,
    memoryStoreProvider: () => memoryStore,
  });

  // The scheduler owns run records and drives durable tasks directly. It never
  // sends a renderer trigger: the browser window may be hidden, destroyed, or
  // not yet created while a scheduled task runs.
  scheduler = new Scheduler({
    baseDir: app.getPath('userData'),
    startTask: async job => {
      if (process.env.JARVIS_DURABLE_AGENT === '0') {
        return { ok: false, error: 'Durable agent is disabled (JARVIS_DURABLE_AGENT=0)' };
      }
      return agentControllerApi.startTaskFromJob(job);
    },
    getTask: taskId => {
      const store = agentControllerApi.getStore();
      return store ? store.getTask(taskId) : null;
    },
    onRunEvent: handleSchedulerEvent,
    autoStart: false,
  });

  registerFileController({
    ipcMain,
    app,
    mainWindowProvider,
    secAudit,
    projectRegistry,
  });
  registerKnowledgeController({ ipcMain, app, secAudit, secCheckRate });
  registerMemoryController({
    ipcMain,
    app,
    JarvisMemory,
    MemoryStore: memoryStore,
    MemoryStoreProvider: () => memoryStore,
  });
  registerSchedulerController({ ipcMain, Scheduler: scheduler });
  registerSecurityController({
    ipcMain,
    app,
    dialog,
    mainWindowProvider,
    secAudit,
    sessionState,
    faceStore: faceProfileStore,
    capabilityStore,
    auditStatus: () => auditLogStore.status(),
  });
  faceController = registerFaceController({
    ipcMain,
    app,
    faceStore: faceProfileStore,
    faceModelServer,
    sessionState,
    faceEnrollmentState,
    secAudit,
    mainWindowProvider,
    verifier: faceVerifier,
    armCamera: armFaceCamera,
    disarmCamera: disarmFaceCamera,
    isCameraArmed: faceCameraIsArmed,
    sendRenderer,
  });
  registerSystemController({
    ipcMain,
    app,
    mainWindowProvider,
    secAudit,
    secCheckRate,
    capabilityStore,
    sessionState,
    projectRegistry,
  });
  registerWindowController({
    ipcMain,
    app,
    mainWindowProvider,
    secAudit,
    capabilityStore,
    sessionState,
  });
  registerClipboardController({ ipcMain, clipboard });

  // Initialize the headless scheduler after the agent controller so a due job
  // always has a live task runtime handle. It stays resident in the tray.
  try {
    await scheduler.init();
    scheduler.startLoop();
    console.log('[MAIN] JARVIS scheduler initialized.');
  } catch (err) {
    console.error('[MAIN] FATAL ERROR in scheduler init:', err);
  }

  // Attach the scheduler to the ambient service so sleep/resume can flush and
  // restart it, then expose the autostart/status IPC to the settings panel.
  if (ambientService) ambientService.setScheduler(scheduler);
  registerAmbientController({ ipcMain, ambientService });

  ipcMain.handle('sec-audit-read', async () => {
    // The IPC policy already limits this channel to privileged sessions. Keep
    // the handler-level check as defense in depth for direct/unit callers.
    if (!sessionState || sessionState.canUsePrivileges !== true) {
      return {
        ok: false,
        error: 'Unlock JARVIS before reading the audit log',
        entries: [],
        data: '',
      };
    }

    try {
      const result = auditLogStore.read({ limit: 500 });
      if (result && result.ok) return result;
      return {
        ok: true,
        entries: [..._secAuditLog],
        data: _secAuditLog.map(e => `[${e.ts}] [${e.verdict}] ${e.action}: ${e.detail}`).join('\n'),
        durable: false,
        integrity: (result && result.integrity) || 'unavailable',
        warning: (result && result.warning) || auditLogStore.status().warning,
      };
    } catch (error) {
      return {
        ok: true,
        entries: [..._secAuditLog],
        data: _secAuditLog.map(e => `[${e.ts}] [${e.verdict}] ${e.action}: ${e.detail}`).join('\n'),
        durable: false,
        integrity: 'unavailable',
        warning: error.message,
      };
    }
  });
}

