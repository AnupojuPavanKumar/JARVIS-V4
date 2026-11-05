'use strict';

/**
 * Bounded, best-effort redaction for the security audit trail.
 *
 * This is a safety net, not a data-loss-prevention boundary. Callers must still
 * avoid passing secrets, PINs, audio buffers, embeddings, or file contents into
 * audit details. Redaction happens before an entry reaches the in-memory ring,
 * the console, or the encrypted durable store.
 */

const os = require('os');

const LIMITS = Object.freeze({
  action: 80,
  detail: 500,
  verdict: 40,
});

const AUTH_ACTIONS = new Set([
  'AUTH_VERIFY',
  'AUTH_SETUP_PIN',
  'AUTH_CHANGE_PIN',
  'AUTH_SKIP',
  'AUTH_RECOVER_RESET',
  'AUTH_RATE_LIMIT',
]);

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SECRET_ASSIGNMENT_RE = /\b(password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AUTHORIZATION_RE = /\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_USERINFO_RE = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const URL_SECRET_QUERY_RE = /([?&](?:token|key|secret|password|api[_-]?key|apikey|access[_-]?token)=)([^&\s#]+)/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createAuditRedactor({
  homeDir = os.homedir(),
  userDataPath = null,
} = {}) {
  const pathReplacements = [];

  function addPathReplacement(value, label) {
    if (typeof value !== 'string' || !value.trim()) return;
    const variants = new Set([
      value,
      value.replace(/\\/g, '/'),
      value.replace(/\//g, '\\'),
    ]);
    for (const variant of variants) {
      if (!variant) continue;
      pathReplacements.push({
        pattern: new RegExp(escapeRegExp(variant), 'gi'),
        label,
      });
    }
  }

  // Replace the longer, more specific userData path first so the home-directory
  // replacement cannot consume its prefix.
  addPathReplacement(userDataPath, '%APPDATA%\\jarvis-ai-os');
  addPathReplacement(homeDir, '%USERPROFILE%');

  function redact(value, action = '') {
    let text = value == null ? '' : String(value);
    text = text.replace(CONTROL_CHARS_RE, '');
    text = text.replace(/\r?\n/g, ' | ');

    if (AUTH_ACTIONS.has(String(action).toUpperCase())) {
      text = text.replace(/\b\d{4}\b/g, '****');
    }

    text = text.replace(AUTHORIZATION_RE, '$1=[redacted]');
    text = text.replace(BEARER_RE, 'Bearer [redacted]');
    text = text.replace(SECRET_ASSIGNMENT_RE, (_match, key) => `${key}=[redacted]`);
    text = text.replace(URL_USERINFO_RE, '$1[redacted]@');
    text = text.replace(URL_SECRET_QUERY_RE, '$1[redacted]');

    for (const replacement of pathReplacements) {
      text = text.replace(replacement.pattern, () => replacement.label);
    }

    return text;
  }

  function sanitizeAuditEntry(action, detail, verdict) {
    const boundedAction = redact(action).trim().slice(0, LIMITS.action) || 'UNKNOWN';
    const boundedDetail = redact(detail, boundedAction).slice(0, LIMITS.detail);
    const boundedVerdict = redact(verdict).trim().slice(0, LIMITS.verdict) || 'UNKNOWN';
    return Object.freeze({
      action: boundedAction,
      detail: boundedDetail,
      verdict: boundedVerdict,
    });
  }

  return Object.freeze({
    sanitizeAuditEntry,
    redact,
  });
}

module.exports = {
  LIMITS,
  createAuditRedactor,
};
