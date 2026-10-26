'use strict';

// Small, dependency-free JSON extraction used by the tool-call fallback,
// planner, and verifier. It deliberately understands only JSON (including
// fenced JSON blocks), never executable code or template tags.

function findBalancedObjectEnd(text, start) {
  if (typeof text !== 'string' || text[start] !== '{') return -1;

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

// Return candidate JSON objects from last to first. This lets callers prefer
// the model's final decision when it has echoed an example earlier in the text.
function findJsonObjects(text) {
  if (typeof text !== 'string' || !text) return [];

  const objects = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    const end = findBalancedObjectEnd(text, index);
    if (end === -1) continue;

    const raw = text.slice(index, end + 1);
    try {
      objects.push({ start: index, end: end + 1, raw, value: JSON.parse(raw) });
    } catch { /* not valid JSON; keep scanning */ }
    index = end;
  }

  return objects.reverse();
}

function parseJsonValue(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const candidates = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    candidates.push(match[1]);
  }

  candidates.push(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch { /* try object scan */ }

    for (const object of findJsonObjects(candidate)) {
      return object.value;
    }
  }

  return null;
}

module.exports = {
  findBalancedObjectEnd,
  findJsonObjects,
  parseJsonValue,
};
