'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../core/runtime/task-store');
const { TASK_STATUS } = require('../core/runtime/task-state');

async function makeStore(options = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-task-store-test-'));
  const store = new TaskStore({ baseDir, ...options });
  await store.init();
  return { baseDir, store };
}

function removeStore(baseDir) {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

test('creates a durable task and records the creation event', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await store.createTask({
      goal: 'Inspect the workspace',
      source: 'test',
      metadata: { suite: 'baseline' },
    });

    assert.match(task.id, /^task_[a-f0-9]{32}$/);
    assert.equal(task.status, TASK_STATUS.QUEUED);
    assert.equal(task.stepCount, 0);
    assert.equal(task.startedAt, null);
    assert.equal(task.finishedAt, null);
    assert.equal(task.metadata.suite, 'baseline');

    const taskDir = path.join(baseDir, task.id);
    assert.equal(fs.existsSync(path.join(taskDir, 'task.json')), true);
    assert.equal(fs.existsSync(path.join(taskDir, 'events.jsonl')), true);

    const loaded = await store.getTask(task.id);
    assert.deepEqual(loaded, task);

    const events = await store.readEvents(task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'task.created');
    assert.equal(events[0].taskId, task.id);
    assert.equal(events[0].data.goal, 'Inspect the workspace');
  } finally {
    removeStore(baseDir);
  }
});

test('lists tasks by newest update and filters by status', async () => {
  let now = 1_000;
  const { baseDir, store } = await makeStore({ now: () => now });
  try {
    const first = await store.createTask({ goal: 'first' });
    now += 1_000;
    const second = await store.createTask({ goal: 'second' });
    now += 1_000;
    const third = await store.createTask({ goal: 'third' });

    const all = await store.listTasks();
    assert.deepEqual(all.map(task => task.id), [third.id, second.id, first.id]);

    const limited = await store.listTasks({ limit: 2 });
    assert.deepEqual(limited.map(task => task.id), [third.id, second.id]);

    await store.transition(second.id, TASK_STATUS.CANCELLED);
    const cancelled = await store.listTasks({ status: TASK_STATUS.CANCELLED });
    assert.deepEqual(cancelled.map(task => task.id), [second.id]);

    assert.deepEqual(await store.listTasks({ limit: 0 }), []);
  } finally {
    removeStore(baseDir);
  }
});

test('transitions through running and completed with timestamps and events', async () => {
  let now = 5_000;
  const { baseDir, store } = await makeStore({ now: () => now });
  try {
    const task = await store.createTask({ goal: 'complete me' });
    now += 100;
    const running = await store.transition(task.id, TASK_STATUS.RUNNING);
    assert.equal(running.status, TASK_STATUS.RUNNING);
    assert.equal(running.startedAt, 5_100);

    now += 100;
    const completed = await store.transition(task.id, TASK_STATUS.COMPLETED, {
      patch: { result: 'done' },
    });
    assert.equal(completed.status, TASK_STATUS.COMPLETED);
    assert.equal(completed.finishedAt, 5_200);
    assert.equal(completed.result, 'done');

    const events = await store.readEvents(task.id);
    assert.deepEqual(events.map(event => event.type), [
      'task.created',
      'task.transition',
      'task.transition',
    ]);
    assert.deepEqual(events[2].data, {
      from: TASK_STATUS.RUNNING,
      to: TASK_STATUS.COMPLETED,
      reason: null,
    });
  } finally {
    removeStore(baseDir);
  }
});

test('rejects invalid transitions without changing the task', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await store.createTask({ goal: 'invalid transition' });

    await assert.rejects(
      store.transition(task.id, TASK_STATUS.COMPLETED),
      /Invalid task transition/
    );

    const unchanged = await store.getTask(task.id);
    assert.equal(unchanged.status, TASK_STATUS.QUEUED);
  } finally {
    removeStore(baseDir);
  }
});

test('serializes concurrent updates without losing writes', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await store.createTask({ goal: 'concurrent updates' });

    await Promise.all(Array.from({ length: 10 }, () => (
      store.updateTask(task.id, draft => {
        draft.stepCount += 1;
        draft.steps.push({ index: draft.stepCount, kind: 'test' });
      })
    )));

    const updated = await store.getTask(task.id);
    assert.equal(updated.stepCount, 10);
    assert.equal(updated.steps.length, 10);

    const events = await store.readEvents(task.id);
    assert.equal(events.filter(event => event.type === 'task.updated').length, 10);

    const leftovers = fs.readdirSync(path.join(baseDir, task.id))
      .filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    removeStore(baseDir);
  }
});

test('recovers only actively running tasks after a restart', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const interrupted = await store.createTask({ goal: 'will be interrupted' });
    await store.transition(interrupted.id, TASK_STATUS.RUNNING);

    const waiting = await store.createTask({ goal: 'waiting for approval' });
    await store.transition(waiting.id, TASK_STATUS.PLANNING);
    await store.transition(waiting.id, TASK_STATUS.RUNNING);
    await store.transition(waiting.id, TASK_STATUS.WAITING_APPROVAL);

    const queued = await store.createTask({ goal: 'still queued' });

    const restarted = new TaskStore({ baseDir });
    await restarted.init();
    const recovered = await restarted.recoverInterruptedTasks();

    assert.deepEqual(recovered.map(task => task.id), [interrupted.id]);
    assert.equal((await restarted.getTask(interrupted.id)).status, TASK_STATUS.INTERRUPTED);
    assert.equal((await restarted.getTask(waiting.id)).status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal((await restarted.getTask(queued.id)).status, TASK_STATUS.QUEUED);

    const again = await restarted.recoverInterruptedTasks();
    assert.deepEqual(again, []);
  } finally {
    removeStore(baseDir);
  }
});

test('rejects unsafe task ids and invalid task input', async () => {
  const { baseDir, store } = await makeStore();
  try {
    await assert.rejects(store.getTask('../escape'), /Invalid task id/);
    await assert.rejects(store.getTask('task_nothex'), /Invalid task id/);
    await assert.rejects(store.createTask({ id: '../escape', goal: 'x' }), /Invalid task id/);
    await assert.rejects(store.createTask({ goal: '   ' }), /non-empty/);
    await assert.rejects(store.createTask({ goal: 'x'.repeat(20001) }), /exceeds/);
    await assert.rejects(store.createTask({ goal: 'x', maxSteps: 0 }), /maxSteps/);
    await assert.rejects(store.createTask({ goal: 'x', metadata: [] }), /metadata must be an object/);
  } finally {
    removeStore(baseDir);
  }
});

test('supports cancellation and event pagination', async () => {
  const { baseDir, store } = await makeStore();
  try {
    const task = await store.createTask({ goal: 'cancel me' });
    await store.transition(task.id, TASK_STATUS.RUNNING);
    const cancelled = await store.transition(task.id, TASK_STATUS.CANCELLED, {
      reason: 'user-request',
    });

    assert.equal(cancelled.status, TASK_STATUS.CANCELLED);
    assert.equal(cancelled.finishedAt !== null, true);

    await store.appendEvent(task.id, 'test.extra', { value: 1 });
    const latest = await store.readEvents(task.id, { limit: 1 });
    assert.equal(latest.length, 1);
    assert.equal(latest[0].type, 'test.extra');
    assert.equal(latest[0].data.value, 1);
  } finally {
    removeStore(baseDir);
  }
});
