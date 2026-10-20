'use strict';

// Task lifecycle shared by the durable runtime and its persistence layer.
// Keep this module free of Electron, filesystem, and model dependencies.

const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  PLANNING: 'planning',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

const TASK_STATUSES = Object.freeze(Object.values(TASK_STATUS));

const TERMINAL_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);

const INTERRUPTIBLE_STATUSES = new Set([
  TASK_STATUS.PLANNING,
  TASK_STATUS.RUNNING,
]);

const TRANSITIONS = Object.freeze({
  [TASK_STATUS.QUEUED]: [
    TASK_STATUS.PLANNING,
    TASK_STATUS.RUNNING,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
    TASK_STATUS.INTERRUPTED,
  ],
  [TASK_STATUS.PLANNING]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.INTERRUPTED,
  ],
  [TASK_STATUS.RUNNING]: [
    TASK_STATUS.WAITING_APPROVAL,
    TASK_STATUS.PAUSED,
    TASK_STATUS.COMPLETED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.INTERRUPTED,
  ],
  [TASK_STATUS.WAITING_APPROVAL]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.PAUSED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
  ],
  [TASK_STATUS.PAUSED]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
    TASK_STATUS.INTERRUPTED,
  ],
  [TASK_STATUS.INTERRUPTED]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
  ],
  [TASK_STATUS.COMPLETED]: [],
  [TASK_STATUS.FAILED]: [
    TASK_STATUS.QUEUED,
    TASK_STATUS.CANCELLED,
  ],
  [TASK_STATUS.CANCELLED]: [],
});

const TASK_ID_RE = /^task_[a-f0-9]{32}$/;

function isTaskStatus(status) {
  return TASK_STATUSES.includes(status);
}

function assertTaskStatus(status) {
  if (!isTaskStatus(status)) {
    throw new Error(`Invalid task status: ${String(status)}`);
  }
  return status;
}

function canTransition(from, to) {
  if (!isTaskStatus(from) || !isTaskStatus(to)) return false;
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${String(from)} -> ${String(to)}`);
  }
  return to;
}

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error('Invalid task id');
  }
  return taskId;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function isInterruptibleStatus(status) {
  return INTERRUPTIBLE_STATUSES.has(status);
}

module.exports = {
  TASK_STATUS,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  INTERRUPTIBLE_STATUSES,
  TASK_ID_RE,
  isTaskStatus,
  assertTaskStatus,
  canTransition,
  assertTransition,
  assertTaskId,
  isTerminalStatus,
  isInterruptibleStatus,
};
