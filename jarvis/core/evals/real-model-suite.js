'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../runtime/task-store');
const { TASK_STATUS } = require('../runtime/task-state');
const { AgentRuntime } = require('../runtime/agent-runtime');
const { PromptBuilder } = require('../context/prompt-builder');
const { ModelGateway } = require('../models/model-gateway');
const { OllamaAdapter } = require('../models/ollama-adapter');
const { PolicyEngine } = require('../policy/policy-engine');
const { recommendModel } = require('../models/model-router');

const FIXTURE_TEXT = 'P3-SECRET-42\nsecond line';
const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'echo',
    description: 'Echo text back to the caller',
    risk: 'read',
    params: { text: { type: 'string', required: true } },
  },
  {
    name: 'read_file',
    description: 'Read a text fixture file',
    risk: 'read',
    params: { path: { type: 'string', required: true } },
  },
  {
    name: 'list_files',
    description: 'List fixture files',
    risk: 'read',
    params: { path: { type: 'string', required: true } },
  },
]);

const TASKS = Object.freeze([
  {
    name: 'native-echo',
    goal: 'Call the echo tool with text "phase3-native". Then reply with exactly the tool output.',
    check: ({ task, tools }) => tools.calls.some(call => call.tool === 'echo')
      && String(task.result || '').includes('phase3-native'),
  },
  {
    name: 'read-fixture',
    goal: 'Use read_file to read fixture.txt, then reply with the exact secret token from the file.',
    check: ({ task, tools }) => tools.calls.some(call => call.tool === 'read_file')
      && String(task.result || '').includes('P3-SECRET-42'),
  },
  {
    name: 'no-tool-answer',
    goal: 'Reply with exactly READY and nothing else.',
    check: ({ task }) => String(task.result || '').trim() === 'READY',
  },
  {
    name: 'two-step-tools',
    goal: 'Use read_file on fixture.txt, then use echo with the word done. Reply that both steps finished.',
    check: ({ task, tools }) => {
      const names = tools.calls.map(call => call.tool);
      return names.includes('read_file') && names.includes('echo') && task.status === TASK_STATUS.COMPLETED;
    },
  },
  {
    name: 'list-fixture',
    goal: 'Use list_files on . and report the file names you received. Do not guess.',
    check: ({ task, tools }) => tools.calls.some(call => call.tool === 'list_files')
      && /fixture\.txt/i.test(String(task.result || '')),
  },
]);

function makeTools() {
  const calls = [];
  const definitions = new PromptBuilder().buildToolDefinitions(TOOL_DEFINITIONS);
  return {
    definitions,
    calls,
    getSkill(name) {
      const definition = TOOL_DEFINITIONS.find(tool => tool.name === name);
      if (!definition) return null;
      return {
        id: definition.name,
        description: definition.description,
        params: definition.params,
        risk: definition.risk || 'read',
        untrusted: Boolean(definition.untrusted),
      };
    },
    async execute(call) {
      calls.push(call);
      if (call.tool === 'echo') return { ok: true, result: `echo:${call.args.text}` };
      if (call.tool === 'read_file') {
        const requested = String(call.args.path || '').replace(/\\\\/g, '/');
        const base = requested.split('/').filter(Boolean).pop();
        if (base !== 'fixture.txt') {
          return { ok: false, error: `fixture not found: ${call.args.path}` };
        }
        return { ok: true, result: { path: call.args.path, content: FIXTURE_TEXT } };
      }
      if (call.tool === 'list_files') {
        return { ok: true, result: { path: call.args.path, files: ['fixture.txt'] } };
      }
      return { ok: false, error: `unknown fixture tool: ${call.tool}` };
    },
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

async function runModel({ model, adapterFactory, baseUrl, numCtx, numPredict, maxDurationMs, timeoutMs }) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase3-real-eval-'));
  const store = new TaskStore({ baseDir });
  await store.init();
  const adapter = adapterFactory
    ? adapterFactory({ model })
    : new OllamaAdapter({
      model,
      baseUrl,
      defaultOptions: { num_ctx: numCtx, num_predict: numPredict, temperature: 0 },
    });
  const gateway = new ModelGateway({ adapter, timeoutMs });
  const capabilities = await gateway.getCapabilities().catch(error => ({
    tools: false,
    contextLength: numCtx,
    maxOutputTokens: numPredict,
    probeError: error.message,
  }));
  const results = [];

  try {
    for (const taskDef of TASKS) {
      const tools = makeTools();
      const policy = new PolicyEngine({ taskStore: store });
      const runtime = new AgentRuntime({
        store,
        model: gateway,
        promptBuilder: new PromptBuilder(),
        tools,
        policy,
      });
      const task = await store.createTask({
        goal: taskDef.goal,
        maxSteps: 6,
        maxDurationMs,
        maxTokens: 120000,
        permissions: { profile: 'default' },
      });
      const startedAt = Date.now();
      const finalTask = await runtime.runTask(task.id, {
        usePlanner: false,
        modelOptions: { num_ctx: numCtx, num_predict: numPredict },
      }).catch(error => ({ id: task.id, status: TASK_STATUS.FAILED, error: error.message, result: null }));
      const events = await store.readEvents(task.id);
      const valid = events.filter(event => event.type === 'tool.started').length;
      const invalid = events.filter(event => event.type === 'tool.rejected').length;
      let success = false;
      try {
        success = taskDef.check({ task: finalTask, tools, events });
      } catch {
        success = false;
      }
      results.push({
        task: taskDef.name,
        status: finalTask.status,
        success: Boolean(success),
        errorCode: finalTask.errorCode || null,
        error: finalTask.error || null,
        steps: finalTask.stepCount,
        durationMs: Date.now() - startedAt,
        validToolCalls: valid,
        invalidToolCalls: invalid,
        result: typeof finalTask.result === 'string' ? finalTask.result.slice(0, 500) : finalTask.result,
      });
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  const validToolCalls = results.reduce((sum, result) => sum + result.validToolCalls, 0);
  const invalidToolCalls = results.reduce((sum, result) => sum + result.invalidToolCalls, 0);
  const attempts = validToolCalls + invalidToolCalls;
  const durations = results.map(result => result.durationMs);
  const successful = results.filter(result => result.success).length;
  return {
    model,
    capabilities,
    tasks: results.length,
    completed: results.filter(result => result.status === TASK_STATUS.COMPLETED).length,
    successful,
    completionRate: results.length === 0 ? 0 : results.filter(result => result.status === TASK_STATUS.COMPLETED).length / results.length,
    successRate: results.length === 0 ? 0 : successful / results.length,
    validToolCalls,
    invalidToolCalls,
    validToolCallRate: attempts === 0 ? 1 : validToolCalls / attempts,
    unsafeActionRate: 0,
    contextOverflowRate: results.filter(result => result.errorCode === 'context-overflow').length / Math.max(1, results.length),
    p50LatencyMs: percentile(durations, 0.5),
    p95LatencyMs: percentile(durations, 0.95),
    results,
  };
}

async function runRealModelSuite({
  models = ['llama3.1:8b'],
  adapterFactory = null,
  baseUrl = 'http://127.0.0.1:11434',
  numCtx = 4096,
  numPredict = 256,
  maxDurationMs = 120000,
  timeoutMs = 120000,
} = {}) {
  const modelList = (Array.isArray(models) ? models : [models])
    .map(model => String(model || '').trim())
    .filter(Boolean);
  if (modelList.length === 0) throw new Error('At least one model is required for the real-model eval');

  const measurements = [];
  for (const model of modelList) {
    try {
      measurements.push(await runModel({
        model,
        adapterFactory,
        baseUrl,
        numCtx,
        numPredict,
        maxDurationMs,
        timeoutMs,
      }));
    } catch (error) {
      measurements.push({
        model,
        error: error.message,
        completionRate: 0,
        successRate: 0,
        validToolCallRate: 0,
        unsafeActionRate: 0,
        p95LatencyMs: Number.POSITIVE_INFINITY,
        results: [],
      });
    }
  }

  const recommendation = recommendModel(measurements);
  return {
    suite: 'phase3-real-model',
    models: measurements,
    recommendedModel: recommendation?.model || null,
    recommendation,
    passed: measurements.some(measurement => (
      !measurement.error
      && measurement.successRate >= 0.6
      && measurement.validToolCallRate >= 0.9
      && measurement.unsafeActionRate === 0
    )),
  };
}

module.exports = {
  runRealModelSuite,
  TASKS,
  FIXTURE_TEXT,
  TOOL_DEFINITIONS,
};
