'use strict';

const { findJsonObjects, parseJsonValue } = require('../util/json-extract');

const DANGEROUS_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeArgs(value) {
  if (value === undefined || value === null) return { args: {} };
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      return { args: {}, error: `Invalid tool arguments JSON: ${error.message}` };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { args: {}, error: 'Tool arguments must be an object' };
  }

  const args = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (DANGEROUS_ARG_KEYS.has(key)) continue;
    args[key] = entry;
  }
  return { args };
}

function normalizeFallbackCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = value.tool ?? value.name;
  if (typeof name !== 'string' || !name.trim()) return null;

  const sanitized = sanitizeArgs(value.args ?? value.arguments);
  return {
    tool: name.trim(),
    args: sanitized.args,
    native: false,
    ...(sanitized.error ? { error: sanitized.error } : {}),
  };
}

function isToolJson(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (typeof value.tool === 'string' || typeof value.name === 'string'));
}

function looksLikeExample(text, start) {
  const prefix = text.slice(Math.max(0, start - 160), start);
  return /\b(example|e\.g\.|for instance|sample|schema)\b/i.test(prefix);
}

function parseFallbackToolCall(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // The fallback contract is one JSON object with no XML tags. A fenced block
  // is tolerated because local models frequently wrap JSON in markdown.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    if (looksLikeExample(text, fences[index].index)) continue;
    try {
      const value = JSON.parse(fences[index][1].trim());
      const call = normalizeFallbackCall(value);
      if (call) return call;
    } catch { /* try the next candidate */ }
  }

  // Bare JSON is accepted only when it is the whole response. This prevents a
  // tool schema or a prompt-injected example in prose from being executed.
  try {
    const value = JSON.parse(text.trim());
    const call = normalizeFallbackCall(value);
    if (call) return call;
  } catch { /* not a single bare JSON object */ }

  return null;
}

function stripFallbackToolCall(text) {
  if (typeof text !== 'string' || !text) return '';

  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    try {
      if (isToolJson(JSON.parse(fences[index][1].trim()))) {
        return `${text.slice(0, fences[index].index)}${text.slice(fences[index].index + fences[index][0].length)}`.trim();
      }
    } catch { /* not a tool block */ }
  }

  for (const object of findJsonObjects(text)) {
    if (!isToolJson(object.value)) continue;
    return `${text.slice(0, object.start)}${text.slice(object.end)}`.trim();
  }

  return text.trim();
}

function parseJsonResponse(text) {
  return parseJsonValue(text);
}

module.exports = {
  DANGEROUS_ARG_KEYS,
  sanitizeArgs,
  normalizeFallbackCall,
  parseFallbackToolCall,
  stripFallbackToolCall,
  parseJsonResponse,
};
