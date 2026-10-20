'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseToolCall,
  stripToolCalls,
  sanitizeArgs,
} = require('../core/tools/tool-call-parser');

test('parses tagged tool calls and the last valid call wins', () => {
  const text = `I will check.
<tool_call>
{"tool": "get_datetime", "args": {}}
</tool_call>
Actually, use this one:
<tool_call>
{"tool": "weather", "args": {"location": "London"}}
</tool_call>`;

  assert.deepEqual(parseToolCall(text), {
    tool: 'weather',
    args: { location: 'London' },
  });
});

test('parses raw JSON tool calls and ignores example mentions', () => {
  assert.deepEqual(
    parseToolCall('Use {"tool":"calculator","args":{"expression":"2+2"}} now'),
    { tool: 'calculator', args: { expression: '2+2' } }
  );

  assert.equal(
    parseToolCall('For example:\n<tool_call>{"tool":"weather","args":{}}</tool_call>'),
    null
  );
});

test('parses string arguments and reports invalid JSON', () => {
  assert.deepEqual(
    parseToolCall('<tool_call>{"tool":"echo","args":"{\\"text\\":\\"hi\\"}"}</tool_call>'),
    { tool: 'echo', args: { text: 'hi' } }
  );

  const invalid = parseToolCall('<tool_call>{"tool":"echo","args":"{"}</tool_call>');
  assert.equal(invalid.tool, 'echo');
  assert.deepEqual(invalid.args, {});
  assert.match(invalid.error, /Invalid tool arguments JSON/);
});

test('rejects malformed and nameless tool calls', () => {
  assert.equal(parseToolCall('nothing here'), null);
  assert.equal(parseToolCall('<tool_call>{"args":{}}</tool_call>'), null);
  assert.equal(parseToolCall('<tool_call>not-json</tool_call>'), null);
  assert.equal(parseToolCall(undefined), null);
});

test('sanitizes dangerous argument keys without mutating the source', () => {
  const source = JSON.parse('{"text":"hi","__proto__":{"polluted":true},"constructor":"x"}');
  const result = sanitizeArgs(source);

  assert.deepEqual(result, { args: { text: 'hi' } });
  assert.equal({}.polluted, undefined);
});

test('strips tagged and raw tool calls from display text', () => {
  const text = `Before
<tool_call>
{"tool":"weather","args":{"location":"London"}}
</tool_call>
After {"tool":"calculator","args":{"expression":"2+2"}} done`;

  const stripped = stripToolCalls(text);
  assert.match(stripped, /Before/);
  assert.match(stripped, /After/);
  assert.match(stripped, /done/);
  assert.doesNotMatch(stripped, /tool_call/);
  assert.doesNotMatch(stripped, /calculator/);
});
