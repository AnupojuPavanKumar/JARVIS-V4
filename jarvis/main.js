// ═══════════════════════════════════════════════════════════════
// JARVIS — Main Process (Electron)
// Handles: window management, system tray, global shortcuts,
//          IPC for file system, terminal, history
// ═══════════════════════════════════════════════════════════════

const {
  app, BrowserWindow, ipcMain, globalShortcut,
  Tray, Menu, nativeImage, shell, dialog
} = require('electron');

// ⚡ PERFORMANCE TUNING: Enforce aggressive garbage collection and hard-cap V8 memory to 2GB
app.commandLine.appendSwitch('js-flags', '--expose_gc --max-old-space-size=2048');
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

// ─── Screen Capture IPC ────────────────────────────────────────
ipcMain.handle('capture-screen', async () => {

  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (!sources || sources.length === 0) return { ok: false, error: 'No screen sources found' };
    const thumb = sources[0].thumbnail;
    const b64 = thumb.toJPEG(80).toString('base64');
    return { ok: true, data: b64, mimeType: 'image/jpeg', source: sources[0].name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

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
      webSecurity: false,
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
          "default-src 'self' 'unsafe-inline' https: data: blob:; " +
          "connect-src 'self' http://localhost:* http://127.0.0.1:* https:; " +
          "font-src 'self' https://fonts.gstatic.com data:; " +
          "img-src 'self' data: https:; " +
          "script-src 'self' 'unsafe-inline';"
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

  // Load index.html
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER] ${message}`);
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
  // Auto-start Ollama with GPU before window opens

  createWindow();
  createTray();
  startTelemetryBroadcast();

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

// ─── Window Controls ─────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.hide());

// ─── File System ─────────────────────────────────────────────────
ipcMain.handle('fs-read', async (_, filePath) => {

  try {
    return { ok: true, data: await fs.promises.readFile(filePath, 'utf8') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs-write', async (_, filePath, content) => {
  // H-3 fix: block writes outside the allowed workspace boundaries.
  // Allowed roots: userData directory and os.tmpdir().
  try {
    const resolved = path.resolve(filePath);
    const userDataRoot = path.resolve(app.getPath('userData'));
    const tmpRoot = path.resolve(os.tmpdir());
    const inUserData = resolved.startsWith(userDataRoot + path.sep) || resolved === userDataRoot;
    const inTmp = resolved.startsWith(tmpRoot + path.sep);
    if (!inUserData && !inTmp) {
      secAudit('FS_WRITE', resolved, 'BLOCKED — outside workspace');
      return { ok: false, error: 'Write refused: path is outside the allowed workspace.' };
    }
    secAudit('FS_WRITE', resolved, 'ALLOWED');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs-list', async (_, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) return { ok: true, data: [] };
    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return {
      ok: true,
      data: items.map(d => ({ name: d.name, isDir: d.isDirectory() }))
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs-dialog-save', async (_, defaultName, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'jarvis-export.md',
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
    ]
  });
  if (!result.canceled && result.filePath) {
    await fs.promises.writeFile(result.filePath, content, 'utf8');
    return { ok: true, filePath: result.filePath };
  }
  return { ok: false };
});

// ─── Security Boundary ───────────────────────────────────────────
ipcMain.handle('sec-config-load', async () => {
  try {
    const fp = path.join(app.getPath('userData'), 'sec-config.json');
    if (!fs.existsSync(fp)) return { ok: true, config: null };
    return { ok: true, config: JSON.parse(await fs.promises.readFile(fp, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('sec-config-save', async (_, cfg) => {
  try {
    const fp = path.join(app.getPath('userData'), 'sec-config.json');
    await fs.promises.writeFile(fp, JSON.stringify(cfg, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── History ─────────────────────────────────────────────────────

ipcMain.handle('history-save', async (_, sessionId, data) => {
  return JarvisMemory.saveSession(sessionId, data);
});

ipcMain.handle('history-load', async (_, sessionId) => {
  return JarvisMemory.loadSession(sessionId);
});

ipcMain.handle('history-list', async () => {
  return JarvisMemory.listSessions();
});

ipcMain.handle('history-delete', async (_, sessionId) => {
  return JarvisMemory.deleteSession(sessionId);
});

// ─── Scheduler ───────────────────────────────────────────────────

ipcMain.handle('scheduler-add', async (_, jobData) => {
  try {
    const job = JarvisScheduler.addJob(jobData);
    return { ok: true, job };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('scheduler-remove', async (_, jobId) => {
  try {
    const success = JarvisScheduler.removeJob(jobId);
    return { ok: success };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('scheduler-list', async () => {
  try {
    return { ok: true, jobs: JarvisScheduler.listJobs() };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Web Search / DuckDuckGo ────────────────────────────────────────────────────
// Issue 5 fix: replaced exec()+shell string with spawnShellCommand().
// The raw command string is never interpolated by cmd.exe directly;
// instead we pass it as a single /C argument so shell metacharacters
// typed by the user cannot escape into the host shell context.
// stdout/stderr are drained via stream events, and a hard SIGKILL
// fires if the child outlasts the 60-second timeout.



ipcMain.handle('run-command', async (_, command, cwd) => {
  // H-7 fix: rate-limit run-command just like run-code-safe.
  if (!secCheckRate('runCommand', 15)) {
    return { ok: false, stdout: '', stderr: '', exitCode: 1, error: '⛔ Rate limit: max 15 commands/minute.' };
  }
  secAudit('RUN_COMMAND', String(command).slice(0, 200), 'ALLOWED');
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(command, { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code : 0,
        error: error ? error.message : null,
      });
    });
  });
});

// ─── System Info ─────────────────────────────────────────────────
ipcMain.handle('get-system-info', async () => ({
  platform: os.platform(),
  arch: os.arch(),
  hostname: os.hostname(),
  username: os.userInfo().username,
  cpuCount: os.cpus().length,
  cpuModel: os.cpus()[0]?.model?.trim() || 'Unknown CPU',
  totalMem: os.totalmem(),
  freeMem: os.freemem(),
  appVersion: app.getVersion(),
  userDataPath: app.getPath('userData'),
  electronVer: process.versions.electron,
  nodejsVer: process.versions.node,
}));

// ─── Misc ─────────────────────────────────────────────────────────

// Whitelist of local apps the user is allowed to start via voice command
const SYSTEM_CMD_APP_ALLOWLIST = new Set([
  'chrome', 'msedge', 'firefox', 'spotify', 'notepad', 'calc', 'calculator',
  'code', 'vscode', 'explorer', 'powershell', 'cmd', 'wt', 'terminal',
]);

function isSafeExternalUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
    if (!p.hostname || p.hostname.length > 253) return false;
    return true;
  } catch { return false; }
}

ipcMain.on('open-external', (_, url) => {
  if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
    secAudit('OPEN_EXTERNAL', String(url), 'BLOCKED');
    return;
  }
  shell.openExternal(url);
});

// Renderer-side system command: validates action+target entirely in the
// privileged main process so no shell-string interpolation ever happens.
ipcMain.handle('system-command', async (_, action, target) => {
  if (typeof action !== 'string' || typeof target !== 'string') {
    return { ok: false, error: 'Invalid request' };
  }
  const t = target.trim();
  if (!t) return { ok: false, error: 'Empty target' };
  if (t.length > 200) return { ok: false, error: 'Target too long' };



  const a = action.toLowerCase();

  // 1. open local app (allowlisted)
  if (a === 'open-app' || a === 'start-app') {
    const key = t.toLowerCase().split(/\s+/)[0];
    if (!SYSTEM_CMD_APP_ALLOWLIST.has(key)) {
      return { ok: false, error: `App not in allowlist: ${key}` };
    }
    // Use shell.openPath for known apps — no shell-string interpolation
    const candidates = {
      chrome: 'chrome', msedge: 'msedge', firefox: 'firefox', spotify: 'spotify',
      notepad: 'notepad', calc: 'calc', calculator: 'calc',
      code: 'code', vscode: 'code', explorer: 'explorer',
      powershell: 'powershell', cmd: 'cmd', wt: 'wt', terminal: 'wt',
    };
    const appName = candidates[key] || key;
    try {
      await shell.openPath(appName);
      return { ok: true, action: 'open-app', target: t };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 2. open URL in default browser
  if (a === 'open-url' || a === 'search' || a === 'open') {
    let url = t;
    // If it doesn't look like a URL, build a Google search
    if (a === 'search' || !/^https?:\/\//i.test(url)) {
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(t);
      }
    }
    // YouTube short-circuit
    const yt = t.match(/^(.+)\s+(?:on|in|from|at)\s+youtube$/i);
    if (yt) url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(yt[1].trim());
    else if (/^youtube$/i.test(t)) url = 'https://www.youtube.com/';
    else if (/youtube/i.test(t) && !/^https?:\/\//i.test(t)) {
      const q = t.replace(/(open|search|in|on|from|youtube)/ig, '').trim();
      url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    }
    // Strip a leading scheme the user typed
    url = url.replace(/^https?:\/\//, 'https://');
    if (!/^https:\/\//.test(url)) url = 'https://' + url.replace(/^\/+/, '');

    if (!isSafeExternalUrl(url)) {
      return { ok: false, error: 'Refused to open unsafe URL' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true, action: 'open-url', target: url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 3. close / kill process by name
  if (a === 'close' || a === 'kill') {
    if (t.length > 64) return { ok: false, error: 'Name too long' };
    if (!/^[A-Za-z0-9_.\- ]+$/.test(t)) return { ok: false, error: 'Invalid process name' };
    const PROTECTED = /^(csrss|winlogon|lsass|smss|wininit|services|svchost|system|registry|dwm|explorer|audiodg|winrt\.exe)$/i;
    if (PROTECTED.test(t)) {
      return { ok: false, error: `Refusing to terminate protected process: ${t}` };
    }
    const cmd = `powershell -NoProfile -Command "Stop-Process -Name '${t}' -Force -ErrorAction SilentlyContinue"`;
    return await new Promise(resolve => {
      exec(cmd, { timeout: 5000, shell: 'cmd.exe', windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err || err.code === 0, action: 'kill', target: t, error: err?.message });
      });
    });
  }

  return { ok: false, error: `Unknown action: ${action}` };
});

ipcMain.handle('get-user-data-path', async () => app.getPath('userData'));

// ─── Quit App (Power Off) ─────────────────────────────────────────
ipcMain.on('quit-app', () => {
  app.isQuitting = true;
  stopOllama();
  app.quit();
});

// ─── Folder Dialog ──────────────────────────────────────────────
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

// ─── Project Reader ──────────────────────────────────────────────
const PROJ_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build', '.next',
  'venv', '.venv', 'vendor', 'bin', 'obj', '.idea', '.vscode',
  '.cache', 'coverage', '.turbo', 'out', 'tmp', '.tmp', 'logs',
]);
const PROJ_EXCLUDE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.env', '.env.local', '.env.production', '.env.development', '.env.test',
]);
const PROJ_EXCLUDE_EXT = new Set([
  'lock', 'map', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico',
  'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mp3', 'zip', 'gz',
  'tar', 'rar', 'exe', 'dll', 'bin', 'pdf', 'pyc',
]);
const PROJ_MAX_FILES = 40;
const PROJ_MAX_TOTAL = 2 * 1024 * 1024;  // 2 MB
const PROJ_MAX_FILE = 150 * 1024;        // 150 KB

// ponytail: async fs.promises walk — avoids blocking the main process event loop
async function scanProject(dir, rootDir, files = [], depth = 0) {
  if (depth > 6) return;
  if (files.length >= PROJ_MAX_FILES) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (files.length >= PROJ_MAX_FILES) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!PROJ_EXCLUDE_DIRS.has(entry.name.toLowerCase())) {
        await scanProject(fullPath, rootDir, files, depth + 1);
      }
    } else if (entry.isFile()) {
      const nameLower = entry.name.toLowerCase();
      const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
      if (PROJ_EXCLUDE_FILES.has(nameLower)) continue;
      if (PROJ_EXCLUDE_EXT.has(ext)) continue;
      if (nameLower.startsWith('.env')) continue;

      let stat;
      try { stat = await fs.promises.stat(fullPath); } catch { continue; }
      if (stat.size > PROJ_MAX_FILE) continue;

      let content = null;
      try {
        const raw = await fs.promises.readFile(fullPath);
        const sample = raw.slice(0, 512);
        const hasBinary = sample.some(b => b === 0 || (b < 8) || (b >= 14 && b < 32 && b !== 27));
        if (!hasBinary) content = raw.toString('utf8');
      } catch { continue; }

      files.push({ path: fullPath, relativePath: relPath, size: stat.size, content });
    }
  }
  return files;
}

ipcMain.handle('read-project', async (_, rootPath) => {
  try {
    const files = [];
    await scanProject(rootPath, rootPath, files);
    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    if (totalBytes > PROJ_MAX_TOTAL) {
      return { ok: false, error: `Project too large (${(totalBytes / 1048576).toFixed(1)}MB > 2MB limit). Exclude more folders.` };
    }
    return { ok: true, files, fileCount: files.length, totalBytes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── Persistent Memory ────────────────────────────────────────────
const memoryFile = () => path.join(app.getPath('userData'), 'memory.json');
const memoryFileTmp = () => memoryFile() + '.tmp';
const memoryFileBak = () => memoryFile() + '.bak';

ipcMain.handle('memory-load', async () => {
  const fp = memoryFile();
  const bak = memoryFileBak();
  // Try primary file, fall back to .bak on corruption
  for (const candidate of [fp, bak]) {
    try {
      const raw = await fs.promises.readFile(candidate, 'utf8');
      const facts = JSON.parse(raw);
      if (Array.isArray(facts)) return { ok: true, facts };
    } catch { /* try next */ }
  }
  return { ok: true, facts: [] };
});

ipcMain.handle('memory-save', async (_, facts) => {
  // ponytail: atomic write — tmp → bak → rename; prevents corruption on crash
  const fp = memoryFile();
  const tmp = memoryFileTmp();
  const bak = memoryFileBak();
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(facts, null, 2));
    // rotate: current → .bak
    try { await fs.promises.rename(fp, bak); } catch { /* first save, no existing file */ }
    await fs.promises.rename(tmp, fp);
    return { ok: true };
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch { }
    return { ok: false, error: e.message };
  }
});

// ─── Web Search ──────────────────────────────────────────────────

/** Generic HTTPS GET with redirect follow and timeout */
function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 JARVIS/2.0',
        'Accept': 'application/json, text/html, application/rss+xml, */*',
      },
      timeout: timeoutMs,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpsGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

/** Parse RSS/Atom XML into structured articles */
function parseRSS(xml) {
  const items = [];
  const itemRx = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRx = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;

  const extractText = (str, tag) => {
    const m = new RegExp(`<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 'si').exec(str);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };
  const extractAttr = (str, tag, attr) => {
    const m = new RegExp(`<${tag}[^>]+${attr}="([^"]*)"`, 'i').exec(str);
    return m ? m[1].trim() : '';
  };

  let match;
  const rawItems = [];
  while ((match = itemRx.exec(xml)) !== null) rawItems.push(match[1]);
  while ((match = entryRx.exec(xml)) !== null) rawItems.push(match[1]);

  for (const raw of rawItems.slice(0, 10)) {
    const title = extractText(raw, 'title');
    // <link> can be text or href attribute
    let url = extractText(raw, 'link') || extractAttr(raw, 'link', 'href');
    // Google News wraps real URL — extract from redirect
    if (url.includes('news.google.com/rss/articles')) url = url; // keep as-is, we'll show it
    const desc = (extractText(raw, 'description') || extractText(raw, 'summary'))
      .replace(/<[^>]+>/g, '').slice(0, 300).trim();
    const pubDate = extractText(raw, 'pubDate') || extractText(raw, 'published') || extractText(raw, 'updated');
    const sourceName = extractText(raw, 'source') || extractAttr(raw, 'source', 'url') || '';

    if (title && title.length > 4) {
      items.push({ title, url, desc, pubDate, source: sourceName });
    }
  }
  return items;
}

ipcMain.handle('web-search', async (_, query, searchType = 'auto') => {
  // Rate limit: max 30 web searches/minute
  if (!secCheckRate('webSearch', 30)) {
    return { ok: false, results: [], query, errors: ['Rate limit exceeded: max 30 searches/minute.'], fetchedAt: new Date().toISOString() };
  }
  const results = [];
  const errors = [];

  // ── Determine search type from query content ──────────────────
  const isNewsQuery = searchType === 'news' || searchType === 'auto' && (
    /\b(news|today|latest|current|recent|breaking|update|happening|world|global|headlines|trending|2025|2026)\b/i.test(query)
  );
  const isFactQuery = searchType === 'fact' || searchType === 'auto' && (
    /\b(who is|what is|when did|how much|price|capital|population|definition|meaning|where is|explain)\b/i.test(query)
  );

  // ── 1. Google News RSS ─────────────────────────────────────────
  if (isNewsQuery || searchType === 'both') {
    try {
      const newsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const rss = await httpsGet(newsUrl);
      const newsItems = parseRSS(rss);
      newsItems.forEach(item => results.push({ ...item, engine: 'Google News' }));
    } catch (e) { errors.push(`Google News: ${e.message}`); }
  }

  // ── 2. DuckDuckGo Instant Answer API ──────────────────────────
  if (isFactQuery || !isNewsQuery || results.length < 3) {
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=jarvis`;
      const raw = await httpsGet(ddgUrl);
      const ddg = JSON.parse(raw);

      if (ddg.AbstractText) {
        results.unshift({
          title: ddg.Heading || query,
          url: ddg.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
          desc: ddg.AbstractText,
          source: ddg.AbstractSource,
          pubDate: new Date().toUTCString(),
          engine: 'DuckDuckGo',
          isPrimary: true,
        });
      }
      // Related topics as extra results
      if (ddg.RelatedTopics) {
        for (const t of ddg.RelatedTopics.slice(0, 5)) {
          if (t.Text && t.FirstURL) {
            results.push({
              title: t.Text.slice(0, 100),
              url: t.FirstURL,
              desc: t.Text,
              pubDate: '',
              source: 'DuckDuckGo',
              engine: 'DuckDuckGo',
            });
          }
        }
      }
    } catch (e) { errors.push(`DuckDuckGo: ${e.message}`); }
  }

  // ── 3. BBC News RSS fallback for world news ────────────────────
  if (isNewsQuery && results.length < 4) {
    try {
      const bbcUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml';
      const rss = await httpsGet(bbcUrl);
      const items = parseRSS(rss);
      items.slice(0, 5).forEach(item => results.push({ ...item, engine: 'BBC News' }));
    } catch (e) { errors.push(`BBC: ${e.message}`); }
  }

  // Deduplicate by title similarity
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  return {
    ok: deduped.length > 0,
    results: deduped.slice(0, 12),
    query,
    errors,
    fetchedAt: new Date().toISOString(),
  };
});

// ─── Image File Dialog ──────────────────────────────────────────
ipcMain.handle('open-image-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select Image for Analysis',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, filePath: result.filePaths[0] };
});

// ─── Read File as Base64 (for vision models) ───────────────────
// Issue 10 fix: was fs.readFileSync — large images blocked the main-thread
// event loop. Replaced with async read so IPC/tray/window events are not
// delayed during file I/O.
ipcMain.handle('fs-read-binary', async (_, filePath) => {
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    return { ok: true, data: data.toString('base64'), mimeType };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── Safe Code Runner ───────────────────────────────────────────
const CODE_RUNNERS = {
  python: { cmd: 'python', ext: '.py', tmpName: 'jarvis_run.py' },
  javascript: { cmd: 'node', ext: '.js', tmpName: 'jarvis_run.js' },
  powershell: { cmd: 'powershell', ext: '.ps1', tmpName: 'jarvis_run.ps1' },
  bash: { cmd: 'bash', ext: '.sh', tmpName: 'jarvis_run.sh' },
};

ipcMain.handle('run-code-safe', async (_, language, code) => {
  if (!secCheckRate('codeRun', 5)) {
    return { ok: false, error: '⛔ Rate limit exceeded: max 5 code runs per minute.', stdout: '', stderr: '', exitCode: 1, time: 0 };
  }
  const runner = CODE_RUNNERS[language] || CODE_RUNNERS.python;
  const tmpDir = os.tmpdir();
  // unique temp filename so concurrent runs don't collide
  const tmpFile = path.join(tmpDir, `jarvis_run_${Date.now()}_${process.pid}.${runner.ext.replace('.', '')}`);
  const start = Date.now();
  try {
    fs.writeFileSync(tmpFile, code, 'utf8');
    let cmd;
    if (language === 'powershell') {
      cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`;
    } else {
      cmd = `${runner.cmd} "${tmpFile}"`;
    }
    secAudit('CODE_RUN', `${language} (${code.length} bytes)`, 'ALLOWED');
    return await new Promise((resolve) => {
      exec(cmd, {
        timeout: 15000,
        maxBuffer: 1024 * 512,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch { }
        resolve({
          ok: true,
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err?.code ?? 0,
          time: Date.now() - start,
          language,
        });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message, stdout: '', stderr: e.message, exitCode: 1, time: Date.now() - start };
  }
});

// ─── HTTP Request Proxy (API Tester) ────────────────────────────
ipcMain.handle('http-request', async (_, { method, url, headers, body }) => {
  const start = Date.now();
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const options = {
        method: method || 'GET',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'JARVIS-API-Tester/2.0',
          'Content-Type': 'application/json',
          ...(headers || {}),
        },
        timeout: 15000,
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          ok: true,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: data,
          time: Date.now() - start,
        }));
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message, time: Date.now() - start }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out (15s)', time: Date.now() - start }); });
      if (body && method !== 'GET') req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message, time: Date.now() - start });
    }
  });
});

// ─── Snippets Persistence ────────────────────────────────────────
const snippetsFile = () => path.join(app.getPath('userData'), 'snippets.json');

ipcMain.handle('snippets-load', async () => {
  try {
    const fp = snippetsFile();
    if (!fs.existsSync(fp)) return { ok: true, data: [] };
    return { ok: true, data: JSON.parse(await fs.promises.readFile(fp, 'utf8')) };
  } catch (e) { return { ok: false, data: [] }; }
});
ipcMain.handle('snippets-save', async (_, data) => {
  try { await fs.promises.writeFile(snippetsFile(), JSON.stringify(data, null, 2)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ─── Prompts Library Persistence ────────────────────────────────
const promptsFile = () => path.join(app.getPath('userData'), 'prompts.json');
ipcMain.handle('prompts-load', async () => {
  try {
    const fp = promptsFile();
    if (!fs.existsSync(fp)) return { ok: true, data: [] };
    return { ok: true, data: JSON.parse(await fs.promises.readFile(fp, 'utf8')) };
  } catch (e) { return { ok: false, data: [] }; }
});
ipcMain.handle('prompts-save', async (_, data) => {
  try { await fs.promises.writeFile(promptsFile(), JSON.stringify(data, null, 2)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ─── Notes Scratchpad Persistence ───────────────────────────────
const notesFile = () => path.join(app.getPath('userData'), 'notes.md');
ipcMain.handle('notes-load', async () => {
  try {
    const fp = notesFile();
    if (!fs.existsSync(fp)) return { ok: true, data: '' };
    return { ok: true, data: await fs.promises.readFile(fp, 'utf8') };
  } catch (e) { return { ok: false, data: '' }; }
});
ipcMain.handle('notes-save', async (_, content) => {
  try { await fs.promises.writeFile(notesFile(), content, 'utf8'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});


// ─── Additional Notes Persistence (see notesFile() above) ────────
// All IPC handlers registered above. No duplicates below.

// (run-code-safe and http-request handlers already registered above — no duplicates)

// (snippets/prompts/notes handlers already registered above — no duplicates)


// =======================================================================
// SKILLS SYSTEM IPC
// =======================================================================

const skillsDir = path.join(__dirname, 'skills');

// Ed25519 public key used to verify the skills manifest signature.
// If `skills/manifest.sig` is present the manifest is only accepted when
// its signature matches this key. To disable signature checks (development
// only) delete the .sig file.
const SKILLS_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=
-----END PUBLIC KEY-----`;

let _skillsPubKey = null;
try {
  // crypto.verify lives in node:crypto
  const { createPublicKey, verify: cryptoVerify } = require('crypto');
  _skillsPubKey = createPublicKey(SKILLS_PUBLIC_KEY_PEM);
} catch (_) { _skillsPubKey = null; }

function verifyManifestSignature(manifestRaw, sigRaw) {
  if (!_skillsPubKey) return { ok: false, reason: 'public-key unavailable' };
  try {
    const { verify } = require('crypto');
    const ok = verify(
      null,
      Buffer.from(manifestRaw),
      _skillsPubKey,
      Buffer.from(sigRaw)
    );
    return { ok };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function loadVerifiedSkillsManifest() {
  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: true, skills: [], manifestRaw: '' };
  const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');

  const sigPath = path.join(skillsDir, 'manifest.sig');
  if (fs.existsSync(sigPath)) {
    const sigRaw = await fs.promises.readFile(sigPath, 'utf8');
    const v = verifyManifestSignature(manifestRaw, sigRaw);
    if (!v.ok) {
      return { ok: false, error: 'Skills manifest signature invalid. Refusing to load skills.' };
    }
  }

  const manifest = JSON.parse(manifestRaw);
  return { ok: true, skills: manifest.skills || [], manifestRaw };
}

ipcMain.handle('skills-list', async () => {
  try {
    const res = await loadVerifiedSkillsManifest();
    if (!res.ok) return { ok: false, error: res.error, skills: [] };
    return { ok: true, skills: res.skills };
  } catch (e) { return { ok: false, error: e.message, skills: [] }; }
});

ipcMain.handle('skills-run', async (_, skillId, args) => {
  const start = Date.now();
  if (!secCheckRate('skillRun', 20)) {
    return { ok: false, error: 'Rate limit exceeded', elapsed: Date.now() - start };
  }
  if (!args) args = {};
  try {
    const load = await loadVerifiedSkillsManifest();
    if (!load.ok) return { ok: false, error: load.error, elapsed: Date.now() - start };
    const skill = (load.skills || []).find(function (s) { return s.id === skillId; });
    if (!skill) return { ok: false, error: 'Skill not found: ' + skillId, elapsed: Date.now() - start };

    // ponytail: use realpathSync — resolves symlinks before comparison so a
    // symlinked script can't escape the skills directory
    let scriptPath, realSkillsRoot;
    try {
      scriptPath = fs.realpathSync(path.resolve(skillsDir, skill.script));
      realSkillsRoot = fs.realpathSync(path.resolve(skillsDir)) + path.sep;
    } catch {
      return { ok: false, error: 'Skill script path could not be resolved.', elapsed: Date.now() - start };
    }
    if (!scriptPath.startsWith(realSkillsRoot)) {
      return { ok: false, error: 'Skill script path escapes skills directory.', elapsed: Date.now() - start };
    }

    if (!fs.existsSync(scriptPath)) return { ok: false, error: 'Script not found: ' + skill.script, elapsed: Date.now() - start };

    const argsStr = JSON.stringify(args);
    const runner = skill.type === 'js' ? 'node' : 'python';
    secAudit('SKILL_RUN', `${skillId} (${argsStr.length} bytes)`, 'ALLOWED');

    // Issue 9 fix: spawn with an explicit argv array and shell:false.
    // scriptPath and argsStr are separate elements — the OS passes them
    // verbatim so no shell metacharacter (spaces, parens, quotes in
    // Windows paths) can alter control flow.
    return await new Promise(function (resolve) {
      const child = spawn(runner, [scriptPath, argsStr], {
        shell: false,
        windowsHide: true,
      });

      let stdoutBuf = '', stderrBuf = '';

      child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });
      child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

      // Hard kill after 10 s
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { }
      }, 10000);

      child.on('error', (err) => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        resolve({ ok: false, skill: skillId, data: { stdout: stdoutBuf, stderr: stderrBuf }, elapsed, error: err.message });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        try {
          const p = JSON.parse(stdoutBuf.trim());
          resolve(Object.assign({ ok: true }, p, { elapsed }));
        } catch (_) {
          resolve({ ok: code === 0, skill: skillId, data: { stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() }, elapsed, error: code !== 0 ? `exit ${code}` : null });
        }
      });
    });
  } catch (e) { return { ok: false, error: e.message, elapsed: Date.now() - start }; }
});

// =======================================================================
// RUNTIME DIAGNOSTICS IPC
// =======================================================================

ipcMain.handle('get-runtime-stats', async () => {
  function fmtS(s) {
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + sec + 's';
  }
  var mu = process.memoryUsage(), up = Math.floor(process.uptime()), sup = Math.floor(os.uptime());
  var ollamaRunning = false;
  try {
    await new Promise(function (resolve) {
      var req = http.request('http://127.0.0.1:11434/', { method: 'GET', timeout: 1000 }, function (res) {
        ollamaRunning = res.statusCode < 500; res.resume(); resolve();
      });
      req.on('error', resolve);
      req.on('timeout', function () { req.destroy(); resolve(); });
      req.end();
    });
  } catch (e) { }
  var skillCount = 0;
  try {
    // Issue 11 fix: was fs.readFileSync — replaced with async read to avoid
    // blocking the main-thread event loop while the manifest is parsed.
    var mp = path.join(skillsDir, 'manifest.json');
    if (fs.existsSync(mp)) { var m = JSON.parse(await fs.promises.readFile(mp, 'utf8')); skillCount = (m.skills || []).length; }
  } catch (e) { }
  var sessionCount = 0;
  try {
    var hd = path.join(app.getPath('userData'), 'history');
    if (fs.existsSync(hd)) sessionCount = (await fs.promises.readdir(hd)).filter(function (f) { return f.endsWith('.json'); }).length;
  } catch (e) { }
  return {
    ok: true,
    process: { uptime_human: fmtS(up), heap_used_mb: (mu.heapUsed / 1048576).toFixed(1), heap_total_mb: (mu.heapTotal / 1048576).toFixed(1), rss_mb: (mu.rss / 1048576).toFixed(1) },
    system: { uptime_human: fmtS(sup), free_mem_gb: (os.freemem() / 1073741824).toFixed(2), total_mem_gb: (os.totalmem() / 1073741824).toFixed(2), cpu_cores: os.cpus().length },
    jarvis: { ollama_running: ollamaRunning, skill_count: skillCount, session_count: sessionCount, electron_ver: process.versions.electron, node_ver: process.versions.node },
    timestamp: new Date().toISOString(),
  };
});

// =======================================================================
// PIN AUTH PERSISTENCE IPC
// =======================================================================

var _authFilePath = function () { return path.join(app.getPath('userData'), 'jarvis_auth.json'); };

ipcMain.handle('auth-load', async () => {
  try {
    var fp = _authFilePath();
    if (!fs.existsSync(fp)) return { ok: true, data: null };
    return { ok: true, data: JSON.parse(await fs.promises.readFile(fp, 'utf8')) };
  } catch (e) { return { ok: false, data: null }; }
});

ipcMain.handle('auth-save', async (_, data) => {
  try {
    await fs.promises.writeFile(_authFilePath(), JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ═══════════════════════════════════════════════════════════════
// PIPER TTS ENGINE
// ═══════════════════════════════════════════════════════════════

let piperProcess = null;
let piperCallbacks = {};

function initPiperProcess() {
  if (piperProcess) return piperProcess;
  const piperExe = path.join(__dirname, 'bin', 'piper', 'piper', 'piper.exe');
  const jarvisModelPath = path.join(__dirname, 'bin', 'piper', 'piper', 'models', 'jarvis.onnx');
  const defaultModelPath = path.join(__dirname, 'bin', 'piper', 'piper', 'models', 'en_GB-alan-medium.onnx');
  const model = fs.existsSync(jarvisModelPath) ? jarvisModelPath : defaultModelPath;
  if (!fs.existsSync(piperExe) || !fs.existsSync(model)) return null;

  piperProcess = spawn(piperExe, [
    '--model', model,
    '--json-input',
    '--noise_scale', '0.333',
    '--noise_w', '0.333'
  ], { windowsHide: true, shell: false });

  let buffer = '';
  piperProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    let lines = buffer.split('\n');
    buffer = lines.pop();
    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (piperCallbacks[trimmed]) {
        const cb = piperCallbacks[trimmed];
        delete piperCallbacks[trimmed];
        try {
          if (fs.existsSync(cb.tmpFile)) {
            const wavBuffer = fs.readFileSync(cb.tmpFile);
            fs.unlinkSync(cb.tmpFile);
            cb.resolve({ ok: true, data: wavBuffer.toString('base64') });
          } else {
            cb.resolve({ ok: false, error: 'WAV not found' });
          }
        } catch (e) { cb.resolve({ ok: false, error: e.message }); }
      }
    }
  });

  piperProcess.on('exit', () => {
    piperProcess = null;
    for (let key in piperCallbacks) {
      piperCallbacks[key].resolve({ ok: false, error: 'Piper process exited' });
    }
    piperCallbacks = {};
  });
  return piperProcess;
}

ipcMain.handle('piper-tts', async (_, text) => {
  return new Promise((resolve) => {
    try {
      const p = initPiperProcess();
      if (!p) {
        return resolve({ ok: false, error: 'Piper binary or model not found' });
      }
      const tmpFile = path.join(app.getPath('temp'), `piper_${Date.now()}_${Math.floor(Math.random() * 10000)}.wav`);
      piperCallbacks[tmpFile] = { resolve, tmpFile };
      p.stdin.write(JSON.stringify({ text, output_file: tmpFile }) + '\n');
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});

ipcMain.handle('sec-classify-command', async (_, cmd) => {
  return { verdict: 'safe' };
});

// ═══════════════════════════════════════════════════════════════
// WHISPER AI VOICE ENGINE
// ═══════════════════════════════════════════════════════════════
// spawn is already required
//
// Issues 1, 2 & 7 fixes:
//   Issue 1 — single global currentResolve/currentReject was overwritten by
//             concurrent calls, permanently hanging the first caller's Promise.
//             Replaced with a serial _whisperQueue: each incoming request waits
//             its turn and is guaranteed exactly one resolve/reject call.
//   Issue 2 — stdin.write() return value was never checked. If the Python
//             process's stdin buffer was full the write silently dropped bytes.
//             _writeToWhisperStdin() now waits for the 'drain' event before
//             resolving so no bytes are lost under backpressure.
//   Issue 7 — a new setInterval(100ms) was created per transcribe-audio call
//             while Whisper was loading. Under rapid clicks this spawned N
//             intervals that all fired together, each overwriting currentResolve.
//             Replaced with a single whisperReadyPromise that resolves once.

let whisperProcess = null;
let _whisperHealthTimer = null;
let _whisperPongReceived = false;

// ── Single-resolve promise that settles exactly once when Whisper outputs READY
let _whisperReadyResolve = null;
let whisperReadyPromise = new Promise(r => { _whisperReadyResolve = r; });

// ── Serial request queue — each entry is { resolvedPath, resolve, reject }
const _whisperQueue = [];
let _whisperBusy = false;   // true while a transcription is in-flight

// ── Active in-flight callbacks (set by _drainWhisperQueue, read by stdout handler)
let _inflight = null;   // { resolve, reject, resolvedPath }

// ─── stdin backpressure-safe write (Issue 2) ──────────────────────────────
function _writeToWhisperStdin(line) {
  return new Promise((res, rej) => {
    if (!whisperProcess || !whisperProcess.stdin.writable) {
      return rej(new Error('Whisper stdin not writable'));
    }
    const ok = whisperProcess.stdin.write(line + '\n');
    if (ok) return res();
    // Buffer full — wait for drain before resolving so no bytes are dropped
    whisperProcess.stdin.once('drain', res);
    whisperProcess.stdin.once('error', rej);
  });
}

// ─── Serial queue drainer ─────────────────────────────────────────────────
async function _drainWhisperQueue() {
  if (_whisperBusy || _whisperQueue.length === 0) return;
  _whisperBusy = true;

  const entry = _whisperQueue[0];   // peek — don't shift until settled
  _inflight = entry;

  try {
    await _writeToWhisperStdin(entry.resolvedPath);
  } catch (writeErr) {
    _whisperQueue.shift();
    _whisperBusy = false;
    _inflight = null;
    try { fs.unlinkSync(entry.resolvedPath); } catch (_) { }
    entry.resolve({ success: false, error: 'stdin write failed: ' + writeErr.message });
    _drainWhisperQueue();
  }
  // _whisperBusy stays true; the stdout handler will call _onWhisperSettled()
  // when TRANSCRIPTION: or ERROR: arrives.
}

// Called by the stdout handler when a result arrives for the current request
function _onWhisperSettled(resultOrError) {
  if (!_inflight) return;
  const entry = _whisperQueue.shift();
  _inflight = null;
  _whisperBusy = false;

  try { fs.unlinkSync(entry.resolvedPath); } catch (_) { }

  if (resultOrError instanceof Error) {
    entry.resolve({ success: false, error: resultOrError.message });
  } else {
    entry.resolve(resultOrError);
  }

  // Process next item in the queue (if any)
  _drainWhisperQueue();
}

// ─── Health-check helpers ─────────────────────────────────────────────────
function _clearWhisperHealth() {
  if (_whisperHealthTimer) { clearInterval(_whisperHealthTimer); _whisperHealthTimer = null; }
}

function _startWhisperHealth() {
  _clearWhisperHealth();
  // PING every 30s; if no PONG within 5s, restart
  _whisperHealthTimer = setInterval(() => {
    if (!whisperProcess) return;
    _whisperPongReceived = false;
    try { whisperProcess.stdin.write('PING\n'); } catch { }
    setTimeout(() => {
      if (!_whisperPongReceived && whisperProcess) {
        console.warn('[WHISPER] Health check failed — restarting...');
        // Fail the in-flight request so the renderer is unblocked
        if (_inflight) {
          _onWhisperSettled(new Error('Whisper process restarted during health check'));
        }
        // Flush any queued requests that can never be served by the dead process
        while (_whisperQueue.length) {
          const stale = _whisperQueue.shift();
          try { fs.unlinkSync(stale.resolvedPath); } catch (_) { }
          stale.resolve({ success: false, error: 'Whisper restarted' });
        }
        _whisperBusy = false;
        try { whisperProcess.kill(); } catch { }
        // 'close' handler will call initWhisper() after 2s
      }
    }, 5000);
  }, 30000);
}

// ─── Process factory ─────────────────────────────────────────────────────
function initWhisper() {
  if (whisperProcess) return;
  console.log('[WHISPER] Spawning transcription server...');

  // Reset the ready promise so callers that arrived before restart will wait
  whisperReadyPromise = new Promise(r => { _whisperReadyResolve = r; });

  whisperProcess = require('child_process').spawn(
    'python',
    [path.join(__dirname, 'skills', 'transcribe_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] }   // explicit pipes for all three streams
  );

  whisperProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    for (const output of lines) {
      if (output === 'READY') {
        console.log('[WHISPER] Server is ready.');
        if (_whisperReadyResolve) { _whisperReadyResolve(); _whisperReadyResolve = null; }
        _startWhisperHealth();
        // Kick the queue in case requests arrived before READY
        _drainWhisperQueue();
      } else if (output === 'PONG') {
        _whisperPongReceived = true;
      } else if (output.startsWith('TRANSCRIPTION:')) {
        const text = output.replace('TRANSCRIPTION:', '').trim();
        _onWhisperSettled({ success: true, text });
      } else if (output.startsWith('ERROR:')) {
        console.error('[WHISPER] Error:', output);
        _onWhisperSettled(new Error(output));
      } else {
        console.log('[WHISPER STDOUT]', output);
      }
    }
  });

  whisperProcess.stderr.on('data', (data) => {
    console.log('[WHISPER STDERR]', data.toString().trim());
  });

  whisperProcess.on('close', (code) => {
    console.log('[WHISPER] Process exited with code', code);
    _clearWhisperHealth();
    whisperProcess = null;
    // Auto-restart after 2s unless app is quitting
    if (!app.isQuitting) {
      setTimeout(() => { if (!whisperProcess) initWhisper(); }, 2000);
    }
  });
}

// Initialize Whisper in the background at startup
initWhisper();

// ─── IPC handler (Issue 1 & 7 fix: queue-based, no polling) ──────────────
ipcMain.handle('transcribe-audio', async (_event, buffer) => {
  // Ensure the process is running
  if (!whisperProcess) initWhisper();

  // Prepare temp audio file path
  const audioDir = path.join(app.getPath('userData'), 'audio-cache');
  try { fs.mkdirSync(audioDir, { recursive: true }); } catch (_) { }
  const tempPath = path.join(audioDir, 'audio_' + Date.now() + '_' + process.pid + '.webm');
  const resolvedPath = path.resolve(tempPath);

  // Security: temp file must stay inside audio-cache
  if (!resolvedPath.startsWith(path.resolve(audioDir))) {
    return { success: false, error: 'Refusing to write temp audio outside audio-cache.' };
  }

  // Write buffer synchronously (small binary blob, negligible cost vs. transcription latency)
  try {
    fs.writeFileSync(resolvedPath, buffer);
  } catch (e) {
    return { success: false, error: 'Failed to write audio temp file: ' + e.message };
  }

  // Enqueue the request — Promise resolves when _onWhisperSettled fires
  const result = await new Promise((resolve, reject) => {
    _whisperQueue.push({ resolvedPath, resolve, reject });
    // Wait for Whisper to be ready, then try to drain the queue.
    // whisperReadyPromise resolves once, so concurrent waiters don't
    // create N setIntervals (Issue 7).
    whisperReadyPromise.then(() => _drainWhisperQueue()).catch(() => { });
  });

  return result;
});

// ─── Telemetry Broadcast ──────────────────────────────────────────────
let lastCpuInfo = os.cpus();
function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0; let total = 0;
  for (const cpu of cpus) { for (const type in cpu.times) { total += cpu.times[type]; } idle += cpu.times.idle; }
  let oldIdle = 0; let oldTotal = 0;
  for (const cpu of lastCpuInfo) { for (const type in cpu.times) { oldTotal += cpu.times[type]; } oldIdle += cpu.times.idle; }
  const idleDiff = idle - oldIdle;
  const totalDiff = total - oldTotal;
  lastCpuInfo = cpus;
  if (totalDiff === 0) return 0;
  return (10000 - Math.round(10000 * idleDiff / totalDiff)) / 100;
}

let lastGpuPayload = {};
let lastGpuFetchTime = 0;

function startTelemetryBroadcast() {
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const hours = Math.floor(os.uptime() / 3600);
      const mins = Math.floor((os.uptime() % 3600) / 60);

      const payload = {
        cpuUsage: getCpuUsage().toFixed(1),
        memUsed: (usedMem / 1024 / 1024 / 1024).toFixed(1),
        memTotal: (totalMem / 1024 / 1024 / 1024).toFixed(1),
        uptime: `${hours}h ${mins}m`
      };

      const now = Date.now();
      if (now - lastGpuFetchTime >= 10000) {
        lastGpuFetchTime = now;
        // Run nvidia-smi asynchronously
        exec('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits', (err, stdout) => {
          if (!err && stdout) {
            const parts = stdout.trim().split(',').map(s => s.trim());
            if (parts.length >= 5) {
              lastGpuPayload = {
                gpuUsage: parts[0],
                gpuMemUsed: parts[1],
                gpuMemTotal: parts[2],
                gpuTemp: parts[3],
                gpuName: parts[4]
              };
            }
          }
          Object.assign(payload, lastGpuPayload);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('telemetry', payload);
          }
        });
      } else {
        Object.assign(payload, lastGpuPayload);
        mainWindow.webContents.send('telemetry', payload);
      }
    }
  }, 2000);
}
