'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { EventLog } = require('./event-log');
const {
  TASK_STATUS,
  TASK_ID_RE,
  assertTaskId,
  assertTaskStatus,
  assertTransition,
  isInterruptibleStatus,
  isTerminalStatus,
} = require('./task-state');

const TASK_SCHEMA_VERSION = 1;
const DEFAULT_MAX_STEPS = 15;
const MAX_STEPS_LIMIT = 100;
const MAX_GOAL_LENGTH = 20000;
const MAX_SOURCE_LENGTH = 80;
const MAX_LIST_LIMIT = 500;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

// Durable task store. A task is a directory:
//   <baseDir>/<taskId>/task.json
//   <baseDir>/<taskId>/events.jsonl
//
// task.json is replaced atomically; events are append-only. This keeps the
// store inspectable and avoids a native database dependency in Phase 1.
class TaskStore {
  constructor({
    baseDir,
    eventLog = null,
    now = Date.now,
    defaultMaxSteps = DEFAULT_MAX_STEPS,
  } = {}) {
    if (!baseDir) throw new Error('TaskStore requires baseDir');

    this.baseDir = path.resolve(baseDir);
    this.now = now;
    this.defaultMaxSteps = defaultMaxSteps;
    this.eventLog = eventLog || new EventLog({ baseDir: this.baseDir, now });
    this._locks = new Map();
  }

  async init() {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    await this.eventLog.init();
    return this;
  }

  _taskDir(taskId) {
    assertTaskId(taskId);
    return path.join(this.baseDir, taskId);
  }

  _taskPath(taskId) {
    return path.join(this._taskDir(taskId), 'task.json');
  }

  _withLock(taskId, fn) {
    const previous = this._locks.get(taskId) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this._locks.set(taskId, current);
    return current.finally(() => {
      if (this._locks.get(taskId) === current) this._locks.delete(taskId);
    });
  }

  _validateTask(task, expectedId = null) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error('Task must be an object');
    }
    if (task.schemaVersion !== TASK_SCHEMA_VERSION) {
      throw new Error(`Unsupported task schema version: ${String(task.schemaVersion)}`);
    }

    assertTaskId(task.id);
    if (expectedId && task.id !== expectedId) {
      throw new Error(`Task id mismatch: expected ${expectedId}, got ${task.id}`);
    }

    if (typeof task.goal !== 'string' || !task.goal.trim()) {
      throw new Error('Task goal must be a non-empty string');
    }
    if (typeof task.source !== 'string' || !task.source.trim()) {
      throw new Error('Task source must be a non-empty string');
    }
    assertTaskStatus(task.status);

    if (!Number.isInteger(task.stepCount) || task.stepCount < 0) {
      throw new Error('Task stepCount must be a non-negative integer');
    }
    if (!Number.isInteger(task.maxSteps) || task.maxSteps < 1 || task.maxSteps > MAX_STEPS_LIMIT) {
      throw new Error(`Task maxSteps must be an integer between 1 and ${MAX_STEPS_LIMIT}`);
    }
    if (!Array.isArray(task.steps)) throw new Error('Task steps must be an array');
    if (!Array.isArray(task.approvals)) throw new Error('Task approvals must be an array');

    // Backward-compatible defaults for tasks created before these fields existed.
    if (task.messages === undefined) task.messages = [];
    if (task.tainted === undefined) task.tainted = false;
    if (!Array.isArray(task.messages)) throw new Error('Task messages must be an array');
    if (typeof task.tainted !== 'boolean') throw new Error('Task tainted must be a boolean');

    if (!Number.isFinite(task.createdAt)) throw new Error('Task createdAt must be a number');
    if (!Number.isFinite(task.updatedAt)) throw new Error('Task updatedAt must be a number');
    if (task.startedAt !== null && !Number.isFinite(task.startedAt)) {
      throw new Error('Task startedAt must be a number or null');
    }
    if (task.finishedAt !== null && !Number.isFinite(task.finishedAt)) {
      throw new Error('Task finishedAt must be a number or null');
    }

    return task;
  }

  async _readTask(taskId) {
    let content;
    try {
      content = await fs.promises.readFile(this._taskPath(taskId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Failed to read task ${taskId}: ${error.message}`);
    }

    let task;
    try {
      task = JSON.parse(content);
    } catch (error) {
      throw new Error(`Corrupt task file for ${taskId}: ${error.message}`);
    }

    return this._validateTask(task, taskId);
  }

  async _writeTask(task) {
    this._validateTask(task, task.id);

    const taskDir = this._taskDir(task.id);
    const taskPath = this._taskPath(task.id);
    await fs.promises.mkdir(taskDir, { recursive: true });

    let json;
    try {
      json = JSON.stringify(task, null, 2);
    } catch (error) {
      throw new Error(`Task is not JSON-serializable: ${error.message}`);
    }

    const tempPath = `${taskPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let handle = null;
    try {
      handle = await fs.promises.open(tempPath, 'w');
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;

      // Windows can transiently return EPERM/EBUSY when an indexer or antivirus
      // scanner has the destination open. Retry briefly; never fall back to a
      // non-atomic direct overwrite.
      let lastError = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await fs.promises.rename(tempPath, taskPath);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 5) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
        }
      }
      if (lastError) throw lastError;
    } finally {
      if (handle) {
        try { await handle.close(); } catch { /* best effort */ }
      }
      try { await fs.promises.unlink(tempPath); } catch { /* renamed or never created */ }
    }
  }

  async _listTaskEntries() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    return entries
      .filter(entry => entry.isDirectory() && TASK_ID_RE.test(entry.name))
      .map(entry => entry.name);
  }

  async createTask({
    id = null,
    goal,
    source = 'ui',
    permissions = { profile: 'default' },
    metadata = {},
    maxSteps = this.defaultMaxSteps,
  } = {}) {
    if (typeof goal !== 'string' || !goal.trim()) {
      throw new Error('Task goal must be a non-empty string');
    }
    if (goal.length > MAX_GOAL_LENGTH) {
      throw new Error(`Task goal exceeds ${MAX_GOAL_LENGTH} characters`);
    }
    if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE_LENGTH) {
      throw new Error('Task source must be a non-empty string of at most 80 characters');
    }
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) {
      throw new Error(`Task maxSteps must be an integer between 1 and ${MAX_STEPS_LIMIT}`);
    }
    if (permissions !== null && typeof permissions !== 'object' && typeof permissions !== 'string') {
      throw new Error('Task permissions must be an object or string');
    }
    assertPlainObject(metadata, 'Task metadata');

    const taskId = id || `task_${crypto.randomBytes(16).toString('hex')}`;
    assertTaskId(taskId);

    const now = this.now();
    const task = {
      schemaVersion: TASK_SCHEMA_VERSION,
      id: taskId,
      goal,
      source: source.trim(),
      permissions: clone(permissions),
      metadata: clone(metadata),
      status: TASK_STATUS.QUEUED,
      stepCount: 0,
      maxSteps,
      steps: [],
      approvals: [],
      messages: [],
      tainted: false,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };

    this._validateTask(task, taskId);

    return this._withLock(taskId, async () => {
      const existing = await this._readTask(taskId);
      if (existing) throw new Error(`Task already exists: ${taskId}`);

      await this._writeTask(task);
      await this.eventLog.append(taskId, 'task.created', {
        goal: task.goal,
        source: task.source,
        permissions: task.permissions,
        maxSteps: task.maxSteps,
      });

      return clone(task);
    });
  }

  async getTask(taskId) {
    assertTaskId(taskId);
    const task = await this._readTask(taskId);
    return task ? clone(task) : null;
  }

  async listTasks({ limit = 100, status = null } = {}) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be an integer between 0 and ${MAX_LIST_LIMIT}`);
    }
    if (status !== null) assertTaskStatus(status);
    if (limit === 0) return [];

    const ids = await this._listTaskEntries();
    const tasks = (await Promise.all(ids.map(taskId => this._readTask(taskId).catch(() => null))))
      .filter(Boolean)
      .filter(task => status === null || task.status === status);

    tasks.sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return b.id.localeCompare(a.id);
    });

    return tasks.slice(0, limit).map(clone);
  }

  _prepareNextTask(previous, next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('Task update must produce an object');
    }
    if (next.id !== previous.id) throw new Error('Task id cannot be changed');
    if (next.createdAt !== previous.createdAt) throw new Error('Task createdAt cannot be changed');
    if (next.schemaVersion !== previous.schemaVersion) {
      throw new Error('Task schemaVersion cannot be changed');
    }

    if (next.status !== previous.status) {
      assertTransition(previous.status, next.status);
    }

    const now = this.now();
    next.updatedAt = now;

    if (next.status === TASK_STATUS.RUNNING && next.startedAt === null) {
      next.startedAt = now;
    }
    if (isTerminalStatus(next.status) && next.finishedAt === null) {
      next.finishedAt = now;
    }

    return this._validateTask(next, previous.id);
  }

  async updateTask(taskId, mutator) {
    assertTaskId(taskId);
    if (typeof mutator !== 'function') throw new Error('Task mutator must be a function');

    return this._withLock(taskId, async () => {
      const previous = await this._readTask(taskId);
      if (!previous) throw new Error(`Task not found: ${taskId}`);

      const draft = clone(previous);
      const replacement = await mutator(draft);
      const next = this._prepareNextTask(previous, replacement === undefined ? draft : replacement);

      await this._writeTask(next);
      await this.eventLog.append(taskId, 'task.updated', {
        status: next.status,
        stepCount: next.stepCount,
      });

      return clone(next);
    });
  }

  async transition(taskId, toStatus, { reason = null, patch = {} } = {}) {
    assertTaskId(taskId);
    assertTaskStatus(toStatus);
    assertPlainObject(patch, 'Task patch');

    return this._withLock(taskId, async () => {
      const previous = await this._readTask(taskId);
      if (!previous) throw new Error(`Task not found: ${taskId}`);

      const next = {
        ...clone(previous),
        ...clone(patch),
        status: toStatus,
      };
      const prepared = this._prepareNextTask(previous, next);

      await this._writeTask(prepared);
      await this.eventLog.append(taskId, 'task.transition', {
        from: previous.status,
        to: toStatus,
        reason,
      });

      return clone(prepared);
    });
  }

  async appendEvent(taskId, type, data = null) {
    assertTaskId(taskId);
    return this.eventLog.append(taskId, type, data);
  }

  async readEvents(taskId, options = {}) {
    assertTaskId(taskId);
    return this.eventLog.read(taskId, options);
  }

  // Called once at startup, before any new task is run. Only tasks that were
  // actively planning/running are marked interrupted; queued, paused, and
  // waiting_approval tasks remain resumable exactly as persisted.
  async recoverInterruptedTasks() {
    const tasks = await this.listTasks({ limit: MAX_LIST_LIMIT });
    const recovered = [];

    for (const task of tasks) {
      if (!isInterruptibleStatus(task.status)) continue;
      const updated = await this.transition(task.id, TASK_STATUS.INTERRUPTED, {
        reason: 'process-restarted',
      });
      recovered.push(updated);
    }

    return recovered;
  }
}

module.exports = {
  TaskStore,
  TASK_SCHEMA_VERSION,
  DEFAULT_MAX_STEPS,
  MAX_STEPS_LIMIT,
  MAX_GOAL_LENGTH,
};
