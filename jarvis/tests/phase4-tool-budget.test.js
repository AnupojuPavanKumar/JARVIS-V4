'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PromptBuilder } = require('../core/context/prompt-builder');
const { createBrowserTools } = require('../core/browser/browser-tools');
const { createIntegrationTools } = require('../core/integrations/integration-tools');
const { createDocumentTools } = require('../core/documents/document-tools');
const { createSystemMetricsTool } = require('../core/tools/system-metrics-tool');

function fakeDriver() {
  return {
    async navigate() { return {}; },
    async read() { return {}; },
    async preview() { return {}; },
    async click() { return {}; },
    async type() { return {}; },
    async select() { return {}; },
    async scroll() { return {}; },
    async stop() { return {}; },
    async status() { return {}; },
  };
}

function fakeService() {
  const noop = async () => ({});
  return {
    calendar: noop,
    createEvent: noop,
    searchEmail: noop,
    composeEmail: noop,
    searchContacts: noop,
    listTasks: noop,
    writeTask: noop,
    searchNotes: noop,
    writeNote: noop,
    message: noop,
  };
}

test('production browser and integration tools fit the durable 4096-token context', () => {
  const tools = [
    createSystemMetricsTool(),
    ...createBrowserTools({ driver: fakeDriver() }),
    ...createIntegrationTools({ service: fakeService() }),
    ...createDocumentTools({
      index: {
        async search() {
          return { citations: [], searchedChunks: 0 };
        },
      },
    }),
  ];
  assert.equal(tools.length, 20);

  const builder = new PromptBuilder({ maxSystemChars: 24000, maxHistoryChars: 16000 });
  const built = builder.buildWithBudget({
    task: {
      goal: 'Check the fixture calendar, draft an email, and create a task.',
      messages: [],
    },
    tools,
    toolMode: 'native',
    context: {
      deepWorkEnabled: true,
      modelOptions: { num_ctx: 4096, num_predict: 512 },
      now: new Date('2026-10-21T12:00:00.000Z'),
    },
  });

  assert.ok(built.budget.toolSchemaTokens > 0);
  assert.ok(built.budget.promptTokens <= built.budget.inputBudget);
  assert.ok(built.budget.systemTokens > 0);
  assert.equal(built.messages[0].role, 'system');
});
