'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../core/runtime/task-store');
const { TASK_STATUS } = require('../core/runtime/task-state');
const { PolicyEngine } = require('../core/policy/policy-engine');

const readSkill = { id: 'read_file', risk: 'read', untrusted: false };
const webSkill = { id: 'web_read', risk: 'read', untrusted: true };
const writeSkill = { id: 'write_file', risk: 'write', untrusted: false };
const destructiveSkill = { id: 'delete_file', risk: 'destructive', untrusted: false };

async function makeStore(options = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-policy-test-'));
  const store = new TaskStore({ baseDir });
  await store.init();
  return { baseDir, store, options };
}

async function runningTask(store, options = {}) {
  const task = await store.createTask({ goal: 'policy task', maxSteps: 5, ...options });
  return store.transition(task.id, TASK_STATUS.RUNNING);
}

test('allows a read on a running task and marks untrusted reads as taint', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await runningTask(store);
    const policy = new PolicyEngine({ taskStore: store });

    const allowed = await policy.authorize({
      taskId: task.id,
      toolCall: { tool: 'read_file', args: { path: 'a.txt' } },
      skill: readSkill,
    });
    assert.deepEqual(allowed, { decision: 'allow', taint: false });

    const untrusted = await policy.authorize({
      taskId: task.id,
      toolCall: { tool: 'web_read', args: {} },
      skill: webSkill,
    });
    assert.deepEqual(untrusted, { decision: 'allow', taint: true });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('requires approval for writes, destructive actions, tainted tasks, and unknown risk', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await runningTask(store);
    const policy = new PolicyEngine({ taskStore: store });

    const write = await policy.authorize({
      taskId: task.id,
      toolCall: { tool: 'write_file', args: { path: 'a.txt' } },
      skill: writeSkill,
    });
    assert.equal(write.decision, 'require_approval');
    assert.equal(write.reason, 'risk=write');

    const destructive = await policy.authorize({
      taskId: task.id,
      toolCall: { tool: 'delete_file', args: { path: 'a.txt' } },
      skill: destructiveSkill,
    });
    assert.equal(destructive.decision, 'require_approval');
    assert.equal(destructive.reason, 'risk=destructive');

    const mystery = await policy.authorize({
      taskId: task.id,
      toolCall: { tool: 'mystery', args: {} },
      skill: { id: 'mystery', risk: 'network' },
    });
    assert.equal(mystery.decision, 'require_approval');
    assert.equal(mystery.reason, 'risk=network');

    await store.updateTask(task.id, draft => { draft.tainted = true; });
    const tainted = await policy.authorize({
      taskId: task.id,
      toolCall: { tool: 'read_file', args: {} },
      skill: readSkill,
    });
    assert.equal(tainted.decision, 'require_approval');
    assert.equal(tainted.reason, 'tainted-task');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('denies tools for tasks that are not running and enforces the tool cap', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const queued = await store.createTask({ goal: 'queued', maxSteps: 5 });
    const policy = new PolicyEngine({ taskStore: store });

    const notRunning = await policy.authorize({
      taskId: queued.id,
      toolCall: { tool: 'read_file', args: {} },
      skill: readSkill,
    });
    assert.equal(notRunning.decision, 'deny');
    assert.match(notRunning.reason, /task-not-running/);

    const capped = await runningTask(store, { maxSteps: 1 });
    await store.updateTask(capped.id, draft => {
      draft.steps.push({ id: 'tool_1', kind: 'tool', status: 'completed' });
    });
    const toolCap = await policy.authorize({
      taskId: capped.id,
      toolCall: { tool: 'read_file', args: {} },
      skill: readSkill,
    });
    assert.equal(toolCap.decision, 'deny');
    assert.equal(toolCap.reason, 'tool-cap');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('rate-limits throwaway reads and denies throwaway writes', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const policy = new PolicyEngine({
      taskStore: store,
      untrackedReadLimit: 1,
      untrackedWindowMs: 60000,
    });

    const first = await policy.authorize({
      toolCall: { tool: 'read_file', args: {} },
      skill: readSkill,
    });
    assert.equal(first.decision, 'allow');
    assert.equal(first.throwaway, true);

    const second = await policy.authorize({
      toolCall: { tool: 'read_file', args: {} },
      skill: readSkill,
    });
    assert.equal(second.decision, 'deny');
    assert.equal(second.reason, 'untracked-rate-limit');

    const write = await policy.authorize({
      toolCall: { tool: 'write_file', args: {} },
      skill: writeSkill,
    });
    assert.equal(write.decision, 'deny');
    assert.equal(write.reason, 'unknown-task');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('rejects invalid tool calls and unknown tools', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await runningTask(store);
    const policy = new PolicyEngine({ taskStore: store });

    assert.deepEqual(
      await policy.authorize({ taskId: task.id, toolCall: null, skill: readSkill }),
      { decision: 'deny', reason: 'invalid-tool-call' }
    );
    assert.deepEqual(
      await policy.authorize({ taskId: task.id, toolCall: { tool: 'read_file' }, skill: null }),
      { decision: 'deny', reason: 'unknown-tool' }
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
