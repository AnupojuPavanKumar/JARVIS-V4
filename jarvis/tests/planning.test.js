'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validatePlan } = require('../core/planning/plan-validator');
const { Planner, buildPlannerPrompt } = require('../core/planning/planner');

test('validates a small plan with dependencies and known tools', () => {
  const result = validatePlan({
    steps: [
      { id: '1', description: 'Read the file', tool: 'read_file', dependsOn: [] },
      { id: '2', description: 'Summarize the file', dependsOn: ['1'] },
    ],
  }, { toolNames: ['read_file'] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.map(step => step.status), ['pending', 'pending']);
});

test('rejects unknown tools, missing dependencies, duplicates, and cycles', () => {
  const base = { toolNames: ['read_file'] };
  assert.match(validatePlan({ steps: [
    { id: '1', description: 'bad', tool: 'missing_tool' },
  ] }, base).error, /unknown tool/);
  assert.match(validatePlan({ steps: [
    { id: '1', description: 'a', dependsOn: ['2'] },
    { id: '2', description: 'b', dependsOn: ['1'] },
  ] }, base).error, /cycle/);
  assert.match(validatePlan({ steps: [
    { id: '1', description: 'a', dependsOn: ['missing'] },
  ] }, base).error, /missing step/);
  assert.match(validatePlan({ steps: [
    { id: '1', description: 'a' },
    { id: '1', description: 'b' },
  ] }, base).error, /Duplicate/);
});

test('rejects empty and oversized plans', () => {
  assert.match(validatePlan({ steps: [] }).error, /at least one/);
  assert.match(validatePlan({
    steps: Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 1),
      description: `step ${index + 1}`,
    })),
  }, { maxSteps: 3 }).error, /limit is 3/);
});

test('planner produces a validated plan from fenced JSON', async () => {
  const requests = [];
  const model = {
    async chat(request) {
      requests.push(request);
      return {
        text: '```json\n{"steps":[{"id":"1","description":"Read package.json","tool":"read_file","dependsOn":[]},{"id":"2","description":"Summarize it","dependsOn":["1"]}]}\n```',
        usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
      };
    },
  };
  const tools = {
    listTools() {
      return [{ id: 'read_file', description: 'Read a file' }];
    },
  };
  const planner = new Planner({ model, tools, maxSteps: 5 });
  const result = await planner.createPlan({ task: { goal: 'Inspect package.json' } });

  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 2);
  assert.equal(result.usage.totalTokens, 140);
  assert.equal(requests[0].tools.length, 0);
  assert.match(requests[0].messages[0].content, /only one JSON object/i);
});

test('planner rejects a plan that references an unknown tool', async () => {
  const model = {
    async chat() {
      return { text: '{"steps":[{"id":"1","description":"Hack","tool":"unknown","dependsOn":[]}]}' };
    },
  };
  const planner = new Planner({
    model,
    tools: { listTools: () => [{ id: 'read_file' }] },
  });
  const result = await planner.createPlan({ task: { goal: 'Bad plan' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown tool/);
});

test('planner revision asks for one step and rejects unknown tools', async () => {
  const prompts = [];
  const model = {
    async chat(request) {
      prompts.push(request);
      return { text: '{"id":"2","description":"Read a different file","tool":"read_file","dependsOn":["1"]}' };
    },
  };
  const planner = new Planner({
    model,
    tools: { listTools: () => [{ id: 'read_file' }, { id: 'list_files' }] },
  });
  const result = await planner.reviseStep({
    task: { goal: 'Inspect' },
    failedStep: { id: '2', description: 'Read missing file' },
    error: 'ENOENT',
  });

  assert.equal(result.ok, true);
  assert.equal(result.patch.description, 'Read a different file');
  assert.match(prompts[0].messages[0].content, /exactly one failed plan step/i);
});

test('planner prompt lists available tools', () => {
  const messages = buildPlannerPrompt({
    task: { goal: 'Read a file' },
    tools: [{ id: 'read_file', description: 'Read a file' }],
    maxSteps: 4,
  });
  assert.match(messages[1].content, /read_file/);
  assert.match(messages[1].content, /Read a file/);
});
