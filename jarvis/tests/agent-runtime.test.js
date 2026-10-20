'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../core/runtime/task-store');
const { AgentRuntime } = require('../core/runtime/agent-runtime');
const { ModelGateway } = require('../core/models/model-gateway');
const { PromptBuilder } = require('../core/context/prompt-builder');
const { TASK_STATUS } = require('../core/runtime/task-state');

function makeAdapter(responses) {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request);
      if (request.signal?.aborted) throw request.signal.reason || new Error('aborted');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(request);
      if (next === undefined) throw new Error('No scripted response');
      return next;
    },
  };
}

async function makeHarness({
  responses = [],
  policyDecision = { decision: 'allow' },
  maxSteps = 5,
  execute = null,
} = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-runtime-test-'));
  const store = new TaskStore({ baseDir });
  await store.init();

  const adapter = makeAdapter(responses);
  const model = new ModelGateway({ adapter, timeoutMs: 1000 });
  const promptBuilder = new PromptBuilder({ maxSystemChars: 12000, maxHistoryChars: 12000 });
  const toolCalls = [];
  const tools = {
    definitions: [{
      name: 'echo',
      description: 'Echo text',
      parameters: { text: { type: 'string', required: true } },
    }],
    calls: toolCalls,
    async execute(call, context) {
      toolCalls.push({ call, context });
      if (execute) return execute(call, context);
      if (call.tool === 'fail') return { ok: false, error: 'boom' };
      return { ok: true, result: `echo:${call.args.text}` };
    },
  };
  const policy = {
    calls: [],
    decision: policyDecision,
    async authorize(input) {
      this.calls.push(input);
      if (typeof this.decision === 'function') return this.decision(input);
      return this.decision;
    },
  };
  const runtime = new AgentRuntime({ store, model, promptBuilder, tools, policy });
  const task = await store.createTask({ goal: 'test goal', maxSteps });

  return { baseDir, store, model, tools, policy, runtime, task, adapter };
}

function cleanup(harness) {
  fs.rmSync(harness.baseDir, { recursive: true, force: true });
}

test('completes a task with a final model response', async () => {
  const harness = await makeHarness({
    responses: [{ text: 'All done.', toolCalls: [] }],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.result, 'All done.');
    assert.equal(final.stepCount, 1);
    assert.equal(final.startedAt !== null, true);
    assert.equal(final.finishedAt !== null, true);

    const events = await harness.store.readEvents(harness.task.id);
    assert.equal(events.some(event => event.type === 'step.started'), true);
    assert.equal(events.some(event => event.type === 'step.completed'), true);
    assert.equal(events.some(event => event.type === 'task.transition'), true);
  } finally {
    cleanup(harness);
  }
});

test('executes a native tool call and continues the loop', async () => {
  const harness = await makeHarness({
    responses: [
      {
        text: 'Calling the tool.',
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'hi' } }],
      },
      { text: 'Finished.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.result, 'Finished.');
    assert.equal(harness.tools.calls.length, 1);
    assert.deepEqual(harness.tools.calls[0].call.args, { text: 'hi' });
    assert.equal(final.steps.some(step => step.kind === 'tool' && step.status === 'completed'), true);
    assert.equal(final.messages.some(message => message.role === 'tool' && message.content.includes('echo:hi')), true);
    assert.equal(harness.adapter.calls.length, 2);
  } finally {
    cleanup(harness);
  }
});

test('executes a fallback text tool call', async () => {
  const harness = await makeHarness({
    responses: [
      { text: '<tool_call>{"tool":"echo","args":{"text":"fallback"}}</tool_call>' },
      { text: 'Fallback complete.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(harness.tools.calls.length, 1);
    assert.equal(harness.tools.calls[0].call.tool, 'echo');
    assert.equal(final.messages.some(message => message.role === 'user' && message.content.includes('echo:fallback')), true);
  } finally {
    cleanup(harness);
  }
});

test('does not execute a tool when policy denies it', async () => {
  const harness = await makeHarness({
    responses: [
      {
        text: 'Trying.',
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'no' } }],
      },
      { text: 'The tool was denied.' },
    ],
    policyDecision: { decision: 'deny', reason: 'not permitted' },
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(harness.tools.calls.length, 0);
    assert.equal(final.messages.some(message => message.content.includes('denied')), true);
    assert.equal(harness.policy.calls.length, 1);
  } finally {
    cleanup(harness);
  }
});

test('pauses for approval, executes the approved tool, and resumes', async () => {
  const harness = await makeHarness({
    responses: [
      {
        text: 'Need permission.',
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'approved' } }],
      },
      { text: 'Approved and complete.' },
    ],
    policyDecision: ({ toolCall }) => (
      toolCall.tool === 'echo'
        ? { decision: 'require_approval', reason: 'write action', taint: true }
        : { decision: 'allow' }
    ),
  });
  try {
    const paused = await harness.runtime.runTask(harness.task.id);

    assert.equal(paused.status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal(paused.approvals.length, 1);
    assert.equal(paused.approvals[0].status, 'pending');
    assert.equal(paused.approvals[0].taint, true);
    assert.equal(paused.tainted, false);
    assert.equal(harness.tools.calls.length, 0);

    const final = await harness.runtime.approveTask(harness.task.id, { approved: true });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(harness.tools.calls.length, 1);
    assert.equal(final.tainted, true);
    assert.equal(final.approvals[0].status, 'approved');
    assert.equal(final.approvals[0].consumedAt !== null, true);
    assert.equal(final.messages.some(message => message.content.includes('echo:approved')), true);
    assert.equal(harness.adapter.calls.length, 2);
  } finally {
    cleanup(harness);
  }
});

test('cancels a task when approval is denied', async () => {
  const harness = await makeHarness({
    responses: [{
      text: 'Need permission.',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'denied' } }],
    }],
    policyDecision: { decision: 'require_approval', reason: 'write action' },
  });
  try {
    const paused = await harness.runtime.runTask(harness.task.id);
    assert.equal(paused.status, TASK_STATUS.WAITING_APPROVAL);

    const final = await harness.runtime.approveTask(harness.task.id, {
      approved: false,
      reason: 'user denied',
    });

    assert.equal(final.status, TASK_STATUS.CANCELLED);
    assert.equal(final.approvals[0].status, 'denied');
    assert.equal(harness.tools.calls.length, 0);
  } finally {
    cleanup(harness);
  }
});

test('fails cleanly at the step cap', async () => {
  const harness = await makeHarness({
    responses: [{
      text: 'Keep going.',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'loop' } }],
    }],
    maxSteps: 1,
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.match(final.error, /Step cap/);
    assert.equal(harness.tools.calls.length, 1);
  } finally {
    cleanup(harness);
  }
});

test('records model failures and tool failures', async () => {
  const modelFailure = await makeHarness({ responses: [new Error('model down')] });
  try {
    const final = await modelFailure.runtime.runTask(modelFailure.task.id);
    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.match(final.error, /model down/);
  } finally {
    cleanup(modelFailure);
  }

  const toolFailure = await makeHarness({
    responses: [
      {
        text: 'Trying.',
        toolCalls: [{ id: 'call_1', name: 'fail', arguments: {} }],
      },
      { text: 'Recovered.' },
    ],
  });
  try {
    const final = await toolFailure.runtime.runTask(toolFailure.task.id);
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.steps.some(step => step.kind === 'tool' && step.status === 'failed'), true);
    assert.equal(final.messages.some(message => message.content.includes('boom')), true);
  } finally {
    cleanup(toolFailure);
  }
});

test('cancels an in-flight model request', async () => {
  const harness = await makeHarness({
    responses: [({ signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })],
  });
  try {
    const run = harness.runtime.runTask(harness.task.id);
    await new Promise(resolve => setTimeout(resolve, 25));

    const cancelled = await harness.runtime.cancelTask(harness.task.id, 'test cancellation');
    const final = await run;

    assert.equal(cancelled.status, TASK_STATUS.CANCELLED);
    assert.equal(final.status, TASK_STATUS.CANCELLED);
  } finally {
    cleanup(harness);
  }
});

test('marks orphaned steps and resumes an interrupted task', async () => {
  const harness = await makeHarness({
    responses: [{ text: 'Recovered.' }],
  });
  try {
    await harness.store.transition(harness.task.id, TASK_STATUS.RUNNING);
    await harness.store.updateTask(harness.task.id, draft => {
      draft.steps.push({
        id: 'step_orphaned',
        index: 1,
        kind: 'tool',
        tool: 'echo',
        status: 'started',
        startedAt: Date.now(),
      });
    });

    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.steps.find(step => step.id === 'step_orphaned').status, 'unknown');
    assert.equal(final.messages.some(message => message.content.includes('RUNTIME NOTICE')), true);

    const events = await harness.store.readEvents(harness.task.id);
    assert.equal(events.some(event => event.type === 'runtime.recovered'), true);
  } finally {
    cleanup(harness);
  }
});

test('retries a failed task and clears the prior error', async () => {
  const harness = await makeHarness({
    responses: [{ text: 'Retry complete.' }],
  });
  try {
    await harness.store.transition(harness.task.id, TASK_STATUS.RUNNING);
    await harness.store.transition(harness.task.id, TASK_STATUS.FAILED, {
      patch: { error: 'old failure' },
    });

    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.error, null);
    assert.equal(final.result, 'Retry complete.');
  } finally {
    cleanup(harness);
  }
});
