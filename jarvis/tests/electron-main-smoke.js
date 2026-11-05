'use strict';

// Boots the real main.js with an isolated userData directory. This is the only
// smoke that verifies startup ordering: memory is initialized before the IPC
// controllers/scheduler are registered, and the renderer can reach the unified
// store through the real preload bridge.
//
//   npx electron tests/electron-main-smoke.js

const { app, BrowserWindow, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JARVIS_TEST_MODE = '1';
app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-main-smoke-'));
app.setPath('userData', userDataDir);
// This smoke verifies startup ordering and privileged controllers. Use an
// explicit first-run skip fixture so the session starts in the supported
// explicit no-lock state; PIN setup and native skip consent are covered by the
// P0-2 auth tests.
fs.writeFileSync(
  path.join(userDataDir, 'jarvis_auth.json'),
  JSON.stringify({ version: 1, skipPin: true }),
  { mode: 0o600 }
);
app.on('window-all-closed', event => event.preventDefault());

function finish(code) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.destroy(); } catch { /* best effort */ }
  }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await wait(50);
  }
  return null;
}

let finished = false;
const watchdog = setTimeout(() => {
  if (finished) return;
  console.error('FAIL main boot smoke timed out');
  finish(1);
}, 25000);
if (typeof watchdog.unref === 'function') watchdog.unref();

app.whenReady().then(async () => {
  try {
    require('../main');

    const win = await waitFor(() => BrowserWindow.getAllWindows()[0] || null);
    check('real main process creates the application window', Boolean(win));
    win.hide();

    if (win.webContents.isLoading()) {
      await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    }
    await wait(700);

    const bridge = await win.webContents.executeJavaScript(`(async () => {
      const face = await window.jarvis.faceStatus();
      let faceModel = null;
      if (face.modelBaseUrl) {
        try {
          const response = await fetch(face.modelBaseUrl + 'blazeface.json');
          faceModel = { ok: response.ok, status: response.status, bytes: (await response.text()).length };
        } catch (error) {
          faceModel = { ok: false, error: String(error) };
        }
      }
      return {
        memory: await window.jarvis.memoryLoad(),
        scheduler: await window.jarvis.schedulerList(),
        ambient: await window.jarvis.ambientStatus(),
        face,
        faceModel,
        memoryClient: typeof window.jarvisMemory?.getRelevantContext,
        schedulerClient: typeof window.jarvis?.schedulerList,
        ambientClient: typeof window.jarvis?.ambientSetAutoStart
      };
    })()`);

    check('real memory controller is registered after startup', bridge.memory?.ok === true, JSON.stringify(bridge.memory));
    check('real scheduler controller is registered after startup', bridge.scheduler?.ok === true, JSON.stringify(bridge.scheduler));
    check('background presence controller is registered after startup', bridge.ambient?.ok === true && bridge.ambient.supported === true, JSON.stringify(bridge.ambient));
    check('background presence reports a resident scheduler', bridge.ambient?.schedulerRunning === true, JSON.stringify(bridge.ambient));
    check('fresh boot defaults to hidden login start', bridge.ambient?.startHidden === true, JSON.stringify(bridge.ambient));
    const ambientConfig = JSON.parse(fs.readFileSync(path.join(userDataDir, 'ambient-config.json'), 'utf8'));
    check(
      'fresh boot persists the tray-first preference',
      ambientConfig.version === 2 && ambientConfig.startHidden === true,
      JSON.stringify(ambientConfig)
    );
    check('unified memory client is available in the renderer', bridge.memoryClient === 'function');
    check('scheduler client is available in the renderer', bridge.schedulerClient === 'function');
    check('background presence client is available in the renderer', bridge.ambientClient === 'function');
    check('fresh boot has an empty, healthy memory store', Array.isArray(bridge.memory.records) && bridge.memory.records.length === 0);
    check(
      'local face unlock reports available without an enrolled profile',
      bridge.face?.ok === true && bridge.face?.available === true && bridge.face?.enrolled === false,
      JSON.stringify(bridge.face)
    );
    check(
      'local face model server responds over loopback with CSP enabled',
      bridge.faceModel?.ok === true && bridge.faceModel.bytes > 1000,
      JSON.stringify(bridge.faceModel)
    );

    const invalidAutoStart = await win.webContents.executeJavaScript(
      `window.jarvis.ambientSetAutoStart({ enabled: 'yes' })`
    );
    check('background presence rejects invalid auto-start payloads', invalidAutoStart?.ok === false, JSON.stringify(invalidAutoStart));

    powerMonitor.emit('suspend');
    await wait(100);
    const suspended = await win.webContents.executeJavaScript('window.jarvis.ambientStatus()');
    check('sleep hook pauses the background scheduler', suspended?.schedulerRunning === false, JSON.stringify(suspended));
    powerMonitor.emit('resume');
    await wait(250);
    const resumed = await win.webContents.executeJavaScript('window.jarvis.ambientStatus()');
    check(
      'resume hook restarts the scheduler and records the wake time',
      resumed?.schedulerRunning === true && typeof resumed.lastResumeAt === 'string',
      JSON.stringify(resumed)
    );

    const added = await win.webContents.executeJavaScript(
      `window.jarvis.memoryAdd({ text: 'Main boot smoke record', type: 'fact' })`
    );
    check('real main process can write to the unified memory store', added?.ok === true && Boolean(added.record?.id), JSON.stringify(added));
    const loaded = await win.webContents.executeJavaScript('window.jarvis.memoryLoad()');
    check('real main process reads the record back', loaded.records.some(record => record.id === added.record.id));

    const approvedUrl = win.webContents.getURL();
    const windowOpenDenied = await win.webContents.executeJavaScript(`
      window.open('https://example.com/p1-window-open') === null
    `);
    check('window.open is denied by the main renderer window-open policy', windowOpenDenied === true);
    await win.webContents.executeJavaScript(`
      (() => { try { location.href = 'https://example.com/p1-navigation'; } catch (_) {} })()
    `).catch(() => {});
    await wait(400);
    check(
      'external navigation cannot replace the approved renderer document',
      win.webContents.getURL() === approvedUrl,
      win.webContents.getURL()
    );
    const audits = await win.webContents.executeJavaScript('window.jarvis.secAuditRead()');
    check(
      'blocked navigation and window-open attempts are audited',
      audits?.entries?.some(entry => entry.action === 'NAVIGATION_BLOCK') === true
        && audits?.entries?.some(entry => entry.action === 'WINDOW_OPEN_BLOCK') === true,
      JSON.stringify(audits?.entries?.slice(-5))
    );
    check(
      'the real main process reads the durable encrypted audit log',
      audits?.durable === true && audits?.integrity === 'ok',
      JSON.stringify({ durable: audits?.durable, integrity: audits?.integrity, warning: audits?.warning })
    );
    const securityStatus = await win.webContents.executeJavaScript('window.jarvis.securityGet()');
    check(
      'security-get exposes durable audit status to the Security panel',
      securityStatus?.ok === true && securityStatus?.audit?.durable === true,
      JSON.stringify(securityStatus?.audit)
    );
    const auditDir = path.join(userDataDir, 'security-audit');
    const auditFiles = fs.existsSync(auditDir)
      ? fs.readdirSync(auditDir).filter(name => /^audit-\d{8}(?:-\d{2})?\.jsonl$/.test(name))
      : [];
    check(
      'the durable audit directory has an encrypted JSONL file and head checkpoint',
      auditFiles.length > 0 && fs.existsSync(path.join(auditDir, 'audit-head.bin')),
      auditFiles.join(',')
    );
    const auditRaw = auditFiles.length > 0
      ? fs.readFileSync(path.join(auditDir, auditFiles[0]), 'utf8')
      : '';
    check(
      'the durable audit file does not store action names in plaintext',
      auditRaw.length > 0
        && auditRaw.includes('NAVIGATION_BLOCK') === false
        && auditRaw.includes('WINDOW_OPEN_BLOCK') === false
    );

    win.show();
    await waitFor(() => win.isVisible(), 3000);
    win.close();
    await waitFor(() => !win.isDestroyed() && win.isVisible() === false, 3000);
    check(
      'closing the main window hides it to the tray instead of quitting',
      !win.isDestroyed() && win.isVisible() === false,
      `destroyed=${win.isDestroyed()} visible=${win.isVisible()}`
    );
    const resident = await win.webContents.executeJavaScript('window.jarvis.ambientStatus()');
    check(
      'the tray-resident window keeps the scheduler running',
      resident?.schedulerRunning === true && resident?.trayResident === true,
      JSON.stringify(resident)
    );

    app.isQuitting = true;
    win.close();
    await wait(100);
    check('quitting closes the tray-resident window', win.isDestroyed());

    finished = true;
    clearTimeout(watchdog);
    console.log('PASS - real main.js boot, memory, scheduler, and preload checks');
    finish(0);
  } catch (error) {
    finished = true;
    clearTimeout(watchdog);
    console.error(error && error.stack ? error.stack : error);
    finish(1);
  }
});
