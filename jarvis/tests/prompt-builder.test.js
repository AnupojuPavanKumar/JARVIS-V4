'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PromptBuilder,
  buildJsonSchema,
  buildToolManifestText,
} = require('../core/context/prompt-builder');

const fixedDate = new Date('2026-10-19T12:34:56Z');

test('builds a system prompt with time, hardware, memory, project, and tools', () => {
  const builder = new PromptBuilder();
  const task = {
    goal: 'Inspect the project',
    messages: [{ role: 'user', content: 'Please inspect it' }],
  };
  const tools = [{
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
    },
  }];

  const messages = builder.build({
    task,
    tools,
    context: {
      now: fixedDate,
      systemSpecs: {
        cpuModel: 'Test CPU',
        cpuCount: 8,
        totalMem: 16 * 1024 * 1024 * 1024,
        platform: 'win32',
        arch: 'x64',
      },
      memory: ['User prefers concise answers', { text: 'Project is JARVIS' }],
      projectContext: {
        name: 'JARVIS',
        rootPath: 'C:\\JARVIS',
        files: [{ relativePath: 'main.js', content: 'console.log("hi")' }],
      },
      webSearchContext: 'search result',
      deepWorkEnabled: true,
    },
  });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /CURRENT SYSTEM TIME/);
  assert.match(messages[0].content, /Test CPU/);
  assert.match(messages[0].content, /User prefers concise/);
  assert.match(messages[0].content, /Project is JARVIS/);
  assert.match(messages[0].content, /PROJECT CONTEXT/);
  assert.match(messages[0].content, /WEB SEARCH CONTEXT/);
  assert.match(messages[0].content, /read_file/);
  assert.match(messages[0].content, /Work step by step/);

  assert.deepEqual(messages.slice(1), [{ role: 'user', content: 'Please inspect it' }]);
});

test('adds a goal message when task history is empty', () => {
  const builder = new PromptBuilder();
  const messages = builder.build({
    task: { goal: 'Find the answer', messages: [] },
    context: { now: fixedDate },
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /AGENTIC GOAL/);
  assert.match(messages[1].content, /Find the answer/);
});

test('truncates the system prompt and preserves recent history', () => {
  const builder = new PromptBuilder({
    maxSystemChars: 1200,
    maxHistoryChars: 1200,
    maxHistoryMessages: 4,
  });
  const task = {
    goal: 'Goal',
    messages: [
      { role: 'user', content: 'g'.repeat(500) },
      { role: 'assistant', content: 'a'.repeat(500) },
      { role: 'user', content: 'b'.repeat(500) },
      { role: 'assistant', content: 'c'.repeat(500) },
    ],
  };

  const messages = builder.build({
    task,
    context: { now: fixedDate, systemPrompt: 'S'.repeat(2000) },
  });
  assert.match(messages[0].content, /truncated/);
  assert.equal(messages.length, 4);
  assert.equal(messages[1].content, 'g'.repeat(500));
  assert.equal(messages[messages.length - 1].content, 'c'.repeat(500));
});

test('preserves assistant tool calls and tool results', () => {
  const builder = new PromptBuilder();
  const messages = builder.build({
    task: {
      goal: 'Use a tool',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }],
        },
        { role: 'tool', content: '[TOOL_RESULT: echo]\nhi', name: 'echo', toolCallId: 'c1' },
      ],
    },
    context: { now: fixedDate },
  });

  assert.equal(messages[2].toolCalls.length, 1);
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].toolCallId, 'c1');
});

test('builds native tool schemas and manifest text', () => {
  const tools = [{
    id: 'calculator',
    description: 'Evaluate math',
    params: {
      expression: { type: 'string', required: true, description: 'Math expression' },
      mode: { type: 'string', enum: ['fast', 'safe'] },
    },
  }];

  assert.deepEqual(buildJsonSchema(tools[0].params), {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression' },
      mode: { type: 'string', enum: ['fast', 'safe'] },
    },
    required: ['expression'],
  });

  const builder = new PromptBuilder();
  const definitions = builder.buildToolDefinitions(tools);
  assert.equal(definitions[0].type, 'function');
  assert.equal(definitions[0].function.name, 'calculator');

  const manifest = buildToolManifestText(tools);
  assert.match(manifest, /calculator/);
  assert.match(manifest, /expression/);
});
