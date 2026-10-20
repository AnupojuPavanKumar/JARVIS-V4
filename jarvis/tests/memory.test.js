'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../memory');

let tempRoot;

test.before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-test-'));
  memory.init(tempRoot);
});

test.after(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('saves, loads, lists, and deletes a session', async () => {
  const sessionId = 'session_alpha';
  const payload = {
    title: 'Alpha',
    mode: 'general',
    messages: [{ role: 'user', content: 'hello' }],
  };

  assert.deepEqual(await memory.saveSession(sessionId, payload), { ok: true });

  const loaded = await memory.loadSession(sessionId);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.data, payload);

  const listed = await memory.listSessions();
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, sessionId);
  assert.equal(listed.data[0].title, 'Alpha');
  assert.equal(listed.data[0].messageCount, 1);

  assert.deepEqual(await memory.deleteSession(sessionId), { ok: true });
  const afterDelete = await memory.loadSession(sessionId);
  assert.equal(afterDelete.ok, true);
  assert.equal(afterDelete.data, null);
});

test('returns null data for a missing session', async () => {
  const result = await memory.loadSession('session_missing');
  assert.equal(result.ok, true);
  assert.equal(result.data, null);
});

test('rejects path traversal, reserved names, and malformed session IDs', async () => {
  const invalid = [
    '../escape',
    '..\\escape',
    'bad/slash',
    'bad\\slash',
    '',
    'a'.repeat(65),
    'CON',
    'NUL',
    'COM1',
    'LPT9',
    'session with spaces',
  ];

  for (const sessionId of invalid) {
    const saved = await memory.saveSession(sessionId, { messages: [] });
    assert.equal(saved.ok, false, sessionId);
    assert.match(saved.error, /Invalid session ID format|Reserved session ID/, sessionId);

    const loaded = await memory.loadSession(sessionId);
    assert.equal(loaded.ok, false, sessionId);

    const deleted = await memory.deleteSession(sessionId);
    assert.equal(deleted.ok, false, sessionId);
  }
});

test('reports uninitialized state without throwing', async () => {
  const previousHistDir = memory.histDir;
  memory.histDir = null;
  try {
    const saved = await memory.saveSession('session_beta', {});
    assert.equal(saved.ok, false);
    assert.match(saved.error, /not initialized/);

    const loaded = await memory.loadSession('session_beta');
    assert.equal(loaded.ok, false);
    assert.match(loaded.error, /not initialized/);
  } finally {
    memory.histDir = previousHistDir;
  }
});
