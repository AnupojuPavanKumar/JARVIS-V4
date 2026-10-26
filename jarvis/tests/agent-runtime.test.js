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
const { PolicyEngine } = require('../core/policy/policy-engine');

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
  now = Date.now,
  goal = 'test goal',
  taskOptions = {},
  capabilities = null,
  verifier = null,
  planner = null,
  extraDefinitions = [],
} = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-runtime-test-'));
  const store = new TaskStore({ baseDir, now });
  await store.init();

  const adapter = makeAdapter(responses);
  const model = new ModelGateway({ adapter, timeoutMs: 1000, capabilities });
  const promptBuilder = new PromptBuilder({ maxSystemChars: 12000, maxHistoryChars: 12000 });
  const toolCalls = [];
  const tools = {
    definitions: [{
      name: 'echo',
      description: 'Echo text',
      parameters: { text: { type: 'string', required: true } },
    }, {
      name: 'fail',
      description: 'Fail deliberately',
      risk: 'read',
      parameters: {},
    }, ...extraDefinitions],
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
    backgroundApprovalAvailable: true,
    async authorize(input) {
      this.calls.push(input);
      if (typeof this.decision === 'function') return this.decision(input);
      return this.decision;
    },
  };
  const runtime = new AgentRuntime({
    store,
    model,
    promptBuilder,
    tools,
    policy,
    now,
    ...(verifier ? { verifier } : {}),
    ...(planner ? { planner } : {}),
  });
  const task = await store.createTask({ goal, maxSteps, ...taskOptions });

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

test('executes a seeded real-metric tool call and completes without asking the model', async () => {
  const harness = await makeHarness({
    execute: async () => ({
      ok: true,
      summaryText: 'GPU 1 over 30s: avg 2.0%',
      displayMarkdown: '### GPU 1 — 30s\\n\\n| Metric | Average |\\n| --- | ---: |\\n| GPU 1 utilization | 2.0% |',
    }),
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, {
      initialToolCall: {
        tool: 'system_metrics',
        args: { target: 'gpu 1 usage, dedicated memory', duration_sec: 30 },
      },
      completeWithToolResult: true,
    });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.match(final.result, /### GPU 1 — 30s/);
    assert.equal(final.stepCount, 1);
    assert.equal(final.steps.length, 1);
    assert.equal(final.steps[0].kind, 'tool');
    assert.equal(final.steps[0].seeded, true);
    assert.equal(final.steps[0].tool, 'system_metrics');
    assert.equal(harness.adapter.calls.length, 0);
    assert.equal(harness.tools.calls.length, 1);
    assert.deepEqual(harness.tools.calls[0].call.args, {
      target: 'gpu 1 usage, dedicated memory',
      duration_sec: 30,
    });
  } finally {
    cleanup(harness);
  }
});

test('passes seeded measured data to the model for an analytical goal', async () => {
  const harness = await makeHarness({
    responses: [{ text: 'The measured GPU load was low.' }],
    execute: async () => ({
      ok: true,
      agentText: '### GPU 1 — 30s\n| GPU 1 utilization | 2.0% |',
      displayMarkdown: '### GPU 1 — 30s\n| GPU 1 utilization | 2.0% |',
    }),
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, {
      initialToolCall: {
        tool: 'system_metrics',
        args: { target: 'gpu 1', duration_sec: 30 },
      },
      completeWithToolResult: false,
    });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.result, 'The measured GPU load was low.');
    assert.equal(harness.adapter.calls.length, 1);
    assert.equal(final.messages.some(message => (
      message.role === 'user' && message.content.includes('| GPU 1 utilization | 2.0% |')
    )), true);
    assert.equal(final.messages.some(message => message.content.includes('[RUNTIME NOTE]')), true);
  } finally {
    cleanup(harness);
  }
});

test('fails a seeded task when the real measurement is unavailable', async () => {
  const harness = await makeHarness({
    execute: async () => ({ ok: false, error: 'nvidia-smi unavailable' }),
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, {
      initialToolCall: {
        tool: 'system_metrics',
        args: { target: 'gpu 1', duration_sec: 30 },
      },
      completeWithToolResult: true,
    });

    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.match(final.error, /nvidia-smi unavailable/);
    assert.equal(harness.adapter.calls.length, 0);
    assert.equal(final.messages.some(message => message.content.includes('RAM')), false);
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

test('executes a JSON-schema fallback tool call without text tags', async () => {
  const harness = await makeHarness({
    responses: [
      { text: '```json\n{"tool":"echo","args":{"text":"fallback"}}\n```' },
      { text: 'Fallback complete.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, { toolMode: 'json' });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(harness.tools.calls.length, 1);
    assert.equal(harness.tools.calls[0].call.tool, 'echo');
    assert.match(harness.adapter.calls[0].messages[0].content, /JSON FALLBACK/);
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

test('uses native tools by default and sends no tool schemas in JSON fallback mode', async () => {
  const native = await makeHarness({
    responses: [
      { text: 'Calling.', toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'native' } }] },
      { text: 'Native done.' },
    ],
    capabilities: { tools: true, contextLength: 4096, maxOutputTokens: 512 },
  });
  try {
    const final = await native.runtime.runTask(native.task.id);
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.ok(native.adapter.calls[0].tools.length > 0);
  } finally {
    cleanup(native);
  }

  const fallback = await makeHarness({
    responses: [
      { text: '{"tool":"echo","args":{"text":"json"}}' },
      { text: 'JSON done.' },
    ],
    capabilities: { tools: false, contextLength: 4096, maxOutputTokens: 512 },
  });
  try {
    const final = await fallback.runtime.runTask(fallback.task.id);
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(fallback.adapter.calls[0].tools.length, 0);
    assert.match(fallback.adapter.calls[0].messages[0].content, /JSON FALLBACK/);
    assert.equal(fallback.tools.calls[0].call.tool, 'echo');
  } finally {
    cleanup(fallback);
  }
});

test('downgrades to JSON fallback when the provider rejects native tools', async () => {
  const harness = await makeHarness({
    responses: [
      new Error('model does not support tools'),
      { text: '{"tool":"echo","args":{"text":"downgraded"}}' },
      { text: 'Downgraded done.' },
    ],
    capabilities: { tools: true, contextLength: 4096, maxOutputTokens: 512 },
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(harness.adapter.calls[1].tools.length, 0);
    assert.equal(harness.tools.calls.length, 1);
    const events = await harness.store.readEvents(harness.task.id);
    assert.equal(events.some(event => event.type === 'tool-mode.fallback'), true);
  } finally {
    cleanup(harness);
  }
});

test('rejects invalid tool arguments before execution', async () => {
  const harness = await makeHarness({
    responses: [
      { text: 'Invalid args.', toolCalls: [{ id: 'call_1', name: 'echo', arguments: {} }] },
      { text: 'Corrected without the tool.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(harness.tools.calls.length, 0);
    assert.equal(final.messages.some(message => message.content.includes('Missing required param')), true);
    assert.equal(final.steps.some(step => step.kind === 'tool' && step.status === 'failed'), true);
  } finally {
    cleanup(harness);
  }
});

test('fails explicitly with context-overflow instead of silently truncating an impossible prompt', async () => {
  const harness = await makeHarness({
    goal: 'x'.repeat(19000),
    capabilities: { tools: true, contextLength: 512, maxOutputTokens: 256 },
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, {
      modelOptions: { num_ctx: 512, num_predict: 256 },
    });

    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'context-overflow');
    assert.match(final.error, /tokens/);
    assert.equal(harness.adapter.calls.length, 0);
  } finally {
    cleanup(harness);
  }
});

test('enforces token and time caps with structured failure codes', async () => {
  const tokenHarness = await makeHarness({
    taskOptions: { maxTokens: 10 },
    responses: [{
      text: 'Too expensive.',
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
    }],
  });
  try {
    const final = await tokenHarness.runtime.runTask(tokenHarness.task.id);
    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'token-cap');
  } finally {
    cleanup(tokenHarness);
  }

  let clock = 1000;
  const timeHarness = await makeHarness({
    now: () => clock,
    taskOptions: { maxDurationMs: 100 },
    responses: [({ signal }) => {
      if (signal?.aborted) throw signal.reason;
      clock += 250;
      return { text: 'Too late.' };
    }],
  });
  try {
    const final = await timeHarness.runtime.runTask(timeHarness.task.id);
    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'time-cap');
  } finally {
    cleanup(timeHarness);
  }
});

test('detects repeated identical tool calls before executing the third one', async () => {
  const call = {
    text: 'Again.',
    toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'same' } }],
  };
  const harness = await makeHarness({
    responses: [{ ...call }, { ...call }, { ...call }],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id);

    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'loop-detected');
    assert.equal(harness.tools.calls.length, 2);
  } finally {
    cleanup(harness);
  }
});

test('auto-retries read-only tools once but never auto-retries a write', async () => {
  let flakyAttempts = 0;
  const readHarness = await makeHarness({
    responses: [
      { text: 'Try.', toolCalls: [{ id: 'call_1', name: 'flaky', arguments: {} }] },
      { text: 'Read recovered.' },
    ],
    extraDefinitions: [{ name: 'flaky', description: 'Flaky read', risk: 'read', parameters: {} }],
    execute: async call => {
      if (call.tool === 'flaky') {
        flakyAttempts += 1;
        return flakyAttempts === 1 ? { ok: false, error: 'transient' } : { ok: true, result: 'read-ok' };
      }
      return { ok: true, result: 'ok' };
    },
  });
  try {
    const final = await readHarness.runtime.runTask(readHarness.task.id);
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    const toolStep = final.steps.find(step => step.kind === 'tool' && step.tool === 'flaky');
    assert.equal(toolStep.attempts.length, 2);
    assert.equal(toolStep.status, 'completed');
    const events = await readHarness.store.readEvents(readHarness.task.id);
    assert.equal(events.some(event => event.type === 'tool.retry'), true);
  } finally {
    cleanup(readHarness);
  }

  let writeAttempts = 0;
  const writeHarness = await makeHarness({
    responses: [
      { text: 'Write.', toolCalls: [{ id: 'call_1', name: 'write_thing', arguments: {} }] },
      { text: 'Write failed but handled.' },
    ],
    extraDefinitions: [{ name: 'write_thing', description: 'Write', risk: 'write', parameters: {} }],
    execute: async call => {
      if (call.tool === 'write_thing') {
        writeAttempts += 1;
        return { ok: false, error: 'disk full' };
      }
      return { ok: true, result: 'ok' };
    },
  });
  try {
    const final = await writeHarness.runtime.runTask(writeHarness.task.id);
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(writeAttempts, 1);
    const toolStep = final.steps.find(step => step.kind === 'tool' && step.tool === 'write_thing');
    assert.equal(toolStep.attempts.length, 1);
  } finally {
    cleanup(writeHarness);
  }
});

test('destructive tools always go through approval', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-runtime-destructive-'));
  const store = new TaskStore({ baseDir });
  await store.init();
  const adapter = makeAdapter([{
    text: 'Delete it.',
    toolCalls: [{ id: 'call_1', name: 'delete_file', arguments: { path: 'x' } }],
  }]);
  const tools = {
    definitions: [{
      name: 'delete_file',
      description: 'Delete a file',
      risk: 'destructive',
      parameters: { path: { type: 'string', required: true } },
    }],
    calls: [],
    async execute(call) {
      this.calls.push(call);
      return { ok: true, result: 'deleted' };
    },
  };
  const policy = new PolicyEngine({ taskStore: store });
  const runtime = new AgentRuntime({
    store,
    model: new ModelGateway({ adapter, timeoutMs: 1000 }),
    promptBuilder: new PromptBuilder(),
    tools,
    policy,
  });
  const task = await store.createTask({ goal: 'Delete a file' });

  try {
    const waiting = await runtime.runTask(task.id);
    assert.equal(waiting.status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal(waiting.approvals[0].reason, 'risk=destructive');
    assert.equal(tools.calls.length, 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('planner creates a plan, updates step status, and closes it on completion', async () => {
  const harness = await makeHarness({
    responses: [
      {
        text: '{"steps":[{"id":"1","description":"Echo the planned value","tool":"echo","dependsOn":[]},{"id":"2","description":"Summarize","dependsOn":["1"]}]}',
      },
      { text: 'Using the plan.', toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'planned' } }] },
      { text: 'Plan complete.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, { usePlanner: true });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.plan.length, 2);
    assert.equal(final.plan[0].status, 'completed');
    assert.equal(final.plan[1].status, 'skipped');
    assert.equal(final.planStatus, 'completed');
    assert.equal(final.currentPlanStepId, null);
    const events = await harness.store.readEvents(harness.task.id);
    assert.equal(events.some(event => event.type === 'plan.created'), true);
    assert.equal(events.some(event => event.type === 'plan.step.completed'), true);
  } finally {
    cleanup(harness);
  }
});

test('does not mark a planned tool complete when the model calls a different tool', async () => {
  const harness = await makeHarness({
    responses: [
      {
        text: '{"steps":[{"id":"1","description":"Echo the planned value","tool":"echo","dependsOn":[]}]}',
      },
      { text: 'Trying another tool.', toolCalls: [{ id: 'call_1', name: 'fail', arguments: {} }] },
      { text: 'The planned action was skipped.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, { usePlanner: true });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.plan[0].status, 'skipped');
    assert.equal(final.planStatus, 'completed');
  } finally {
    cleanup(harness);
  }
});

test('revises one failed plan step instead of rewriting the plan', async () => {
  const harness = await makeHarness({
    responses: [
      {
        text: '{"steps":[{"id":"1","description":"Use the failing tool","tool":"fail","dependsOn":[]},{"id":"2","description":"Finish","dependsOn":["1"]}]}',
      },
      { text: 'Trying.', toolCalls: [{ id: 'call_1', name: 'fail', arguments: {} }] },
      { text: '{"id":"1","description":"Echo a replacement value","tool":"echo","args":{"text":"fixed"},"dependsOn":[]}' },
      { text: 'Trying replacement.', toolCalls: [{ id: 'call_2', name: 'echo', arguments: { text: 'fixed' } }] },
      { text: 'Recovered from the failed step.' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, { usePlanner: true });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.plan[0].revision, 1);
    assert.match(final.plan[0].description, /replacement/i);
    assert.equal(final.plan[0].status, 'completed');
    const events = await harness.store.readEvents(harness.task.id);
    assert.equal(events.some(event => event.type === 'plan.step.revised'), true);
  } finally {
    cleanup(harness);
  }
});

test('invalid plans fall back safely unless the planner is required', async () => {
  const fallback = await makeHarness({
    responses: [
      { text: '{"steps":[{"id":"1","description":"Use a ghost","tool":"ghost","dependsOn":[]}]}' },
      { text: 'Continued without a plan.' },
    ],
  });
  try {
    const final = await fallback.runtime.runTask(fallback.task.id, { usePlanner: true });
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.planStatus, 'invalid');
    assert.equal(final.messages.some(message => message.content.includes('PLAN UNAVAILABLE')), true);
  } finally {
    cleanup(fallback);
  }

  const required = await makeHarness({
    responses: [
      { text: '{"steps":[{"id":"1","description":"Use a ghost","tool":"ghost","dependsOn":[]}]}' },
    ],
  });
  try {
    const final = await required.runtime.runTask(required.task.id, {
      usePlanner: true,
      plannerRequired: true,
    });
    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'plan-invalid');
  } finally {
    cleanup(required);
  }
});

test('plan validation rejects write steps when a background task has no approval channel', async () => {
  const harness = await makeHarness({
    taskOptions: { permissions: { profile: 'background-restricted' } },
    extraDefinitions: [{ name: 'write_thing', description: 'Write', risk: 'write', parameters: {} }],
    responses: [
      { text: '{"steps":[{"id":"1","description":"Write a file","tool":"write_thing","dependsOn":[]}]}' },
    ],
  });
  harness.policy.backgroundApprovalAvailable = false;
  try {
    const final = await harness.runtime.runTask(harness.task.id, {
      usePlanner: true,
      plannerRequired: true,
    });
    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'plan-invalid');
    assert.match(final.error, /no approval channel/);
  } finally {
    cleanup(harness);
  }
});

test('verifier rejects a bad result, then accepts the corrected result', async () => {
  const harness = await makeHarness({
    responses: [
      { text: 'The GPU is definitely at 99%.' },
      { text: '{"verdict":"reject","reason":"unsupported measurement","guidance":"use the tool evidence"}' },
      { text: 'I could not verify that measurement.' },
      { text: '{"verdict":"accept","reason":"the corrected answer is supported"}' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, { verify: true });

    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.result, 'I could not verify that measurement.');
    assert.equal(final.verification.status, 'accepted');
    assert.equal(final.verification.attempts, 2);
    const events = await harness.store.readEvents(harness.task.id);
    assert.equal(events.some(event => event.type === 'verification.rejected'), true);
    assert.equal(events.some(event => event.type === 'verification.accepted'), true);
  } finally {
    cleanup(harness);
  }
});

test('fails with verification-rejected when the verifier rejects twice', async () => {
  const harness = await makeHarness({
    responses: [
      { text: 'Bad answer.' },
      { text: '{"verdict":"reject","reason":"unsupported"}' },
      { text: 'Still bad.' },
      { text: '{"verdict":"reject","reason":"still unsupported"}' },
    ],
  });
  try {
    const final = await harness.runtime.runTask(harness.task.id, { verify: true });
    assert.equal(final.status, TASK_STATUS.FAILED);
    assert.equal(final.errorCode, 'verification-rejected');
  } finally {
    cleanup(harness);
  }
});
