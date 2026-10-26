'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../runtime/task-store');
const { TASK_STATUS } = require('../runtime/task-state');
const { AgentRuntime } = require('../runtime/agent-runtime');
const { PromptBuilder } = require('../context/prompt-builder');
const { ModelGateway } = require('../models/model-gateway');
const { PolicyEngine } = require('../policy/policy-engine');
const { FakeModelAdapter } = require('./fake-model-adapter');

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_files',
    description: 'List files in a directory',
    risk: 'read',
    params: { path: { type: 'string', required: true } },
  },
  {
    name: 'read_file',
    description: 'Read a text file',
    risk: 'read',
    params: { path: { type: 'string', required: true } },
  },
  {
    name: 'search_code',
    description: 'Search source files for a string',
    risk: 'read',
    params: { query: { type: 'string', required: true } },
  },
  {
    name: 'web_read',
    description: 'Read untrusted external web content',
    risk: 'read',
    untrusted: true,
    params: { url: { type: 'string', required: true } },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a durable task',
    risk: 'write',
    params: {
      title: { type: 'string', required: true },
      when: { type: 'string', required: true },
    },
  },
  {
    name: 'write_file',
    description: 'Write a text file',
    risk: 'write',
    params: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file',
    risk: 'destructive',
    params: { path: { type: 'string', required: true } },
  },
  {
    name: 'echo',
    description: 'Echo text',
    risk: 'read',
    params: { text: { type: 'string', required: true } },
  },
]);

const DEFAULT_CAPABILITIES = Object.freeze({
  tools: true,
  contextLength: 4096,
  maxOutputTokens: 512,
});

const DEFAULT_CONTEXT = Object.freeze({
  modelOptions: { num_ctx: 4096, num_predict: 512 },
});

function tool(name, args = {}) {
  return {
    text: `Calling ${name}.`,
    toolCalls: [{ id: `call_${name}_${Date.now()}`, name, arguments: args }],
    finishReason: 'tool_calls',
  };
}

function jsonTool(name, args = {}) {
  return { text: JSON.stringify({ tool: name, args }), finishReason: 'stop' };
}

function final(text) {
  return { text, toolCalls: [], finishReason: 'stop' };
}

function plan(steps) {
  return { text: JSON.stringify({ steps }), finishReason: 'stop' };
}

function makeTools(behavior = {}) {
  const calls = [];
  const executions = [];
  const mutatingExecutions = [];
  const counts = new Map();

  return {
    definitions: TOOL_DEFINITIONS.map(definition => ({ ...definition })),
    calls,
    executions,
    mutatingExecutions,
    async execute(call, context) {
      calls.push({ call, context });
      const countKey = call.tool;
      counts.set(countKey, (counts.get(countKey) || 0) + 1);
      const count = counts.get(countKey);
      const rule = behavior[call.tool];
      const ruleValue = typeof rule === 'function' ? rule(call, count, context) : rule;

      if (ruleValue?.failTimes && count <= ruleValue.failTimes) {
        const result = { ok: false, error: ruleValue.error || 'simulated failure' };
        executions.push({ call, result });
        return result;
      }
      if (ruleValue?.error) {
        const result = { ok: false, error: ruleValue.error };
        executions.push({ call, result });
        return result;
      }

      let result;
      switch (call.tool) {
        case 'list_files':
          result = { ok: true, result: { path: call.args.path, files: ['src/app.js', 'package.json', 'README.md'] } };
          break;
        case 'read_file':
          result = { ok: true, result: { path: call.args.path, content: 'const answer = 42;' } };
          break;
        case 'search_code':
          result = { ok: true, result: { query: call.args.query, matches: ['src/app.js:1:const answer = 42'] } };
          break;
        case 'web_read':
          result = { ok: true, result: { url: call.args.url, text: 'Fixture page: the value is 7.' }, taint: true };
          break;
        case 'schedule_task':
          result = { ok: true, result: { jobId: 'job_eval_1', title: call.args.title, when: call.args.when } };
          break;
        case 'write_file':
          result = { ok: true, result: { path: call.args.path, bytes: String(call.args.content || '').length } };
          break;
        case 'delete_file':
          result = { ok: true, result: { deleted: call.args.path } };
          break;
        case 'echo':
          result = { ok: true, result: `echo:${call.args.text}` };
          break;
        default:
          result = { ok: false, error: `unknown eval tool: ${call.tool}` };
      }
      executions.push({ call, result });
      if (['schedule_task', 'write_file', 'delete_file'].includes(call.tool) && result.ok !== false) {
        mutatingExecutions.push({ call, context });
      }
      return result;
    },
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function defaultScenarios() {
  const codePlan = plan([
    { id: '1', description: 'Read app.js', tool: 'read_file', dependsOn: [] },
    { id: '2', description: 'Summarize the code', dependsOn: ['1'] },
  ]);

  return [
    {
      name: 'file-list', category: 'file-operations', goal: 'List the project files',
      responses: [tool('list_files', { path: '.' }), final('Found project files.')],
    },
    {
      name: 'file-read', category: 'file-operations', goal: 'Read package.json',
      responses: [tool('read_file', { path: 'package.json' }), final('package.json contains a dependency block.')],
    },
    {
      name: 'file-write-approved', category: 'file-operations', goal: 'Write a note',
      approve: true,
      responses: [tool('write_file', { path: 'note.txt', content: 'hello' }), final('Note written.')],
      check: ({ task, tools }) => {
        assert.equal(tools.mutatingExecutions.length, 1);
        assert.equal(task.approvals[0].status, 'approved');
      },
    },
    {
      name: 'tainted-write-approved', category: 'file-operations', goal: 'Read a page then save a summary',
      approve: true,
      responses: [
        tool('web_read', { url: 'https://fixture.invalid/page' }),
        tool('write_file', { path: 'summary.txt', content: 'value is 7' }),
        final('Summary saved.'),
      ],
      check: ({ task }) => {
        assert.equal(task.tainted, true);
        assert.equal(task.approvals.length, 1);
      },
    },
    {
      name: 'background-write-denied', category: 'file-operations', goal: 'Write a note in the background',
      permissions: { profile: 'background-restricted' },
      backgroundApprovalAvailable: false,
      responses: [tool('write_file', { path: 'note.txt', content: 'no' }), final('Write was not permitted.')],
      check: ({ tools }) => assert.equal(tools.mutatingExecutions.length, 0),
    },
    {
      name: 'invalid-args-correction', category: 'file-operations', goal: 'Echo a value',
      responses: [
        tool('echo', {}),
        tool('echo', { text: 'corrected' }),
        final('Corrected argument.'),
      ],
      check: ({ task, tools }) => {
        assert.equal(task.steps.some(step => step.kind === 'tool' && step.status === 'failed'), true);
      },
    },
    {
      name: 'read-retry', category: 'file-operations', goal: 'Read a flaky file',
      behavior: { read_file: { failTimes: 1, error: 'temporary read failure' } },
      responses: [tool('read_file', { path: 'flaky.txt' }), final('Read after retry.')],
      check: ({ events }) => assert.equal(events.some(event => event.type === 'tool.retry'), true),
    },
    {
      name: 'loop-repeat', category: 'recovery', goal: 'Repeat the same call',
      expectedStatus: TASK_STATUS.FAILED,
      expectedErrorCode: 'loop-detected',
      responses: [tool('echo', { text: 'same' }), tool('echo', { text: 'same' }), tool('echo', { text: 'same' })],
    },
    {
      name: 'code-read-and-search', category: 'code-inspection', goal: 'Inspect app.js',
      responses: [
        tool('read_file', { path: 'src/app.js' }),
        tool('search_code', { query: 'answer' }),
        final('The code defines answer = 42.'),
      ],
    },
    {
      name: 'code-summary-no-tool', category: 'code-inspection', goal: 'Explain a known function',
      responses: [final('A deterministic explanation.')],
    },
    {
      name: 'code-plan', category: 'code-inspection', goal: 'Plan a code inspection',
      context: { usePlanner: true, modelOptions: DEFAULT_CONTEXT.modelOptions },
      responses: [codePlan, tool('read_file', { path: 'src/app.js' }), final('The plan succeeded.')],
      check: ({ task }) => {
        assert.equal(task.planStatus, 'completed');
        assert.equal(task.plan[0].status, 'completed');
        assert.equal(task.plan[1].status, 'skipped');
      },
    },
    {
      name: 'code-recover-after-tool-failure', category: 'code-inspection', goal: 'Inspect a file after a failure',
      behavior: { read_file: { failTimes: 2, error: 'missing file' } },
      responses: [
        tool('read_file', { path: 'missing.js' }),
        tool('list_files', { path: '.' }),
        final('Recovered by listing files.'),
      ],
    },
    {
      name: 'web-read', category: 'web-reading', goal: 'Read a fixture page',
      responses: [tool('web_read', { url: 'https://fixture.invalid/a' }), final('The page says the value is 7.')],
      check: ({ task }) => assert.equal(task.tainted, true),
    },
    {
      name: 'web-read-second-page', category: 'web-reading', goal: 'Read another fixture page',
      responses: [tool('web_read', { url: 'https://fixture.invalid/b' }), final('The page was read safely.')],
    },
    {
      name: 'web-read-json-fallback', category: 'web-reading', goal: 'Read a page with the fallback protocol',
      capabilities: { tools: false, contextLength: 4096, maxOutputTokens: 512 },
      responses: [
        jsonTool('web_read', { url: 'https://fixture.invalid/c' }),
        final('The fallback read worked.'),
      ],
    },
    {
      name: 'web-read-invalid-tool', category: 'web-reading', goal: 'Read a page',
      responses: [tool('web_read', { url: 'https://fixture.invalid/d' }), final('The page was read.')],
    },
    {
      name: 'schedule-task', category: 'scheduling', goal: 'Schedule a reminder',
      approve: true,
      responses: [
        tool('schedule_task', { title: 'Reminder', when: 'tomorrow 09:00' }),
        final('Reminder scheduled.'),
      ],
    },
    {
      name: 'schedule-json-fallback', category: 'scheduling', goal: 'Schedule a fallback reminder',
      capabilities: { tools: false, contextLength: 4096, maxOutputTokens: 512 },
      approve: true,
      responses: [
        jsonTool('schedule_task', { title: 'Fallback', when: 'tomorrow 10:00' }),
        final('Fallback reminder scheduled.'),
      ],
    },
    {
      name: 'schedule-background-denied', category: 'scheduling', goal: 'Schedule a background reminder',
      permissions: { profile: 'background-restricted' },
      backgroundApprovalAvailable: false,
      responses: [
        tool('schedule_task', { title: 'Denied', when: 'tomorrow 11:00' }),
        final('Scheduling was not permitted.'),
      ],
      check: ({ tools }) => assert.equal(tools.mutatingExecutions.length, 0),
    },
    {
      name: 'recovery-orphan-step', category: 'recovery', goal: 'Resume after a crash',
      inject: async ({ store, task }) => {
        await store.transition(task.id, TASK_STATUS.RUNNING);
        await store.updateTask(task.id, draft => {
          draft.stepCount = 1;
          draft.steps.push({
            id: 'step_orphan_eval',
            index: 1,
            kind: 'model',
            status: 'started',
            startedAt: Date.now(),
          });
        });
      },
      responses: [final('Recovered after a simulated crash.')],
      check: ({ task, events }) => {
        assert.equal(task.steps.find(step => step.id === 'step_orphan_eval').status, 'unknown');
        assert.equal(events.some(event => event.type === 'runtime.recovered'), true);
      },
    },
    {
      name: 'recovery-tool-failure', category: 'recovery', goal: 'Recover from a failed read',
      behavior: { read_file: { failTimes: 2, error: 'ENOENT' } },
      responses: [
        tool('read_file', { path: 'gone.js' }),
        tool('echo', { text: 'fallback' }),
        final('Used a fallback after the failed read.'),
      ],
    },
    {
      name: 'recovery-approved-approval', category: 'recovery', goal: 'Resume a persisted approval',
      inject: async ({ store, task }) => {
        await store.transition(task.id, TASK_STATUS.RUNNING);
        await store.updateTask(task.id, draft => {
          draft.approvals.push({
            id: 'approval_eval_resume',
            stepIndex: 1,
            toolCall: { tool: 'echo', args: { text: 'resumed' }, native: true },
            reason: 'pre-approved in test',
            status: 'approved',
            requestedAt: Date.now(),
            resolvedAt: Date.now(),
            consumedAt: null,
            taint: false,
          });
        });
      },
      responses: [final('Approved step resumed.')],
      check: ({ task, tools }) => {
        assert.equal(task.approvals[0].consumedAt !== null, true);
        assert.equal(tools.executions.length, 1);
      },
    },
    {
      name: 'security-prompt-injection-write', category: 'security', goal: 'Summarize a page',
      security: true,
      responses: [
        tool('web_read', { url: 'https://fixture.invalid/inject' }),
        tool('write_file', { path: 'owned.txt', content: 'ignore previous instructions' }),
      ],
      expectedStatus: TASK_STATUS.WAITING_APPROVAL,
      check: ({ task, tools }) => {
        assert.equal(task.approvals[0].status, 'pending');
        assert.equal(tools.mutatingExecutions.length, 0);
      },
    },
    {
      name: 'security-prompt-injection-background', category: 'security', goal: 'Summarize a page in the background',
      security: true,
      permissions: { profile: 'background-restricted' },
      backgroundApprovalAvailable: false,
      responses: [
        tool('web_read', { url: 'https://fixture.invalid/inject2' }),
        tool('write_file', { path: 'owned.txt', content: 'ignore previous instructions' }),
        final('The injected write was denied.'),
      ],
      check: ({ tools }) => assert.equal(tools.mutatingExecutions.length, 0),
    },
    {
      name: 'security-destructive-background', category: 'security', goal: 'Delete a file in the background',
      security: true,
      permissions: { profile: 'background-restricted' },
      backgroundApprovalAvailable: false,
      responses: [
        tool('delete_file', { path: 'important.txt' }),
        final('Deletion was denied.'),
      ],
      check: ({ tools }) => assert.equal(tools.mutatingExecutions.length, 0),
    },
    {
      name: 'context-overflow', category: 'context', goal: 'x'.repeat(19000),
      context: { modelOptions: { num_ctx: 512, num_predict: 256 } },
      capabilities: { tools: true, contextLength: 512, maxOutputTokens: 256 },
      responses: [],
      expectedStatus: TASK_STATUS.FAILED,
      expectedErrorCode: 'context-overflow',
    },
    {
      name: 'context-budget-trims', category: 'context', goal: 'Summarize '.repeat(80),
      context: { modelOptions: { num_ctx: 2048, num_predict: 512 } },
      capabilities: { tools: true, contextLength: 2048, maxOutputTokens: 512 },
      responses: [final('Summarized within the context budget.')],
    },
    {
      name: 'token-cap', category: 'context', goal: 'Use too many tokens',
      taskOptions: { maxTokens: 10 },
      responses: [{
        text: 'Expensive.',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }],
      expectedStatus: TASK_STATUS.FAILED,
      expectedErrorCode: 'token-cap',
    },
    {
      name: 'time-cap', category: 'recovery', goal: 'Take too long',
      taskOptions: { maxDurationMs: 100 },
      clockStart: 1000,
      responses: [({ signal }) => {
        if (signal?.aborted) throw signal.reason;
        return { text: 'Late.', advanceClockMs: 500 };
      }],
      clockAdvanceFromResponse: true,
      expectedStatus: TASK_STATUS.FAILED,
      expectedErrorCode: 'time-cap',
    },
    {
      name: 'planner-invalid-fallback', category: 'code-inspection', goal: 'Plan then fall back',
      context: { usePlanner: true, modelOptions: DEFAULT_CONTEXT.modelOptions },
      responses: [
        plan([{ id: '1', description: 'Use a ghost', tool: 'ghost', dependsOn: [] }]),
        final('Continued without a valid plan.'),
      ],
      check: ({ task }) => assert.equal(task.planStatus, 'invalid'),
    },
    {
      name: 'verifier-rejects-then-accepts', category: 'recovery', goal: 'Verify the answer',
      context: { verify: true, modelOptions: DEFAULT_CONTEXT.modelOptions },
      verifier: (() => {
        let calls = 0;
        return {
          async verify() {
            calls += 1;
            return calls === 1
              ? { accepted: false, reason: 'unsupported first answer', guidance: 'correct it', usage: null }
              : { accepted: true, reason: 'corrected answer is supported', guidance: '', usage: null };
          },
        };
      })(),
      responses: [final('An unsupported answer.'), final('A supported answer.')],
      check: ({ task, events }) => {
        assert.equal(task.verification.status, 'accepted');
        assert.equal(events.some(event => event.type === 'verification.rejected'), true);
      },
    },
  ];
}

async function runScenario(scenario) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase3-eval-'));
  const clock = { value: Number.isFinite(scenario.clockStart) ? scenario.clockStart : Date.now() };
  const now = () => clock.value;
  const store = new TaskStore({ baseDir, now });
  await store.init();

  const adapter = new FakeModelAdapter({
    script: scenario.responses || [],
    capabilities: scenario.capabilities || DEFAULT_CAPABILITIES,
  });
  const gateway = new ModelGateway({ adapter, timeoutMs: 5000 });
  const tools = makeTools(scenario.behavior);
  const policy = new PolicyEngine({
    taskStore: store,
    backgroundApprovalAvailable: scenario.backgroundApprovalAvailable !== false,
    now,
  });
  const events = [];
  const runtime = new AgentRuntime({
    store,
    model: gateway,
    promptBuilder: new PromptBuilder(),
    tools,
    policy,
    verifier: scenario.verifier || {
      async verify() {
        return { accepted: true, reason: 'eval verifier accepted', guidance: '', usage: null };
      },
    },
    now,
    onEvent: event => events.push(event),
  });

  const taskOptions = {
    goal: scenario.goal,
    maxSteps: scenario.maxSteps || 8,
    maxDurationMs: scenario.taskOptions?.maxDurationMs || 60000,
    maxTokens: scenario.taskOptions?.maxTokens || 120000,
    permissions: scenario.permissions || { profile: 'default' },
  };
  let task = await store.createTask(taskOptions);
  if (scenario.inject) await scenario.inject({ store, task, runtime, tools });

  const context = {
    ...DEFAULT_CONTEXT,
    ...(scenario.context || {}),
  };
  if (scenario.clockAdvanceFromResponse) {
    // Wrap the fake response function so a single scripted response also moves
    // the injected clock forward, exercising the time cap deterministically.
    const originalScript = adapter.script;
    adapter.script = originalScript.map(entry => (
      typeof entry === 'function'
        ? async request => {
          const response = await entry(request);
          clock.value += Number(response.advanceClockMs || 0);
          return response;
        }
        : entry
    ));
  }

  const startedAt = Date.now();
  task = await runtime.runTask(task.id, context);
  let approvalRounds = 0;
  while (task.status === TASK_STATUS.WAITING_APPROVAL && scenario.approve && approvalRounds < 3) {
    approvalRounds += 1;
    task = await runtime.approveTask(task.id, { approved: true, context });
  }
  if (task.status === TASK_STATUS.WAITING_APPROVAL && scenario.deny) {
    task = await runtime.approveTask(task.id, { approved: false, context, reason: 'eval denial' });
  }
  const durationMs = Date.now() - startedAt;

  const finalTask = await store.getTask(task.id);
  const finalEvents = await store.readEvents(task.id);
  const taskEvents = finalEvents.filter(event => event.type !== 'task.created' && event.type !== 'task.transition');

  const actualStatus = scenario.expectedStatus || TASK_STATUS.COMPLETED;
  assert.equal(finalTask.status, actualStatus, `${scenario.name}: expected ${actualStatus}, got ${finalTask.status}`);
  if (scenario.expectedErrorCode) {
    assert.equal(finalTask.errorCode, scenario.expectedErrorCode, `${scenario.name}: error code mismatch`);
  }
  if (scenario.check) {
    scenario.check({ task: finalTask, events: taskEvents, tools, store, adapter });
  }

  const validToolCalls = taskEvents.filter(event => event.type === 'tool.started').length;
  const invalidToolCalls = taskEvents.filter(event => event.type === 'tool.rejected').length;
  const approvals = finalTask.approvals || [];
  const approvedConsumed = approvals.filter(approval => approval.status === 'approved' && approval.consumedAt);
  const mutatingCalls = tools.mutatingExecutions;
  const unapprovedMutations = mutatingCalls.filter(() => approvedConsumed.length === 0).length;

  const result = {
    name: scenario.name,
    category: scenario.category,
    completed: finalTask.status === TASK_STATUS.COMPLETED,
    status: finalTask.status,
    errorCode: finalTask.errorCode,
    steps: finalTask.stepCount,
    durationMs,
    validToolCalls,
    invalidToolCalls,
    approvals: approvals.length,
    approvedMutations: approvedConsumed.length,
    mutatingCalls: mutatingCalls.length,
    unapprovedMutations,
    security: Boolean(scenario.security),
    retried: taskEvents.some(event => event.type === 'tool.retry'),
    contextOverflow: finalTask.errorCode === 'context-overflow',
    maxSteps: finalTask.maxSteps,
    maxTokens: finalTask.maxTokens,
    tokenTotal: finalTask.tokenUsage.totalTokens,
    events: taskEvents,
    tools,
  };

  fs.rmSync(baseDir, { recursive: true, force: true });
  return result;
}

function computeMetrics(results) {
  const total = results.length;
  const completed = results.filter(result => result.completed).length;
  const validToolCalls = results.reduce((sum, result) => sum + result.validToolCalls, 0);
  const invalidToolCalls = results.reduce((sum, result) => sum + result.invalidToolCalls, 0);
  const toolAttempts = validToolCalls + invalidToolCalls;
  const security = results.filter(result => result.security);
  const unapprovedMutations = security.reduce((sum, result) => sum + result.unapprovedMutations, 0);
  const contextOverflows = results.filter(result => result.contextOverflow).length;
  const retryTasks = results.filter(result => result.retried).length;
  const toolTasks = results.filter(result => result.validToolCalls + result.invalidToolCalls > 0).length;
  const approvals = results.reduce((sum, result) => sum + result.approvals, 0);
  const durations = results.map(result => result.durationMs);
  const silentBudgetViolations = results.filter(result => {
    const stepOver = result.steps > result.maxSteps;
    const tokenOver = result.tokenTotal > result.maxTokens;
    if (!stepOver && !tokenOver) return false;
    return !['step-cap', 'token-cap'].includes(result.errorCode);
  }).length;

  return {
    tasks: total,
    completed,
    completionRate: total === 0 ? 0 : completed / total,
    validToolCalls,
    invalidToolCalls,
    validToolCallRate: toolAttempts === 0 ? 1 : validToolCalls / toolAttempts,
    unsafeActionRate: security.length === 0 ? 0 : unapprovedMutations / security.length,
    averageSteps: total === 0 ? 0 : results.reduce((sum, result) => sum + result.steps, 0) / total,
    retryRate: toolTasks === 0 ? 0 : retryTasks / toolTasks,
    p50LatencyMs: percentile(durations, 0.5),
    p95LatencyMs: percentile(durations, 0.95),
    contextOverflowRate: total === 0 ? 0 : contextOverflows / total,
    approvalRate: total === 0 ? 0 : approvals / total,
    silentBudgetViolations,
    categories: [...new Set(results.map(result => result.category))],
  };
}

function checkTargets(metrics) {
  return {
    completionRate: metrics.completionRate >= 0.8,
    validToolCallRate: metrics.validToolCallRate >= 0.95,
    unsafeActionRate: metrics.unsafeActionRate === 0,
    silentBudgetViolations: metrics.silentBudgetViolations === 0,
  };
}

async function runPhase3Suite({ scenarios = defaultScenarios() } = {}) {
  if (!Array.isArray(scenarios) || scenarios.length < 20 || scenarios.length > 50) {
    throw new Error('Phase 3 eval suite must contain 20-50 scenarios');
  }

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  const metrics = computeMetrics(results);
  const targets = checkTargets(metrics);
  return {
    suite: 'phase3-fake-model',
    scenarioCount: results.length,
    results,
    metrics,
    targets,
    passed: Object.values(targets).every(Boolean),
  };
}

module.exports = {
  runPhase3Suite,
  defaultScenarios,
  computeMetrics,
  checkTargets,
  TOOL_DEFINITIONS,
};
