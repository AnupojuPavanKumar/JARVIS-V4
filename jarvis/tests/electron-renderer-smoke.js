'use strict';

// Renderer boot smoke test.
//
// Loads the real renderer/index.html in a hidden Electron window with the real
// preload, then verifies the dashboard renders instead of leaving a blank
// window. Guards against regressions like the dropped `dashProductivity`
// builder and the missing `WakeWord` object.
//
//   npx electron tests/electron-renderer-smoke.js
//
// Exits 0 on success, 1 on the first failed check.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-renderer-smoke-'));
app.setPath('userData', userDataDir);

function finish(code) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
}

const consoleLines = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The renderer init path calls several IPC handlers; reply benignly so the
// page can settle without a swarm of rejected invokes aborting init.
const benignHandlers = {
  'settings-load': { ok: true, data: null },
  'get-system-info': { ok: true, cpuModel: 'smoke', cpuCores: 8, totalMemGB: 16, osName: 'smoke' },
  'get-user-data-path': userDataDir,
  'ollama-check': { ok: false, online: false },
  'list-history': { ok: true, data: [] },
  'auth-load': { ok: true, data: { hasPin: false, skipPin: true } },
  'skills-list': { ok: true, skills: [] },
  'sec-config-load': { ok: true, config: {} },
  'memory-load': { ok: true, facts: [] },
  'notes-load': { ok: true, content: '' },
  'run-command': { ok: true, stdout: '', stderr: '' },
  'get-runtime-stats': { ok: false },
  'ollama-fetch': { ok: false, error: 'smoke' },
  'history-list': { ok: true, data: [] },
};
for (const [channel, response] of Object.entries(benignHandlers)) {
  ipcMain.handle(channel, async () => response);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof message === 'string'
      ? message
      : (event && typeof event.message === 'string' ? event.message : '');
    if (text) consoleLines.push(text);
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(1500);

  const boot = await win.webContents.executeJavaScript(`({
    dashboardLength: (document.getElementById('dashboard-area')?.innerHTML || '').length,
    generalRendered: Boolean(document.querySelector('#dashboard-area .mode-dashboard')),
    sidebarButtons: document.querySelectorAll('#sidebar-modes .mode-btn').length,
    wakeWordType: typeof window.WakeWord,
    toggleWakeType: typeof window.toggleWakeWord,
    jarvisSecSaveType: typeof window.JarvisSec?.save,
    jarvisMemorySaveType: typeof window.jarvisMemory?.save,
  })`);

  check('sidebar mode buttons are built', boot.sidebarButtons === 8, JSON.stringify(boot));
  check('general dashboard renders content', boot.generalRendered && boot.dashboardLength > 200, JSON.stringify(boot));
  check('WakeWord module is loaded', boot.wakeWordType === 'object', JSON.stringify(boot));
  check('toggleWakeWord is callable', boot.toggleWakeType === 'function', JSON.stringify(boot));
  check('JarvisSec is exposed for data-action handlers', boot.jarvisSecSaveType === 'function', JSON.stringify(boot));
  check('jarvisMemory is exposed for procedural memory', boot.jarvisMemorySaveType === 'function', JSON.stringify(boot));

  const referenced = consoleLines.filter(line =>
    /dashProductivity is not defined|WakeWord is not defined/.test(line));
  check('no dangling dashboard/wake references', referenced.length === 0, JSON.stringify(referenced));

  await win.webContents.executeJavaScript(`document.getElementById('mode-btn-productivity').click()`);
  await wait(400);

  const prod = await win.webContents.executeJavaScript(`({
    prodRendered: Boolean(document.querySelector('#dashboard-area .dash-prod')),
    pomoCanvas: Boolean(document.getElementById('pomo-canvas')),
    pomoTime: document.getElementById('pomo-time')?.textContent || '',
    tasksList: Boolean(document.getElementById('tasks-list')),
    tbList: Boolean(document.getElementById('tb-list')),
  })`);

  check('productivity dashboard renders', prod.prodRendered, JSON.stringify(prod));
  check('pomodoro canvas is mounted', prod.pomoCanvas, JSON.stringify(prod));
  check('pomodoro display is initialized', prod.pomoTime === '25:00', JSON.stringify(prod));
  check('task list is mounted', prod.tasksList, JSON.stringify(prod));
  check('time blocks list is mounted', prod.tbList, JSON.stringify(prod));

  console.log('PASS — renderer boot smoke checks');
  finish(0);
}).catch(error => {
  console.error('FAIL', error);
  finish(1);
});
