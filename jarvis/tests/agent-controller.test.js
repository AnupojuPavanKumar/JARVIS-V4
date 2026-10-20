'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerAgentController = require('../backend/controllers/AgentController');
const { TaskStore } = require('../core/runtime/task-store');
const { TASK_STATUS } = require('../core/runtime/task-state');

function makeFakeRegistry(ok = true) {
  return {
    loaded: false,
    async load() {
      this.loaded = ok;
      return ok ? { ok: true, skills: [] } : { ok: false, error: 'bad signature' };
    },
    listDefinitions() { return []; },
    getSkill() { return null; },
    async execute() { return { ok: true, result: 'ok' }; },
  };
}

async function setup({ skillsOk = true, holdRun = false, listModels, onAgentEvent = null } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-controller-test-'));
  const handlers = new Map();
  const audit = [];
  const runs = [];
  let store = null;
  let registry = makeFakeRegistry(skillsOk);

  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
  };
  const app = {
    getPath() { return tempDir; },
  };

  const createRuntime = ({ store: taskStore }) => ({
    runTask(taskId, context, options) {
      runs.push({ type: 'run', taskId, context, options });
      if (holdRun) return new Promise(() => {});
      return taskStore.getTask(taskId);
    },
    async cancelTask(taskId, reason) {
      runs.push({ type: 'cancel', taskId, reason });
      return taskStore.transition(taskId, TASK_STATUS.CANCELLED, { reason });
    },
    async approveTask(taskId, options) {
      runs.push({ type: 'approve', taskId, options });
      if (!options.approved) {
        return taskStore.transition(taskId, TASK_STATUS.CANCELLED, { reason: 'denied' });
      }
      return taskStore.transition(taskId, TASK_STATUS.RUNNING, { reason: 'approval-granted' });
    },
  });

  const controller = registerAgentController({
    ipcMain,
    app,
    secAudit(action, detail, verdict) { audit.push({ action, detail, verdict }); },
    secCheckRate() { return true; },
    mainWindowProvider() { return null; },
    createRuntime,
    listModels: listModels || (async () => ['llama3.1:8b', 'all-minilm']),
    onAgentEvent,
    taskStoreFactory(baseDir) {
      store = new TaskStore({ baseDir });
      return store;
    },
    toolRegistryFactory() { return registry; },
  });

  await controller.ensureReady();
  return { tempDir, handlers, store, controller, runs, audit, registry };
}

function cleanup(context) {
  fs.rmSync(context.tempDir, { recursive: true, force: true });
}

test('starts a task, validates input, and persists runtime metadata', async () => {
  const context = await setup();
  try {
    const start = context.handlers.get('agent-task-start');
    const started = await start({}, {
      goal: 'Inspect the workspace',
      model: 'llama3.2',
      maxSteps: 3,
      mode: 'code',
    });

    assert.equal(started.ok, true);
    assert.match(started.task.id, /^task_[a-f0-9]{32}$/);
    assert.equal(started.task.maxSteps, 3);
    assert.equal(started.task.metadata.runtime.model, 'llama3.2');
    assert.equal(started.task.metadata.runtime.mode, 'code');
    assert.equal(context.runs.length, 1);
    assert.equal(context.runs[0].taskId, started.task.id);
    assert.equal(context.runs[0].context.mode, 'code');

    assert.equal((await start({}, { goal: '   ' })).ok, false);
    assert.equal((await start({}, { goal: 'x', model: 'bad model!' })).ok, false);
  } finally {
    cleanup(context);
  }
});

test('lists, gets, and streams events for persisted tasks', async () => {
  const context = await setup();
  try {
    const task = await context.store.createTask({ goal: 'Read me' });

    const list = await context.handlers.get('agent-task-list')({}, {});
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].id, task.id);

    const get = await context.handlers.get('agent-task-get')({}, task.id);
    assert.equal(get.ok, true);
    assert.equal(get.task.id, task.id);
    assert.equal(get.events.some(event => event.type === 'task.created'), true);

    const events = await context.handlers.get('agent-task-events')({}, task.id, { limit: 1 });
    assert.equal(events.ok, true);
    assert.equal(events.events.length, 1);

    assert.equal((await context.handlers.get('agent-task-get')({}, '../bad')).ok, false);
  } finally {
    cleanup(context);
  }
});

test('cancels a task that has no active runtime', async () => {
  const context = await setup();
  try {
    const task = await context.store.createTask({ goal: 'Cancel me' });
    await context.store.transition(task.id, TASK_STATUS.RUNNING);

    const result = await context.handlers.get('agent-task-cancel')({}, task.id, 'test');
    assert.equal(result.ok, true);
    assert.equal(result.task.status, TASK_STATUS.CANCELLED);
  } finally {
    cleanup(context);
  }
});

test('records approval and starts the approved runtime', async () => {
  const context = await setup();
  try {
    const task = await context.store.createTask({
      goal: 'Approve me',
      metadata: { runtime: { model: 'llama3.2', mode: 'general', modelOptions: {} } },
    });
    await context.store.transition(task.id, TASK_STATUS.RUNNING);
    await context.store.transition(task.id, TASK_STATUS.WAITING_APPROVAL, {
      patch: {
        approvals: [{
          id: 'approval_1',
          status: 'pending',
          toolCall: { tool: 'echo', args: {} },
          requestedAt: Date.now(),
        }],
      },
    });

    const result = await context.handlers.get('agent-task-approve')({}, task.id, { approved: true });
    assert.equal(result.ok, true);
    assert.equal(result.task.status, TASK_STATUS.RUNNING);
    assert.equal(context.runs.some(run => run.type === 'approve' && run.options.wait === false), true);
    assert.equal(context.runs.some(run => run.type === 'run' && run.options?.alreadyRunning === true), true);
  } finally {
    cleanup(context);
  }
});

test('denies approval without starting a run', async () => {
  const context = await setup();
  try {
    const task = await context.store.createTask({
      goal: 'Deny me',
      metadata: { runtime: { model: 'llama3.2', mode: 'general', modelOptions: {} } },
    });
    await context.store.transition(task.id, TASK_STATUS.RUNNING);
    await context.store.transition(task.id, TASK_STATUS.WAITING_APPROVAL, {
      patch: {
        approvals: [{
          id: 'approval_1',
          status: 'pending',
          toolCall: { tool: 'echo', args: {} },
          requestedAt: Date.now(),
        }],
      },
    });

    const result = await context.handlers.get('agent-task-approve')({}, task.id, {
      approved: false,
      reason: 'no',
    });
    assert.equal(result.ok, true);
    assert.equal(result.task.status, TASK_STATUS.CANCELLED);
    assert.equal(context.runs.some(run => run.type === 'run'), false);
  } finally {
    cleanup(context);
  }
});

test('resumes an interrupted task and rejects terminal or approval states', async () => {
  const context = await setup();
  try {
    const interrupted = await context.store.createTask({ goal: 'Resume me' });
    await context.store.transition(interrupted.id, TASK_STATUS.RUNNING);
    await context.store.transition(interrupted.id, TASK_STATUS.INTERRUPTED);

    const resumed = await context.handlers.get('agent-task-resume')({}, interrupted.id, {});
    assert.equal(resumed.ok, true);
    assert.equal(context.runs.some(run => run.type === 'run' && run.taskId === interrupted.id), true);

    const completed = await context.store.createTask({ goal: 'Done' });
    await context.store.transition(completed.id, TASK_STATUS.RUNNING);
    await context.store.transition(completed.id, TASK_STATUS.COMPLETED);
    const rejected = await context.handlers.get('agent-task-resume')({}, completed.id, {});
    assert.equal(rejected.ok, false);
  } finally {
    cleanup(context);
  }
});

test('fails closed when the skills manifest is invalid', async () => {
  const context = await setup({ skillsOk: false });
  try {
    const started = await context.handlers.get('agent-task-start')({}, { goal: 'No tools' });
    assert.equal(started.ok, false);
    assert.match(started.error, /Skills unavailable/);

    const list = await context.handlers.get('agent-task-list')({}, {});
    assert.equal(list.ok, true);
    assert.deepEqual(list.tasks, []);
  } finally {
    cleanup(context);
  }
});

test('starts durable tasks from scheduler jobs (headless path)', async () => {
  const context = await setup();
  try {
    const scheduled = await context.controller.startTaskFromJob({
      id: 'job_abc',
      name: 'Nightly digest',
      payload: { goal: 'Summarize the notes', maxSteps: 2, mode: 'research' },
    });
    assert.equal(scheduled.ok, true);
    assert.equal(scheduled.task.source, 'scheduler');
    assert.equal(scheduled.task.maxSteps, 2);
    assert.equal(scheduled.task.metadata.schedule.id, 'job_abc');
    assert.equal(scheduled.task.metadata.schedule.name, 'Nightly digest');
    assert.equal(scheduled.task.metadata.runtime.mode, 'research');
    // No model was pinned, so an installed chat model is resolved.
    assert.equal(scheduled.task.metadata.runtime.model, 'llama3.1:8b');
    assert.equal(context.runs.length, 1);
    assert.equal(context.runs[0].taskId, scheduled.task.id);
    assert.equal(context.runs[0].context.mode, 'research');

    // The scheduler modal stores its prompt in payload.text.
    const viaText = await context.controller.startTaskFromJob({
      id: 'job_text',
      name: 'Text job',
      payload: { text: 'Say hello to the user' },
    });
    assert.equal(viaText.ok, true);
    assert.equal(viaText.task.source, 'scheduler');
    assert.equal(viaText.task.goal, 'Say hello to the user');
    assert.equal(viaText.task.metadata.schedule.name, 'Text job');

    // An explicit model in the payload wins over resolution.
    const pinned = await context.controller.startTaskFromJob({
      id: 'job_pinned',
      name: 'Pinned model',
      payload: { goal: 'Use phi3', model: 'phi3:mini' },
    });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.task.metadata.runtime.model, 'phi3:mini');

    // A recurring fire is skipped while a task from the same job is active.
    const duplicate = await context.controller.startTaskFromJob({
      id: 'job_abc',
      name: 'Nightly digest',
      payload: { goal: 'Summarize the notes', maxSteps: 2, mode: 'research' },
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /still queued/);
    assert.equal(context.runs.length, 3);

    // Jobs without a goal are refused without creating a task.
    const refused = await context.controller.startTaskFromJob({
      id: 'job_empty',
      name: 'Empty job',
      payload: {},
    });
    assert.equal(refused.ok, false);
    assert.equal(context.runs.length, 3);
    assert.equal(
      context.audit.some(entry => entry.action === 'AGENT_TASK_SCHEDULE' && entry.verdict === 'DENY'),
      true
    );
  } finally {
    cleanup(context);
  }
});

test('falls back to the default model when the installed-model probe fails', async () => {
  const context = await setup({ listModels: async () => null });
  try {
    const result = await context.controller.startTaskFromJob({
      id: 'job_offline',
      name: 'Offline job',
      payload: { goal: 'Try anyway' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.task.metadata.runtime.model, 'llama3.2');
  } finally {
    cleanup(context);
  }
});

test('exposes startTask for non-IPC callers', async () => {
  const context = await setup();
  try {
    const direct = await context.controller.startTask({ goal: 'Direct goal' });
    assert.equal(direct.ok, true);
    assert.equal(direct.task.source, 'agent-task');
    assert.equal(context.runs.length, 1);

    const invalid = await context.controller.startTask({ goal: '' });
    assert.equal(invalid.ok, false);
    assert.equal(context.runs.length, 1);
  } finally {
    cleanup(context);
  }
});

test('forwards runtime events to the main-process notification hook', async () => {
  const events = [];
  const context = await setup({ onAgentEvent: event => events.push(event) });
  try {
    const started = await context.controller.startTask({ goal: 'Notify on approval' });
    assert.equal(started.ok, true);
    events.length = 0;

    const cancelled = await context.handlers.get('agent-task-cancel')({}, started.task.id, 'test');
    assert.equal(cancelled.ok, true);
    assert.equal(
      events.some(event => event.type === 'task.updated' && event.taskId === started.task.id),
      true
    );
  } finally {
    cleanup(context);
  }
});
