'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IntegrationStore } = require('../core/integrations/integration-store');
const { FixtureProvider } = require('../core/integrations/fixture-provider');
const { IntegrationService } = require('../core/integrations/integration-service');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-integration-service-'));
}

async function makeService(options = {}) {
  const baseDir = tempDir();
  const store = new IntegrationStore({ baseDir, now: () => NOW });
  await store.init();
  const provider = new FixtureProvider({ store, now: () => NOW });
  const audit = [];
  const service = new IntegrationService({
    store,
    provider,
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
    now: () => NOW,
    ...options,
  });
  return { baseDir, store, service, audit };
}

test('multi-family fixture workflow reads, drafts, sends, and writes scoped data', async () => {
  const { baseDir, store, service, audit } = await makeService();
  try {
    const contacts = await service.searchContacts({ query: 'ada' });
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].email, 'ada@example.test');

    const date = new Date(NOW + DAY).toISOString().slice(0, 10);
    const availability = await service.calendar({ action: 'availability', date, duration_minutes: 30 });
    assert.equal(availability.date, date);
    assert.ok(Array.isArray(availability.slots));
    assert.ok(availability.slots.length >= 1);

    const draft = await service.composeEmail({
      action: 'draft',
      to: contacts[0].email,
      subject: 'Fixture follow-up',
      body: 'This body must never appear in the audit log.',
    });
    assert.match(draft.id, /^eml_/);
    assert.equal(draft.status, 'draft');

    const sent = await service.composeEmail({ action: 'send', draft_id: draft.id });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.to, 'ada@example.test');

    const task = await service.writeTask({
      action: 'create',
      title: 'Send fixture summary',
      due: new Date(NOW + 2 * DAY).toISOString(),
    });
    assert.equal(task.status, 'pending');
    const completed = await service.writeTask({ action: 'complete', task_id: task.id });
    assert.equal(completed.status, 'completed');

    const note = await service.writeNote({ title: 'Workflow note', body: 'Local fixture result.', tags: 'work' });
    assert.equal(note.title, 'Workflow note');
    const notes = await service.searchNotes({ query: 'workflow' });
    assert.equal(notes.length, 1);

    const messageDraft = await service.message({ action: 'draft', contact: 'Ada Lovelace', body: 'Fixture message' });
    assert.equal(messageDraft.status, 'draft');
    const messageSent = await service.message({ action: 'send', draft_id: messageDraft.id });
    assert.equal(messageSent.status, 'sent');

    const state = await store.read();
    assert.equal(state.data.emails.find(email => email.id === draft.id).status, 'sent');
    assert.equal(state.data.tasks.find(item => item.id === task.id).status, 'completed');
    assert.ok(state.data.messages.some(message => message.id === messageSent.id && message.status === 'sent'));

    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_CONTACTS_SEARCH'));
    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_EMAIL_SEND'));
    assert.ok(!JSON.stringify(audit).includes('This body must never appear'));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('scope changes fail closed before a provider call', async () => {
  const { baseDir, service } = await makeService();
  try {
    await service.setScopes('email', ['email.read']);
    await assert.rejects(
      () => service.composeEmail({
        action: 'draft',
        to: 'ada@example.test',
        subject: 'Blocked',
        body: 'Blocked body',
      }),
      error => error.code === 'scope-denied'
    );
    await assert.rejects(
      () => service.composeEmail({ action: 'send', draft_id: 'eml_missing' }),
      error => error.code === 'scope-denied'
    );

    await service.revoke('calendar');
    await assert.rejects(
      () => service.calendar({ action: 'list' }),
      error => error.code === 'integration-revoked'
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('rate limits stop repeated reads in the same window', async () => {
  const { baseDir, service } = await makeService({ limits: { read: 1, write: 1 } });
  try {
    await service.searchContacts({ query: 'ada' });
    await assert.rejects(
      () => service.searchContacts({ query: 'grace' }),
      error => error.code === 'rate-limited'
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('deleteData removes stored records and activity for that integration', async () => {
  const { baseDir, service } = await makeService();
  try {
    await service.searchEmail({ query: 'fixture' });
    await service.deleteData('email');

    const stats = await service.stats();
    assert.equal(stats.integrations.email.counts.emails, 0);
    assert.equal(stats.integrations.email.enabled, false);

    const activity = await service.activity();
    assert.equal(activity.some(action => action.integration === 'email'), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
