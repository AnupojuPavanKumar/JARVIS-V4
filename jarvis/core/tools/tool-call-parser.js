'use strict';

const TOOL_TAG_RE = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi;
const RAW_TOOL_RE = /\{\s*"tool"\s*:/g;
const DANGEROUS_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeArgs(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return { args: {}, error: `Invalid tool arguments JSON: ${error.message}` };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { args: {}, error: 'Tool arguments must be an object' };
  }

  const args = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_ARG_KEYS.has(key)) continue;
    args[key] = entry;
  }
  return { args };
}

function normalizeParsedTool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = value.tool ?? value.name;
  if (typeof name !== 'string' || !name.trim()) return null;

  const sanitized = sanitizeArgs(value.args ?? value.arguments);
  return {
    tool: name.trim(),
    args: sanitized.args,
    ...(sanitized.error ? { error: sanitized.error } : {}),
  };
}

function isExampleMention(text, index) {
  const before = text.slice(0, index).trim().toLowerCase();
  return before.endsWith('example:') || before.includes('example:\n') || before.includes('command should be:');
}

// Find a balanced JSON object starting at `start`. String and escape handling
// prevents braces inside tool arguments from ending the object early.
function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function parseToolCall(text) {
  if (typeof text !== 'string' || !text) return null;

  const matches = [...text.matchAll(TOOL_TAG_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (isExampleMention(text, match.index)) continue;

    try {
      const parsed = normalizeParsedTool(JSON.parse(match[1].trim()));
      if (parsed) return parsed;
    } catch { /* try the next match */ }
  }

  const rawMatches = [...text.matchAll(RAW_TOOL_RE)];
  for (let index = rawMatches.length - 1; index >= 0; index -= 1) {
    const start = rawMatches[index].index;
    if (isExampleMention(text, start)) continue;

    const end = findJsonObjectEnd(text, start);
    if (end === -1) continue;

    try {
      const parsed = normalizeParsedTool(JSON.parse(text.slice(start, end + 1)));
      if (parsed) return parsed;
    } catch { /* try the next match */ }
  }

  return null;
}

// Remove tool-call blocks and raw tool JSON from display text while preserving
// the surrounding assistant prose.
function stripToolCalls(text) {
  if (typeof text !== 'string' || !text) return '';

  let clean = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```json\s*\{[\s\S]*?"tool"[\s\S]*?```/gi, '');

  while (true) {
    RAW_TOOL_RE.lastIndex = 0;
    const match = RAW_TOOL_RE.exec(clean);
    if (!match) break;

    const start = match.index;
    const end = findJsonObjectEnd(clean, start);
    if (end === -1) break;

    clean = `${clean.slice(0, start)}${clean.slice(end + 1)}`;
  }

  return clean.trim();
}

module.exports = {
  parseToolCall,
  stripToolCalls,
  sanitizeArgs,
  findJsonObjectEnd,
};
