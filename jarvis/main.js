// ═══════════════════════════════════════════════════════════════
// JARVIS — Main Process (Electron)
// Handles: window management, system tray, global shortcuts,
//          IPC for file system, terminal, history
// ═══════════════════════════════════════════════════════════════

const {
  app, BrowserWindow, ipcMain, globalShortcut,
  Tray, Menu, nativeImage, shell, dialog
} = require('electron');

const _path = require('path');
const _url = require('url');

// IPC sender validation is installed later (lines ~95) after mainWindow is known.

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
const JarvisScheduler = require('./scheduler');

// ─── State ───────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let ollamaProcess = null;   // reference to the spawned ollama serve process
app.isQuitting = false;
let liveSecConfig = { terminalEnabled: false, screenCaptureEnabled: false };

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

// ─── Security Audit Log (ring-buffer, max 1000 entries) ─────────────
const _secAuditLog = [];
function secAudit(action, detail, verdict) {
  const entry = { ts: new Date().toISOString(), action, detail: String(detail).slice(0, 500), verdict };
  _secAuditLog.push(entry);
  if (_secAuditLog.length > 1000) _secAuditLog.shift(); // ring-buffer cap
  console.log(`[SEC] ${verdict} | ${action} | ${entry.detail}`);
}

function stopOllama() {
  if (ollamaProcess) {
    try {
      process.kill(ollamaProcess.pid, 'SIGTERM');
    } catch (e) {
      // ignore
    }
    ollamaProcess = null;
  }
}

// ─── Global IPC Sender Validation ──────────────────────────────────────────
// Defense-in-depth: checks both senderFrame URL (origin) and webContents identity.
// Fails closed if mainWindow is null or destroyed.
const _allowedRendererBase = process.env.VITE_DEV_SERVER_URL ? (new _url.URL(process.env.VITE_DEV_SERVER_URL).href) : (_url.pathToFileURL(_path.join(__dirname, 'renderer')).href + '/');

const originalIpcHandle = ipcMain.handle.bind(ipcMain);
global.workspaceTokens = {};

ipcMain.handle = (channel, listener) => {
  originalIpcHandle(channel, async (event, ...args) => {
    const senderOk = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    const urlOk = event.senderFrame && typeof event.senderFrame.url === 'string' &&
      event.senderFrame.url.startsWith(_allowedRendererBase);
    if (!senderOk || !urlOk) {
      secAudit('IPC_BLOCK', channel, `BLOCKED sender=${senderOk} url=${urlOk}`);
      return { ok: false, error: 'untrusted sender' };
    }
    return listener(event, ...args);
  });
};

const originalIpcOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => {
  originalIpcOn(channel, (event, ...args) => {
    const senderOk = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    const urlOk = event.senderFrame && typeof event.senderFrame.url === 'string' &&
      event.senderFrame.url.startsWith(_allowedRendererBase);
    if (!senderOk || !urlOk) {
      secAudit('IPC_BLOCK', channel, `BLOCKED sender=${senderOk} url=${urlOk}`);
      event.returnValue = { ok: false, error: 'untrusted sender' };
      return;
    }
    listener(event, ...args);
  });
};



// ─── Window Factory ──────────────────────────────────────────────
function createWindow() {
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
      // CRIT-01 fix: webSecurity restored. Ollama API is called via IPC not
      // directly from the renderer, so this will not break core functionality.
      webSecurity: true,
    },
    show: false,
  });

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
          "connect-src 'self' https:; " +
          "font-src 'self' https://fonts.gstatic.com data:; " +
          "img-src 'self' data: https:; " +
          "media-src 'self' data: blob:; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "script-src 'self';"
        ]
      }
    });
  });

  // Rate limiting system for IPC handlers
  const _rateLimits = {};
  global.secCheckRate = function (action, maxPerMin) {
    const now = Date.now();
    if (!_rateLimits[action]) _rateLimits[action] = [];
    _rateLimits[action] = _rateLimits[action].filter(t => now - t < 60000);
    if (_rateLimits[action].length >= maxPerMin) return false;
    _rateLimits[action].push(now);
    return true;
  };

  // Load index.html or Vite dev server
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER] ${message}`);
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Hide to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', 'normal'));
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

  tray.setToolTip('JARVIS — AI Operating System  [Ctrl+Space]');
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

// ─── App Lifecycle ───────────────────────────────────────────────


app.whenReady().then(() => {
  // Ensure history directory exists
  const histDir = path.join(app.getPath('userData'), 'history');
  fs.mkdirSync(histDir, { recursive: true });

  // Initialize JARVIS Memory (SQLite)
  try {
    JarvisMemory.init(app.getPath('userData'));
    console.log('[MAIN] JARVIS Memory (JSON Fallback Engine) initialized successfully.');
  } catch (err) {
    console.error('[MAIN] FATAL ERROR in JarvisMemory.init:', err);
  }

  // Initialize Autonomous Scheduler
  try {
    JarvisScheduler.init(app.getPath('userData'), (job) => {
      // Send job trigger to frontend
      if (mainWindow) {
        mainWindow.webContents.send('scheduler-trigger', job);
      }
    });
  } catch (err) {
    console.error('[MAIN] FATAL ERROR in JarvisScheduler.init:', err);
  }

  // Load security config from disk at startup
  try {
    const fp = path.join(app.getPath('userData'), 'sec-config.json');
    if (fs.existsSync(fp)) {
      const cfg = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (typeof cfg.terminalEnabled === 'boolean') liveSecConfig.terminalEnabled = cfg.terminalEnabled;
      if (typeof cfg.screenCaptureEnabled === 'boolean') liveSecConfig.screenCaptureEnabled = cfg.screenCaptureEnabled;
    }
  } catch (e) { }

  let appConfig = { embeddingModel: 'all-minilm', textModel: 'llama3.2' };
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

  // Check Ollama Models
  setTimeout(() => {
    http.get('http://127.0.0.1:11434/api/tags', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const installed = json.models.map(m => m.name.split(':')[0]); // strip tags
          const missing = [];
          if (!installed.includes(appConfig.embeddingModel.split(':')[0])) missing.push(appConfig.embeddingModel);
          // Text model check handled dynamically by the frontend UI
          
          if (missing.length > 0) {
            console.error(`[OLLAMA] WARNING: Required models missing: ${missing.join(', ')}. Please run 'ollama pull <model>'.`);
            if (mainWindow) {
              mainWindow.webContents.send('show-toast', { title: 'Missing Models', message: `Please pull: ${missing.join(', ')}`, type: 'error' });
            }
          } else {
            console.log('[OLLAMA] All required models are installed.');
          }
        } catch (e) {}
      });
    }).on('error', () => {
      console.log('[OLLAMA] Failed to connect to Ollama API for startup check.');
    });
  }, 10000); // 10s delay to allow Ollama to start

  createWindow();
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
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Keep alive in tray — never quit on all-windows-closed
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// ═══════════════════════════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════════════════════════


const registerAIController = require('./backend/controllers/AIController');
const registerFileController = require('./backend/controllers/FileController');
const registerKnowledgeController = require('./backend/controllers/KnowledgeController');
const registerMemoryController = require('./backend/controllers/MemoryController');
const registerSchedulerController = require('./backend/controllers/SchedulerController');
const registerSecurityController = require('./backend/controllers/SecurityController');
const registerSystemController = require('./backend/controllers/SystemController');
const registerWindowController = require('./backend/controllers/WindowController');

  const mainWindowProvider = () => mainWindow;

  registerAIController({ ipcMain, app, mainWindowProvider, secAudit, _allowedRendererBase });
  registerFileController({ ipcMain, app, mainWindowProvider, secAudit });
  registerKnowledgeController({ ipcMain, app, secAudit, secCheckRate });
  registerMemoryController({ ipcMain, app, JarvisMemory });
  registerSchedulerController({ ipcMain, JarvisScheduler });
  registerSecurityController({ ipcMain, app, secAudit, liveSecConfig });
  registerSystemController({ ipcMain, app, mainWindowProvider, secAudit, liveSecConfig, secCheckRate });
  registerWindowController({ ipcMain, app, mainWindowProvider, liveSecConfig });

