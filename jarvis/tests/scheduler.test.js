'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  Scheduler,
  computeNextSchedule,
  zonedParts,
  inQuietHours,
} = require('../core/scheduler/scheduler');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scheduler-v2-'));
}

test('validates, starts one-off and recurring jobs, records runs, and persists', async () => {
  const dir = tempDir();
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const triggered = [];
  const events = [];
  try {
    const scheduler = new Scheduler({
      baseDir: dir,
      now: () => clock,
      startTask: async job => {
        triggered.push(job);
        return {
          ok: true,
          task: { id: `task_${String(triggered.length).padStart(32, '0')}`, status: 'completed', result: `done ${job.name}` },
        };
      },
      onRunEvent: event => events.push(event),
    });
    await scheduler.init();

    await assert.rejects(
      () => scheduler.addJob({ name: 'too fast', type: 'recurring', payload: { text: 'too fast' }, intervalMs: 1 }),
      /intervalMs must be a finite/
    );
    await assert.rejects(
      () => scheduler.addJob({ name: 'unknown', type: 'unknown', payload: { text: 'unknown' } }),
      /Unknown job type/
    );
    await assert.rejects(
      () => scheduler.addJob({ name: 'missing goal', type: 'one-off', triggerTime: clock + 1000 }),
      /requires payload/
    );

    const oneOff = await scheduler.addJob({
      name: 'one-off',
      type: 'one-off',
      payload: { text: 'Inspect the build' },
      triggerTime: clock - 1,
    });
    const recurring = await scheduler.addJob({
      name: 'recurring',
      type: 'recurring',
      payload: { goal: 'Check disk space' },
      intervalMs: 10_000,
      nextRun: clock - 1,
    });

    assert.equal((await scheduler.listJobs()).length, 2);
    assert.equal(oneOff.active, true);

    await scheduler.tick();
    assert.equal(triggered.length, 2);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 2);

    const jobs = scheduler.listJobs();
    const one = jobs.find(job => job.id === oneOff.id);
    const recurringAfter = jobs.find(job => job.id === recurring.id);
    assert.equal(one.active, false);
    assert.equal(one.lastRunStatus, 'completed');
    assert.ok(recurringAfter.nextRun > clock);

    const runs = scheduler.listRuns();
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.status === 'completed'));
    assert.ok(runs.every(run => run.result && run.result.startsWith('done')));

    await scheduler.saveJobs();
    const loaded = new Scheduler({ baseDir: dir, now: () => clock });
    const loadedStats = await loaded.init();
    assert.equal(loadedStats.jobs, 2);
    assert.equal(loaded.listRuns().length, 2);
    assert.equal((await loaded.removeJob(recurring.id)), true);
    assert.equal((await loaded.listJobs()).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retries failed runs with backoff and then succeeds', async () => {
  const dir = tempDir();
  let clock = Date.parse('2026-01-01T12:00:00Z');
  let attempts = 0;
  try {
    const scheduler = new Scheduler({
      baseDir: dir,
      now: () => clock,
      startTask: async () => {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: 'temporary failure' };
        return { ok: true, task: { id: 'task_retry', status: 'completed', result: 'recovered' } };
      },
    });
    await scheduler.init();
    const job = await scheduler.addJob({
      name: 'retry me',
      type: 'one-off',
      payload: { text: 'Try the operation' },
      triggerTime: clock - 1,
      retry: { maxAttempts: 2, backoffMs: 1000 },
    });

    await scheduler.tick();
    let current = scheduler.listJobs().find(candidate => candidate.id === job.id);
    assert.equal(current.lastRunStatus, 'failed');
    assert.equal(current.active, true);
    assert.equal(current.retryAt, clock + 1000);
    assert.equal(scheduler.listRuns()[0].status, 'failed');

    clock += 1001;
    await scheduler.tick();
    current = scheduler.listJobs().find(candidate => candidate.id === job.id);
    assert.equal(attempts, 2);
    assert.equal(current.lastRunStatus, 'completed');
    assert.equal(current.lastRunResult, 'recovered');
    assert.equal(current.active, false);
    const runs = scheduler.listRuns();
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[1].status, 'failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quiet hours and per-job run limits defer without starting a task', async () => {
  const dir = tempDir();
  let clock = Date.parse('2026-01-01T12:00:00Z');
  let starts = 0;
  try {
    const scheduler = new Scheduler({
      baseDir: dir,
      now: () => clock,
      startTask: async () => {
        starts += 1;
        return { ok: true, task: { id: `task_${starts}`, status: 'completed', result: 'ok' } };
      },
    });
    await scheduler.init();
    await scheduler.updateSettings({
      quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC' },
      maxRunsPerHour: 1,
    });

    const quietJob = await scheduler.addJob({
      name: 'quiet',
      type: 'one-off',
      payload: { text: 'Do quiet work' },
      triggerTime: clock - 1,
    });
    await scheduler.tick();
    assert.equal(starts, 0);
    const deferred = scheduler.listJobs().find(job => job.id === quietJob.id);
    assert.equal(deferred.lastDeferredReason, 'quiet-hours');

    await scheduler.updateSettings({ quietHours: { enabled: false } });
    clock += 61_000;
    await scheduler.tick();
    assert.equal(starts, 1);

    // The next run is inside the hourly window and must be deferred.
    clock += 10 * 60_000;
    const limited = await scheduler.addJob({
      name: 'limited',
      type: 'recurring',
      payload: { text: 'Limited task' },
      intervalMs: 10_000,
      nextRun: clock - 1,
    });
    await scheduler.tick();
    assert.equal(starts, 1);
    const limitedJob = scheduler.listJobs().find(job => job.id === limited.id);
    assert.equal(limitedJob.lastDeferredReason, 'max-runs-per-hour');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('event triggers are headless and remain available for Phase 3/4', async () => {
  const dir = tempDir();
  const started = [];
  try {
    const scheduler = new Scheduler({
      baseDir: dir,
      now: () => Date.parse('2026-01-01T12:00:00Z'),
      startTask: async (job, run) => {
        started.push({ job, run });
        return { ok: true, task: { id: 'task_event', status: 'completed', result: 'event handled' } };
      },
    });
    await scheduler.init();
    const job = await scheduler.addJob({
      name: 'event watcher',
      type: 'event',
      payload: { text: 'Handle the event' },
      trigger: { type: 'event', event: 'file.created' },
    });
    assert.equal(job.nextRun, null);

    await scheduler.tick();
    assert.equal(started.length, 0);

    const matched = await scheduler.emitEvent('file.created', { path: 'notes.md' });
    assert.equal(matched, 1);
    assert.equal(started.length, 1);
    assert.equal(started[0].job.id, job.id);
    assert.deepEqual(started[0].job.payload.event, { path: 'notes.md' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery marks a run interrupted after a process restart', async () => {
  const dir = tempDir();
  try {
    const first = new Scheduler({
      baseDir: dir,
      now: () => Date.parse('2026-01-01T12:00:00Z'),
      startTask: async () => ({ ok: true, task: { id: 'task_running', status: 'running' } }),
      getTask: async () => ({ id: 'task_running', status: 'running' }),
    });
    await first.init();
    await first.addJob({
      name: 'long runner',
      type: 'one-off',
      payload: { text: 'Run for a while' },
      triggerTime: Date.parse('2026-01-01T11:59:59Z'),
    });
    await first.tick();
    assert.equal(first.listRuns()[0].status, 'running');
    first.shutdown();

    const second = new Scheduler({ baseDir: dir });
    await second.init();
    const run = second.listRuns()[0];
    assert.equal(run.status, 'interrupted');
    assert.match(run.error, /restarted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timezone-aware daily and weekly schedules compute real local times', () => {
  const from = Date.parse('2026-01-01T12:00:00Z');
  const daily = computeNextSchedule({
    frequency: 'daily',
    time: '09:30',
    timeZone: 'America/New_York',
  }, from);
  const dailyParts = zonedParts(new Date(daily), 'America/New_York');
  assert.equal(dailyParts.hour, 9);
  assert.equal(dailyParts.minute, 30);
  assert.ok(daily > from);

  const weekly = computeNextSchedule({
    frequency: 'weekly',
    time: '18:15',
    days: [1],
    timeZone: 'Europe/London',
  }, from);
  const weeklyParts = zonedParts(new Date(weekly), 'Europe/London');
  assert.equal(weeklyParts.weekday, 1);
  assert.equal(weeklyParts.hour, 18);
  assert.equal(weeklyParts.minute, 15);

  assert.equal(inQuietHours(Date.parse('2026-01-01T23:30:00Z'), {
    enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC',
  }), true);
  assert.equal(inQuietHours(Date.parse('2026-01-01T12:00:00Z'), {
    enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC',
  }), false);
});
