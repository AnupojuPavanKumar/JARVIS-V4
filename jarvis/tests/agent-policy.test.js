'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateArgs, AgentTaskStore, authorize } = require('../agent-policy');

const readSkill = { id: 'get_datetime', risk: 'read', params: {} };
const writeSkill = {
  id: 'write_file',
  risk: 'write',
  params: {
    path: { type: 'string', required: true },
  },
};
const untrustedReadSkill = { id: 'web_read', risk: 'read', untrusted: true, params: {} };
const enumSkill = {
  id: 'enum_skill',
  risk: 'read',
  params: {
    mode: { type: 'string', required: true, enum: ['fast', 'safe'] },
  },
};

const allow = async () => true;
const deny = async () => false;

test('validateArgs accepts valid args', () => {
  assert.equal(validateArgs(readSkill, {}), null);
  assert.equal(validateArgs(writeSkill, { path: 'notes.txt' }), null);
  assert.equal(validateArgs(enumSkill, { mode: 'fast' }), null);
});

test('validateArgs rejects unknown, missing, wrong-type, and out-of-enum args', () => {
  assert.match(validateArgs(readSkill, { extra: 1 }), /Unknown param/);
  assert.match(validateArgs(writeSkill, {}), /Missing required param/);
  assert.match(validateArgs(writeSkill, { path: 42 }), /must be type string/);
  assert.match(validateArgs(enumSkill, { mode: 'turbo' }), /must be one of/);
});

test('AgentTaskStore mints, aborts, and evicts task records', async () => {
  const store = new AgentTaskStore({ ttlMs: 1 });
  const id = store.mintTaskId();

  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(store.has(id), true);
  assert.equal(store.get(id).stepCount, 0);

  assert.deepEqual(store.abort(id), { ok: true });
  assert.equal(store.get(id).aborted, true);

  await new Promise(resolve => setTimeout(resolve, 10));
  const nextId = store.mintTaskId();
  assert.equal(store.has(id), false);
  assert.equal(store.has(nextId), true);
  assert.equal(store.size, 1);
});

test('AgentTaskStore rate-limits untracked read calls', () => {
  const store = new AgentTaskStore({ untrackedCallLimit: 2 });
  assert.equal(store.allowUntrackedCall(), true);
  assert.equal(store.allowUntrackedCall(), true);
  assert.equal(store.allowUntrackedCall(), false);
});

test('authorize denies write/destructive skills without a task token', async () => {
  const store = new AgentTaskStore();
  const result = await authorize({
    skill: writeSkill,
    args: { path: 'notes.txt' },
    taskId: undefined,
    store,
    confirmFn: allow,
  });

  assert.equal(result.ok, false);
  assert.equal(result.deny, 'unknown-taskId');
});

test('authorize allows untracked reads but enforces the rate limit', async () => {
  const store = new AgentTaskStore({ untrackedCallLimit: 1 });
  const first = await authorize({
    skill: readSkill,
    args: {},
    taskId: undefined,
    store,
    confirmFn: allow,
  });
  const second = await authorize({
    skill: readSkill,
    args: {},
    taskId: undefined,
    store,
    confirmFn: allow,
  });

  assert.equal(first.ok, true);
  assert.equal(first.taskRec.throwaway, true);
  assert.equal(second.ok, false);
  assert.equal(second.deny, 'untracked-rate-limit');
});

test('authorize increments the step count and enforces the step cap', async () => {
  const store = new AgentTaskStore({ stepCap: 1 });
  const taskId = store.mintTaskId();

  const first = await authorize({
    skill: readSkill,
    args: {},
    taskId,
    store,
    confirmFn: allow,
  });
  const second = await authorize({
    skill: readSkill,
    args: {},
    taskId,
    store,
    confirmFn: allow,
  });

  assert.equal(first.ok, true);
  assert.equal(store.get(taskId).stepCount, 1);
  assert.equal(second.ok, false);
  assert.equal(second.deny, 'step-cap');
});

test('authorize confirms writes and counts denied attempts as steps', async () => {
  const store = new AgentTaskStore();
  const taskId = store.mintTaskId();
  let confirmCalls = 0;

  const allowed = await authorize({
    skill: writeSkill,
    args: { path: 'notes.txt' },
    taskId,
    store,
    confirmFn: async (skill, args, risk, tainted) => {
      confirmCalls += 1;
      assert.equal(skill, writeSkill);
      assert.deepEqual(args, { path: 'notes.txt' });
      assert.equal(risk, 'write');
      assert.equal(tainted, false);
      return true;
    },
  });

  assert.equal(allowed.ok, true);
  assert.equal(confirmCalls, 1);
  assert.equal(store.get(taskId).stepCount, 1);

  const denied = await authorize({
    skill: writeSkill,
    args: { path: 'notes.txt' },
    taskId,
    store,
    confirmFn: deny,
  });

  assert.equal(denied.ok, false);
  assert.equal(denied.deny, 'confirm-denied(risk=write)');
  assert.equal(store.get(taskId).stepCount, 2);
});

test('authorize marks tasks tainted after untrusted reads and confirms later steps', async () => {
  const store = new AgentTaskStore();
  const taskId = store.mintTaskId();

  const untrusted = await authorize({
    skill: untrustedReadSkill,
    args: {},
    taskId,
    store,
    confirmFn: allow,
  });

  assert.equal(untrusted.ok, true);
  assert.equal(store.get(taskId).tainted, true);

  let confirmCalls = 0;
  const followUp = await authorize({
    skill: readSkill,
    args: {},
    taskId,
    store,
    confirmFn: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  assert.equal(followUp.ok, true);
  assert.equal(confirmCalls, 1);
});

test('authorize refuses aborted tasks', async () => {
  const store = new AgentTaskStore();
  const taskId = store.mintTaskId();
  store.abort(taskId);

  const result = await authorize({
    skill: readSkill,
    args: {},
    taskId,
    store,
    confirmFn: allow,
  });

  assert.equal(result.ok, false);
  assert.equal(result.deny, 'aborted');
});
