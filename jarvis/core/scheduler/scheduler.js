'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEDULER_SCHEMA_VERSION = 2;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TICK_MS = 1000;
const MAX_RUNS_STORED = 1000;
const MAX_RESULT_CHARS = 4000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
    timeZone: 'UTC',
  },
  maxRunsPerHour: 0,
  maxRunsPerDay: 0,
  retry: {
    maxAttempts: 2,
    backoffMs: 60_000,
  },
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseClock(value, fallback = '00:00') {
  const raw = typeof value === 'string' ? value.trim() : fallback;
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? { hour: Number(match[1]), minute: Number(match[2]), text: raw } : null;
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  return {
    weekday: WEEKDAYS.indexOf(parts.weekday),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function validateSchedule(schedule) {
  if (!isPlainObject(schedule)) throw new Error('schedule must be an object');
  const frequency = schedule.frequency;
  if (!['daily', 'weekly'].includes(frequency)) {
    throw new Error('schedule.frequency must be daily or weekly');
  }
  const time = parseClock(schedule.time, '09:00');
  if (!time) throw new Error('schedule.time must be HH:MM');
  const timeZone = schedule.timeZone || 'UTC';
  if (!validTimeZone(timeZone)) throw new Error(`Invalid schedule time zone: ${timeZone}`);
  let days = null;
  if (frequency === 'weekly') {
    if (!Array.isArray(schedule.days) || schedule.days.length === 0) {
      throw new Error('weekly schedule requires at least one day (0=Sunday..6=Saturday)');
    }
    days = [...new Set(schedule.days.map(Number))];
    if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('schedule.days must contain integers 0..6');
    }
    days.sort((a, b) => a - b);
  }
  return {
    frequency,
    time: time.text,
    timeZone,
    ...(days ? { days } : {}),
  };
}

function computeNextSchedule(schedule, from = Date.now()) {
  const normalized = validateSchedule(schedule);
  const [hour, minute] = normalized.time.split(':').map(Number);
  const days = normalized.frequency === 'weekly' ? new Set(normalized.days) : null;
  const start = new Date(from);
  start.setUTCSeconds(0, 0);

  // Walk minute-by-minute through the target time zone. This is bounded to
  // eight days, handles daylight-saving transitions through Intl, and avoids
  // adding a cron/timezone dependency.
  for (let minuteOffset = 1; minuteOffset <= 8 * 24 * 60; minuteOffset += 1) {
    const candidate = new Date(start.getTime() + minuteOffset * 60_000);
    const local = zonedParts(candidate, normalized.timeZone);
    if (local.hour !== hour || local.minute !== minute) continue;
    if (days && !days.has(local.weekday)) continue;
    return candidate.getTime();
  }
  throw new Error('Could not compute the next schedule occurrence');
}

function inQuietHours(now, quietHours) {
  if (!quietHours || quietHours.enabled !== true) return false;
  const timeZone = quietHours.timeZone || 'UTC';
  if (!validTimeZone(timeZone)) return false;
  const start = parseClock(quietHours.start, '22:00');
  const end = parseClock(quietHours.end, '07:00');
  if (!start || !end || (start.hour === end.hour && start.minute === end.minute)) return false;
  const local = zonedParts(new Date(now), timeZone);
  const minutes = local.hour * 60 + local.minute;
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
}

class Scheduler {
  constructor({
    baseDir = null,
    filePath = null,
    now = Date.now,
    logger = console,
    startTask = null,
    getTask = null,
    onRunEvent = null,
    tickMs = DEFAULT_TICK_MS,
    autoStart = false,
    runTimeoutMs = MAX_TIMEOUT_MS,
  } = {}) {
    if (!baseDir && !filePath) throw new Error('Scheduler requires baseDir or filePath');
    if (!Number.isInteger(tickMs) || tickMs < 100) throw new Error('tickMs must be an integer of at least 100');
    this.baseDir = baseDir ? path.resolve(baseDir) : path.dirname(path.resolve(filePath));
    this.filePath = filePath ? path.resolve(filePath) : path.join(this.baseDir, 'scheduler.json');
    this.now = now;
    this.logger = logger;
    this.startTask = startTask;
    this.getTask = getTask;
    this.onRunEvent = onRunEvent;
    this.tickMs = tickMs;
    this.runTimeoutMs = runTimeoutMs;
    this.autoStart = autoStart;
    this.jobs = [];
    this.runs = [];
    this.settings = clone(DEFAULT_SETTINGS);
    this.timer = null;
    this._savePromise = Promise.resolve();
    this._tickPromise = null;
    this._trackers = new Set();
    this._initialized = false;
    this._legacyTriggerCallback = null;
  }

  async init(baseDirOrOptions = null, triggerCallbackOrOptions = null) {
    if (this._initialized) return this.stats();
    if (typeof baseDirOrOptions === 'string') {
      this.baseDir = path.resolve(baseDirOrOptions);
      this.filePath = path.join(this.baseDir, 'scheduler.json');
    } else if (isPlainObject(baseDirOrOptions)) {
      const options = baseDirOrOptions;
      if (options.baseDir) {
        this.baseDir = path.resolve(options.baseDir);
        this.filePath = options.filePath
          ? path.resolve(options.filePath)
          : path.join(this.baseDir, 'scheduler.json');
      } else if (options.filePath) {
        this.filePath = path.resolve(options.filePath);
        this.baseDir = path.dirname(this.filePath);
      }
      if (typeof options.startTask === 'function') this.startTask = options.startTask;
      if (typeof options.getTask === 'function') this.getTask = options.getTask;
      if (typeof options.onRunEvent === 'function') this.onRunEvent = options.onRunEvent;
      if (typeof options.onJobTriggered === 'function') this._legacyTriggerCallback = options.onJobTriggered;
      if (Number.isInteger(options.tickMs)) this.tickMs = options.tickMs;
      if (typeof options.autoStart === 'boolean') this.autoStart = options.autoStart;
    }

    if (typeof triggerCallbackOrOptions === 'function') {
      this._legacyTriggerCallback = triggerCallbackOrOptions;
    } else if (isPlainObject(triggerCallbackOrOptions)) {
      if (typeof triggerCallbackOrOptions.startTask === 'function') this.startTask = triggerCallbackOrOptions.startTask;
      if (typeof triggerCallbackOrOptions.getTask === 'function') this.getTask = triggerCallbackOrOptions.getTask;
      if (typeof triggerCallbackOrOptions.onRunEvent === 'function') this.onRunEvent = triggerCallbackOrOptions.onRunEvent;
    }

    await fs.promises.mkdir(this.baseDir, { recursive: true });
    await this.loadJobs();
    this._initialized = true;
    if (this.autoStart) this.startLoop();
    return this.stats();
  }

  async loadJobs() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Failed to read scheduler: ${error.message}`);
      this.jobs = [];
      this.runs = [];
      this.settings = clone(DEFAULT_SETTINGS);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`Scheduler file is corrupt: ${error.message}`);
    }

    if (Array.isArray(parsed)) {
      this.jobs = parsed.map(job => this._normalizeJob(job)).filter(Boolean);
      this.runs = [];
      this.settings = clone(DEFAULT_SETTINGS);
      await this.saveJobs();
      return;
    }

    if (!isPlainObject(parsed)) throw new Error('Scheduler file must contain an object or array');
    this.jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs.map(job => this._normalizeJob(job)).filter(Boolean)
      : [];
    this.runs = Array.isArray(parsed.runs) ? parsed.runs.map(run => this._normalizeRun(run)).filter(Boolean) : [];
    this.settings = {
      ...clone(DEFAULT_SETTINGS),
      ...(isPlainObject(parsed.settings) ? clone(parsed.settings) : {}),
      quietHours: {
        ...DEFAULT_SETTINGS.quietHours,
        ...(isPlainObject(parsed.settings?.quietHours) ? parsed.settings.quietHours : {}),
      },
      retry: {
        ...DEFAULT_SETTINGS.retry,
        ...(isPlainObject(parsed.settings?.retry) ? parsed.settings.retry : {}),
      },
    };

    // A run cannot survive a process restart in a live state. Mark it
    // interrupted and keep the audit record; the durable TaskStore recovers the
    // underlying task itself.
    let changed = false;
    for (const run of this.runs) {
      if (run.status === 'starting' || run.status === 'running' || run.status === 'waiting_approval') {
        run.status = 'interrupted';
        run.finishedAt = this.now();
        run.error = 'Scheduler restarted while this run was active';
        changed = true;
      }
    }
    if (changed) await this.saveJobs();
  }

  _normalizeJob(job) {
    if (!isPlainObject(job)) return null;
    const type = job.type;
    if (!['one-off', 'recurring', 'event'].includes(type)) return null;
    const payload = isPlainObject(job.payload) ? job.payload : {};
    const text = typeof payload.goal === 'string'
      ? payload.goal
      : (typeof payload.text === 'string' ? payload.text : '');
    if (type !== 'event' && !text.trim()) return null;

    const trigger = isPlainObject(job.trigger) ? job.trigger : { type: 'schedule' };
    if (trigger.type === 'event' && typeof trigger.event !== 'string') return null;

    const result = {
      id: typeof job.id === 'string' && job.id ? job.id : makeId('job'),
      name: typeof job.name === 'string' && job.name.trim() ? job.name.trim().slice(0, 200) : 'Scheduled task',
      type,
      payload: {
        ...payload,
        ...(text ? { goal: text } : {}),
      },
      active: job.active !== false,
      trigger: {
        type: trigger.type === 'event' ? 'event' : 'schedule',
        ...(trigger.type === 'event' ? { event: String(trigger.event).slice(0, 120) } : {}),
      },
      createdAt: Number.isFinite(job.createdAt) ? job.createdAt : this.now(),
      updatedAt: Number.isFinite(job.updatedAt) ? job.updatedAt : this.now(),
      timeZone: typeof job.timeZone === 'string' && validTimeZone(job.timeZone) ? job.timeZone : undefined,
      retry: this._normalizeRetry(job.retry),
      quietHours: isPlainObject(job.quietHours) ? job.quietHours : undefined,
      runCount: Number.isInteger(job.runCount) ? job.runCount : 0,
      consecutiveFailures: Number.isInteger(job.consecutiveFailures) ? job.consecutiveFailures : 0,
      nextAttempt: Number.isInteger(job.nextAttempt) && job.nextAttempt > 0 ? job.nextAttempt : 1,
      lastRunAt: Number.isFinite(job.lastRunAt) ? job.lastRunAt : null,
      lastRunId: typeof job.lastRunId === 'string' ? job.lastRunId : null,
      lastRunStatus: typeof job.lastRunStatus === 'string' ? job.lastRunStatus : null,
      lastRunResult: typeof job.lastRunResult === 'string' ? job.lastRunResult.slice(0, MAX_RESULT_CHARS) : null,
      retryAt: Number.isFinite(job.retryAt) ? job.retryAt : null,
      lastDeferredAt: Number.isFinite(job.lastDeferredAt) ? job.lastDeferredAt : null,
      lastDeferredReason: typeof job.lastDeferredReason === 'string' ? job.lastDeferredReason : null,
    };

    if (type === 'event') {
      result.nextRun = null;
      return result;
    }

    if (type === 'one-off') {
      const triggerTime = typeof job.triggerTime === 'string'
        ? Date.parse(job.triggerTime)
        : Number(job.triggerTime);
      if (!Number.isFinite(triggerTime)) return null;
      result.triggerTime = triggerTime;
      result.nextRun = triggerTime;
      return result;
    }

    if (isPlainObject(job.schedule)) {
      try {
        result.schedule = validateSchedule(job.schedule);
      } catch {
        return null;
      }
      if (!Number.isFinite(job.nextRun)) {
        result.nextRun = computeNextSchedule(result.schedule, this.now());
      } else {
        result.nextRun = job.nextRun;
      }
      return result;
    }

    const intervalMs = Number(job.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      return null;
    }
    result.intervalMs = intervalMs;
    result.nextRun = Number.isFinite(job.nextRun) ? job.nextRun : this.now() + intervalMs;
    return result;
  }

  _normalizeRun(run) {
    if (!isPlainObject(run)) return null;
    if (typeof run.id !== 'string' || !run.id) return null;
    return {
      id: run.id,
      jobId: typeof run.jobId === 'string' ? run.jobId : '',
      jobName: typeof run.jobName === 'string' ? run.jobName : '',
      taskId: typeof run.taskId === 'string' ? run.taskId : null,
      status: typeof run.status === 'string' ? run.status : 'unknown',
      attempt: Number.isInteger(run.attempt) ? run.attempt : 1,
      scheduledFor: Number.isFinite(run.scheduledFor) ? run.scheduledFor : null,
      startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
      finishedAt: Number.isFinite(run.finishedAt) ? run.finishedAt : null,
      retryAt: Number.isFinite(run.retryAt) ? run.retryAt : null,
      result: typeof run.result === 'string' ? run.result.slice(0, MAX_RESULT_CHARS) : null,
      error: typeof run.error === 'string' ? run.error.slice(0, 2000) : null,
    };
  }

  _normalizeRetry(retry) {
    if (!isPlainObject(retry)) return null;
    const maxAttempts = Number.isInteger(retry.maxAttempts) ? retry.maxAttempts : 2;
    const backoffMs = Number(retry.backoffMs);
    if (maxAttempts < 1 || maxAttempts > 10) throw new Error('retry.maxAttempts must be between 1 and 10');
    if (!Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > 24 * 60 * 60 * 1000) {
      throw new Error('retry.backoffMs must be between 0 and one day');
    }
    return { maxAttempts, backoffMs };
  }

  _serialize() {
    return JSON.stringify({
      schemaVersion: SCHEDULER_SCHEMA_VERSION,
      updatedAt: this.now(),
      settings: this.settings,
      jobs: this.jobs,
      runs: this.runs.slice(-MAX_RUNS_STORED),
    }, null, 2);
  }

  async saveJobs() {
    if (!this.filePath) return;
    const payload = this._serialize();
    this._savePromise = this._savePromise
      .catch(() => {})
      .then(async () => {
        const temp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        let handle = null;
        try {
          handle = await fs.promises.open(temp, 'w');
          await handle.writeFile(payload, 'utf8');
          await handle.sync();
          await handle.close();
          handle = null;
          let lastError = null;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              await fs.promises.rename(temp, this.filePath);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 4) throw error;
              await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
            }
          }
          if (lastError) throw lastError;
        } finally {
          if (handle) {
            try { await handle.close(); } catch { /* best effort */ }
          }
          try { await fs.promises.unlink(temp); } catch { /* renamed or never created */ }
        }
      })
      .catch(error => {
        (this.logger.error || this.logger.log || (() => {}))(`[Scheduler] Failed to save jobs: ${error.message}`);
      });
    return this._savePromise;
  }

  startLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.tick().catch(error => {
        (this.logger.error || this.logger.log || (() => {}))(`[Scheduler] Tick failed: ${error.message}`);
      });
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (this._tickPromise) return this._tickPromise;
    const promise = this._tick().finally(() => {
      this._tickPromise = null;
    });
    this._tickPromise = promise;
    return promise;
  }

  _activeRunFor(jobId) {
    return this.runs.find(run => (
      run.jobId === jobId
      && ['starting', 'running', 'waiting_approval', 'started'].includes(run.status)
    )) || null;
  }

  _runCountSince(jobId, since) {
    return this.runs.filter(run => run.jobId === jobId && run.startedAt && run.startedAt > since).length;
  }

  _defer(job, now, reason) {
    job.lastDeferredAt = now;
    job.lastDeferredReason = reason;
    job.updatedAt = now;
    if (job.type === 'recurring') {
      job.nextRun = now + 60_000;
    } else if (job.type === 'one-off') {
      job.retryAt = now + 60_000;
      job.active = true;
    }
    this._emit({ type: 'run.deferred', job: clone(job), reason, at: now });
  }

  _limitReason(job, now) {
    const settings = this.settings || DEFAULT_SETTINGS;
    const jobMaxHour = Number(job.maxRunsPerHour || 0);
    const jobMaxDay = Number(job.maxRunsPerDay || 0);
    const globalMaxHour = Number(settings.maxRunsPerHour || 0);
    const globalMaxDay = Number(settings.maxRunsPerDay || 0);

    if (jobMaxHour > 0 && this._runCountSince(job.id, now - 60 * 60 * 1000) >= jobMaxHour) {
      return 'max-runs-per-hour';
    }
    if (jobMaxDay > 0 && this._runCountSince(job.id, now - 24 * 60 * 60 * 1000) >= jobMaxDay) {
      return 'max-runs-per-day';
    }
    if (jobMaxHour > 0 || jobMaxDay > 0) return null;

    const globalRunsHour = this.runs.filter(run => run.startedAt && run.startedAt > now - 60 * 60 * 1000).length;
    if (globalMaxHour > 0 && globalRunsHour >= globalMaxHour) return 'max-runs-per-hour';
    const globalRunsDay = this.runs.filter(run => run.startedAt && run.startedAt > now - 24 * 60 * 60 * 1000).length;
    if (globalMaxDay > 0 && globalRunsDay >= globalMaxDay) return 'max-runs-per-day';
    return null;
  }

  _due(job, now) {
    if (!job.active) return false;
    if (job.trigger?.type === 'event' || job.type === 'event') return false;
    if (Number.isFinite(job.retryAt) && now >= job.retryAt) return true;
    if (job.type === 'one-off') return Number.isFinite(job.nextRun) && now >= job.nextRun;
    return Number.isFinite(job.nextRun) && now >= job.nextRun;
  }

  _nextRunAfter(job, from) {
    if (job.schedule) return computeNextSchedule(job.schedule, from);
    if (Number.isFinite(job.intervalMs)) return from + job.intervalMs;
    return null;
  }

  async _tick() {
    const now = this.now();
    let changed = false;

    for (const job of this.jobs) {
      if (!this._due(job, now)) continue;
      const active = this._activeRunFor(job.id);
      if (active) {
        job.lastDeferredAt = now;
        job.lastDeferredReason = `run-active:${active.id}`;
        changed = true;
        continue;
      }

      const quiet = inQuietHours(now, job.quietHours || this.settings.quietHours);
      if (quiet) {
        this._defer(job, now, 'quiet-hours');
        changed = true;
        continue;
      }

      const limit = this._limitReason(job, now);
      if (limit) {
        this._defer(job, now, limit);
        changed = true;
        continue;
      }

      const started = await this._startRun(job, now);
      changed = changed || started;
    }

    if (changed) await this.saveJobs();
  }

  _newRun(job, now) {
    const attempt = Number.isInteger(job.nextAttempt) && job.nextAttempt > 0 ? job.nextAttempt : 1;
    return {
      id: makeId('run'),
      jobId: job.id,
      jobName: job.name,
      taskId: null,
      status: 'starting',
      attempt,
      scheduledFor: Number.isFinite(job.retryAt) ? job.retryAt : (job.nextRun || now),
      startedAt: now,
      finishedAt: null,
      retryAt: null,
      result: null,
      error: null,
    };
  }

  async _startRun(job, now) {
    const run = this._newRun(job, now);
    this.runs.push(run);
    this.runs = this.runs.slice(-MAX_RUNS_STORED);

    if (job.type === 'one-off') {
      job.active = false;
      job.nextRun = null;
    } else if (job.type === 'recurring') {
      job.nextRun = this._nextRunAfter(job, now);
    }
    job.retryAt = null;
    job.lastRunAt = now;
    job.lastRunId = run.id;
    job.lastRunStatus = 'starting';
    job.runCount += 1;
    job.updatedAt = now;

    if (typeof this._legacyTriggerCallback === 'function') {
      try { this._legacyTriggerCallback(clone(job)); } catch (error) {
        (this.logger.error || this.logger.log || (() => {}))(`[Scheduler] Trigger callback failed: ${error.message}`);
      }
    }

    if (typeof this.startTask !== 'function') {
      run.status = 'failed';
      run.error = 'Scheduler has no task starter';
      run.finishedAt = this.now();
      this._applyFailure(job, run, run.error);
      this._emit({ type: 'run.failed', job: clone(job), run: clone(run), error: run.error, at: now });
      return true;
    }

    let result;
    try {
      result = await this.startTask(clone(job), clone(run));
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (!result || result.ok !== true) {
      const error = (result && result.error) || 'Scheduled task did not start';
      run.status = 'failed';
      run.error = String(error).slice(0, 2000);
      run.finishedAt = this.now();
      this._applyFailure(job, run, run.error);
      this._emit({ type: 'run.failed', job: clone(job), run: clone(run), error: run.error, at: now });
      return true;
    }

    const task = result.task || null;
    run.taskId = task && task.id ? task.id : null;
    run.status = 'running';
    job.lastRunStatus = 'running';
    this._emit({ type: 'run.started', job: clone(job), run: clone(run), task: task ? clone(task) : null, at: now });

    if (task && ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
      await this._finishRun(job, run, task);
    } else if (run.taskId && typeof this.getTask === 'function') {
      this._trackRun(job, run);
    } else {
      // A test/dry-run starter may intentionally omit a task tracker. Keep the
      // audit record as "started"; an operator can see it was handed off.
      run.status = 'started';
      job.lastRunStatus = 'started';
    }
    return true;
  }

  _applyFailure(job, run, error) {
    const retry = job.retry || this.settings.retry || DEFAULT_SETTINGS.retry;
    const maxAttempts = Number.isInteger(retry.maxAttempts) ? retry.maxAttempts : 2;
    const backoffMs = Number.isFinite(retry.backoffMs) ? retry.backoffMs : 60_000;
    job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
    job.lastRunStatus = run.status;
    job.lastRunResult = null;
    job.updatedAt = this.now();

    if (run.attempt < maxAttempts) {
      const retryAt = this.now() + backoffMs;
      job.retryAt = retryAt;
      job.nextAttempt = run.attempt + 1;
      job.active = true;
      run.retryAt = retryAt;
      this._emit({
        type: 'run.retry',
        job: clone(job),
        run: clone(run),
        retryAt,
        error,
        at: this.now(),
      });
    } else {
      job.nextAttempt = 1;
      job.retryAt = null;
      if (job.type === 'one-off') job.active = false;
    }
  }

  _emit(event) {
    if (typeof this.onRunEvent !== 'function') return;
    try { this.onRunEvent(event); } catch (error) {
      (this.logger.error || this.logger.log || (() => {}))(`[Scheduler] Run event listener failed: ${error.message}`);
    }
  }

  _trackRun(job, run) {
    const startedAt = this.now();
    const promise = (async () => {
      while (true) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 500);
          if (typeof timer.unref === 'function') timer.unref();
        });
        if (!this._activeRunFor(job.id) || this._activeRunFor(job.id).id !== run.id) return;
        if (this.now() - startedAt > this.runTimeoutMs) {
          run.status = 'failed';
          run.error = 'Scheduled task did not reach a terminal state before the timeout';
          run.finishedAt = this.now();
          this._applyFailure(job, run, run.error);
          await this.saveJobs();
          this._emit({ type: 'run.failed', job: clone(job), run: clone(run), error: run.error, at: this.now() });
          return;
        }
        let task = null;
        try {
          task = await this.getTask(run.taskId);
        } catch (error) {
          task = { status: 'failed', error: error.message };
        }
        if (!task) continue;
        if (task.status === 'waiting_approval') {
          run.status = 'waiting_approval';
          job.lastRunStatus = 'waiting_approval';
          await this.saveJobs();
          continue;
        }
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
          await this._finishRun(job, run, task);
          return;
        }
      }
    })().catch(error => {
      (this.logger.error || this.logger.log || (() => {}))(`[Scheduler] Run tracking failed: ${error.message}`);
    }).finally(() => {
      this._trackers.delete(promise);
    });
    this._trackers.add(promise);
  }

  async _finishRun(job, run, task) {
    run.status = task.status === 'completed' ? 'completed' : task.status;
    run.finishedAt = this.now();
    run.result = typeof task.result === 'string' ? task.result.slice(0, MAX_RESULT_CHARS) : null;
    run.error = typeof task.error === 'string' ? task.error.slice(0, 2000) : null;
    if (run.status === 'waiting_approval') {
      job.lastRunStatus = 'waiting_approval';
    } else if (run.status === 'completed') {
      job.consecutiveFailures = 0;
      job.nextAttempt = 1;
      job.lastRunStatus = 'completed';
      job.lastRunResult = run.result;
    } else {
      this._applyFailure(job, run, run.error || `Task ${run.status}`);
    }
    job.updatedAt = this.now();
    await this.saveJobs();
    this._emit({
      type: run.status === 'completed' ? 'run.completed' : 'run.failed',
      job: clone(job),
      run: clone(run),
      task: clone(task),
      error: run.error,
      at: this.now(),
    });
  }

  async addJob(jobData = {}) {
    if (!isPlainObject(jobData)) throw new Error('Scheduler job must be an object');
    const now = this.now();
    const payload = isPlainObject(jobData.payload) ? clone(jobData.payload) : {};
    if (typeof jobData.payload === 'string') payload.goal = jobData.payload;
    const goal = typeof payload.goal === 'string'
      ? payload.goal
      : (typeof payload.text === 'string' ? payload.text : '');
    const type = jobData.type;
    if (!['one-off', 'recurring', 'event'].includes(type)) throw new Error(`Unknown job type: ${type}`);
    if (type !== 'event' && !goal.trim()) throw new Error('Scheduled job requires payload.text or payload.goal');

    const job = {
      id: `job_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`,
      name: typeof jobData.name === 'string' && jobData.name.trim()
        ? jobData.name.trim().slice(0, 200)
        : 'Scheduled task',
      type,
      payload: {
        ...payload,
        ...(goal ? { goal: goal.trim() } : {}),
      },
      active: jobData.active !== false,
      trigger: {
        type: jobData.trigger?.type === 'event' || type === 'event' ? 'event' : 'schedule',
        ...(jobData.trigger?.event || jobData.event
          ? { event: String(jobData.trigger?.event || jobData.event).slice(0, 120) }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
      retry: jobData.retry ? this._normalizeRetry(jobData.retry) : null,
      quietHours: isPlainObject(jobData.quietHours) ? clone(jobData.quietHours) : undefined,
      maxRunsPerHour: Number.isInteger(jobData.maxRunsPerHour) ? jobData.maxRunsPerHour : undefined,
      maxRunsPerDay: Number.isInteger(jobData.maxRunsPerDay) ? jobData.maxRunsPerDay : undefined,
      runCount: 0,
      consecutiveFailures: 0,
      nextAttempt: 1,
      lastRunAt: null,
      lastRunId: null,
      lastRunStatus: null,
      lastRunResult: null,
      retryAt: null,
      lastDeferredAt: null,
      lastDeferredReason: null,
    };

    if (type === 'event') {
      if (!job.trigger.event) throw new Error('Event job requires an event name');
      job.nextRun = null;
    } else if (type === 'one-off') {
      const triggerTime = typeof jobData.triggerTime === 'string'
        ? Date.parse(jobData.triggerTime)
        : Number(jobData.triggerTime);
      if (!Number.isFinite(triggerTime)) throw new Error('one-off jobs require a finite triggerTime');
      job.triggerTime = triggerTime;
      job.nextRun = triggerTime;
    } else if (isPlainObject(jobData.schedule)) {
      job.schedule = validateSchedule(jobData.schedule);
      job.timeZone = job.schedule.timeZone;
      job.nextRun = Number.isFinite(jobData.nextRun)
        ? jobData.nextRun
        : computeNextSchedule(job.schedule, now);
    } else {
      const intervalMs = Number(jobData.intervalMs);
      if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
        throw new Error(`intervalMs must be a finite number between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms`);
      }
      job.intervalMs = intervalMs;
      job.nextRun = Number.isFinite(jobData.nextRun) ? jobData.nextRun : now + intervalMs;
      if (jobData.timeZone) {
        if (!validTimeZone(jobData.timeZone)) throw new Error(`Invalid time zone: ${jobData.timeZone}`);
        job.timeZone = jobData.timeZone;
      }
    }

    if (jobData.trigger?.type === 'event' && type !== 'event') {
      job.trigger = { type: 'event', event: String(jobData.trigger.event || '').slice(0, 120) };
    }
    this.jobs.push(job);
    await this.saveJobs();
    return clone(job);
  }

  async removeJob(jobId) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter(job => job.id !== jobId);
    if (this.jobs.length === before) return false;
    await this.saveJobs();
    return true;
  }

  listJobs() {
    return this.jobs.map(clone);
  }

  listRuns({ jobId = null, limit = 50 } = {}) {
    const requested = Number.isInteger(limit) ? Math.max(0, Math.min(MAX_RUNS_STORED, limit)) : 50;
    return this.runs
      .filter(run => !jobId || run.jobId === jobId)
      .slice(-requested)
      .reverse()
      .map(clone);
  }

  async updateSettings(patch = {}) {
    if (!isPlainObject(patch)) throw new Error('Scheduler settings must be an object');
    if (isPlainObject(patch.quietHours)) {
      const quiet = patch.quietHours;
      if (quiet.start && !parseClock(quiet.start)) throw new Error('quietHours.start must be HH:MM');
      if (quiet.end && !parseClock(quiet.end)) throw new Error('quietHours.end must be HH:MM');
      if (quiet.timeZone && !validTimeZone(quiet.timeZone)) throw new Error('Invalid quietHours timeZone');
      this.settings.quietHours = { ...this.settings.quietHours, ...quiet };
    }
    for (const key of ['maxRunsPerHour', 'maxRunsPerDay']) {
      if (patch[key] === undefined) continue;
      if (!Number.isInteger(patch[key]) || patch[key] < 0) throw new Error(`${key} must be a non-negative integer`);
      this.settings[key] = patch[key];
    }
    if (patch.retry) {
      this.settings.retry = { ...this.settings.retry, ...this._normalizeRetry(patch.retry) };
    }
    await this.saveJobs();
    return clone(this.settings);
  }

  getSettings() {
    return clone(this.settings);
  }

  async emitEvent(eventName, payload = {}) {
    if (!eventName || typeof eventName !== 'string') throw new Error('eventName is required');
    const now = this.now();
    const matching = this.jobs.filter(job => (
      job.active
      && job.trigger?.type === 'event'
      && job.trigger.event === eventName
    ));

    for (const job of matching) {
      if (this._activeRunFor(job.id)) continue;
      job.payload = {
        ...job.payload,
        ...(isPlainObject(payload) ? { event: clone(payload) } : {}),
      };
      await this._startRun(job, now);
    }
    if (matching.length > 0) await this.saveJobs();
    return matching.length;
  }

  stats() {
    return {
      ok: true,
      schemaVersion: SCHEDULER_SCHEMA_VERSION,
      filePath: this.filePath,
      jobs: this.jobs.length,
      activeJobs: this.jobs.filter(job => job.active).length,
      runs: this.runs.length,
      settings: clone(this.settings),
    };
  }
}

// Backwards-compatible singleton for older main-process imports. New code
// should create a Scheduler explicitly so it can inject the task runtime.
const scheduler = new Scheduler({ baseDir: process.cwd(), filePath: path.join(process.cwd(), 'scheduler.json') });

module.exports = {
  Scheduler,
  scheduler,
  SCHEDULER_SCHEMA_VERSION,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_SETTINGS,
  validateSchedule,
  computeNextSchedule,
  inQuietHours,
  zonedParts,
  validTimeZone,
  parseClock,
  WEEKDAYS,
};
