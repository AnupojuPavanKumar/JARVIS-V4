'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelGateway, normalizeResponse } = require('../core/models/model-gateway');

function makeAdapter(responses) {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request);
      if (request.signal?.aborted) throw request.signal.reason || new Error('aborted');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(request);
      if (next === undefined) throw new Error('No scripted response');
      return next;
    },
  };
}

test('normalizes string and Ollama-style responses', () => {
  assert.deepEqual(normalizeResponse('hello'), {
    text: 'hello',
    toolCalls: [],
    finishReason: 'stop',
    usage: null,
  });

  const normalized = normalizeResponse({
    message: {
      content: '',
      tool_calls: [{
        function: {
          name: 'weather',
          arguments: { location: 'London' },
        },
      }],
    },
    prompt_eval_count: 12,
    eval_count: 5,
  });

  assert.equal(normalized.text, '');
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, 'weather');
  assert.deepEqual(normalized.toolCalls[0].arguments, { location: 'London' });
  assert.equal(normalized.finishReason, 'tool_calls');
  assert.deepEqual(normalized.usage, {
    promptTokens: 12,
    completionTokens: 5,
    totalTokens: 17,
  });
});

test('reports malformed tool arguments instead of executing them', () => {
  const normalized = normalizeResponse({
    toolCalls: [{ name: 'write_file', arguments: '{"path":' }],
  });

  assert.equal(normalized.toolCalls.length, 1);
  assert.deepEqual(normalized.toolCalls[0].arguments, {});
  assert.match(normalized.toolCalls[0].error, /Invalid tool arguments JSON/);
});

test('validates messages and forwards merged options', async () => {
  const adapter = makeAdapter([{ text: 'ok' }]);
  const gateway = new ModelGateway({ adapter, defaultOptions: { temperature: 0.2 } });

  const result = await gateway.chat({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'echo' } }],
    options: { num_predict: 10 },
  });

  assert.equal(result.text, 'ok');
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(adapter.calls[0].options, { temperature: 0.2, num_predict: 10 });
  assert.equal(adapter.calls[0].tools.length, 1);

  await assert.rejects(
    gateway.chat({ messages: [] }),
    /at least one message/
  );
  await assert.rejects(
    gateway.chat({ messages: [{ role: 'invalid', content: 'x' }] }),
    /Invalid model message role/
  );
});

test('times out slow adapter calls', async () => {
  const adapter = {
    async chat({ signal }) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const gateway = new ModelGateway({ adapter, timeoutMs: 10 });

  await assert.rejects(
    gateway.chat({ messages: [{ role: 'user', content: 'wait' }] }),
    /timed out/
  );
});

test('honors an external abort signal', async () => {
  const adapter = {
    async chat({ signal }) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const gateway = new ModelGateway({ adapter, timeoutMs: 10000 });
  const controller = new AbortController();

  const promise = gateway.chat({
    messages: [{ role: 'user', content: 'wait' }],
    signal: controller.signal,
  });
  controller.abort(new Error('stop now'));

  await assert.rejects(promise, /stop now/);
});
