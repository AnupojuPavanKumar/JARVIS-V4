'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIntegrationTools } = require('../core/integrations/integration-tools');

function makeService() {
  const calls = [];
  return {
    calls,
    async calendar(args) {
      calls.push({ method: 'calendar', args });
      return args.action === 'availability' ? { slots: [{ start: 'x', end: 'y' }] } : [{ id: 'evt_1' }];
    },
    async createEvent(args) {
      calls.push({ method: 'createEvent', args });
      return { id: 'evt_2', title: args.title };
    },
    async searchEmail(args) {
      calls.push({ method: 'searchEmail', args });
      return [{ id: 'eml_1', subject: 'Fixture' }];
    },
    async composeEmail(args) {
      calls.push({ method: 'composeEmail', args });
      return args.action === 'delete_draft'
        ? { deleted: 1 }
        : { id: 'eml_2', status: args.action === 'send' ? 'sent' : 'draft', to: args.to || 'x@y.test' };
    },
    async searchContacts(args) {
      calls.push({ method: 'searchContacts', args });
      return [{ id: 'con_1', name: 'Ada Lovelace' }];
    },
    async listTasks(args) {
      calls.push({ method: 'listTasks', args });
      return [{ id: 'tsk_1' }];
    },
    async writeTask(args) {
      calls.push({ method: 'writeTask', args });
      return { id: 'tsk_2', status: args.action === 'complete' ? 'completed' : 'pending' };
    },
    async searchNotes(args) {
      calls.push({ method: 'searchNotes', args });
      return [{ id: 'note_1' }];
    },
    async writeNote(args) {
      calls.push({ method: 'writeNote', args });
      return { id: 'note_2', title: args.title };
    },
    async message(args) {
      calls.push({ method: 'message', args });
      return { id: 'msg_1', status: args.action === 'send' ? 'sent' : 'draft' };
    },
  };
}

function makeTools() {
  const service = makeService();
  const tools = createIntegrationTools({ service });
  return { service, tools, byId: new Map(tools.map(tool => [tool.id, tool])) };
}

test('integration tools expose the expected scoped read and write surfaces', () => {
  const { byId } = makeTools();
  assert.deepEqual([...byId.keys()], [
    'calendar',
    'calendar_create_event',
    'email_search',
    'email_compose',
    'contacts_search',
    'tasks_list',
    'tasks_write',
    'notes_search',
    'notes_write',
    'messaging',
  ]);
  assert.equal(byId.get('calendar').risk, 'read');
  assert.equal(byId.get('email_search').untrusted, true);
  assert.equal(byId.get('email_compose').risk, 'destructive');
  assert.equal(byId.get('messaging').risk, 'destructive');
  assert.equal(byId.get('tasks_write').risk, 'write');
  assert.equal(byId.get('notes_write').risk, 'write');
});

test('email search marks results as tainted and compose validates new-email fields', async () => {
  const { byId, service } = makeTools();
  const searched = await byId.get('email_search').execute({ query: 'fixture' });
  assert.equal(searched.ok, true);
  assert.equal(searched.taint, true);
  assert.equal(service.calls.at(-1).method, 'searchEmail');

  const missing = await byId.get('email_compose').execute({ action: 'draft' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /to is required/);
  assert.equal(service.calls.some(call => call.method === 'composeEmail'), false);

  const sent = await byId.get('email_compose').execute({
    action: 'send',
    to: 'ada@example.test',
    subject: 'Hello',
    body: 'Body',
  });
  assert.equal(sent.ok, true);
  assert.equal(service.calls.at(-1).method, 'composeEmail');
});

test('task and messaging tools reject incomplete commands before calling the service', async () => {
  const { byId, service } = makeTools();
  const missingTitle = await byId.get('tasks_write').execute({ action: 'create' });
  assert.equal(missingTitle.ok, false);
  assert.equal(service.calls.some(call => call.method === 'writeTask'), false);

  const missingContact = await byId.get('messaging').execute({ action: 'send', body: 'Hello' });
  assert.equal(missingContact.ok, false);
  assert.equal(service.calls.some(call => call.method === 'message'), false);

  const drafted = await byId.get('messaging').execute({
    action: 'draft',
    contact: 'Ada Lovelace',
    body: 'Fixture message',
  });
  assert.equal(drafted.ok, true);
  assert.equal(service.calls.at(-1).method, 'message');
});
