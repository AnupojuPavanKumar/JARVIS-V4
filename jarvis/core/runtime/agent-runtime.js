'use strict';

const crypto = require('crypto');

const {
  TASK_STATUS,
  assertTaskId,
  isTerminalStatus,
} = require('./task-state');
const { parseToolCall, stripToolCalls } = require('../tools/tool-call-parser');

const MAX_TOOL_OUTPUT_CHARS = 3000;

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    const payload = result.result ?? result.data ?? result.output ?? result;
    output = typeof payload === 'object'
      ? JSON.stringify(payload, null, 2)
      : String(payload);
  } else {
    output = String(result ?? '');
  }

  if (output.length > MAX_TOOL_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n...[TRUNCATED: output exceeded ${MAX_TOOL_OUTPUT_CHARS} chars]`;
  }

  return `[TOOL_RESULT: ${tool}]\n${output}\n[END_TOOL_RESULT]`;
}

// Durable ReAct-style runtime. The renderer, Ollama, Electron, and skill
// spawning are all injected dependencies so the loop can be tested in isolation.
class AgentRuntime {
  constructor({
    store,
    model,
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

    this._active = new Map();
    this._controllers = new Map();
    this.toolDefinitions = this._loadToolDefinitions();
  }

  _loadToolDefinitions() {
    if (Array.isArray(this.tools.definitions)) return this.tools.definitions;
    if (typeof this.tools.listDefinitions === 'function') return this.tools.listDefinitions();
    return [];
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
          patch: { error: null, result: null, startedAt: null, finishedAt: null },
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

      task = await this._ensureGoalMessage(taskId);
      task = await this._executeApprovedApprovals(taskId, context, controller.signal);
      if (controller.signal.aborted) return this._settleAfterAbort(taskId);

      while (!controller.signal.aborted) {
        task = await this.store.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.status !== TASK_STATUS.RUNNING) return task;

        if (task.stepCount >= task.maxSteps) {
          return this._failTask(
            taskId,
            'step-cap',
            `Step cap of ${task.maxSteps} reached before the goal was completed`
          );
        }

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
        await this._record(taskId, 'step.started', { stepId, index: stepIndex });

        const messages = this.promptBuilder.build({
          task,
          context,
          tools: this.toolDefinitions,
        });

        let response;
        try {
          response = await this.model.chat({
            messages,
            tools: this.toolDefinitions,
            options: context.modelOptions || {},
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) return this._settleAfterAbort(taskId);
          return this._failTask(taskId, 'model-error', errorMessage(error));
        }

        if (controller.signal.aborted) return this._settleAfterAbort(taskId);

        const nativeCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        const firstNative = nativeCalls[0] || null;
        const parsed = firstNative
          ? {
              tool: firstNative.name,
              args: firstNative.arguments || {},
              id: firstNative.id,
              native: true,
              ...(firstNative.error ? { error: firstNative.error } : {}),
            }
          : (() => {
              const textCall = parseToolCall(response.text);
              return textCall ? { ...textCall, native: false } : null;
            })();

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
          const final = stripToolCalls(response.text).trim();
          if (!final) {
            return this._failTask(taskId, 'empty-response', 'Model returned no final answer');
          }
          return this.store.transition(taskId, TASK_STATUS.COMPLETED, {
            reason: 'model-final',
            patch: { result: final, error: null },
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

        if (parsed.error) {
          await this._appendToolMessage(
            taskId,
            parsed.tool || 'runtime',
            `[TOOL_RESULT: error — ${parsed.error}]`,
            parsed
          );
          continue;
        }

        let decision;
        try {
          const skill = typeof this.tools.getSkill === 'function'
            ? this.tools.getSkill(parsed.tool)
            : null;
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
      }

      return this._settleAfterAbort(taskId);
    } catch (error) {
      return this._failTask(taskId, 'runtime-error', errorMessage(error));
    }
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

      task = await this.store.updateTask(taskId, draft => {
        const current = draft.approvals.find(entry => entry.id === approval.id);
        if (current) current.consumedAt = this.now();
      });
    }

    return task;
  }

  async _executeToolStep({ taskId, stepIndex, toolCall, context, signal, taint }) {
    let task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== TASK_STATUS.RUNNING) return false;
    if (signal?.aborted) return false;

    const toolStepId = makeId('tool');
    await this.store.updateTask(taskId, draft => {
      draft.steps.push({
        id: toolStepId,
        index: stepIndex,
        kind: 'tool',
        tool: toolCall.tool,
        args: toolCall.args,
        status: 'started',
        startedAt: this.now(),
      });
      if (taint) draft.tainted = true;
    });
    await this._record(taskId, 'tool.started', {
      stepId: toolStepId,
      tool: toolCall.tool,
      args: toolCall.args,
    });

    let result;
    try {
      result = await this.tools.execute(toolCall, { taskId, signal, context });
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }

    if (signal.aborted) return false;

    const ok = !(result && typeof result === 'object' && result.ok === false);
    const content = formatToolPayload(toolCall.tool, result);
    const role = toolCall.native ? 'tool' : 'user';

    await this.store.updateTask(taskId, draft => {
      const step = draft.steps.find(entry => entry.id === toolStepId);
      if (step) {
        step.status = ok ? 'completed' : 'failed';
        step.finishedAt = this.now();
        step.result = result;
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
    });

    return true;
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
        patch: { error: message },
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
};
