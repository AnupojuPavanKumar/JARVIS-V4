'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTokens,
  estimateMessagesTokens,
  truncateToTokens,
  truncateMiddleToTokens,
  fitMessagesToBudget,
  resolveContextBudget,
} = require('../core/context/token-budget');
const { PromptBuilder, ContextOverflowError } = require('../core/context/prompt-builder');

test('estimates conservatively and truncates to a token budget', () => {
  assert.equal(estimateTokens('abcd'), 2);
  assert.ok(estimateMessagesTokens([
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'y'.repeat(400) },
  ]) > 200);

  const truncated = truncateToTokens('a'.repeat(1000), 100);
  assert.ok(truncated.length <= 350);
  assert.match(truncated, /truncated/);
});

test('reserves configured output tokens and respects the smaller context window', () => {
  const budget = resolveContextBudget({
    capabilities: { contextLength: 8192 },
    modelOptions: { num_ctx: 2048, num_predict: 512 },
  });
  assert.equal(budget.contextWindow, 2048);
  assert.equal(budget.outputReserve, 512);
  assert.equal(budget.inputBudget, 1536);
});

test('prompt budget includes memory, project, tools, history, and output reserve', () => {
  const builder = new PromptBuilder({ maxSystemChars: 24000, maxHistoryChars: 24000 });
  const task = {
    goal: 'Inspect the project and summarize it',
    messages: [
      { role: 'user', content: 'g'.repeat(2000) },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `${index}:`.padEnd(1500, 'x'),
      })),
    ],
  };
  const tools = [{
    name: 'read_file',
    description: 'Read a file',
    params: { path: { type: 'string', required: true } },
  }];
  const result = builder.buildWithBudget({
    task,
    tools,
    toolMode: 'native',
    capabilities: { tools: true, contextLength: 8192, maxOutputTokens: 1024 },
    context: {
      modelOptions: { num_ctx: 2048, num_predict: 512 },
      memory: ['User prefers concise answers'],
      projectContext: {
        name: 'demo',
        rootPath: '/demo',
        files: [{ relativePath: 'a.js', content: 'x'.repeat(4000) }],
      },
      systemPrompt: 'You are a test agent.',
    },
  });

  assert.equal(result.budget.contextWindow, 2048);
  assert.equal(result.budget.outputReserve, 512);
  assert.ok(result.budget.promptTokens + result.budget.outputReserve <= result.budget.contextWindow);
  assert.ok(result.budget.promptTokens > 0);
  assert.ok(result.budget.toolSchemaTokens > 0);
  assert.ok(result.budget.historyTokens > 0);
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[0].content, /read_file/);
});

test('JSON fallback includes the tool manifest and does not emit text tags', () => {
  const builder = new PromptBuilder();
  const result = builder.buildWithBudget({
    task: { goal: 'Read a file', messages: [] },
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      params: { path: { type: 'string', required: true } },
    }],
    toolMode: 'json',
    capabilities: { tools: false, contextLength: 4096, maxOutputTokens: 512 },
    context: { modelOptions: { num_ctx: 4096, num_predict: 512 } },
  });
  assert.match(result.messages[0].content, /JSON FALLBACK/);
  assert.match(result.messages[0].content, /read_file/);
  assert.doesNotMatch(result.messages[0].content, /<tool_call>/);
});

test('middle truncation preserves both the opening goal and closing instruction', () => {
  const text = `START ${'x'.repeat(2000)} END`;
  const truncated = truncateMiddleToTokens(text, 100);
  assert.match(truncated, /^START/);
  assert.match(truncated, /END$/);
  assert.match(truncated, /middle truncated/);
  assert.ok(truncated.length <= 350);
});

test('fits planner and verifier style messages into a hard window', () => {
  const messages = [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: `GOAL ${'x'.repeat(8000)} FINAL_INSTRUCTION` },
  ];
  const fitted = fitMessagesToBudget(messages, { contextWindow: 1024, outputReserve: 256 });
  assert.ok(fitted.budget.promptTokens <= fitted.budget.inputBudget);
  assert.match(fitted.messages[1].content, /^GOAL/);
  assert.match(fitted.messages[1].content, /FINAL_INSTRUCTION$/);
  assert.equal(fitted.budget.truncated, true);

  assert.throws(() => fitMessagesToBudget([
    { role: 'system', content: 'x'.repeat(4000) },
  ], { contextWindow: 512, outputReserve: 256 }), error => {
    assert.equal(error.code, 'context-overflow');
    return true;
  });
});

test('throws a typed overflow error instead of silently exceeding the window', () => {
  const builder = new PromptBuilder();
  assert.throws(() => builder.buildWithBudget({
    task: {
      goal: 'x'.repeat(20000),
      messages: [{ role: 'user', content: 'x'.repeat(20000) }],
    },
    tools: [],
    capabilities: { tools: true, contextLength: 512, maxOutputTokens: 256 },
    context: { modelOptions: { num_ctx: 512, num_predict: 256 } },
  }), error => {
    assert.equal(error instanceof ContextOverflowError, true);
    assert.equal(error.code, 'context-overflow');
    return true;
  });
});
