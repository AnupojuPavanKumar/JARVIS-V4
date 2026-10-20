'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OllamaAdapter } = require('../core/models/ollama-adapter');

test('posts chat requests with merged options and native tools', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      async json() {
        return {
          message: { role: 'assistant', content: 'hello' },
          prompt_eval_count: 3,
          eval_count: 1,
        };
      },
    };
  };

  const adapter = new OllamaAdapter({
    baseUrl: 'http://127.0.0.1:11434/',
    model: 'llama3.2',
    fetchImpl,
    defaultOptions: { temperature: 0.3, num_ctx: 4096 },
  });

  const result = await adapter.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'echo' } }],
    options: { num_predict: 20 },
  });

  assert.equal(result.message.content, 'hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].init.method, 'POST');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'llama3.2');
  assert.equal(body.stream, false);
  assert.equal(body.keep_alive, '30m');
  assert.deepEqual(body.options, { temperature: 0.3, num_ctx: 4096, num_predict: 20 });
  assert.equal(body.tools.length, 1);
});

test('maps provider-neutral tool messages to the Ollama wire shape', async () => {
  const calls = [];
  const adapter = new OllamaAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { message: { role: 'assistant', content: 'done' } }; } };
    },
  });

  await adapter.chat({
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'weather', arguments: { location: 'London' } }],
      },
      { role: 'tool', content: '14C', name: 'weather', toolCallId: 'call_1' },
    ],
  });

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'weather', arguments: { location: 'London' } },
    }],
  });
  assert.deepEqual(body.messages[2], {
    role: 'tool',
    content: '14C',
    tool_name: 'weather',
    tool_call_id: 'call_1',
  });
  assert.equal(body.messages[0].tool_calls, undefined);
});

test('surfaces HTTP errors with response detail', async () => {
  const adapter = new OllamaAdapter({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() { return 'model crashed'; },
    }),
  });

  await assert.rejects(
    adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    /HTTP 500: model crashed/
  );
});

test('rejects missing fetch and invalid configuration', () => {
  assert.throws(() => new OllamaAdapter({ fetchImpl: null }), /fetch implementation/);
  assert.throws(() => new OllamaAdapter({ fetchImpl: async () => {}, baseUrl: '' }), /base URL/);
  assert.throws(() => new OllamaAdapter({ fetchImpl: async () => {}, model: '' }), /model name/);
});
