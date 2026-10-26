'use strict';

const path = require('path');
const http = require('http');

const { TaskStore, DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TOKENS, MAX_DURATION_LIMIT_MS, MAX_TOKENS_LIMIT } = require('../../core/runtime/task-store');
const { AgentRuntime } = require('../../core/runtime/agent-runtime');
const { PromptBuilder } = require('../../core/context/prompt-builder');
const { ModelGateway } = require('../../core/models/model-gateway');
const { OllamaAdapter } = require('../../core/models/ollama-adapter');
const { ModelRouter } = require('../../core/models/model-router');
const { ToolRegistry } = require('../../core/tools/tool-registry');
const { createSystemMetricsTool } = require('../../core/tools/system-metrics-tool');
const { createBrowserTools } = require('../../core/browser/browser-tools');
const { createIntegrationTools } = require('../../core/integrations/integration-tools');
const { createDocumentTools } = require('../../core/documents/document-tools');
const { planMonitoringTask } = require('../../core/metrics/monitor-intent');
const { PolicyEngine } = require('../../core/policy/policy-engine');
const { TASK_STATUS, assertTaskId, isTerminalStatus } = require('../../core/runtime/task-state');
const { unpackedPath } = require('../asar-paths');

const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_MAX_STEPS = 15;
const MAX_MODEL_LENGTH = 120;
const MAX_GOAL_LENGTH = 20000;
const MAX_LIST_LIMIT = 200;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
const ALLOWED_MODEL_OPTIONS = new Set([
  'temperature',
  'top_p',
  'top_k',
  'num_predict',
  'num_ctx',
  'num_gpu',
  'num_thread',
  'repeat_penalty',
  'seed',
]);

function sanitizeModelOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
  const result = {};
  for (const [key, value] of Object.entries(options)) {
    if (!ALLOWED_MODEL_OPTIONS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
  }

  if (typeof result.temperature === 'number') {
    result.temperature = Math.min(2, Math.max(0, result.temperature));
  }
  if (typeof result.num_predict === 'number') {
    result.num_predict = Math.min(8192, Math.max(1, Math.floor(result.num_predict)));
  }
  if (typeof result.num_ctx === 'number') {
    result.num_ctx = Math.min(32768, Math.max(512, Math.floor(result.num_ctx)));
  }
  return result;
}

function sanitizeMaxSteps(value) {
  if (!Number.isInteger(value)) return DEFAULT_MAX_STEPS;
  return Math.min(50, Math.max(1, value));
}

function sanitizeMaxDurationMs(value) {
  if (!Number.isInteger(value)) return DEFAULT_MAX_DURATION_MS;
  return Math.min(MAX_DURATION_LIMIT_MS, Math.max(1, value));
}

function sanitizeMaxTokens(value) {
  if (!Number.isInteger(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_TOKENS_LIMIT, Math.max(1, value));
}

function sanitizeToolMode(value) {
  return value === 'native' || value === 'json' ? value : null;
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

const MODEL_PROBE_TIMEOUT_MS = 750;
const MODEL_CACHE_MS = 60 * 1000;
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const EMBEDDING_MODEL_RE = /embed|minilm/i;

// Best-effort list of installed Ollama model names (with tags). Returns null
// when the daemon is unreachable so callers can fall back to their default.
function defaultListModels() {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = http.get(OLLAMA_TAGS_URL, { timeout: MODEL_PROBE_TIMEOUT_MS }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const names = (json.models || [])
            .map(model => model && model.name)
            .filter(name => typeof name === 'string' && name.length > 0);
          done(names.length > 0 ? names : null);
        } catch (_) {
          done(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

function defaultCreateRuntime({
  store,
  registry,
  policy,
  promptBuilder,
  model,
  plannerModel = null,
  verifierModel = null,
  modelOptions,
  onEvent,
}) {
  const adapter = new OllamaAdapter({ model });
  const gateway = new ModelGateway({
    adapter,
    defaultOptions: modelOptions,
    timeoutMs: 120000,
  });

  // Role-specific gateways are optional. When they are not configured, the
  // planner and verifier share the task model, which keeps a single Ollama
  // model warm on low-VRAM machines.
  function optionalGateway(name) {
    if (!name || name === model) return gateway;
    return new ModelGateway({
      adapter: new OllamaAdapter({ model: name }),
      defaultOptions: modelOptions,
      timeoutMs: 120000,
    });
  }

  return new AgentRuntime({
    store,
    model: gateway,
    plannerModel: optionalGateway(plannerModel),
    verifierModel: optionalGateway(verifierModel),
    promptBuilder,
    tools: registry,
    policy,
    onEvent,
  });
}

module.exports = function registerAgentController({
  ipcMain,
  app,
  secAudit = () => {},
  secCheckRate = () => true,
  mainWindowProvider = () => null,
  createRuntime = defaultCreateRuntime,
  taskStoreFactory = baseDir => new TaskStore({ baseDir }),
  toolRegistryFactory = (skillsDir, options = {}) => new ToolRegistry({
    skillsDir,
    nativeTools: options.nativeTools,
  }),
  policyFactory = store => new PolicyEngine({ taskStore: store }),
  promptBuilder: injectedPromptBuilder = null,
  defaultModel = DEFAULT_MODEL,
  plannerModel = process.env.JARVIS_PLANNER_MODEL || null,
  verifierModel = process.env.JARVIS_VERIFIER_MODEL || null,
  smallModel = process.env.JARVIS_SMALL_MODEL || null,
  strongModel = process.env.JARVIS_STRONG_MODEL || null,
  cloudModel = process.env.JARVIS_CLOUD_MODEL || null,
  listModels = defaultListModels,
  onAgentEvent = null,
  nativeTools = null,
  browserDriver = null,
  integrationService = null,
  documentIndex = null,
  memoryStore = null,
  memoryStoreProvider = null,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerAgentController requires ipcMain');
  }
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('registerAgentController requires app');
  }

  const skillsDir = unpackedPath(path.join(__dirname, '../../skills'));
  const promptBuilder = injectedPromptBuilder || new PromptBuilder();
  const resolvedNativeTools = Array.isArray(nativeTools)
    ? nativeTools.slice()
    : [createSystemMetricsTool()];
  // Browser tools are trusted application code, but page content is not. The
  // read/interaction tools are marked untrusted so the runtime taints the task
  // and requires approval before later externally visible steps.
  if (!Array.isArray(nativeTools) && browserDriver) {
    resolvedNativeTools.push(...createBrowserTools({ driver: browserDriver, audit }));
  }
  if (!Array.isArray(nativeTools) && integrationService) {
    resolvedNativeTools.push(...createIntegrationTools({ service: integrationService }));
  }
  if (!Array.isArray(nativeTools) && documentIndex) {
    resolvedNativeTools.push(...createDocumentTools({ index: documentIndex, audit }));
  }
  const registry = toolRegistryFactory(skillsDir, { nativeTools: resolvedNativeTools });
  const runtimes = new Map();

  const routedModels = [];
  function addRouteModel(name, tier) {
    const value = sanitizeString(name, MAX_MODEL_LENGTH);
    if (!value || !MODEL_RE.test(value)) return;
    if (!routedModels.some(model => model.name === value && model.tier === tier)) {
      routedModels.push({ name: value, tier, score: tier === 'default' ? 1 : 0 });
    }
  }
  addRouteModel(smallModel, 'small');
  addRouteModel(defaultModel, 'default');
  addRouteModel(strongModel, 'strong');
  addRouteModel(cloudModel, 'cloud');
  const modelRouter = new ModelRouter({ models: routedModels, defaultModel });
  const routedPlannerModel = MODEL_RE.test(sanitizeString(plannerModel, MAX_MODEL_LENGTH))
    ? sanitizeString(plannerModel, MAX_MODEL_LENGTH)
    : null;
  const routedVerifierModel = MODEL_RE.test(sanitizeString(verifierModel, MAX_MODEL_LENGTH))
    ? sanitizeString(verifierModel, MAX_MODEL_LENGTH)
    : null;

  function resolveMemoryStore() {
    if (typeof memoryStoreProvider === 'function') return memoryStoreProvider();
    return memoryStore;
  }

  let store = null;
  let policy = null;
  let readyPromise = null;
  let skillsError = null;
  let cachedInstalledModel = null;
  let cachedInstalledModelAt = 0;

  // Pick a chat-capable installed model for callers that do not specify one
  // (e.g. scheduler jobs). Preference: the controller default when installed,
  // then a llama3.1 tag, then the first non-embedding model.
  async function resolveInstalledModel() {
    const now = Date.now();
    if (cachedInstalledModel && now - cachedInstalledModelAt < MODEL_CACHE_MS) {
      return cachedInstalledModel;
    }
    let names = null;
    try { names = await listModels(); } catch (_) { names = null; }
    if (!Array.isArray(names)) return cachedInstalledModel;
    const candidates = names.filter(name => !EMBEDDING_MODEL_RE.test(name));
    const picked = candidates.find(name => name === defaultModel || name.startsWith(`${defaultModel}:`))
      || candidates.find(name => name.startsWith('llama3.1'))
      || candidates[0]
      || null;
    if (picked) {
      cachedInstalledModel = picked;
      cachedInstalledModelAt = now;
    }
    return picked;
  }

  function emitEvent(event) {
    const win = mainWindowProvider();
    if (
      win
      && typeof win.isDestroyed === 'function'
      && !win.isDestroyed()
      && win.webContents
      && typeof win.webContents.send === 'function'
    ) {
      win.webContents.send('agent-task-event', event);
    }
    // Main-process observers use this for native notifications when the
    // renderer is hidden. Never let a notification failure break the runtime.
    if (typeof onAgentEvent === 'function') {
      try { onAgentEvent(event); } catch (_) {}
    }
  }

  function audit(action, detail, verdict) {
    try { secAudit(action, detail, verdict); } catch { /* audit must not break IPC */ }
  }

  function rateLimited(key, limit) {
    try { return !secCheckRate(key, limit); } catch { return false; }
  }

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const userData = app.getPath('userData');
        store = taskStoreFactory(path.join(userData, 'tasks'));
        await store.init();

        const memory = resolveMemoryStore();
        if (memory && typeof memory.init === 'function') {
          await memory.init();
        }

        const recovered = await store.recoverInterruptedTasks();
        if (recovered.length > 0) {
          audit('AGENT_RECOVER', recovered.map(task => task.id).join(','), 'INTERRUPTED');
        }

        policy = policyFactory(store);
        const loaded = await registry.load();
        if (!loaded.ok) {
          skillsError = loaded.error || 'Skills manifest could not be verified';
          audit('AGENT_SKILLS_LOAD', skillsError, 'DENY');
        } else {
          skillsError = null;
          const excluded = Array.isArray(loaded.excluded) ? loaded.excluded : [];
          if (excluded.length > 0) {
            audit('AGENT_SKILLS_LOAD', excluded.map(entry => entry.reason).join(' | '), 'EXCLUDED');
          }
        }

        return { store, registry, policy };
      })().catch(error => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  function contextFromRequest(request, task) {
    const runtimeMeta = task?.metadata?.runtime || {};
    const modelOptions = sanitizeModelOptions(
      request?.modelOptions && Object.keys(request.modelOptions).length > 0
        ? request.modelOptions
        : runtimeMeta.modelOptions
    );

    // The seed is created by the controller, never accepted from the renderer.
    // Persisting it in task metadata lets a resumed task finish a deterministic
    // measurement without asking the model to choose the tool again.
    const runtimeSeed = runtimeMeta.initialToolCall;
    const initialToolCall = runtimeSeed
      && runtimeSeed.tool === 'system_metrics'
      && runtimeSeed.args
      && typeof runtimeSeed.args.target === 'string'
      && typeof runtimeSeed.args.duration_sec === 'number'
      ? {
          tool: 'system_metrics',
          args: {
            target: runtimeSeed.args.target,
            duration_sec: runtimeSeed.args.duration_sec,
          },
          native: false,
        }
      : null;

    const deepWorkEnabled = request?.deepWorkEnabled !== false;
    const usePlanner = request?.usePlanner !== undefined
      ? request.usePlanner !== false
      : (runtimeMeta.usePlanner !== undefined
        ? runtimeMeta.usePlanner !== false
        : (deepWorkEnabled && !initialToolCall));
    const toolMode = sanitizeToolMode(request?.toolMode) || sanitizeToolMode(runtimeMeta.toolMode);
    const verify = request?.verify === true || runtimeMeta.verify === true;

    return {
      mode: sanitizeString(request?.mode, 40) || runtimeMeta.mode || 'general',
      purpose: sanitizeString(request?.purpose, 40) || runtimeMeta.purpose || 'agent',
      highStakes: request?.highStakes === true || runtimeMeta.highStakes === true,
      ambiguous: request?.ambiguous === true || runtimeMeta.ambiguous === true,
      systemSpecs: request?.systemSpecs && typeof request.systemSpecs === 'object'
        ? request.systemSpecs
        : undefined,
      memory: [],
      projectContext: request?.projectContext && typeof request.projectContext === 'object'
        ? request.projectContext
        : undefined,
      webSearchContext: sanitizeString(request?.webSearchContext, 4000) || undefined,
      deepWorkEnabled,
      usePlanner,
      plannerRequired: request?.plannerRequired === true || runtimeMeta.plannerRequired === true,
      verify,
      ...(toolMode ? { toolMode } : {}),
      modelOptions,
      initialToolCall,
      completeWithToolResult: runtimeMeta.completeWithToolResult === true,
    };
  }

  // Memory retrieval is performed by the main process, not by the renderer.
  // Personal/secret records are excluded from prompt context by default; the
  // user can still inspect them in the memory panel.
  async function contextForTask(request, task) {
    const context = contextFromRequest(request, task);
    const memory = resolveMemoryStore();
    if (!memory || typeof memory.retrieve !== 'function' || !task || !task.goal) {
      return context;
    }
    try {
      const retrieval = await memory.retrieve(task.goal, {
        maxRecords: 6,
        maxChars: 1600,
        allowPersonal: false,
      });
      context.memory = retrieval.records.map(record => record.text);
      context.memoryContext = retrieval.context;
      context.memoryIds = retrieval.records.map(record => record.id);
    } catch (error) {
      audit('AGENT_MEMORY_RETRIEVE', error.message, 'ERROR');
      context.memory = [];
    }
    return context;
  }

  function makeRuntimeForTask(task, request) {
    const runtimeMeta = task?.metadata?.runtime || {};
    const purpose = sanitizeString(request?.purpose, 40) || runtimeMeta.purpose || 'agent';
    const highStakes = request?.highStakes === true || runtimeMeta.highStakes === true;
    const ambiguous = request?.ambiguous === true || runtimeMeta.ambiguous === true;
    const explicitModel = sanitizeString(request?.model, MAX_MODEL_LENGTH);
    const model = explicitModel
      || sanitizeString(runtimeMeta.model, MAX_MODEL_LENGTH)
      || modelRouter.select({ kind: purpose, highStakes, ambiguous })
      || defaultModel;
    if (!MODEL_RE.test(model)) throw new Error('Invalid model name');

    const modelOptions = sanitizeModelOptions(
      request?.modelOptions && Object.keys(request.modelOptions).length > 0
        ? request.modelOptions
        : runtimeMeta.modelOptions
    );
    const plannerModelName = routedPlannerModel
      || modelRouter.select({ kind: 'planning', highStakes, ambiguous })
      || model;
    const verifierModelName = routedVerifierModel
      || modelRouter.select({ kind: 'verification', highStakes: true, ambiguous })
      || model;

    return createRuntime({
      store,
      registry,
      policy,
      promptBuilder,
      model,
      plannerModel: plannerModelName,
      verifierModel: verifierModelName,
      modelOptions,
      onEvent: emitEvent,
    });
  }

  function emitTaskUpdate(task) {
    if (!task) return;
    emitEvent({
      taskId: task.id,
      type: 'task.updated',
      at: new Date().toISOString(),
      data: { task },
    });
  }

  function trackRuntime(taskId, runtime, promise) {
    runtimes.set(taskId, runtime);
    promise
      .then(async task => {
        // Memory extraction happens only after the task settles, never inside
        // the model/tool loop. Tainted tasks may create an episode, but the
        // store refuses to create a procedure from them.
        const memory = resolveMemoryStore();
        if (memory && task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
          try {
            await memory.recordTaskOutcome(task);
          } catch (error) {
            audit('AGENT_MEMORY_WRITE', `${taskId}: ${error.message}`, 'ERROR');
          }
        }
        emitTaskUpdate(task);
      })
      .catch(error => {
        audit('AGENT_TASK_ERROR', `${taskId}: ${error.message}`, 'ERROR');
      })
      .finally(() => {
        if (runtimes.get(taskId) === runtime) runtimes.delete(taskId);
      });
  }

  async function getTaskOrError(_, taskId) {
    try {
      assertTaskId(taskId);
    } catch {
      return { ok: false, error: 'Invalid task id' };
    }
    const task = await store.getTask(taskId);
    if (!task) return { ok: false, error: 'Task not found' };
    return { ok: true, task };
  }

  // ─── Start ─────────────────────────────────────────────────────
  // Shared by the renderer IPC path (Deep Work) and the scheduler
  // (headless autonomous runs).
  async function startTask(request = {}) {
    await ensureReady();
    if (skillsError) {
      return { ok: false, error: `Skills unavailable: ${skillsError}` };
    }
    if (rateLimited('agentTaskStart', 10)) {
      audit('AGENT_TASK_START', 'rate limit', 'DENY');
      return { ok: false, error: 'Rate limit exceeded' };
    }

    const goal = sanitizeString(request.goal, MAX_GOAL_LENGTH);
    if (!goal) return { ok: false, error: 'Task goal is required' };
    if (typeof request.goal === 'string' && request.goal.length > MAX_GOAL_LENGTH) {
      return { ok: false, error: `Task goal exceeds ${MAX_GOAL_LENGTH} characters` };
    }

    const purpose = sanitizeString(request.purpose, 40) || 'agent';
    const highStakes = request.highStakes === true;
    const ambiguous = request.ambiguous === true;
    const explicitModel = sanitizeString(request.model, MAX_MODEL_LENGTH);
    const model = explicitModel
      || modelRouter.select({ kind: purpose, highStakes, ambiguous })
      || defaultModel;
    if (!MODEL_RE.test(model)) return { ok: false, error: 'Invalid model name' };
    const modelOptions = sanitizeModelOptions(request.modelOptions);
    const maxSteps = sanitizeMaxSteps(request.maxSteps);
    const maxDurationMs = sanitizeMaxDurationMs(request.maxDurationMs);
    const maxTokens = sanitizeMaxTokens(request.maxTokens);
    const mode = sanitizeString(request.mode, 40) || 'general';
    const toolMode = sanitizeToolMode(request.toolMode);
    const usePlanner = typeof request.usePlanner === 'boolean' ? request.usePlanner : undefined;
    const verify = request.verify === true;
    const plannerRequired = request.plannerRequired === true;
    const scheduleId = sanitizeString(request.scheduleId, 80);
    const scheduleName = sanitizeString(request.scheduleName, 120);
    const source = sanitizeString(request.source, 80) || 'agent-task';
    const permissionProfile = sanitizeString(
      typeof request.permissions === 'string' ? request.permissions : request.permissions?.profile,
      80
    ) || 'default';
    const permissions = { profile: permissionProfile };
    const monitoringPlan = planMonitoringTask(goal);

    const task = await store.createTask({
      goal,
      source,
      permissions,
      maxSteps,
      maxDurationMs,
      maxTokens,
      metadata: {
        runtime: {
          model,
          modelOptions,
          mode,
          purpose,
          highStakes,
          ambiguous,
          ...(toolMode ? { toolMode } : {}),
          ...(usePlanner !== undefined ? { usePlanner } : {}),
          verify,
          plannerRequired,
          ...(monitoringPlan ? {
            initialToolCall: monitoringPlan.toolCall,
            completeWithToolResult: monitoringPlan.completeWithToolResult,
          } : {}),
        },
        ...(scheduleId ? { schedule: { id: scheduleId, name: scheduleName || null } } : {}),
      },
    });

    const runtime = makeRuntimeForTask(task, { ...request, model, modelOptions });
    const context = await contextForTask({ ...request, model, modelOptions }, task);
    const promise = runtime.runTask(task.id, context);
    trackRuntime(task.id, runtime, promise);

    audit('AGENT_TASK_START', `${task.id} goal=${goal.slice(0, 80)} model=${model}`, 'ALLOWED');
    return { ok: true, task: await store.getTask(task.id) };
  }

  ipcMain.handle('agent-task-start', async (_, request = {}) => {
    try {
      return await startTask(request);
    } catch (error) {
      audit('AGENT_TASK_START', error.message, 'ERROR');
      return { ok: false, error: error.message };
    }
  });

  // Start a durable task from a scheduler job. Jobs describe their intent in
  // payload.goal (agent-native) or payload.text (scheduler modal form).
  async function startTaskFromJob(job) {
    try {
      await ensureReady();
      const payload = job && typeof job.payload === 'object' && job.payload !== null
        ? job.payload
        : {};
      const rawGoal = typeof payload.goal === 'string'
        ? payload.goal
        : (typeof payload.text === 'string' ? payload.text : '');
      if (!rawGoal.trim()) {
        audit('AGENT_TASK_SCHEDULE', `${job?.id || 'unknown'}: missing goal`, 'DENY');
        return { ok: false, error: 'Scheduled job has no goal payload' };
      }

      // Single-flight per schedule: recurring jobs skip a fire while a
      // previous run is still queued, running, or waiting for supervision.
      const scheduleId = sanitizeString(job?.id, 80);
      if (scheduleId) {
        const liveStatuses = new Set([
          TASK_STATUS.QUEUED,
          TASK_STATUS.RUNNING,
          TASK_STATUS.WAITING_APPROVAL,
        ]);
        const active = (await store.listTasks({ limit: MAX_LIST_LIMIT }))
          .find(task => task.metadata?.schedule?.id === scheduleId && liveStatuses.has(task.status));
        if (active) {
          audit('AGENT_TASK_SCHEDULE', `${scheduleId}: skipped, task ${active.id} is ${active.status}`, 'DENY');
          return { ok: false, error: `A task from this schedule is still ${active.status}` };
        }
      }

      // Scheduler jobs rarely pin a model; resolve an installed one so the
      // task cannot fail against a model that was never pulled.
      const model = typeof payload.model === 'string' && payload.model.trim()
        ? payload.model
        : (await resolveInstalledModel()) || undefined;

      const result = await startTask({
        goal: rawGoal,
        source: 'schedule',
        permissions: { profile: 'background-restricted' },
        scheduleId,
        scheduleName: sanitizeString(job?.name, 120),
        model,
        mode: payload.mode,
        modelOptions: payload.modelOptions,
        maxSteps: payload.maxSteps,
      });
      audit(
        'AGENT_TASK_SCHEDULE',
        `${job?.id || 'unknown'} -> ${result.ok ? result.task.id : `error: ${result.error}`}`,
        result.ok ? 'ALLOWED' : 'ERROR'
      );
      return result;
    } catch (error) {
      audit('AGENT_TASK_SCHEDULE', error.message, 'ERROR');
      return { ok: false, error: error.message };
    }
  }

  // ─── Read ──────────────────────────────────────────────────────
  ipcMain.handle('agent-task-list', async (_, options = {}) => {
    try {
      await ensureReady();
      const requestedLimit = Number.isInteger(options?.limit) ? options.limit : 50;
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, requestedLimit));
      const status = typeof options?.status === 'string' ? options.status : null;
      const tasks = await store.listTasks({ limit, status });
      return { ok: true, tasks };
    } catch (error) {
      return { ok: false, error: error.message, tasks: [] };
    }
  });

  ipcMain.handle('agent-task-get', async (_, taskId) => {
    try {
      await ensureReady();
      const result = await getTaskOrError(_, taskId);
      if (!result.ok) return result;
      const events = await store.readEvents(taskId, { limit: 200 });
      return { ok: true, task: result.task, events };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('agent-task-events', async (_, taskId, options = {}) => {
    try {
      await ensureReady();
      const result = await getTaskOrError(_, taskId);
      if (!result.ok) return result;
      const requestedLimit = Number.isInteger(options?.limit) ? options.limit : 200;
      const limit = Math.min(1000, Math.max(1, requestedLimit));
      const events = await store.readEvents(taskId, { limit });
      return { ok: true, events };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ─── Cancel ────────────────────────────────────────────────────
  ipcMain.handle('agent-task-cancel', async (_, taskId, reason = 'user-request') => {
    try {
      await ensureReady();
      const result = await getTaskOrError(_, taskId);
      if (!result.ok) return result;

      const runtime = runtimes.get(taskId);
      if (runtime) {
        const task = await runtime.cancelTask(taskId, sanitizeString(reason, 120) || 'user-request');
        emitTaskUpdate(task);
        audit('AGENT_TASK_CANCEL', taskId, 'CANCELLED');
        return { ok: true, task };
      }

      if (isTerminalStatus(result.task.status)) {
        return { ok: true, task: result.task };
      }
      const task = await store.transition(taskId, TASK_STATUS.CANCELLED, {
        reason: sanitizeString(reason, 120) || 'user-request',
      });
      emitTaskUpdate(task);
      audit('AGENT_TASK_CANCEL', taskId, 'CANCELLED');
      return { ok: true, task };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ─── Approval ──────────────────────────────────────────────────
  ipcMain.handle('agent-task-approve', async (_, taskId, options = {}) => {
    try {
      await ensureReady();
      const result = await getTaskOrError(_, taskId);
      if (!result.ok) return result;
      if (typeof options?.approved !== 'boolean') {
        return { ok: false, error: 'approved must be a boolean' };
      }
      if (result.task.status !== TASK_STATUS.WAITING_APPROVAL) {
        return { ok: false, error: `Task is not waiting for approval: ${result.task.status}` };
      }

      let runtime = runtimes.get(taskId);
      if (!runtime) {
        runtime = makeRuntimeForTask(result.task, options);
      }

      const approvedTask = await runtime.approveTask(taskId, {
        approved: options.approved,
        reason: sanitizeString(options.reason, 200) || null,
        wait: false,
      });

      if (options.approved) {
        const context = await contextForTask(options, approvedTask);
        const promise = runtime.runTask(taskId, context, {
          fromApproval: true,
          alreadyRunning: true,
        });
        trackRuntime(taskId, runtime, promise);
      } else {
        emitTaskUpdate(approvedTask);
      }

      audit(
        'AGENT_TASK_APPROVAL',
        `${taskId} approved=${options.approved}`,
        options.approved ? 'ALLOWED' : 'DENIED'
      );
      return { ok: true, task: approvedTask };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ─── Resume ────────────────────────────────────────────────────
  ipcMain.handle('agent-task-resume', async (_, taskId, options = {}) => {
    try {
      await ensureReady();
      const result = await getTaskOrError(_, taskId);
      if (!result.ok) return result;

      if (result.task.status === TASK_STATUS.WAITING_APPROVAL) {
        return { ok: false, error: 'Task is waiting for approval' };
      }
      if (isTerminalStatus(result.task.status) && result.task.status !== TASK_STATUS.FAILED) {
        return { ok: false, error: `Task is already ${result.task.status}` };
      }
      if (rateLimited('agentTaskResume', 20)) {
        return { ok: false, error: 'Rate limit exceeded' };
      }

      const runtime = makeRuntimeForTask(result.task, options);
      const context = await contextForTask(options, result.task);
      const promise = runtime.runTask(taskId, context);
      trackRuntime(taskId, runtime, promise);
      audit('AGENT_TASK_RESUME', taskId, 'ALLOWED');
      return { ok: true, task: await store.getTask(taskId) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  return {
    ensureReady,
    startTask,
    startTaskFromJob,
    getStore: () => store,
    getMemoryStore: () => resolveMemoryStore(),
    getRegistry: () => registry,
    getRuntimes: () => runtimes,
    getSkillsError: () => skillsError,
  };
};

module.exports.sanitizeModelOptions = sanitizeModelOptions;
module.exports.sanitizeMaxSteps = sanitizeMaxSteps;
