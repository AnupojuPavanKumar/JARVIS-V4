'use strict';

// Phase 1 integration smoke test.
//
// Unlike electron-agent-smoke.js, this test uses the real AgentController,
// TaskStore, AgentRuntime, IPC handlers, preload, and renderer page. Only the
// model and tool registry are deterministic fakes. It verifies that a durable
// task survives both a renderer reload and a window close, and that the next
// renderer reattaches to the still-running task.
//
//   npx electron tests/electron-phase1-smoke.js
//
// Exits 0 on success, 1 on the first failed check.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentRuntime } = require('../core/runtime/agent-runtime');
const { PromptBuilder } = require('../core/context/prompt-builder');
const registerAgentController = require('../backend/controllers/AgentController');

app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase1-smoke-'));
app.setPath('userData', userDataDir);

// A window may be destroyed between the close and reopen parts of the test.
// Do not let Electron quit while no window exists.
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

function waitForAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

let modelCalls = 0;
let failNext = false;
const runtimeEvents = [];
let currentWindow = null;

const fakeRegistry = {
  loaded: true,
  definitions: [],
  async load() {
    return { ok: true, skills: [] };
  },
  listDefinitions() {
    return [];
  },
  getSkill() {
    return null;
  },
  async execute() {
    throw new Error('No tool should run in this smoke test');
  },
};

function createDeterministicRuntime({
  store,
  registry,
  policy,
  promptBuilder,
  onEvent,
}) {
  const model = {
    async chat({ signal, messages }) {
      modelCalls += 1;
      const planningRequest = String(messages?.[0]?.content || '').includes('planning component');
      if (failNext && planningRequest) {
        throw new Error('deterministic planner failure for Phase 1 smoke');
      }
      if (failNext) {
        failNext = false;
        throw new Error('deterministic model failure for Phase 1 smoke');
      }
      await waitForAbort(2500, signal);
      return {
        text: `Phase 1 task ${modelCalls} completed after renderer recovery.`,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  };

  return new AgentRuntime({
    store,
    model,
    promptBuilder,
    tools: registry,
    policy,
    onEvent,
  });
}

registerAgentController({
  ipcMain,
  app,
  mainWindowProvider: () => currentWindow,
  createRuntime: createDeterministicRuntime,
  toolRegistryFactory: () => fakeRegistry,
  listModels: async () => ['llama3.1:8b'],
  secAudit: () => {},
  secCheckRate: () => true,
  onAgentEvent: event => runtimeEvents.push(event),
});

// The renderer also asks the rest of the app for its normal startup data.
// Keep this integration test focused on the agent by answering benignly.
const benignHandlers = {
  'memory-load': { ok: true, records: [], facts: [], stats: { total: 0 } },
  'memory-retrieve': { ok: true, context: '', records: [], chars: 0, budget: { maxChars: 1800, maxRecords: 6 } },
  'memory-record-conversation': { ok: true, episode: null, extractedCount: 0, stats: { total: 0 } },
  'get-runtime-stats': { ok: false },
  'get-system-info': { ok: true, cpuModel: 'smoke', cpuCores: 8, totalMemGB: 16, osName: 'smoke' },
  'ollama-fetch': { ok: false, error: 'smoke' },
  'history-list': { ok: true, data: [] },
  'skills-list': { ok: true, skills: [] },
  'security-get': { ok: true, state: 'no-lock', capabilities: {}, legacy: { detected: false } },
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
  'get-user-data-path': userDataDir,
  'history-save': { ok: true },
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

async function createRendererWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  currentWindow = win;
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(500);
  return win;
}

async function reloadRenderer(win) {
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.reload();
  await loaded;
  await wait(500);
}

async function startTask(win, goal) {
  return win.webContents.executeJavaScript(`(async () => {
    window.state.deepWorkEnabled = true;
    window.state.ollamaOnline = true;
    await window.sendMessage(${JSON.stringify(goal)});
    const id = window.AgentClient.getCurrentTaskId();
    const result = id ? await window.jarvis.agentTaskGet(id) : null;
    return { ok: Boolean(id && result && result.ok), task: result && result.task };
  })()`);
}

async function getTask(win, taskId) {
  return win.webContents.executeJavaScript(`window.jarvis.agentTaskGet(${JSON.stringify(taskId)})`);
}

async function waitForStatus(win, taskId, wanted, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await getTask(win, taskId);
    if (latest && latest.ok && latest.task && latest.task.status === wanted) return latest;
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${taskId} to reach ${wanted}: ${JSON.stringify(latest)}`);
}

app.whenReady().then(async () => {
  let win = await createRendererWindow();

  const boot = await win.webContents.executeJavaScript(`({
    hasClient: Boolean(window.AgentClient && window.AgentClient.enabled()),
    hasState: Boolean(window.state),
  })`);
  check('real renderer loads the durable agent client', boot.hasClient, JSON.stringify(boot));
  check('renderer state is available', boot.hasState, JSON.stringify(boot));

  // ── Reload while a task is running ─────────────────────────────
  const first = await startTask(win, 'Phase 1 reload persistence test');
  check('renderer starts a durable task', first && first.ok && first.task && first.task.id, JSON.stringify(first));
  const firstId = first.task.id;
  await waitForStatus(win, firstId, 'running');

  await reloadRenderer(win);
  const afterReload = await win.webContents.executeJavaScript(`({
    currentTaskId: window.AgentClient.getCurrentTaskId(),
    view: Boolean(document.getElementById('agent-task-${firstId}')),
  })`);
  check('renderer reattaches to the running task after reload', afterReload.currentTaskId === firstId && afterReload.view, JSON.stringify(afterReload));

  const firstFinal = await waitForStatus(win, firstId, 'completed');
  check(
    'task completes after the renderer reload',
    /completed after renderer recovery/.test(firstFinal.task.result || ''),
    JSON.stringify(firstFinal.task)
  );
  const firstDom = await win.webContents.executeJavaScript(`document.querySelector('#agent-task-${firstId} .task-final-output')?.textContent || ''`);
  check('reloaded renderer renders the final result', /completed after renderer recovery/.test(firstDom), JSON.stringify(firstDom));

  // ── Close the window while a task is running ───────────────────
  const second = await startTask(win, 'Phase 1 window-close persistence test');
  check('renderer starts the second durable task', second && second.ok && second.task && second.task.id, JSON.stringify(second));
  const secondId = second.task.id;
  await waitForStatus(win, secondId, 'running');

  currentWindow = null;
  win.destroy();
  await wait(300);

  win = await createRendererWindow();
  const afterClose = await win.webContents.executeJavaScript(`({
    currentTaskId: window.AgentClient.getCurrentTaskId(),
    view: Boolean(document.getElementById('agent-task-${secondId}')),
  })`);
  check('new renderer reattaches to the task after window close', afterClose.currentTaskId === secondId && afterClose.view, JSON.stringify(afterClose));

  const secondFinal = await waitForStatus(win, secondId, 'completed');
  check(
    'task completes after the window was closed and reopened',
    /completed after renderer recovery/.test(secondFinal.task.result || ''),
    JSON.stringify(secondFinal.task)
  );

  // ── Cancel from the renderer ───────────────────────────────────
  const third = await startTask(win, 'Phase 1 renderer cancellation test');
  check('renderer starts a cancellable task', third && third.ok && third.task && third.task.id, JSON.stringify(third));
  const thirdId = third.task.id;
  await waitForStatus(win, thirdId, 'running');
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#agent-task-${thirdId} .task-cancel');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check('renderer exposes a cancel control for a running task', clicked === true, String(clicked));
  const cancelled = await waitForStatus(win, thirdId, 'cancelled');
  check('cancellation from the renderer reaches the durable runtime', cancelled.task.status === 'cancelled', JSON.stringify(cancelled.task));

  // ── Failed task is recorded and visible ─────────────────────────
  failNext = true;
  const fourth = await startTask(win, 'Phase 1 failed-task visibility test');
  check('renderer starts a task that will fail', fourth && fourth.ok && fourth.task && fourth.task.id, JSON.stringify(fourth));
  const fourthId = fourth.task.id;
  const failed = await waitForStatus(win, fourthId, 'failed');
  const failedView = await win.webContents.executeJavaScript(`({
    status: document.querySelector('#agent-task-${fourthId} .task-status')?.textContent || '',
    final: document.querySelector('#agent-task-${fourthId} .task-final-output')?.textContent || '',
  })`);
  check('failed task status is persisted', failed.task.status === 'failed', JSON.stringify(failed.task));
  check(
    'failed task error is visible in the renderer',
    /FAILED/i.test(failedView.status) && /ERROR/i.test(failedView.final) && /deterministic model failure/.test(failedView.final),
    JSON.stringify(failedView)
  );

  const completed = new Set(
    runtimeEvents
      .filter(event => event.type === 'task.updated' && event.data?.task?.status === 'completed')
      .map(event => event.taskId)
  );
  check(
    'runtime emitted completed updates for both tasks',
    completed.has(firstId) && completed.has(secondId),
    JSON.stringify(runtimeEvents.map(event => `${event.taskId}:${event.type}`))
  );

  console.log('PASS - Phase 1 reload/window-close integration checks');
  finish(0);
}).catch(error => {
  console.error('FAIL', error);
  finish(1);
});
