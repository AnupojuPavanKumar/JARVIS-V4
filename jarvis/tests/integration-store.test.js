'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IntegrationStore, SCOPES } = require('../core/integrations/integration-store');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-integration-store-'));
}

test('fixture integration store seeds scoped data and persists it', async () => {
  const baseDir = tempDir();
  try {
    const store = new IntegrationStore({ baseDir, now: () => NOW });
    const initial = await store.init();
    assert.equal(initial.version, 1);
    assert.equal(initial.integrations.calendar.enabled, true);
    assert.deepEqual(initial.integrations.calendar.scopes, SCOPES.calendar);
    assert.equal(initial.integrations.calendar.counts.events, 2);
    assert.equal(initial.integrations.contacts.counts.contacts, 2);

    const state = await store.read();
    assert.equal(state.data.events.length, 2);
    assert.equal(state.data.contacts[0].email, 'ada@example.test');

    const reloaded = new IntegrationStore({ baseDir, now: () => NOW });
    await reloaded.init();
    const reloadedState = await reloaded.read();
    assert.equal(reloadedState.data.events.length, 2);
    assert.equal(reloadedState.data.notes[0].title, 'Fixture planning notes');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('scopes can be narrowed and unknown scopes are rejected', async () => {
  const baseDir = tempDir();
  try {
    const store = new IntegrationStore({ baseDir, now: () => NOW });
    await store.init();

    const updated = await store.setScopes('email', ['email.read', 'not.a.scope']);
    assert.deepEqual(updated.scopes, ['email.read']);
    assert.equal(await store.hasScope('email', 'email.read'), true);
    assert.equal(await store.hasScope('email', 'email.send'), false);

    const revoked = await store.revoke('email');
    assert.equal(revoked.enabled, false);
    assert.deepEqual(revoked.scopes, []);
    assert.equal(await store.hasScope('email', 'email.read'), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('deleteData removes only the selected integration and its action history', async () => {
  const baseDir = tempDir();
  try {
    const store = new IntegrationStore({ baseDir, now: () => NOW });
    await store.init();
    await store.recordAction({ integration: 'email', action: 'email_search', scope: 'email.read' });
    await store.recordAction({ integration: 'calendar', action: 'calendar_list', scope: 'calendar.read' });

    await store.deleteData('email');
    const stats = await store.stats();
    assert.equal(stats.integrations.email.counts.emails, 0);
    assert.equal(stats.integrations.email.enabled, false);
    assert.equal(stats.integrations.calendar.counts.events, 2);

    const actions = await store.listActions();
    assert.equal(actions.some(action => action.integration === 'email'), false);
    assert.equal(actions.some(action => action.integration === 'calendar'), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('action log caps retained entries and exposes no content fields', async () => {
  const baseDir = tempDir();
  try {
    const store = new IntegrationStore({ baseDir, now: () => NOW });
    await store.init();
    for (let index = 0; index < 510; index += 1) {
      await store.recordAction({
        integration: 'notes',
        action: 'notes_search',
        scope: 'notes.read',
        metadata: { count: index },
      });
    }
    const actions = await store.listActions({ limit: 500 });
    assert.equal(actions.length, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'body'), false);
    assert.equal(actions[0].metadata.count, 509);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
