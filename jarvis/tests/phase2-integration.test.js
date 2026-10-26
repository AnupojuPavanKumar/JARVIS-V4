'use strict';

// Phase 2 integration: the core scheduler starts a durable, background-
// restricted task through the real AgentController, and the real unified
// MemoryStore receives the verified procedure after completion. No model or
// renderer is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerAgentController = require('../backend/controllers/AgentController');
const registerMemoryController = require('../backend/controllers/MemoryController');
const { TaskStore } = require('../core/runtime/task-store');
const { TASK_STATUS } = require('../core/runtime/task-state');
const { MemoryStore } = require('../core/memory/memory-store');
const { Scheduler } = require('../core/scheduler/scheduler');
const { PolicyEngine } = require('../core/policy/policy-engine');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('scheduler runs headlessly as a restricted task and writes verified procedural memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase2-integration-'));
  const handlers = new Map();
  let store = null;
  try {
    const memory = new MemoryStore({ baseDir: dir });
    await memory.init();
    let liveMemory = null;

    const ipcMain = { handle(channel, handler) { handlers.set(channel, handler); } };
    const app = { getPath() { return dir; } };
    let createdRuntime = null;
    const controller = registerAgentController({
      ipcMain,
      app,
      secAudit() {},
      secCheckRate() { return true; },
      mainWindowProvider() { return null; },
      listModels: async () => ['llama3.1:8b'],
      // The real main process registers controllers during startup and the
      // store is created immediately before. The provider form also prevents a
      // future registration-order regression from silently detaching memory.
      memoryStoreProvider: () => liveMemory,
      taskStoreFactory(baseDir) {
        store = new TaskStore({ baseDir });
        return store;
      },
      toolRegistryFactory() {
        return { load: async () => ({ ok: true }), listDefinitions: () => [] };
      },
      createRuntime({ store: taskStore }) {
        createdRuntime = { runTask() {} };
        return {
          runTask(taskId) {
            return (async () => {
              await taskStore.transition(taskId, TASK_STATUS.RUNNING, { reason: 'runtime-start' });
              await taskStore.updateTask(taskId, task => {
                task.steps.push({
                  id: 'step_tool_1',
                  kind: 'tool',
                  tool: 'system_metrics',
                  status: 'completed',
                  args: { target: 'cpu' },
                  result: { ok: true },
                });
                task.stepCount = task.steps.length;
                return task;
              });
              return taskStore.transition(taskId, TASK_STATUS.COMPLETED, {
                reason: 'runtime-finished',
                patch: { result: 'Scheduled work completed and measured.' },
              });
            })();
          },
          async cancelTask(taskId, reason) {
            return taskStore.transition(taskId, TASK_STATUS.CANCELLED, { reason });
          },
          async approveTask() {
            return null;
          },
        };
      },
    });
    await controller.ensureReady();
    liveMemory = memory;
    assert.equal(controller.getMemoryStore(), memory);

    const events = [];
    const scheduler = new Scheduler({
      baseDir: dir,
      startTask: job => controller.startTaskFromJob(job),
      getTask: taskId => store.getTask(taskId),
      onRunEvent: event => events.push(event),
    });
    await scheduler.init();
    const job = await scheduler.addJob({
      name: 'scheduled integration',
      type: 'one-off',
      payload: { goal: 'Back up the project notes' },
      triggerTime: Date.now() - 1,
    });

    await scheduler.tick();
    assert.ok(createdRuntime);
    const run = scheduler.listRuns()[0];
    assert.ok(run.taskId);
    const task = await store.getTask(run.taskId);
    assert.equal(task.source, 'schedule');
    assert.equal(task.permissions.profile, 'background-restricted');
    assert.equal(task.goal, 'Back up the project notes');
    assert.ok(task.metadata.schedule);

    let completedTask = task;
    let procedures = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      completedTask = await store.getTask(run.taskId);
      procedures = await memory.list({ type: 'procedure' });
      if (completedTask.status === TASK_STATUS.COMPLETED && procedures.length > 0) break;
      await delay(50);
    }

    assert.equal(completedTask.status, TASK_STATUS.COMPLETED);
    assert.equal(procedures.length, 1);
    assert.equal(procedures[0].verification.status, 'verified');
    assert.equal(procedures[0].source.taskId, run.taskId);
    assert.match(procedures[0].text, /Back up the project notes/);

    // The scheduler polls the real task and records the result. Wait for the
    // completion event as well as the run state: the state is updated before
    // the scheduler finishes persisting and emits the event.
    let schedulerRun = null;
    let completedEvent = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      schedulerRun = scheduler.listRuns().find(candidate => candidate.id === run.id);
      completedEvent = events.find(event =>
        event.type === 'run.completed' && (!event.run || event.run.id === run.id)
      );
      if (schedulerRun && schedulerRun.status === 'completed' && completedEvent) break;
      await delay(50);
    }
    assert.equal(schedulerRun.status, 'completed');
    assert.match(schedulerRun.result, /Scheduled work completed/);
    assert.ok(completedEvent);

    // The one-off job remains as an audit record but is no longer active.
    const savedJob = scheduler.listJobs().find(candidate => candidate.id === job.id);
    assert.equal(savedJob.active, false);
    assert.equal(savedJob.lastRunStatus, 'completed');
  } finally {
    if (store) store = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory controller resolves the store provider after app startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase2-memory-provider-'));
  const handlers = new Map();
  let liveStore = null;
  try {
    const memory = new MemoryStore({ baseDir: dir });
    await memory.init();
    registerMemoryController({
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
      app: {},
      JarvisMemory: {},
      MemoryStoreProvider: () => liveStore,
    });

    const before = await handlers.get('memory-load')({});
    assert.equal(before.ok, false);
    assert.match(before.error, /unavailable/);

    liveStore = memory;
    const added = await handlers.get('memory-add')({}, {
      text: 'User prefers provider-backed memory',
      type: 'preference',
    });
    assert.equal(added.ok, true);
    const loaded = await handlers.get('memory-load')({});
    assert.equal(loaded.ok, true);
    assert.equal(loaded.records.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('background-restricted writes require approval when available and fail closed when not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase2-policy-'));
  try {
    const store = new TaskStore({ baseDir: path.join(dir, 'tasks') });
    await store.init();
    const task = await store.createTask({
      goal: 'Write a background report',
      source: 'schedule',
      permissions: { profile: 'background-restricted' },
      maxSteps: 5,
    });
    await store.transition(task.id, TASK_STATUS.RUNNING, { reason: 'test' });
    const toolCall = { tool: 'write_file', args: { path: 'report.txt', content: 'x' } };
    const skill = { name: 'write_file', risk: 'write' };

    const unapproved = new PolicyEngine({ taskStore: store, backgroundApprovalAvailable: false });
    const denied = await unapproved.authorize({ taskId: task.id, toolCall, skill });
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.reason, 'background-write-without-approval-channel');

    const approved = new PolicyEngine({ taskStore: store, backgroundApprovalAvailable: true });
    const pending = await approved.authorize({ taskId: task.id, toolCall, skill });
    assert.equal(pending.decision, 'require_approval');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
