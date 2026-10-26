'use strict';

const crypto = require('crypto');

const { validateArgs } = require('../../agent-policy');
const {
  TASK_STATUS,
  assertTaskId,
  isTerminalStatus,
} = require('./task-state');
const { parseFallbackToolCall } = require('../tools/tool-call-fallback');
const { estimateTokens, estimateMessagesTokens } = require('../context/token-budget');
const { ContextOverflowError } = require('../context/prompt-builder');
const { Planner } = require('../planning/planner');
const { firstPendingStep } = require('../planning/plan-validator');
const { Verifier, compactToolResults } = require('../verification/verifier');

const MAX_TOOL_OUTPUT_CHARS = 3000;
const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 120000;
const LOOP_REPEAT_LIMIT = 3;
const LOOP_FAILURE_LIMIT = 2;
const READ_RETRY_LIMIT = 1;
const MAX_VERIFY_ATTEMPTS = 2;

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function formatToolPayload(tool, result) {
  let output;

  if (typeof result === 'string') {
    output = result;
  } else if (result && typeof result === 'object') {
    if (result.ok === false) {
      output = `[TOOL_RESULT: error — ${result.error || 'unknown tool error'}]`;
      return output;
    }
    if (typeof result.agentText === 'string' && result.agentText.trim()) {
      output = result.agentText;
    } else {
      const payload = result.result ?? result.data ?? result.output ?? result;
      output = typeof payload === 'object'
        ? JSON.stringify(payload, null, 2)
        : String(payload);
    }
  } else {
    output = String(result ?? '');
  }

  if (output.length > MAX_TOOL_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n...[TRUNCATED: output exceeded ${MAX_TOOL_OUTPUT_CHARS} chars]`;
  }

  return `[TOOL_RESULT: ${tool}]\n${output}\n[END_TOOL_RESULT]`;
}

function nativeToolsUnsupported(error) {
  return /does not support tools|tools? (?:are|is) not supported|native tools?.*(?:unsupported|not supported)|unsupported.*tools?/i
    .test(errorMessage(error));
}

// Durable ReAct-style runtime. The renderer, Ollama, Electron, and skill
// spawning are all injected dependencies so the loop can be tested in isolation.
class AgentRuntime {
  constructor({
    store,
    model,
    plannerModel = null,
    verifierModel = null,
    planner = null,
    verifier = null,
    promptBuilder,
    tools,
    policy,
    now = Date.now,
    onEvent = null,
  } = {}) {
    if (!store || typeof store.getTask !== 'function' || typeof store.updateTask !== 'function') {
      throw new Error('AgentRuntime requires a TaskStore');
    }
    if (!model || typeof model.chat !== 'function') {
      throw new Error('AgentRuntime requires a ModelGateway');
    }
    if (!promptBuilder || typeof promptBuilder.build !== 'function') {
      throw new Error('AgentRuntime requires a PromptBuilder');
    }
    if (!tools || typeof tools.execute !== 'function') {
      throw new Error('AgentRuntime requires a tool executor');
    }
    if (!policy || typeof policy.authorize !== 'function') {
      throw new Error('AgentRuntime requires a policy engine');
    }

    this.store = store;
    this.model = model;
    this.promptBuilder = promptBuilder;
    this.tools = tools;
    this.policy = policy;
    this.now = now;
    this.onEvent = onEvent;
    this.planner = planner || new Planner({ model: plannerModel || model, tools, maxSteps: 12 });
    this.verifier = verifier || new Verifier({ model: verifierModel || model });

    this._active = new Map();
    this._controllers = new Map();
    this.toolDefinitions = this._loadToolDefinitions();
    this._toolManifest = this._buildToolManifest(this.toolDefinitions);
  }

  _loadToolDefinitions() {
    if (Array.isArray(this.tools.definitions)) return this.tools.definitions;
    if (typeof this.tools.listDefinitions === 'function') return this.tools.listDefinitions();
    return [];
  }

  _buildToolManifest(definitions) {
    const manifest = new Map();
    for (const definition of Array.isArray(definitions) ? definitions : []) {
      if (!definition || typeof definition !== 'object') continue;
      const fn = definition.function && typeof definition.function === 'object'
        ? definition.function
        : definition;
      const name = fn.name || fn.id;
      if (typeof name !== 'string' || !name) continue;
      manifest.set(name, {
        id: name,
        name,
        params: fn.parameters || fn.params || {},
        risk: typeof definition.risk === 'string' ? definition.risk : (typeof fn.risk === 'string' ? fn.risk : null),
        untrusted: Boolean(definition.untrusted || fn.untrusted),
        alwaysAllow: Boolean(definition.alwaysAllow || fn.alwaysAllow),
      });
    }
    return manifest;
  }

  _skillForCall(toolCall) {
    if (typeof this.tools.getSkill === 'function') {
      const skill = this.tools.getSkill(toolCall.tool);
      if (skill) return skill;
    }
    return this._toolManifest.get(toolCall.tool) || null;
  }

  _validateToolCall(toolCall) {
    if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.tool !== 'string' || !toolCall.tool.trim()) {
      return { ok: false, error: 'Tool name is missing' };
    }
    if (toolCall.error) return { ok: false, error: toolCall.error, tool: this._skillForCall(toolCall) };
    if (typeof this.tools.validateCall === 'function') {
      const result = this.tools.validateCall(toolCall);
      if (!result.ok) return result;
      return { ok: true, tool: result.tool || this._skillForCall(toolCall) };
    }

    const tool = this._skillForCall(toolCall);
    if (!tool) return { ok: false, error: `Unknown tool: ${toolCall.tool}` };
    const args = toolCall.args === undefined || toolCall.args === null ? {} : toolCall.args;
    if (typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'Tool arguments must be an object', tool };
    }
    const argError = validateArgs(tool, args);
    if (argError) return { ok: false, error: argError, tool };
    return { ok: true, tool };
  }

  async _record(taskId, type, data = null) {
    const payload = {
      taskId,
      type,
      at: new Date(this.now()).toISOString(),
      data,
    };

    try {
      await this.store.appendEvent(taskId, type, data);
    } catch (error) {
      console.error(`[AgentRuntime] Failed to append event ${type}:`, error.message);
    }

    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(payload);
      } catch (error) {
        console.error('[AgentRuntime] Event listener failed:', error.message);
      }
    }
  }

  async startTask(taskId, context = {}) {
    assertTaskId(taskId);
    const promise = this.runTask(taskId, context);
    promise.catch(error => {
      console.error(`[AgentRuntime] Task ${taskId} failed to start:`, error.message);
    });
    return this.store.getTask(taskId);
  }

  async createTask(options, context = {}) {
    const task = await this.store.createTask(options);
    await this.startTask(task.id, context);
    return task;
  }

  async runTask(taskId, context = {}, { fromApproval = false, alreadyRunning = false } = {}) {
    assertTaskId(taskId);
    if (this._active.has(taskId)) return this._active.get(taskId);

    const promise = this._runTask(taskId, context, { fromApproval, alreadyRunning })
      .finally(() => {
        this._active.delete(taskId);
        this._controllers.delete(taskId);
      });

    this._active.set(taskId, promise);
    return promise;
  }

  async _runTask(taskId, context, { fromApproval, alreadyRunning }) {
    const controller = new AbortController();
    this._controllers.set(taskId, controller);

    try {
      let task = await this.store.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED) {
        return task;
      }

      if (task.status === TASK_STATUS.WAITING_APPROVAL) {
        if (!fromApproval) return task;
        task = await this.store.transition(taskId, TASK_STATUS.RUNNING, {
          reason: 'approval-granted',
        });
      } else if (task.status === TASK_STATUS.RUNNING) {
        // A persisted RUNNING task with no active controller was orphaned by a
        // process restart. Mark it before resuming so orphaned steps are visible.
        if (!alreadyRunning) {
          task = await this.store.transition(taskId, TASK_STATUS.INTERRUPTED, {
            reason: 'orphaned-run',
          });
        }
      }

      if (task.status === TASK_STATUS.INTERRUPTED) {
        await this._markOrphanedSteps(taskId);
        task = await this.store.transition(taskId, TASK_STATUS.RUNNING, {
          reason: 'resume',
        });
      } else if (task.status === TASK_STATUS.FAILED) {
        task = await this.store.transition(taskId, TASK_STATUS.QUEUED, {
          reason: 'retry',
          patch: { error: null, errorCode: null, result: null, startedAt: null, finishedAt: null },
        });
        task = await this.store.transition(taskId, TASK_STATUS.RUNNING, {
          reason: 'start',
        });
      } else if (
        task.status === TASK_STATUS.QUEUED
        || task.status === TASK_STATUS.PLANNING
        || task.status === TASK_STATUS.PAUSED
      ) {
        task = await this.store.transition(taskId, TASK_STATUS.RUNNING, {
          reason: 'start',
        });
      }

      if (task.status !== TASK_STATUS.RUNNING) return task;

      const capabilities = await this._resolveCapabilities();
      let toolMode = this._resolveToolMode(context, capabilities);

      task = await this._ensureGoalMessage(taskId);
      task = await this._executeApprovedApprovals(taskId, context, controller.signal);
      if (controller.signal.aborted) return this._settleAfterAbort(taskId);

      const seeded = await this._executeInitialToolCall(taskId, context, controller.signal);
      if (controller.signal.aborted) return this._settleAfterAbort(taskId);
      if (seeded && seeded.terminal) return seeded.task;

      task = await this._ensurePlan(taskId, context, capabilities, controller.signal);
      if (controller.signal.aborted) return this._settleAfterAbort(taskId);
      if (isTerminalStatus(task.status)) return task;

      let lengthRetries = 0;

      while (!controller.signal.aborted) {
        task = await this.store.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.status !== TASK_STATUS.RUNNING) return task;

        const capFailure = await this._enforceCaps(task);
        if (capFailure) return capFailure;

        const stepIndex = task.stepCount + 1;
        const stepId = makeId('step');
        task = await this.store.updateTask(taskId, draft => {
          draft.stepCount = stepIndex;
          draft.steps.push({
            id: stepId,
            index: stepIndex,
            kind: 'model',
            status: 'started',
            startedAt: this.now(),
          });
        });
        await this._record(taskId, 'step.started', { stepId, index: stepIndex, toolMode });

        let built;
        try {
          built = this._buildPrompt(task, context, capabilities, toolMode);
        } catch (error) {
          if (error instanceof ContextOverflowError || error.code === 'context-overflow') {
            return this._failTask(taskId, 'context-overflow', errorMessage(error));
          }
          throw error;
        }

        let response;
        try {
          response = await this.model.chat({
            messages: built.messages,
            tools: toolMode === 'native' ? this.toolDefinitions : [],
            options: context.modelOptions || {},
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) return this._settleAfterAbort(taskId);
          if (toolMode === 'native' && nativeToolsUnsupported(error)) {
            toolMode = 'json';
            if (typeof this.model.markNativeToolsUnsupported === 'function') {
              this.model.markNativeToolsUnsupported(errorMessage(error));
            }
            await this.store.updateTask(taskId, draft => {
              const step = draft.steps.find(entry => entry.id === stepId);
              if (step) {
                step.status = 'failed';
                step.finishedAt = this.now();
                step.error = 'Native tools rejected; falling back to JSON schema mode';
              }
              draft.messages.push({
                role: 'user',
                content: '[RUNTIME NOTICE] The provider rejected native tool calls. Continue using the JSON fallback tool protocol.',
              });
            });
            await this._record(taskId, 'tool-mode.fallback', { reason: errorMessage(error) });
            continue;
          }
          return this._failTask(taskId, 'model-error', errorMessage(error));
        }

        if (controller.signal.aborted) return this._settleAfterAbort(taskId);

        const usage = await this._consumeUsage(taskId, response.usage, {
          promptTokens: built.budget?.promptTokens || estimateMessagesTokens(built.messages),
          completionTokens: estimateTokens(response.text || ''),
        });
        task = usage.task;
        if (usage.exceeded) {
          return this._failTask(
            taskId,
            'token-cap',
            `Token cap of ${task.maxTokens} exceeded (${task.tokenUsage.totalTokens} used)`
          );
        }
        if (Number.isFinite(task.startedAt) && this.now() - task.startedAt > task.maxDurationMs) {
          return this._failTask(
            taskId,
            'time-cap',
            `Time cap of ${task.maxDurationMs}ms reached before the goal was completed`
          );
        }

        const selected = this._selectToolCall(response, toolMode);
        const nativeCalls = selected.nativeCalls;
        const parsed = selected.call;

        task = await this.store.updateTask(taskId, draft => {
          const step = draft.steps.find(entry => entry.id === stepId);
          if (step) {
            step.status = 'completed';
            step.finishedAt = this.now();
            step.text = response.text;
            step.finishReason = response.finishReason;
            step.toolCall = parsed;
          }
          draft.messages.push({
            role: 'assistant',
            content: response.text || '',
            ...(nativeCalls.length > 0 ? { toolCalls: nativeCalls } : {}),
          });
        });
        await this._record(taskId, 'step.completed', {
          stepId,
          index: stepIndex,
          finishReason: response.finishReason,
          text: (response.text || '').slice(0, 4000),
          toolCall: parsed ? { tool: parsed.tool, args: parsed.args } : null,
        });

        if (!parsed) {
          if (response.finishReason === 'length') {
            lengthRetries += 1;
            if (lengthRetries > 1) {
              return this._failTask(taskId, 'output-truncated', 'Model output hit the limit twice before a final answer');
            }
            await this._appendUserNotice(
              taskId,
              '[RUNTIME NOTICE] Your previous answer hit the output limit. Provide a concise final answer, or call one tool if more work is required.'
            );
            continue;
          }

          const final = (response.text || '').trim();
          if (!final) {
            return this._failTask(taskId, 'empty-response', 'Model returned no final answer');
          }

          const verification = await this._verifyIfRequired(task, final, context, capabilities, controller.signal);
          if (controller.signal.aborted) return this._settleAfterAbort(taskId);
          if (verification && verification.terminal) return verification.task;
          if (verification && !verification.accepted) {
            const attempts = Number(verification.attempts || 0);
            if (attempts >= MAX_VERIFY_ATTEMPTS) {
              return this._failTask(
                taskId,
                'verification-rejected',
                verification.reason || 'Verifier rejected the final result'
              );
            }
            await this._appendUserNotice(
              taskId,
              `[VERIFIER REJECTED]\n${verification.reason || 'The result did not satisfy the goal.'}${verification.guidance ? `\nGuidance: ${verification.guidance}` : ''}\nRevise the result using the recorded evidence.`
            );
            continue;
          }

          task = await this._closePlan(taskId);
          const finalPlanStatus = task.plan.length > 0
            ? (task.plan.every(step => step.status === 'completed' || step.status === 'skipped') ? 'completed' : 'partial')
            : (task.planStatus === 'invalid' ? 'invalid' : 'none');
          return this.store.transition(taskId, TASK_STATUS.COMPLETED, {
            reason: 'model-final',
            patch: {
              result: final,
              error: null,
              errorCode: null,
              planStatus: finalPlanStatus,
              currentPlanStepId: null,
              verification: verification?.record || task.verification || null,
            },
          });
        }

        if (nativeCalls.length > 1) {
          await this._appendToolMessage(
            taskId,
            'runtime',
            `[TOOL_RESULT: error — only one tool call per step is supported; ${nativeCalls.length - 1} extra call(s) ignored]`,
            null
          );
        }

        const validation = this._validateToolCall(parsed);
        if (!validation.ok) {
          await this._appendToolMessage(
            taskId,
            parsed.tool || 'runtime',
            `[TOOL_RESULT: error — ${validation.error}]`,
            parsed
          );
          await this._record(taskId, 'tool.rejected', {
            tool: parsed.tool || null,
            error: validation.error,
          });
          continue;
        }

        const loop = this._detectLoop(task, parsed);
        if (loop) {
          await this._record(taskId, 'loop.detected', loop);
          return this._failTask(taskId, 'loop-detected', loop.message);
        }

        let decision;
        try {
          const skill = validation.tool || this._skillForCall(parsed);
          decision = await this.policy.authorize({
            task,
            taskId,
            toolCall: parsed,
            skill,
            store: this.store,
          });
        } catch (error) {
          return this._failTask(taskId, 'policy-error', errorMessage(error));
        }

        if (decision.decision === 'require_approval') {
          const approval = {
            id: makeId('approval'),
            stepIndex,
            toolCall: parsed,
            reason: decision.reason || 'approval-required',
            status: 'pending',
            requestedAt: this.now(),
            resolvedAt: null,
            consumedAt: null,
            taint: Boolean(decision.taint),
          };
          task = await this.store.transition(taskId, TASK_STATUS.WAITING_APPROVAL, {
            reason: 'approval-required',
            patch: { approvals: [...task.approvals, approval] },
          });
          await this._record(taskId, 'approval.requested', { approval });
          return task;
        }

        if (decision.decision !== 'allow') {
          await this._appendToolMessage(
            taskId,
            parsed.tool,
            `[TOOL_RESULT: denied — ${decision.reason || decision.error || 'policy denied'}]`,
            parsed
          );
          continue;
        }

        const executed = await this._executeToolStep({
          taskId,
          stepIndex,
          toolCall: parsed,
          context,
          signal: controller.signal,
          taint: Boolean(decision.taint),
        });
        if (controller.signal.aborted) return this._settleAfterAbort(taskId);
        if (!executed) return this.store.getTask(taskId);

        task = await this.store.getTask(taskId);
        if (Number.isFinite(task.startedAt) && this.now() - task.startedAt > task.maxDurationMs) {
          return this._failTask(
            taskId,
            'time-cap',
            `Time cap of ${task.maxDurationMs}ms reached while executing ${parsed.tool}`
          );
        }

        task = await this._advancePlan(taskId, parsed.tool, executed.ok);
        if (!executed.ok) {
          const failure = await this._handleFailedPlanStep(
            taskId,
            parsed.tool,
            executed.result,
            context,
            capabilities,
            controller.signal
          );
          if (failure?.terminal) return failure.task;
        }
      }

      return this._settleAfterAbort(taskId);
    } catch (error) {
      return this._failTask(taskId, 'runtime-error', errorMessage(error));
    }
  }

  _selectToolCall(response, toolMode) {
    const nativeCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const firstNative = nativeCalls[0] || null;
    if (firstNative) {
      return {
        nativeCalls,
        call: {
          tool: firstNative.name,
          args: firstNative.arguments || {},
          id: firstNative.id,
          native: true,
          ...(firstNative.error ? { error: firstNative.error } : {}),
        },
      };
    }

    // JSON schema fallback is intentionally based on structured JSON, not the
    // legacy <tool_call> text tags. It is accepted in native mode too, because
    // some local models claim tool support but emit JSON text.
    const fallback = parseFallbackToolCall(response.text);
    return {
      nativeCalls: [],
      call: fallback ? { ...fallback, native: false } : null,
    };
  }

  async _resolveCapabilities() {
    try {
      if (typeof this.model.getCapabilities === 'function') return await this.model.getCapabilities();
    } catch { /* use conservative defaults */ }
    return {
      tools: true,
      vision: false,
      contextLength: 4096,
      maxOutputTokens: 512,
      source: 'fallback',
    };
  }

  _resolveToolMode(context, capabilities) {
    if (context.toolMode === 'json' || context.toolMode === 'native') return context.toolMode;
    return capabilities?.tools === false ? 'json' : 'native';
  }

  _buildPrompt(task, context, capabilities, toolMode) {
    if (typeof this.promptBuilder.buildWithBudget === 'function') {
      return this.promptBuilder.buildWithBudget({
        task,
        context,
        tools: this.toolDefinitions,
        capabilities,
        toolMode,
      });
    }
    return {
      messages: this.promptBuilder.build({ task, context, tools: this.toolDefinitions }),
      budget: null,
    };
  }

  async _ensureGoalMessage(taskId) {
    let task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.messages.length > 0) return task;

    return this.store.updateTask(taskId, draft => {
      draft.messages.push({
        role: 'user',
        content: `[AGENTIC GOAL]\n${draft.goal}\n\nUse tools when needed. When the goal is complete, provide the final answer.`,
      });
    });
  }

  async _ensurePlan(taskId, context, capabilities, signal) {
    let task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (context.usePlanner !== true) return task;
    if (task.plan.length > 0) return task;
    if (context.initialToolCall) return task;

    let result;
    try {
      result = await this.planner.createPlan({
        task,
        capabilities,
        modelOptions: context.modelOptions || {},
        signal,
      });
    } catch (error) {
      result = { ok: false, error: errorMessage(error), code: error.code || null };
    }

    const usage = result.usage
      ? await this._consumeUsage(taskId, result.usage, { completionTokens: estimateTokens(result.raw || '') })
      : { task, exceeded: false };
    task = usage.task;
    if (usage.exceeded) {
      return this._failTask(
        taskId,
        'token-cap',
        `Token cap of ${task.maxTokens} exceeded while planning`
      );
    }

    if (result.ok) {
      const policyError = this._planPolicyError(task, result.plan);
      if (policyError) result = { ...result, ok: false, error: policyError };
    }

    if (!result.ok) {
      task = await this.store.updateTask(taskId, draft => {
        draft.planStatus = 'invalid';
        draft.messages.push({
          role: 'user',
          content: `[PLAN UNAVAILABLE] ${result.error || 'Planner returned an invalid plan'}. Continue without a plan; do not rewrite the plan.`,
        });
      });
      await this._record(taskId, 'plan.invalid', { error: result.error || 'invalid plan' });
      if (context.plannerRequired === true) {
        return this._failTask(
          taskId,
          result.code === 'context-overflow' ? 'context-overflow' : 'plan-invalid',
          result.error || 'Planner returned an invalid plan'
        );
      }
      return task;
    }

    const first = firstPendingStep(result.plan);
    task = await this.store.updateTask(taskId, draft => {
      draft.plan = result.plan.map(step => ({ ...step }));
      draft.planStatus = 'active';
      draft.currentPlanStepId = first?.id || null;
    });
    await this._record(taskId, 'plan.created', { plan: result.plan });
    return task;
  }

  _planPolicyError(task, plan) {
    const backgroundRestricted = task?.permissions?.profile === 'background-restricted';
    if (!backgroundRestricted || this.policy.backgroundApprovalAvailable !== false) return null;

    for (const step of plan) {
      if (!step.tool) continue;
      const tool = this._toolManifest.get(step.tool);
      const risk = tool?.risk || 'read';
      if (risk !== 'read') {
        return `Plan step ${step.id} uses ${step.tool} (${risk}), but this background task has no approval channel`;
      }
    }
    return null;
  }

  async _closePlan(taskId) {
    let task = await this.store.getTask(taskId);
    if (!task || !Array.isArray(task.plan) || task.plan.length === 0) return task;

    task = await this.store.updateTask(taskId, draft => {
      for (const step of draft.plan) {
        if (step.status === 'pending' || step.status === 'active') step.status = 'skipped';
      }
      draft.currentPlanStepId = null;
      draft.planStatus = draft.plan.every(step => step.status === 'completed' || step.status === 'skipped')
        ? 'completed'
        : 'partial';
    });
    await this._record(taskId, 'plan.closed', { planStatus: task.planStatus });
    return task;
  }

  async _advancePlan(taskId, tool, ok) {
    let task = await this.store.getTask(taskId);
    if (!task || !Array.isArray(task.plan) || task.plan.length === 0) return task;
    if (task.planStatus !== 'active') return task;

    let current = task.plan.find(step => step.id === task.currentPlanStepId)
      || firstPendingStep(task.plan);
    if (!current) return task;

    if (current.tool && current.tool !== tool) {
      const matching = task.plan.find(step => step.tool === tool && ['pending', 'active'].includes(step.status));
      if (matching) current = matching;
      // Do not mark a planned tool step complete because the model called a
      // different, unplanned tool. The plan will close honestly as skipped.
      else return task;
    }

    task = await this.store.updateTask(taskId, draft => {
      const step = draft.plan.find(entry => entry.id === current.id);
      if (!step) return;
      step.status = ok ? 'completed' : 'failed';
      const next = draft.plan.find(entry => entry.status === 'pending' || entry.status === 'active');
      draft.currentPlanStepId = next?.id || null;
      if (draft.plan.every(entry => entry.status === 'completed' || entry.status === 'skipped')) {
        draft.planStatus = 'completed';
      }
    });
    await this._record(taskId, ok ? 'plan.step.completed' : 'plan.step.failed', {
      stepId: current.id,
      tool,
    });
    return task;
  }

  async _handleFailedPlanStep(taskId, tool, result, context, capabilities, signal) {
    let task = await this.store.getTask(taskId);
    if (!task || task.planStatus !== 'active' || !Array.isArray(task.plan)) return null;

    const failedStep = task.plan.find(step => (
      step.id === task.currentPlanStepId && step.status === 'failed'
    )) || task.plan.find(step => step.status === 'failed');
    if (!failedStep) return null;
    if ((failedStep.revision || 0) >= 1) {
      await this._appendUserNotice(
        taskId,
        `[PLAN STEP FAILED] Step ${failedStep.id} has already been revised once. Do not repeat the same failed call; choose a different concrete action or explain the limitation.`
      );
      return null;
    }

    let revision;
    try {
      revision = await this.planner.reviseStep({
        task,
        failedStep,
        error: result?.error || result?.result?.error || 'tool failed',
        capabilities,
        modelOptions: context.modelOptions || {},
        signal,
      });
    } catch (error) {
      revision = { ok: false, error: errorMessage(error), errorCode: error.code || null };
    }
    if (revision.errorCode === 'context-overflow') {
      return {
        terminal: true,
        task: await this._failTask(
          taskId,
          'context-overflow',
          `Planner revision prompt overflow: ${revision.error}`
        ),
      };
    }

    if (revision.usage) {
      const usage = await this._consumeUsage(taskId, revision.usage, {
        completionTokens: estimateTokens(revision.raw || ''),
      });
      task = usage.task;
      if (usage.exceeded) {
        return {
          terminal: true,
          task: await this._failTask(
            taskId,
            'token-cap',
            `Token cap of ${task.maxTokens} exceeded while revising a plan step`
          ),
        };
      }
    }

    if (!revision.ok) {
      await this._appendUserNotice(
        taskId,
        `[PLAN REVISION FAILED] Step ${failedStep.id}: ${revision.error || 'no revised step was returned'}. Continue with a different concrete action; do not repeat the same call.`
      );
      await this._record(taskId, 'plan.revision_failed', { stepId: failedStep.id, error: revision.error });
      return null;
    }

    task = await this.store.updateTask(taskId, draft => {
      const step = draft.plan.find(entry => entry.id === failedStep.id);
      if (!step) return;
      step.description = revision.patch.description;
      step.status = 'pending';
      step.revision = (step.revision || 0) + 1;
      if (revision.patch.tool) step.tool = revision.patch.tool;
      else delete step.tool;
      if (revision.patch.args) step.args = revision.patch.args;
      else delete step.args;
      draft.currentPlanStepId = step.id;
      draft.planStatus = 'active';
    });
    await this._record(taskId, 'plan.step.revised', {
      stepId: failedStep.id,
      patch: revision.patch,
      tool,
    });
    return { task };
  }

  async _enforceCaps(task) {
    if (task.stepCount >= task.maxSteps) {
      return this._failTask(
        task.id,
        'step-cap',
        `Step cap of ${task.maxSteps} reached before the goal was completed`
      );
    }
    if (Number.isFinite(task.startedAt) && this.now() - task.startedAt > task.maxDurationMs) {
      return this._failTask(
        task.id,
        'time-cap',
        `Time cap of ${task.maxDurationMs}ms reached before the goal was completed`
      );
    }
    if (task.tokenUsage.totalTokens >= task.maxTokens) {
      return this._failTask(
        task.id,
        'token-cap',
        `Token cap of ${task.maxTokens} reached before the goal was completed`
      );
    }
    return null;
  }

  async _consumeUsage(taskId, usage, fallback = {}) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const promptTokens = Number.isInteger(usage?.promptTokens)
      ? usage.promptTokens
      : (Number.isInteger(fallback.promptTokens) ? fallback.promptTokens : 0);
    const completionTokens = Number.isInteger(usage?.completionTokens)
      ? usage.completionTokens
      : (Number.isInteger(fallback.completionTokens) ? fallback.completionTokens : 0);
    const totalTokens = Number.isInteger(usage?.totalTokens)
      ? usage.totalTokens
      : promptTokens + completionTokens;

    const updated = await this.store.updateTask(taskId, draft => {
      draft.tokenUsage = {
        promptTokens: draft.tokenUsage.promptTokens + Math.max(0, promptTokens),
        completionTokens: draft.tokenUsage.completionTokens + Math.max(0, completionTokens),
        totalTokens: draft.tokenUsage.totalTokens + Math.max(0, totalTokens),
      };
    });
    return { task: updated, exceeded: updated.tokenUsage.totalTokens > updated.maxTokens };
  }

  _detectLoop(task, toolCall) {
    const key = `${toolCall.tool}:${stableStringify(toolCall.args || {})}`;
    const tools = (task.steps || []).filter(step => step && step.kind === 'tool');
    let repeats = 0;
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const step = tools[index];
      if (`${step.tool}:${stableStringify(step.args || {})}` !== key) break;
      repeats += 1;
    }
    if (repeats >= LOOP_REPEAT_LIMIT - 1) {
      return {
        kind: 'repeat',
        tool: toolCall.tool,
        args: toolCall.args,
        repeats,
        message: `Loop detected: ${toolCall.tool} was called with identical arguments ${repeats + 1} times`,
      };
    }

    let failures = 0;
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const step = tools[index];
      if (`${step.tool}:${stableStringify(step.args || {})}` !== key) break;
      if (step.status !== 'failed') break;
      failures += 1;
    }
    if (failures >= LOOP_FAILURE_LIMIT - 1) {
      return {
        kind: 'failure',
        tool: toolCall.tool,
        args: toolCall.args,
        failures,
        message: `Loop detected: ${toolCall.tool} failed twice with identical arguments`,
      };
    }
    return null;
  }

  async _shouldVerify(task, context) {
    if (context.verify === true) return true;
    if (task.metadata?.runtime?.verify === true) return true;
    for (const step of task.steps || []) {
      if (!step || step.kind !== 'tool' || step.status !== 'completed') continue;
      const tool = this._skillForCall({ tool: step.tool, args: step.args || {} });
      if (tool && (tool.risk === 'write' || tool.risk === 'destructive')) return true;
    }
    return false;
  }

  async _verifyIfRequired(task, final, context, capabilities, signal) {
    if (!(await this._shouldVerify(task, context))) return null;

    let result;
    try {
      result = await this.verifier.verify({
        task,
        plan: task.plan,
        finalAnswer: final,
        toolResults: compactToolResults(task.steps),
        capabilities,
        modelOptions: context.modelOptions || {},
        signal,
      });
    } catch (error) {
      if (error.code === 'context-overflow') {
        return {
          accepted: false,
          terminal: true,
          task: await this._failTask(task.id, 'context-overflow', `Verifier prompt overflow: ${errorMessage(error)}`),
        };
      }
      result = { accepted: false, reason: `Verifier failed: ${errorMessage(error)}`, guidance: '' };
    }

    if (result.usage) {
      const usage = await this._consumeUsage(task.id, result.usage, {
        completionTokens: estimateTokens(result.raw || ''),
      });
      if (usage.exceeded) {
        return {
          terminal: true,
          task: await this._failTask(
            task.id,
            'token-cap',
            `Token cap of ${usage.task.maxTokens} exceeded during verification`
          ),
        };
      }
    }

    const attempts = Number(task.verification?.attempts || 0) + 1;
    const record = {
      status: result.accepted ? 'accepted' : 'rejected',
      attempts,
      reason: result.reason || null,
      guidance: result.guidance || null,
      at: this.now(),
    };
    task = await this.store.updateTask(task.id, draft => {
      draft.verification = record;
    });
    await this._record(task.id, result.accepted ? 'verification.accepted' : 'verification.rejected', record);
    return { ...result, attempts, record, task };
  }

  async _markOrphanedSteps(taskId) {
    const task = await this.store.getTask(taskId);
    if (!task) return;
    const orphaned = task.steps.filter(step => step.status === 'started');
    if (orphaned.length === 0) return;

    await this.store.updateTask(taskId, draft => {
      for (const step of draft.steps) {
        if (step.status !== 'started') continue;
        step.status = 'unknown';
        step.finishedAt = this.now();
        step.error = 'Runtime restarted while this step was in flight';
      }
      draft.messages.push({
        role: 'user',
        content: '[RUNTIME NOTICE: a previous step was interrupted by a restart. Verify its state before retrying any write.]',
      });
    });
    await this._record(taskId, 'runtime.recovered', { steps: orphaned.map(step => step.id) });
  }

  async _executeApprovedApprovals(taskId, context, signal) {
    let task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const approved = task.approvals.filter(approval => (
      approval.status === 'approved' && !approval.consumedAt
    ));

    for (const approval of approved) {
      if (signal.aborted) return this.store.getTask(taskId);
      const toolCall = approval.toolCall;
      const executed = await this._executeToolStep({
        taskId,
        stepIndex: approval.stepIndex || task.stepCount,
        toolCall,
        context,
        signal,
        taint: Boolean(approval.taint),
      });
      if (!executed) return this.store.getTask(taskId);

      task = await this._advancePlan(taskId, toolCall.tool, executed.ok);
      task = await this.store.updateTask(taskId, draft => {
        const current = draft.approvals.find(entry => entry.id === approval.id);
        if (current) current.consumedAt = this.now();
      });
    }

    return task;
  }

  async _executeInitialToolCall(taskId, context, signal) {
    const seed = context?.initialToolCall;
    if (!seed || typeof seed !== 'object' || typeof seed.tool !== 'string') return null;
    if (signal?.aborted) return null;

    let task = await this.store.getTask(taskId);
    if (!task || task.status !== TASK_STATUS.RUNNING) return null;

    const existing = task.steps.find(step => (
      step && step.kind === 'tool' && step.seeded === true && step.tool === seed.tool
    ));
    if (existing) {
      if (context.completeWithToolResult) {
        return { terminal: true, task: await this._completeFromSeededStep(taskId, existing) };
      }
      return null;
    }

    if (task.stepCount >= task.maxSteps) {
      return {
        terminal: true,
        task: await this._failTask(
          taskId,
          'step-cap',
          `Step cap of ${task.maxSteps} reached before the seeded tool could run`
        ),
      };
    }

    const toolCall = {
      tool: seed.tool,
      args: seed.args && typeof seed.args === 'object' ? seed.args : {},
      native: false,
    };
    const skill = this._skillForCall(toolCall);
    let decision;
    try {
      decision = await this.policy.authorize({
        task,
        taskId,
        toolCall,
        skill,
        store: this.store,
      });
    } catch (error) {
      return { terminal: true, task: await this._failTask(taskId, 'policy-error', errorMessage(error)) };
    }

    // A seed is a deterministic read-only first step. If policy would require
    // approval or deny it, do not bypass the policy: leave the task to the
    // normal model loop, which will see the denial and can explain it.
    if (decision.decision !== 'allow') {
      await this._appendToolMessage(
        taskId,
        toolCall.tool,
        `[TOOL_RESULT: denied — ${decision.reason || decision.error || 'policy denied'}]`,
        toolCall
      );
      return null;
    }

    const stepIndex = task.stepCount + 1;
    task = await this.store.updateTask(taskId, draft => {
      draft.stepCount = stepIndex;
    });

    const executed = await this._executeToolStep({
      taskId,
      stepIndex,
      toolCall,
      context,
      signal,
      taint: Boolean(decision.taint),
      seeded: true,
    });
    if (!executed) return null;

    if (context.completeWithToolResult) {
      const current = await this.store.getTask(taskId);
      const seededStep = current?.steps.find(step => (
        step && step.kind === 'tool' && step.seeded === true && step.tool === toolCall.tool
      ));
      return {
        terminal: true,
        task: seededStep
          ? await this._completeFromSeededStep(taskId, seededStep)
          : await this._failTask(taskId, 'seeded-result-missing', 'Seeded tool result was not recorded'),
      };
    }

    await this.store.updateTask(taskId, draft => {
      draft.messages.push({
        role: 'user',
        content: '[RUNTIME NOTE] The preceding [TOOL_RESULT] is real measured data. Use those values exactly; do not invent or substitute measurements.',
      });
    });
    await this._record(taskId, 'runtime.note', { kind: 'seeded-tool-result' });
    return null;
  }

  async _completeFromSeededStep(taskId, step) {
    if (!step || step.status !== 'completed' || !step.result || step.result.ok === false) {
      const error = step?.error || step?.result?.error || 'Seeded tool did not return a usable result';
      return this._failTask(taskId, 'seeded-tool-error', error);
    }
    const result = step.result;
    const text = result.displayMarkdown || result.summaryText || JSON.stringify(result);
    return this.store.transition(taskId, TASK_STATUS.COMPLETED, {
      reason: 'seeded-tool-result',
      patch: {
        result: text,
        error: null,
        errorCode: null,
        planStatus: 'none',
        currentPlanStepId: null,
      },
    });
  }

  _toolRisk(toolCall) {
    const tool = this._skillForCall(toolCall);
    return tool && typeof tool.risk === 'string' ? tool.risk : null;
  }

  async _executeToolStep({ taskId, stepIndex, toolCall, context, signal, taint, seeded = false }) {
    let task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== TASK_STATUS.RUNNING) return null;
    if (signal?.aborted) return null;

    const toolStepId = makeId('tool');
    await this.store.updateTask(taskId, draft => {
      draft.steps.push({
        id: toolStepId,
        index: stepIndex,
        kind: 'tool',
        tool: toolCall.tool,
        args: toolCall.args,
        seeded: Boolean(seeded),
        status: 'started',
        startedAt: this.now(),
      });
      if (taint) draft.tainted = true;
    });
    await this._record(taskId, 'tool.started', {
      stepId: toolStepId,
      tool: toolCall.tool,
      args: toolCall.args,
      seeded: Boolean(seeded),
    });

    const risk = this._toolRisk(toolCall);
    const maxAttempts = !seeded && risk === 'read' ? 1 + READ_RETRY_LIMIT : 1;
    const attempts = [];
    let result = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        result = await this.tools.execute(toolCall, { taskId, signal, context });
      } catch (error) {
        result = { ok: false, error: errorMessage(error) };
      }
      const ok = !(result && typeof result === 'object' && result.ok === false);
      attempts.push({ attempt, ok, error: ok ? null : (result?.error || 'tool failed') });
      if (ok) break;
      if (attempt < maxAttempts) {
        await this._record(taskId, 'tool.retry', {
          stepId: toolStepId,
          tool: toolCall.tool,
          attempt,
          error: result?.error || 'tool failed',
          risk,
        });
      }
    }

    if (signal?.aborted) return null;

    const ok = !(result && typeof result === 'object' && result.ok === false);
    const content = formatToolPayload(toolCall.tool, result);
    const role = toolCall.native ? 'tool' : 'user';

    await this.store.updateTask(taskId, draft => {
      const step = draft.steps.find(entry => entry.id === toolStepId);
      if (step) {
        step.status = ok ? 'completed' : 'failed';
        step.finishedAt = this.now();
        step.result = result;
        step.attempts = attempts;
        if (!ok) step.error = result?.error || 'tool failed';
      }
      draft.messages.push({
        role,
        content,
        ...(toolCall.native
          ? { name: toolCall.tool, ...(toolCall.id ? { toolCallId: toolCall.id } : {}) }
          : {}),
      });
      if (result && typeof result === 'object' && result.taint) draft.tainted = true;
    });

    await this._record(taskId, ok ? 'tool.completed' : 'tool.failed', {
      stepId: toolStepId,
      tool: toolCall.tool,
      ok,
      error: ok ? null : (result?.error || null),
      attempts: attempts.length,
      risk,
    });

    return { ok, result, stepId: toolStepId };
  }

  async _appendUserNotice(taskId, content) {
    await this.store.updateTask(taskId, draft => {
      draft.messages.push({ role: 'user', content });
    });
  }

  async _appendToolMessage(taskId, tool, content, toolCall) {
    await this.store.updateTask(taskId, draft => {
      draft.steps.push({
        id: makeId('tool'),
        index: draft.stepCount,
        kind: 'tool',
        tool,
        args: toolCall?.args || {},
        status: 'failed',
        startedAt: this.now(),
        finishedAt: this.now(),
        error: content,
      });
      const role = toolCall?.native ? 'tool' : 'user';
      draft.messages.push({
        role,
        content,
        ...(toolCall?.native
          ? { name: tool, ...(toolCall.id ? { toolCallId: toolCall.id } : {}) }
          : {}),
      });
    });
    await this._record(taskId, 'tool.failed', { tool, error: content });
  }

  async approveTask(taskId, { approved, reason = null, context = {}, wait = true } = {}) {
    assertTaskId(taskId);
    if (typeof approved !== 'boolean') throw new Error('approved must be a boolean');

    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== TASK_STATUS.WAITING_APPROVAL) {
      throw new Error(`Task is not waiting for approval: ${task.status}`);
    }

    const pending = [...task.approvals].reverse().find(entry => entry.status === 'pending');
    if (!pending) throw new Error('No pending approval found');

    await this.store.updateTask(taskId, draft => {
      const entry = draft.approvals.find(approval => approval.id === pending.id);
      if (!entry) throw new Error('Pending approval disappeared');
      entry.status = approved ? 'approved' : 'denied';
      entry.resolvedAt = this.now();
      entry.reason = reason || entry.reason;
    });

    if (!approved) {
      return this.store.transition(taskId, TASK_STATUS.CANCELLED, {
        reason: reason || 'approval-denied',
      });
    }

    const runningTask = await this.store.transition(taskId, TASK_STATUS.RUNNING, {
      reason: 'approval-granted',
    });

    if (!wait) return runningTask;

    return this.runTask(taskId, context, { fromApproval: true, alreadyRunning: true });
  }

  async cancelTask(taskId, reason = 'user-request') {
    assertTaskId(taskId);
    const controller = this._controllers.get(taskId);
    if (controller) controller.abort(new Error(reason));

    const task = await this.store.getTask(taskId);
    if (!task) return null;
    if (isTerminalStatus(task.status)) return task;

    try {
      return await this.store.transition(taskId, TASK_STATUS.CANCELLED, { reason });
    } catch (error) {
      const current = await this.store.getTask(taskId);
      if (current && isTerminalStatus(current.status)) return current;
      throw error;
    }
  }

  async _settleAfterAbort(taskId) {
    const task = await this.store.getTask(taskId);
    if (!task) return null;
    if (task.status === TASK_STATUS.RUNNING) {
      return this.store.transition(taskId, TASK_STATUS.CANCELLED, {
        reason: 'aborted',
      });
    }
    return task;
  }

  async _failTask(taskId, code, message) {
    const task = await this.store.getTask(taskId);
    if (!task) return null;
    if (isTerminalStatus(task.status)) return task;

    await this._record(taskId, 'task.failed', { code, message });

    const latest = await this.store.getTask(taskId);
    if (!latest || isTerminalStatus(latest.status)) return latest;

    try {
      return await this.store.transition(taskId, TASK_STATUS.FAILED, {
        reason: code,
        patch: { error: message, errorCode: code },
      });
    } catch (error) {
      const current = await this.store.getTask(taskId);
      if (current && isTerminalStatus(current.status)) return current;
      throw error;
    }
  }
}

module.exports = {
  AgentRuntime,
  formatToolPayload,
  MAX_TOOL_OUTPUT_CHARS,
  LOOP_REPEAT_LIMIT,
  LOOP_FAILURE_LIMIT,
  READ_RETRY_LIMIT,
  MAX_VERIFY_ATTEMPTS,
};
