'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVerdict,
  buildVerifierPrompt,
  compactToolResults,
  Verifier,
} = require('../core/verification/verifier');
const { estimateMessagesTokens } = require('../core/context/token-budget');

test('parses accept and reject verdicts', () => {
  assert.deepEqual(parseVerdict({ verdict: 'accept', reason: 'ok' }, ''), {
    accepted: true,
    reason: 'ok',
    guidance: '',
  });
  assert.equal(parseVerdict({ verdict: 'reject', reason: 'bad' }, '').accepted, false);
  assert.equal(parseVerdict(null, 'REJECTED: invented values').accepted, false);
  assert.equal(parseVerdict(null, 'ACCEPTED').accepted, true);
  assert.equal(parseVerdict(null, 'unclear').accepted, false);
});

test('verifier prompt includes goal, plan, tool evidence, and final answer', () => {
  const messages = buildVerifierPrompt({
    task: { goal: 'Measure GPU memory' },
    plan: [{ id: '1', description: 'Sample GPU' }],
    toolResults: [{ tool: 'system_metrics', status: 'completed', output: '2 GB' }],
    finalAnswer: 'It uses 2 GB.',
  });

  assert.match(messages[1].content, /Measure GPU memory/);
  assert.match(messages[1].content, /Sample GPU/);
  assert.match(messages[1].content, /2 GB/);
  assert.match(messages[1].content, /It uses 2 GB/);
});

test('compacts tool results for the verifier', () => {
  const results = compactToolResults([
    { kind: 'model', text: 'ignored' },
    { kind: 'tool', tool: 'echo', status: 'completed', result: { agentText: 'hello' } },
    { kind: 'tool', tool: 'fail', status: 'failed', error: 'boom', result: { ok: false, error: 'boom' } },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].output, 'hello');
  assert.match(results[1].error, /boom/);
});

test('verifier returns the parsed decision and usage', async () => {
  const requests = [];
  const model = {
    async chat(request) {
      requests.push(request);
      return {
        text: '{"verdict":"reject","reason":"answer is unsupported","guidance":"cite the tool result"}',
        usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
      };
    },
  };
  const verifier = new Verifier({ model });
  const result = await verifier.verify({
    task: { goal: 'Say the measured value' },
    finalAnswer: 'It is 99.',
    toolResults: [{ tool: 'system_metrics', output: 'It is 2.' }],
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /unsupported/);
  assert.match(result.guidance, /cite/);
  assert.equal(result.usage.totalTokens, 110);
  assert.equal(requests[0].tools.length, 0);
});

test('invalid verifier JSON fails closed', async () => {
  const verifier = new Verifier({
    model: { async chat() { return { text: 'I think it is fine.' }; } },
  });
  const result = await verifier.verify({ task: { goal: 'x' }, finalAnswer: 'y' });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /invalid decision/);
});

test('verifier fits large evidence into the configured context window', async () => {
  const requests = [];
  const verifier = new Verifier({
    model: {
      async chat(request) {
        requests.push(request);
        return { text: '{"verdict":"accept","reason":"supported"}' };
      },
    },
  });

  const result = await verifier.verify({
    task: { goal: `GOAL ${'g'.repeat(6000)}` },
    finalAnswer: `FINAL ${'f'.repeat(6000)}`,
    toolResults: Array.from({ length: 8 }, (_, index) => ({
      tool: `tool_${index}`,
      status: 'completed',
      output: 'o'.repeat(1200),
    })),
    capabilities: { contextLength: 1024, tools: true },
    modelOptions: { num_ctx: 1024, num_predict: 256 },
  });

  assert.equal(result.accepted, true);
  assert.equal(requests[0].options.num_predict, 256);
  assert.ok(estimateMessagesTokens(requests[0].messages) <= 768);
  assert.match(requests[0].messages[1].content, /^[\s\S]*GOAL/);
  assert.match(requests[0].messages[1].content, /FINAL/);
});
