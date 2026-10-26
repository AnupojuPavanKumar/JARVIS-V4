'use strict';

// One schema for every kind of remembered thing. The durable task store solves
// a different problem (audit/restart), so conversation history and task files
// remain separate stores; this module is the only writable memory-record store.
const crypto = require('crypto');

const MEMORY_SCHEMA_VERSION = 1;
const MEMORY_TYPES = Object.freeze(['fact', 'preference', 'episode', 'procedure', 'relationship']);
const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
const SENSITIVITY_LEVELS = Object.freeze(['public', 'personal', 'secret']);
const SENSITIVITY_SET = new Set(SENSITIVITY_LEVELS);
const MAX_TEXT_LENGTH = 8000;
const MAX_SOURCE_STRING = 160;

const SECRET_RE = /\b(password|passwd|passcode|api[\s_-]*key|access[\s_-]*token|secret|private[\s_-]*key|seed[\s_-]*phrase|credit[\s_-]*card|cvv|cvc|social[\s_-]*security|ssn|bank[\s_-]*account|routing[\s_-]*number)\b/i;
const PERSONAL_RE = /\b(email|e-mail|phone|mobile|address|home address|birthday|date of birth|age|salary|income|medical|health|diagnosis|prescription|passport|driver'?s licence|driver'?s license|location|live in|work at|work for)\b/i;

function hashId(value) {
  return `mem_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function makeMemoryId() {
  return `mem_${crypto.randomBytes(12).toString('hex')}`;
}

function isValidMemoryId(value) {
  return typeof value === 'string' && /^mem_[A-Za-z0-9_]{4,80}$/.test(value);
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function inferType(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(prefer|prefers|favorite|favourite|like|likes|love|loves|hate|hates|dislike|dislikes|rather)\b/.test(value)) return 'preference';
  if (/\b(relationship|partner|wife|husband|friend|mother|father|sister|brother)\b/.test(value)) return 'relationship';
  return 'fact';
}

function classifySensitivity(text) {
  const value = String(text || '');
  if (SECRET_RE.test(value)) return 'secret';
  if (PERSONAL_RE.test(value)) return 'personal';
  return 'public';
}

function toTimestamp(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeSource(source) {
  if (typeof source === 'string' && source.trim()) {
    return { kind: source.trim().slice(0, MAX_SOURCE_STRING) };
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { kind: 'unknown' };
  }

  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (key === 'kind' || key === 'sessionId' || key === 'taskId' || key === 'label') {
      result[key] = String(value).slice(0, MAX_SOURCE_STRING);
    } else if (key === 'migrated' || key === 'tainted' || key === 'scheduled') {
      result[key] = Boolean(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  if (!result.kind) result.kind = 'unknown';
  return result;
}

function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  const values = embedding
    .slice(0, 4096)
    .map(value => (typeof value === 'number' && Number.isFinite(value) ? value : null));
  if (values.some(value => value === null)) return null;
  return values;
}

function normalizeRecord(input, {
  now = Date.now(),
  id = null,
  source = null,
} = {}) {
  const raw = typeof input === 'string' ? { text: input } : (input || {});
  const text = normalizeText(raw.text ?? raw.content ?? raw.fact ?? raw.memory);
  if (!text) throw new Error('Memory text must be a non-empty string');

  const type = MEMORY_TYPE_SET.has(raw.type) ? raw.type : inferType(text);
  const sensitivity = SENSITIVITY_SET.has(raw.sensitivity)
    ? raw.sensitivity
    : classifySensitivity(text);
  const createdAt = toTimestamp(raw.createdAt ?? raw.timestamp, now);
  const updatedAt = toTimestamp(raw.updatedAt, createdAt);
  const lastUsedAt = toTimestamp(raw.lastUsedAt, null);
  const expiresAt = toTimestamp(raw.expiresAt, null);

  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : (source && source.kind === 'manual' ? 1 : 0.7);

  return {
    id: id || (isValidMemoryId(raw.id) ? raw.id : hashId(`${type}:${text}:${createdAt}`)),
    type,
    text,
    embedding: normalizeEmbedding(raw.embedding),
    source: normalizeSource(source || raw.source || { kind: 'unknown' }),
    confidence,
    sensitivity,
    createdAt,
    updatedAt,
    lastUsedAt,
    expiresAt,
    disabled: raw.disabled === true,
    ...(raw.verification && typeof raw.verification === 'object' && !Array.isArray(raw.verification)
      ? {
          verification: {
            status: raw.verification.status === 'verified' ? 'verified' : 'unverified',
            method: raw.verification.method ? String(raw.verification.method).slice(0, 120) : null,
            taskId: raw.verification.taskId ? String(raw.verification.taskId).slice(0, 120) : null,
            verifiedAt: toTimestamp(raw.verification.verifiedAt, null),
          },
        }
      : {}),
  };
}

function isExpired(record, at = Date.now()) {
  return Number.isFinite(record.expiresAt) && record.expiresAt <= at;
}

function isManual(record) {
  return Boolean(record && record.source && record.source.kind === 'manual');
}

function isSemantic(record) {
  return Boolean(record && record.source && ['conversation', 'task', 'migration'].includes(record.source.kind));
}

module.exports = {
  MEMORY_SCHEMA_VERSION,
  MEMORY_TYPES,
  MEMORY_TYPE_SET,
  SENSITIVITY_LEVELS,
  SENSITIVITY_SET,
  MAX_TEXT_LENGTH,
  SECRET_RE,
  PERSONAL_RE,
  hashId,
  makeMemoryId,
  isValidMemoryId,
  normalizeText,
  inferType,
  classifySensitivity,
  toTimestamp,
  normalizeSource,
  normalizeEmbedding,
  normalizeRecord,
  isExpired,
  isManual,
  isSemantic,
};
