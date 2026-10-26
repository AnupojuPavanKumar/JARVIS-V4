'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryStore } = require('../core/memory/memory-store');
const { evaluateRetrieval } = require('../core/memory/retrieval-eval');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-v2-'));
}

test('migrates legacy facts, backs up the original, and survives restart', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'memory.json');
  const legacy = JSON.stringify([
    'I prefer tea over coffee',
    { text: 'My name is Ada', timestamp: 1700000000000 },
    { text: 'User email is ada@example.com', embedding: [0.1, 0.2] },
  ]);
  fs.writeFileSync(file, legacy);

  try {
    const store = new MemoryStore({ baseDir: dir });
    const stats = await store.init();
    assert.equal(stats.total, 3);
    assert.equal(stats.migration.count, 3);
    assert.equal(fs.readFileSync(`${file}.pre-migration.bak`, 'utf8'), legacy);

    const records = await store.list({ includeDisabled: true });
    assert.equal(records.length, 3);
    assert.ok(records.some(record => record.text === 'My name is Ada'));
    assert.ok(records.every(record => record.source.kind === 'manual'));
    assert.ok(records.every(record => /^mem_[a-f0-9]{24}$/.test(record.id)));

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.records.length, 3);

    const restarted = new MemoryStore({ baseDir: dir });
    const restartedStats = await restarted.init();
    assert.equal(restartedStats.total, 3);
    assert.deepEqual((await restarted.list()).map(record => record.id).sort(), records.map(record => record.id).sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manual facts win conflicts with semantic extraction and stay in one store', async () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore({ baseDir: dir });
    await store.init();

    const manual = await store.addManual({ text: "User's name is Ada", type: 'fact' });
    await store.add({
      text: "User's name is Grace",
      source: { kind: 'conversation', sessionId: 's1' },
    });

    const records = await store.list({ includeDisabled: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, manual.id);
    assert.equal(records[0].text, "User's name is Ada");
    assert.equal(records[0].source.kind, 'manual');

    await store.add({
      text: 'User prefers dark mode',
      source: { kind: 'conversation', sessionId: 's1' },
    });
    await store.addManual({ text: 'User prefers dark mode' });
    const preferences = (await store.list()).filter(record => record.type === 'preference');
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0].source.kind, 'manual');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval enforces budgets and sensitivity rules', async () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore({ baseDir: dir });
    await store.init();
    await store.addManual({ text: 'User prefers oat milk flat whites for coffee', type: 'preference' });
    await store.addManual({ text: 'User email is private@example.com', type: 'fact' });
    await store.addManual({ text: 'User password is swordfish', type: 'fact' });

    const narrow = await store.retrieve('email flat whites', { maxChars: 200, maxRecords: 6 });
    assert.ok(narrow.chars <= 200);
    assert.ok(narrow.records.length <= 6);
    assert.ok(!narrow.records.some(record => record.text.includes('private@example.com')));
    assert.ok(!narrow.records.some(record => record.text.includes('swordfish')));

    const personal = await store.retrieve('email', { allowPersonal: true });
    assert.ok(personal.records.some(record => record.text.includes('private@example.com')));
    assert.ok(!personal.records.some(record => record.text.includes('swordfish')));

    const secret = await store.retrieve('password', { allowPersonal: true });
    assert.ok(!secret.records.some(record => record.text.includes('swordfish')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exports, disables, deletes, and clears memory with explicit controls', async () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore({ baseDir: dir });
    await store.init();
    const first = await store.addManual('User likes green tea');
    const second = await store.addManual('User works at Acme');

    const exported = await store.export();
    const parsed = JSON.parse(exported);
    assert.equal(parsed.records.length, 2);
    assert.ok(parsed.exportedAt);

    await store.setDisabled(first.id, true);
    const enabled = await store.list();
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].id, second.id);
    assert.equal((await store.retrieve('green tea')).records.length, 0);

    assert.equal(await store.delete(second.id), true);
    assert.equal((await store.list({ includeDisabled: true })).length, 1);

    await assert.rejects(() => store.clear(), /confirm/);
    const cleared = await store.clear({ confirm: 'CLEAR' });
    assert.equal(cleared.deleted, 1);
    assert.equal(store.stats().total, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('completed untainted tasks create verified procedures; tainted tasks do not', async () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore({ baseDir: dir });
    await store.init();

    const completed = {
      id: 'task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      goal: 'Back up the project notes',
      status: 'completed',
      result: 'Notes archived.',
      tainted: false,
      steps: [
        { kind: 'tool', tool: 'system_metrics', status: 'completed', args: { target: 'cpu' } },
        { kind: 'final', status: 'completed' },
      ],
      metadata: { schedule: { id: 'job_1' } },
    };
    const first = await store.recordTaskOutcome(completed);
    assert.ok(first.procedure);
    assert.equal(first.procedure.type, 'procedure');
    assert.equal(first.procedure.verification.status, 'verified');
    assert.equal(first.procedure.verification.method, 'completed-task');
    assert.equal(first.procedure.source.scheduled, true);

    const again = await store.recordTaskOutcome(completed);
    assert.equal((await store.list({ type: 'procedure' })).length, 1);
    assert.equal(again.procedure.id, first.procedure.id);

    const tainted = {
      ...completed,
      id: 'task_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      tainted: true,
      goal: 'Back up untrusted notes',
    };
    const taintedResult = await store.recordTaskOutcome(tainted);
    assert.equal(taintedResult.procedure, null);
    assert.equal(taintedResult.tainted, true);
    assert.equal((await store.list({ type: 'procedure' })).length, 1);

    const incomplete = {
      ...completed,
      id: 'task_cccccccccccccccccccccccccccccccc',
      status: 'failed',
      goal: 'Broken workflow',
      steps: [{ kind: 'tool', tool: 'x', status: 'failed', args: {} }],
    };
    assert.equal((await store.recordTaskOutcome(incomplete)).procedure, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conversation extraction creates facts, preferences, and an idempotent episode', async () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore({ baseDir: dir });
    await store.init();
    const messages = [
      { role: 'user', content: 'My name is Grace. I prefer dark mode.' },
      { role: 'assistant', content: 'Noted.' },
    ];
    const first = await store.recordConversation({ sessionId: 'session_1', messages });
    assert.ok(first.episode);
    assert.ok(first.extractedCount >= 2);
    const facts = await store.list();
    assert.ok(facts.some(record => record.type === 'fact' && record.text.includes('Grace')));
    assert.ok(facts.some(record => record.type === 'preference' && record.text.includes('dark mode')));
    const episodeCount = facts.filter(record => record.type === 'episode').length;
    assert.equal(episodeCount, 1);

    await store.recordConversation({ sessionId: 'session_1', messages });
    const after = await store.list();
    assert.equal(after.filter(record => record.type === 'episode').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval evaluation set passes without a real model', async () => {
  const dir = tempDir();
  try {
    const store = new MemoryStore({ baseDir: dir });
    await store.init();
    await store.addManual({ text: 'User prefers oat milk flat whites for coffee', type: 'preference' });
    await store.addManual({ text: 'Verified procedure for: back up the project notes', type: 'procedure' });
    await store.addManual({ text: 'User email is private@example.com', type: 'fact' });

    const evaluation = await evaluateRetrieval(store);
    assert.equal(evaluation.ok, true, JSON.stringify(evaluation.results, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
