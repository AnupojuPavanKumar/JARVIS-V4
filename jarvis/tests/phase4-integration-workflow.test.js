'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../core/runtime/task-store');
const { AgentRuntime } = require('../core/runtime/agent-runtime');
const { ModelGateway } = require('../core/models/model-gateway');
const { PromptBuilder } = require('../core/context/prompt-builder');
const { PolicyEngine } = require('../core/policy/policy-engine');
const { ToolRegistry } = require('../core/tools/tool-registry');
const { TASK_STATUS } = require('../core/runtime/task-state');
const { IntegrationStore } = require('../core/integrations/integration-store');
const { FixtureProvider } = require('../core/integrations/fixture-provider');
const { IntegrationService } = require('../core/integrations/integration-service');
const { createIntegrationTools } = require('../core/integrations/integration-tools');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function makeAdapter(responses) {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error('No scripted response');
      return next;
    },
  };
}

test('durable runtime completes a multi-app fixture workflow with approvals', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase4-workflow-'));
  try {
    const taskStore = new TaskStore({ baseDir, now: () => NOW });
    await taskStore.init();
    const integrationStore = new IntegrationStore({ baseDir: path.join(baseDir, 'integrations'), now: () => NOW });
    await integrationStore.init();
    const service = new IntegrationService({
      store: integrationStore,
      provider: new FixtureProvider({ store: integrationStore, now: () => NOW }),
      now: () => NOW,
    });
    const audit = [];
    service.audit = (action, detail, verdict) => audit.push({ action, detail, verdict });

    const registry = new ToolRegistry({
      skillsDir: path.join(__dirname, '../skills'),
      loadManifest: async () => ({ ok: true, skills: [] }),
      nativeTools: createIntegrationTools({ service }),
    });
    await registry.load();

    const date = new Date(NOW + DAY).toISOString().slice(0, 10);
    const adapter = makeAdapter([
      {
        text: 'Find the contact.',
        toolCalls: [{ id: 'call_1', name: 'contacts_search', arguments: { query: 'ada' } }],
      },
      {
        text: 'Check availability.',
        toolCalls: [{ id: 'call_2', name: 'calendar', arguments: { action: 'availability', date, duration_minutes: 30 } }],
      },
      {
        text: 'Draft the follow-up.',
        toolCalls: [{
          id: 'call_3',
          name: 'email_compose',
          arguments: {
            action: 'draft',
            to: 'ada@example.test',
            subject: 'Fixture follow-up',
            body: 'This is a local fixture draft.',
          },
        }],
      },
      {
        text: 'Create the task.',
        toolCalls: [{
          id: 'call_4',
          name: 'tasks_write',
          arguments: { action: 'create', title: 'Send fixture summary' },
        }],
      },
      { text: 'The fixture workflow is complete.' },
    ]);
    const model = new ModelGateway({ adapter, timeoutMs: 1000 });
    const runtime = new AgentRuntime({
      store: taskStore,
      model,
      promptBuilder: new PromptBuilder({ maxSystemChars: 20000, maxHistoryChars: 20000 }),
      tools: registry,
      policy: new PolicyEngine({ taskStore }),
      verifier: {
        async verify() {
          return { accepted: true, reason: 'fixture workflow verified' };
        },
      },
      now: () => NOW,
    });
    const task = await taskStore.createTask({
      goal: 'Find Ada, check availability, draft a follow-up email, and create a task.',
      maxSteps: 8,
    });

    const firstPause = await runtime.runTask(task.id);
    assert.equal(firstPause.status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal(firstPause.approvals.at(-1).toolCall.tool, 'email_compose');
    assert.equal(firstPause.approvals.at(-1).status, 'pending');

    const secondPause = await runtime.approveTask(task.id, { approved: true });
    assert.equal(secondPause.status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal(secondPause.approvals.at(-1).toolCall.tool, 'tasks_write');

    const final = await runtime.approveTask(task.id, { approved: true });
    assert.equal(final.status, TASK_STATUS.COMPLETED);
    assert.equal(final.result, 'The fixture workflow is complete.');
    assert.equal(final.approvals.length, 2);

    const state = await integrationStore.read();
    assert.equal(state.data.emails.filter(email => email.status === 'draft').length, 1);
    assert.equal(state.data.tasks.filter(item => item.title === 'Send fixture summary').length, 1);
    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_EMAIL_DRAFT'));
    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_TASKS_CREATE'));
    assert.equal(JSON.stringify(audit).includes('This is a local fixture draft.'), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
