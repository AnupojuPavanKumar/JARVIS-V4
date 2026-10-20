'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { assertTaskId } = require('./task-state');

const EVENT_SCHEMA_VERSION = 1;
const MAX_EVENT_TYPE_LENGTH = 100;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Append-only JSONL event log. One file per task:
//   <baseDir>/<taskId>/events.jsonl
//
// Writes are serialized per task, flushed with fsync, and are intentionally
// simple so the log can be inspected or replayed without a database.
class EventLog {
  constructor({ baseDir, now = Date.now } = {}) {
    if (!baseDir) throw new Error('EventLog requires baseDir');
    this.baseDir = path.resolve(baseDir);
    this.now = now;
    this._queues = new Map();
  }

  async init() {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    return this;
  }

  _taskDir(taskId) {
    assertTaskId(taskId);
    return path.join(this.baseDir, taskId);
  }

  _eventPath(taskId) {
    return path.join(this._taskDir(taskId), 'events.jsonl');
  }

  _withLock(taskId, fn) {
    const previous = this._queues.get(taskId) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this._queues.set(taskId, current);
    return current.finally(() => {
      if (this._queues.get(taskId) === current) this._queues.delete(taskId);
    });
  }

  async append(taskId, type, data = null) {
    assertTaskId(taskId);
    if (typeof type !== 'string' || !type.trim() || type.length > MAX_EVENT_TYPE_LENGTH) {
      throw new Error('Invalid event type');
    }

    const event = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: `evt_${crypto.randomBytes(12).toString('hex')}`,
      taskId,
      type: type.trim(),
      at: new Date(this.now()).toISOString(),
      data: data === undefined ? null : clone(data),
    };

    let line;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (error) {
      throw new Error(`Event data is not JSON-serializable: ${error.message}`);
    }

    return this._withLock(taskId, async () => {
      const taskDir = this._taskDir(taskId);
      await fs.promises.mkdir(taskDir, { recursive: true });

      const file = this._eventPath(taskId);
      const handle = await fs.promises.open(file, 'a');
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      return event;
    });
  }

  async read(taskId, { limit = null } = {}) {
    assertTaskId(taskId);

    let content;
    try {
      content = await fs.promises.readFile(this._eventPath(taskId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const events = [];
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`Corrupt event log for ${taskId} at line ${index + 1}: ${error.message}`);
      }

      if (!event || event.taskId !== taskId) {
        throw new Error(`Corrupt event log for ${taskId} at line ${index + 1}: task mismatch`);
      }
      events.push(event);
    }

    if (limit !== null) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error('limit must be a non-negative integer');
      }
      return events.slice(-limit);
    }
    return events;
  }
}

module.exports = { EventLog, EVENT_SCHEMA_VERSION };
