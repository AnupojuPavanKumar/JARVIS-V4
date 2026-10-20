'use strict';

const { TASK_STATUS } = require('../runtime/task-state');

const DEFAULT_UNTRACKED_READ_LIMIT = 8;
const DEFAULT_UNTRACKED_WINDOW_MS = 60 * 1000;

// Persistent policy boundary for the durable runtime. The TaskStore is the
// source of truth for taint, status, and tool-call counts; approvals are
// returned as a decision and persisted by the runtime.
class PolicyEngine {
  constructor({
    taskStore,
    untrackedReadLimit = DEFAULT_UNTRACKED_READ_LIMIT,
    untrackedWindowMs = DEFAULT_UNTRACKED_WINDOW_MS,
    now = Date.now,
  } = {}) {
    if (!taskStore || typeof taskStore.getTask !== 'function') {
      throw new Error('PolicyEngine requires a TaskStore');
    }
    if (!Number.isInteger(untrackedReadLimit) || untrackedReadLimit < 0) {
      throw new Error('untrackedReadLimit must be a non-negative integer');
    }
    if (!Number.isInteger(untrackedWindowMs) || untrackedWindowMs < 1) {
      throw new Error('untrackedWindowMs must be a positive integer');
    }

    this.taskStore = taskStore;
    this.untrackedReadLimit = untrackedReadLimit;
    this.untrackedWindowMs = untrackedWindowMs;
    this.now = now;
    this._untrackedCalls = [];
  }

  _allowUntrackedRead() {
    const cutoff = this.now() - this.untrackedWindowMs;
    this._untrackedCalls = this._untrackedCalls.filter(timestamp => timestamp >= cutoff);
    if (this._untrackedCalls.length >= this.untrackedReadLimit) return false;
    this._untrackedCalls.push(this.now());
    return true;
  }

  async authorize({ taskId = null, toolCall, skill } = {}) {
    if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.tool !== 'string') {
      return { decision: 'deny', reason: 'invalid-tool-call' };
    }
    if (!skill || typeof skill !== 'object') {
      return { decision: 'deny', reason: 'unknown-tool' };
    }

    const risk = typeof skill.risk === 'string' ? skill.risk : 'read';
    const untrusted = Boolean(skill.untrusted);

    if (!taskId) {
      if (risk !== 'read') {
        return { decision: 'deny', reason: 'unknown-task' };
      }
      if (!this._allowUntrackedRead()) {
        return { decision: 'deny', reason: 'untracked-rate-limit' };
      }
      return { decision: 'allow', taint: untrusted, throwaway: true };
    }

    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      return { decision: 'deny', reason: 'task-not-found' };
    }
    if (task.id !== taskId) {
      return { decision: 'deny', reason: 'task-mismatch' };
    }
    if (task.status !== TASK_STATUS.RUNNING) {
      return { decision: 'deny', reason: `task-not-running(${task.status})` };
    }

    const toolCalls = task.steps.filter(step => (
      step && step.kind === 'tool' && step.status !== 'denied'
    )).length;
    if (toolCalls >= task.maxSteps) {
      return { decision: 'deny', reason: 'tool-cap' };
    }

    if (risk === 'write' || risk === 'destructive') {
      return {
        decision: 'require_approval',
        reason: `risk=${risk}`,
        taint: untrusted,
      };
    }

    if (risk !== 'read') {
      return {
        decision: 'require_approval',
        reason: `risk=${risk}`,
        taint: untrusted,
      };
    }

    if (task.tainted) {
      return {
        decision: 'require_approval',
        reason: 'tainted-task',
        taint: untrusted,
      };
    }

    return { decision: 'allow', taint: untrusted };
  }
}

module.exports = {
  PolicyEngine,
  DEFAULT_UNTRACKED_READ_LIMIT,
  DEFAULT_UNTRACKED_WINDOW_MS,
};
