'use strict';

// Phase 2 integration smoke test.
//
// This uses the real MemoryStore, MemoryController, SchedulerController,
// AgentController, TaskStore, preload, and renderer. The only deterministic
// replacement is the model runtime: it completes with a successful tool step so
// the verified-procedure path can be asserted without a real model.
//
// It proves that:
//   - a scheduled task runs while the only window is hidden;
//   - another scheduled task runs after the window is destroyed;
//   - jobs/runs/results and memory survive closing and reopening the renderer;
//   - the scheduler and memory panels render their persisted data.
//
//   npx electron tests/electron-phase2-smoke.js

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryStore } = require('../core/memory/memory-store');
const { Scheduler } = require('../core/scheduler/scheduler');
const { TASK_STATUS } = require('../core/runtime/task-state');
const registerMemoryController = require('../backend/controllers/MemoryController');
const registerSchedulerController = require('../backend/controllers/SchedulerController');
const registerAgentController = require('../backend/controllers/AgentController');
const JarvisMemory = require('../memory');

app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase2-smoke-'));
app.setPath('userData', userDataDir);
app.on('window-all-closed', () => {});

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

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await wait(50);
  }
  return null;
}

const benignHandlers = {
  'settings-load': { ok: true, data: null },
  'get-system-info': { ok: true, cpuModel: 'smoke', cpuCores: 8, totalMemGB: 16, osName: 'smoke' },
  'get-user-data-path': userDataDir,
  'ollama-check': { ok: false, online: false },
  'list-history': { ok: true, data: [] },
  'auth-load': { ok: true, state: 'no-lock', status: 'explicit-skip', data: { hasPin: false, skipPin: true, status: 'explicit-skip', recoveredFromBackup: false } },
  'face-status': {
    ok: true,
    available: false,
    enrolled: false,
    enabled: false,
    hasPin: false,
    skipPin: true,
    lockRequired: false,
    samples: 0,
    modelBaseUrl: null,
    error: 'smoke: face models are not used in this test',
  },
  'skills-list': { ok: true, skills: [] },
  'security-get': { ok: true, state: 'no-lock', capabilities: {}, legacy: { detected: false } },
  'notes-load': { ok: true, content: '' },
  'run-command': { ok: true, stdout: '', stderr: '' },
  'get-runtime-stats': { ok: false },
  'ollama-fetch': { ok: false, error: 'smoke' },
  'ambient-status': { ok: true, supported: true, autoStartEnabled: false, schedulerRunning: true },

  'piper-tts': { ok: true },
  'fs-write': { ok: true },
  'voice-status': {
    ok: true,
    wakeWordEnabled: false,
    settingsError: null,
    sessionLocked: false,
    windowVisible: false,
    capture: null,
  },
};
for (const [channel, response] of Object.entries(benignHandlers)) {
  ipcMain.handle(channel, async () => response);
}

let currentWindow = null;
let taskStore = null;
let scheduler = null;
let memoryStore = null;

app.whenReady().then(async () => {
  try {
    JarvisMemory.init(userDataDir);
    memoryStore = new MemoryStore({ baseDir: userDataDir });
    await memoryStore.init();

    const agentController = registerAgentController({
      ipcMain,
      app,
      mainWindowProvider: () => currentWindow,
      listModels: async () => ['llama3.1:8b'],
      toolRegistryFactory: () => ({
        loaded: true,
        definitions: [],
        async load() { return { ok: true, skills: [] }; },
        listDefinitions() { return []; },
        getSkill() { return null; },
        async execute() { throw new Error('No real tool is needed for this smoke test'); },
      }),
      createRuntime({ store }) {
        return {
          runTask(taskId) {
            return (async () => {
              await store.transition(taskId, TASK_STATUS.RUNNING, { reason: 'phase2-smoke-start' });
              await wait(120);
              await store.updateTask(taskId, task => {
                task.steps.push({
                  id: 'step_phase2_tool',
                  kind: 'tool',
                  tool: 'system_metrics',
                  status: 'completed',
                  args: { target: 'cpu' },
                  result: { ok: true, metrics: { cpuPercent: 12 } },
                });
                task.stepCount = task.steps.length;
                return task;
              });
              return store.transition(taskId, TASK_STATUS.COMPLETED, {
                reason: 'phase2-smoke-complete',
                patch: { result: 'Phase 2 scheduled work completed.' },
              });
            })();
          },
          async cancelTask(taskId, reason) {
            return store.transition(taskId, TASK_STATUS.CANCELLED, { reason });
          },
          async approveTask() { return null; },
        };
      },
      secAudit: () => {},
      secCheckRate: () => true,
      memoryStore,
    });

    await agentController.ensureReady();
    taskStore = agentController.getStore();

    // This is the same wiring main.js uses: the scheduler is headless and calls
    // the controller's schedule entry point directly, never the renderer.
    scheduler = new Scheduler({
      baseDir: userDataDir,
      startTask: job => agentController.startTaskFromJob(job),
      getTask: taskId => taskStore.getTask(taskId),
      autoStart: false,
    });

    await scheduler.init();
    registerMemoryController({ ipcMain, app, JarvisMemory, MemoryStore: memoryStore });
    registerSchedulerController({ ipcMain, Scheduler: scheduler });

    currentWindow = await createRendererWindow();
    check('renderer loads with the unified memory client', await currentWindow.webContents.executeJavaScript(
      `typeof window.jarvisMemory?.getRelevantContext === 'function'`
    ));

    const hiddenJob = await scheduler.addJob({
      name: 'hidden window job',
      type: 'one-off',
      payload: { goal: 'Back up the project notes while hidden' },
      triggerTime: Date.now() - 1,
    });
    currentWindow.hide();
    check('the only window is hidden before the scheduled run', currentWindow.isVisible() === false);
    await scheduler.tick();

    const hiddenRun = await waitFor(() => {
      const run = scheduler.listRuns({ jobId: hiddenJob.id })[0];
      return run && run.status === 'completed' ? run : null;
    });
    check('scheduled task completed while the window was hidden', Boolean(hiddenRun), JSON.stringify(scheduler.listRuns()));
    check('scheduled task result was persisted with the run', /Phase 2 scheduled work/.test(hiddenRun.result || ''));

    const procedure = await waitFor(async () => {
      const records = await memoryStore.list({ type: 'procedure' });
      return records.length ? records[0] : null;
    });
    check('completed scheduled task produced a verified procedure', procedure?.verification?.status === 'verified');
    check('procedure is attributed to the scheduled task', procedure?.source?.taskId === hiddenRun.taskId);
    check('task source is schedule', (await taskStore.getTask(hiddenRun.taskId)).source === 'schedule');
    check(
      'scheduled task uses background-restricted permissions',
      (await taskStore.getTask(hiddenRun.taskId)).permissions.profile === 'background-restricted'
    );

    // Destroy the only renderer and run another scheduled task with no window at
    // all. This is the close/reopen persistence boundary.
    currentWindow.destroy();
    currentWindow = null;
    await wait(100);

    await scheduler.addJob({
      name: 'windowless job',
      type: 'one-off',
      payload: { goal: 'Check disk space with no renderer' },
      triggerTime: Date.now() - 1,
    });
    await scheduler.tick();
    const windowlessRun = await waitFor(() => {
      const run = scheduler.listRuns().find(candidate => candidate.jobName === 'windowless job');
      return run && run.status === 'completed' ? run : null;
    }, 8000);
    check('scheduled task completed with no renderer window', Boolean(windowlessRun), JSON.stringify(scheduler.listRuns()));

    currentWindow = await createRendererWindow();
    const persisted = await currentWindow.webContents.executeJavaScript(
      `window.jarvis.schedulerList()`
    );
    check('scheduler jobs survive close/reopen', persisted.ok && persisted.jobs.length >= 2);
    check(
      'scheduler run history and results survive close/reopen',
      persisted.ok && persisted.runs.filter(run => run.status === 'completed').length >= 2
    );

    const loadedMemory = await currentWindow.webContents.executeJavaScript('window.jarvis.memoryLoad()');
    check('verified procedure is visible after close/reopen', loadedMemory.ok && loadedMemory.records.some(
      record => record.type === 'procedure' && record.verification?.status === 'verified'
    ));

    const restartedStore = new MemoryStore({ baseDir: userDataDir });
    const restartedStats = await restartedStore.init();
    check('memory survives a process-restart-style store reload', restartedStats.total >= 2);
    check(
      'verified procedure survives store reload',
      (await restartedStore.list({ type: 'procedure' })).length >= 1
    );

    const added = await currentWindow.webContents.executeJavaScript(
      `window.jarvis.memoryAdd({ text: 'User prefers phase two smoke tests', type: 'preference' })`
    );
    check('manual memory write through IPC succeeds', added.ok && added.record?.id);
    const exported = await currentWindow.webContents.executeJavaScript('window.jarvis.memoryExport()');
    const exportedJson = JSON.parse(exported.json);
    check('memory export includes the new record', exportedJson.records.some(record => record.id === added.record.id));
    const deleted = await currentWindow.webContents.executeJavaScript(
      `window.jarvis.memoryDelete(${JSON.stringify(added.record.id)})`
    );
    check('memory delete through IPC succeeds', deleted.ok && deleted.deleted === true);
    const afterDelete = await currentWindow.webContents.executeJavaScript('window.jarvis.memoryLoad()');
    check('deleted record is gone from the unified store', !afterDelete.records.some(record => record.id === added.record.id));

    const schedulerPanel = await currentWindow.webContents.executeJavaScript(`(async () => {
      window.openSchedulerModal();
      await window.renderSchedulerJobs();
      return document.getElementById('scheduler-list')?.innerText || '';
    })()`);
    check('scheduler panel renders persisted jobs and run status', /hidden window job/.test(schedulerPanel) && /completed/i.test(schedulerPanel));

    const savedSettings = await currentWindow.webContents.executeJavaScript(`(async () => {
      window.openSchedulerModal();
      await new Promise(resolve => setTimeout(resolve, 50));
      document.getElementById('sched-quiet-enabled').checked = true;
      document.getElementById('sched-quiet-start').value = '23:00';
      document.getElementById('sched-quiet-end').value = '06:30';
      document.getElementById('sched-quiet-tz').value = 'UTC';
      document.getElementById('sched-max-runs').value = '2';
      await window.saveSchedulerSettings();
      const list = await window.jarvis.schedulerList();
      return list.settings;
    })()`);
    check(
      'scheduler settings persist quiet hours and interruption limits',
      savedSettings?.quietHours?.enabled === true
        && savedSettings.quietHours.start === '23:00'
        && savedSettings.quietHours.end === '06:30'
        && savedSettings.maxRunsPerHour === 2
    );

    const memoryPanel = await currentWindow.webContents.executeJavaScript(`(async () => {
      await window.MemoryPanel.refresh();
      window.renderMemory();
      return document.getElementById('mem-list')?.innerText || '';
    })()`);
    check('memory panel renders persisted records', /verified procedure/i.test(memoryPanel) || /Back up the project notes/i.test(memoryPanel));

    const editable = await currentWindow.webContents.executeJavaScript(
      `window.jarvis.memoryAdd({ text: 'User likes editable smoke records', type: 'preference' })`
    );
    await currentWindow.webContents.executeJavaScript(`(async () => {
      await window.MemoryPanel.refresh();
      window.memoryEdit(${JSON.stringify(editable.record.id)});
      const input = document.querySelector('.mem-edit-input');
      if (!input) return false;
      input.value = 'User likes corrected smoke records';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    const editedRecord = await waitFor(async () => {
      const loaded = await currentWindow.webContents.executeJavaScript('window.jarvis.memoryLoad()');
      return loaded.records.find(record => (
        record.id === editable.record.id && record.text === 'User likes corrected smoke records'
      ));
    });
    check('memory panel inline edit updates the unified store', Boolean(editedRecord));

    await currentWindow.webContents.executeJavaScript(`(() => {
      window.confirm = () => true;
      window.memoryDelete(${JSON.stringify(editable.record.id)});
      return true;
    })()`);
    const deletedFromPanel = await waitFor(async () => {
      const loaded = await currentWindow.webContents.executeJavaScript('window.jarvis.memoryLoad()');
      return !loaded.records.some(record => record.id === editable.record.id);
    });
    check('memory panel delete removes the unified record', deletedFromPanel);

    scheduler.shutdown();
    console.log('PASS - Phase 2 headless scheduler and unified memory smoke checks');
    finish(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    finish(1);
  }
});

async function createRendererWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(600);
  return win;
}
