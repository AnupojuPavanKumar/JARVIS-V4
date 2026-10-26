'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFallbackToolCall,
  stripFallbackToolCall,
  sanitizeArgs,
} = require('../core/tools/tool-call-fallback');

test('parses a fenced JSON tool call', () => {
  const text = '```json\n{"tool":"echo","args":{"text":"fallback"}}\n```';
  assert.deepEqual(parseFallbackToolCall(text), {
    tool: 'echo',
    args: { text: 'fallback' },
    native: false,
  });
});

test('parses a bare JSON tool call only when it is the whole response', () => {
  assert.deepEqual(parseFallbackToolCall('{"name":"echo","arguments":{"text":"hi"}}'), {
    tool: 'echo',
    args: { text: 'hi' },
    native: false,
  });
  assert.equal(parseFallbackToolCall('Use this: {"tool":"echo","args":{}}'), null);
  assert.equal(parseFallbackToolCall('For example:\n```json\n{"tool":"echo","args":{}}\n```'), null);
});

test('parses string arguments and reports invalid JSON', () => {
  const parsed = parseFallbackToolCall('{"tool":"echo","args":"{\\"text\\":\\"hi\\"}"}');
  assert.deepEqual(parsed.args, { text: 'hi' });

  const invalid = parseFallbackToolCall('{"tool":"echo","args":"{"}');
  assert.equal(invalid.tool, 'echo');
  assert.deepEqual(invalid.args, {});
  assert.match(invalid.error, /Invalid tool arguments JSON/);
});

test('rejects malformed, tagged-only, and nameless calls', () => {
  assert.equal(parseFallbackToolCall('nothing here'), null);
  assert.equal(parseFallbackToolCall('<tool_call>{"tool":"echo","args":{}}</tool_call>'), null);
  assert.equal(parseFallbackToolCall('{"args":{}}'), null);
  assert.equal(parseFallbackToolCall(undefined), null);
});

test('sanitizes dangerous argument keys without mutating the source', () => {
  const source = JSON.parse('{"text":"hi","__proto__":{"polluted":true},"constructor":"x"}');
  const result = sanitizeArgs(source);

  assert.deepEqual(result, { args: { text: 'hi' } });
  assert.equal({}.polluted, undefined);
});

test('strips JSON fallback calls from display text', () => {
  const fenced = stripFallbackToolCall('Before\n```json\n{"tool":"echo","args":{}}\n```\nAfter');
  assert.match(fenced, /Before/);
  assert.match(fenced, /After/);
  assert.doesNotMatch(fenced, /"tool"/);

  const bare = stripFallbackToolCall('Before {"tool":"echo","args":{}} after');
  assert.match(bare, /Before/);
  assert.match(bare, /after/);
  assert.doesNotMatch(bare, /"tool"/);
});
