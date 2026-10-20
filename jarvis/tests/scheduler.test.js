'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scheduler = require('../scheduler');

test('scheduler validates, triggers, persists, and removes jobs', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scheduler-test-'));
  const triggered = [];

  scheduler.init(tempRoot, job => triggered.push(job));

  try {
    scheduler.jobs = [];

    assert.throws(
      () => scheduler.addJob({ name: 'too fast', type: 'recurring', intervalMs: 1 }),
      /intervalMs must be a finite number/
    );
    assert.throws(
      () => scheduler.addJob({ name: 'unknown', type: 'unknown' }),
      /Unknown job type/
    );

    const oneOff = scheduler.addJob({
      name: 'one-off',
      type: 'one-off',
      triggerTime: Date.now() - 1,
    });
    const recurring = scheduler.addJob({
      name: 'recurring',
      type: 'recurring',
      intervalMs: 10000,
    });

    assert.equal(scheduler.listJobs().length, 2);
    assert.equal(oneOff.active, true);
    assert.equal(recurring.nextRun > Date.now(), true);

    scheduler.tick();

    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].id, oneOff.id);
    assert.equal(scheduler.listJobs().length, 1);
    assert.equal(scheduler.removeJob(recurring.id), true);
    assert.equal(scheduler.listJobs().length, 0);
    await scheduler.saveJobs();

    fs.writeFileSync(
      scheduler.schedulerFile,
      JSON.stringify([
        { id: 'bad', type: 'recurring', intervalMs: 1, active: true },
        { id: 'good', type: 'recurring', intervalMs: 10000, active: true },
        { id: 'one', type: 'one-off', triggerTime: Date.now() + 10000, active: true },
      ])
    );
    scheduler.loadJobs();
    assert.deepEqual(scheduler.listJobs().map(job => job.id), ['good', 'one']);

    // A hand-edited file may have a UTF-8 BOM or contain a single job object
    // instead of an array. Both should load without discarding the job.
    fs.writeFileSync(
      scheduler.schedulerFile,
      `\uFEFF${JSON.stringify({ id: 'bom-one', type: 'one-off', triggerTime: Date.now() + 10000, active: true })}`
    );
    scheduler.loadJobs();
    assert.deepEqual(scheduler.listJobs().map(job => job.id), ['bom-one']);
  } finally {
    clearInterval(scheduler.timer);
    scheduler.timer = null;
    scheduler.jobs = [];
    scheduler.onJobTriggered = null;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
