'use strict';

// Phase 1 renderer acceptance smoke test.
//
// Runs a hidden Electron window with the real preload, injects the real
// agentClient.js into the page, and drives the same IPC events the main
// process emits. Durable mode is enabled by default:
//
//   npx electron tests/electron-agent-smoke.js
//
// Exits 0 on success, 1 on the first failed check.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-electron-smoke-'));
app.setPath('userData', userDataDir);

function finish(code) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
}

let approved = null;
let approvedExternal = null;
let cancelled = null;

ipcMain.handle('agent-task-start', async (_, request) => ({
  ok: true,
  task: {
    id: 'task_smoke_1',
    goal: request.goal,
    status: 'queued',
    stepCount: 0,
    maxSteps: 15,
    steps: [],
    messages: [],
    approvals: [],
    tainted: false,
    metadata: { runtime: { model: request.model, mode: request.mode, modelOptions: {} } },
  },
}));

const smokeTasks = {
  task_smoke_1: () => ({
    id: 'task_smoke_1',
    goal: 'Inspect the smoke test',
    status: 'waiting_approval',
    stepCount: 1,
    maxSteps: 15,
    steps: [{ id: 'step_1', index: 1, kind: 'model', status: 'completed', text: 'Thinking done' }],
    messages: [],
    approvals: [],
    tainted: false,
    metadata: { runtime: { model: 'llama3.2', mode: 'general', modelOptions: {} } },
  }),
  task_smoke_2: () => ({
    id: 'task_smoke_2',
    goal: 'Digest the notes',
    status: 'waiting_approval',
    stepCount: 0,
    maxSteps: 15,
    steps: [],
    messages: [],
    approvals: [{
      id: 'approval_ext',
      status: 'pending',
      toolCall: { tool: 'write_file', args: { path: 'notes.md' } },
      reason: 'risk=write',
      requestedAt: Date.now(),
    }],
    tainted: false,
    metadata: { runtime: { model: 'llama3.1:8b', mode: 'general', modelOptions: {} } },
  }),
  task_smoke_3: () => ({
    id: 'task_smoke_3',
    goal: 'Background sweep',
    status: 'running',
    stepCount: 1,
    maxSteps: 15,
    steps: [{ id: 'step_bg', index: 1, kind: 'model', status: 'completed', text: 'Scanning' }],
    messages: [],
    approvals: [],
    tainted: false,
    metadata: { runtime: { model: 'llama3.1:8b', mode: 'general', modelOptions: {} } },
  }),
};

ipcMain.handle('agent-task-get', async (_, taskId) => ({
  ok: true,
  events: [],
  task: (smokeTasks[taskId] || smokeTasks.task_smoke_1)(),
}));

ipcMain.handle('agent-task-list', async () => ({
  ok: true,
  tasks: [
    smokeTasks.task_smoke_3(),
    { id: 'task_done', goal: 'An old finished job', status: 'completed', steps: [], approvals: [] },
  ],
}));

ipcMain.handle('agent-task-cancel', async () => {
  cancelled = true;
  return { ok: true, task: { id: 'task_smoke_1', status: 'cancelled', steps: [], approvals: [] } };
});

ipcMain.handle('agent-task-approve', async (_, taskId, options) => {
  if (taskId === 'task_smoke_2') {
    approvedExternal = { taskId, options };
  } else {
    approved = { taskId, options };
  }
  return { ok: true, task: { id: taskId, status: 'running', steps: [], approvals: [] } };
});

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL('data:text/html,<html><body><div id="chat-messages"></div><div id="toast"></div></body></html>');

  const preloadApi = await win.webContents.executeJavaScript(`({
    enabled: window.jarvis.durableAgentEnabled,
    hasStart: typeof window.jarvis.agentTaskStart,
    hasApprove: typeof window.jarvis.agentTaskApprove,
    hasEvents: typeof window.jarvis.onAgentTaskEvent,
  })`);
  check('preload exposes the durable flag', preloadApi.enabled === true, JSON.stringify(preloadApi));
  check(
    'preload exposes durable methods',
    preloadApi.hasStart === 'function'
      && preloadApi.hasApprove === 'function'
      && preloadApi.hasEvents === 'function',
    JSON.stringify(preloadApi)
  );

  await win.webContents.executeJavaScript(`
    window.__jarvisNotices = [];
    window.__toasts = [];
    window.appendJarvisMessage = (text) => { window.__jarvisNotices.push(String(text)); };
    window.showToast = (text, type) => { window.__toasts.push({ text: String(text), type: String(type || '') }); };
    void 0;
  `);
  const clientSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'modules', 'agentClient.js'),
    'utf8'
  );
  await win.webContents.executeJavaScript(`${clientSource}\n;void 0;`);
  const client = await win.webContents.executeJavaScript(`({
    enabled: window.AgentClient.enabled(),
    hasRun: typeof window.AgentClient.runDeepWork,
  })`);
  check('agent client loads and reports enabled', client.enabled === true && client.hasRun === 'function', JSON.stringify(client));

  // ── Supervision of live tasks found at startup (scheduler path) ──
  await wait(100);
  const listed = await win.webContents.executeJavaScript(`({
    surfaced: Boolean(document.querySelector('#agent-task-task_smoke_3')),
    skippedTerminal: !document.querySelector('#agent-task-task_done'),
  })`);
  check('surfaces live tasks found at startup', listed.surfaced === true, JSON.stringify(listed));
  check('skips terminal tasks when listing', listed.skippedTerminal === true, JSON.stringify(listed));

  const started = await win.webContents.executeJavaScript(
    'window.AgentClient.runDeepWork("Inspect the smoke test", { model: "llama3.2" })'
  );
  check('runDeepWork starts a durable task', started && started.ok === true, JSON.stringify(started));
  await wait(50);

  win.webContents.send('agent-task-event', {
    taskId: 'task_smoke_1',
    type: 'step.started',
    at: new Date().toISOString(),
    data: { stepId: 'step_1', index: 1 },
  });
  win.webContents.send('agent-task-event', {
    taskId: 'task_smoke_1',
    type: 'step.completed',
    at: new Date().toISOString(),
    data: { stepId: 'step_1', index: 1, text: 'Thinking done', toolCall: { tool: 'write_note', args: { path: 'x' } } },
  });
  win.webContents.send('agent-task-event', {
    taskId: 'task_smoke_1',
    type: 'approval.requested',
    at: new Date().toISOString(),
    data: {
      approval: {
        id: 'approval_1',
        status: 'pending',
        toolCall: { tool: 'write_note', args: { path: 'x' } },
        reason: 'risk=write',
      },
    },
  });
  await wait(100);

  const dom = await win.webContents.executeJavaScript(`({
    status: document.querySelector('#agent-task-task_smoke_1 .task-status')?.textContent,
    approvalVisible: document.querySelector('#agent-task-task_smoke_1 .task-approval')?.style.display,
    approveButton: typeof document.querySelector('#agent-task-task_smoke_1 [data-approve]')?.click,
  })`);
  check('renders the approval status', /APPROVAL REQUIRED/.test(dom.status || ''), JSON.stringify(dom));
  check('shows the approval panel', dom.approvalVisible === 'block', JSON.stringify(dom));
  check('renders an approve button', dom.approveButton === 'function', JSON.stringify(dom));

  const notice = await win.webContents.executeJavaScript(`({
    chat: (window.__jarvisNotices || []).join('\\n'),
    toasts: (window.__toasts || []).map(entry => entry.text).join('\\n'),
  })`);
  check(
    'announces pending approvals in chat',
    /write_note/.test(notice.chat) && /requires your approval/i.test(notice.chat),
    JSON.stringify(notice)
  );
  check('toasts pending approvals', /write_note/.test(notice.toasts), JSON.stringify(notice));

  await win.webContents.executeJavaScript(
    `document.querySelector('#agent-task-task_smoke_1 [data-approve]').click()`
  );
  await wait(100);
  check('approval reaches the main process', Boolean(approved && approved.options && approved.options.approved === true), JSON.stringify(approved));
  check('approval preserves the original context', Boolean(approved && approved.options.model === 'llama3.2'), JSON.stringify(approved));

  win.webContents.send('agent-task-event', {
    taskId: 'task_smoke_1',
    type: 'task.updated',
    at: new Date().toISOString(),
    data: {
      task: {
        id: 'task_smoke_1',
        status: 'completed',
        result: 'Smoke test complete.',
        steps: [],
        approvals: [{ id: 'approval_1', status: 'approved' }],
        metadata: { runtime: { mode: 'general' } },
      },
    },
  });
  await wait(100);

  const final = await win.webContents.executeJavaScript(`({
    status: document.querySelector('#agent-task-task_smoke_1 .task-status')?.textContent,
    finalVisible: document.querySelector('#agent-task-task_smoke_1 .task-final-output')?.style.display,
    finalText: document.querySelector('#agent-task-task_smoke_1 .task-final-output')?.textContent,
    cancelHidden: document.querySelector('#agent-task-task_smoke_1 .task-cancel')?.hidden,
  })`);
  check('marks the task completed', /COMPLETED/.test(final.status || ''), JSON.stringify(final));
  check(
    'shows the final result',
    final.finalVisible === 'block' && /Smoke test complete/.test(final.finalText || ''),
    JSON.stringify(final)
  );
  check('hides cancel after the task is finished', final.cancelHidden === true, JSON.stringify(final));

  // ── Externally started tasks (headless scheduler path) ───────────
  win.webContents.send('agent-task-event', {
    taskId: 'task_smoke_2',
    type: 'approval.requested',
    at: new Date().toISOString(),
    data: {
      approval: {
        id: 'approval_ext',
        status: 'pending',
        toolCall: { tool: 'write_file', args: { path: 'notes.md' } },
        reason: 'risk=write',
      },
    },
  });
  await wait(150);

  const external = await win.webContents.executeJavaScript(`({
    view: Boolean(document.querySelector('#agent-task-task_smoke_2')),
    approvalVisible: document.querySelector('#agent-task-task_smoke_2 .task-approval')?.style.display,
  })`);
  check(
    'surfaces approvals for externally started tasks',
    external.view === true && external.approvalVisible === 'block',
    JSON.stringify(external)
  );

  await win.webContents.executeJavaScript(
    `document.querySelector('#agent-task-task_smoke_2 [data-approve]').click()`
  );
  await wait(100);
  check(
    'external approval reaches the main process',
    Boolean(approvedExternal && approvedExternal.taskId === 'task_smoke_2' && approvedExternal.options.approved === true),
    JSON.stringify(approvedExternal)
  );

  win.webContents.send('agent-task-event', {
    taskId: 'task_smoke_2',
    type: 'task.updated',
    at: new Date().toISOString(),
    data: {
      task: {
        id: 'task_smoke_2',
        status: 'completed',
        result: 'Scheduled digest ready.',
        steps: [],
        approvals: [{ id: 'approval_ext', status: 'approved' }],
        metadata: { runtime: { mode: 'general' } },
      },
    },
  });
  await wait(100);

  const externalFinal = await win.webContents.executeJavaScript(`({
    finalText: document.querySelector('#agent-task-task_smoke_2 .task-final-output')?.textContent,
  })`);
  check(
    'shows results for externally started tasks',
    /Scheduled digest ready/.test(externalFinal.finalText || ''),
    JSON.stringify(externalFinal)
  );

  console.log('PASS — renderer durable-agent smoke checks');
  finish(0);
}).catch(error => {
  console.error('FAIL', error);
  finish(1);
});
