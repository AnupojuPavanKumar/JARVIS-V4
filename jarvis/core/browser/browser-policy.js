'use strict';

// Browser navigation and subresource policy. This module is deliberately free
// of Electron dependencies so the URL boundary can be unit-tested without a
// running browser.

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://127.0.0.1',
  'http://localhost',
  'http://[::1]',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}

function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  return LOOPBACK_HOSTS.has(host);
}

function parseHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'A URL is required' };
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https URLs are allowed' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed' };
  }

  return { ok: true, url };
}

function parseOrigin(value) {
  const parsed = parseHttpUrl(value);
  return parsed.ok ? parsed.url.origin : null;
}

function parseAllowedOrigins(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);

  for (const entry of values) {
    const origin = parseOrigin(entry);
    if (origin) origins.add(origin);
  }

  return Object.freeze([...origins]);
}

function hasLoopbackOrigin(allowedOrigins) {
  return allowedOrigins.some(origin => {
    try {
      return isLoopbackHost(new URL(origin).hostname);
    } catch {
      return false;
    }
  });
}

function isNavigationAllowed(rawUrl, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed.ok) return parsed;

  const origins = Array.isArray(allowedOrigins) && allowedOrigins.length > 0
    ? allowedOrigins
    : DEFAULT_ALLOWED_ORIGINS;
  const url = parsed.url;

  // Loopback origins are port-agnostic so local fixtures can bind an ephemeral
  // port, but only when the allowlist actually contains a loopback origin.
  if (isLoopbackHost(url.hostname)) {
    if (!hasLoopbackOrigin(origins)) {
      return { ok: false, error: 'Loopback navigation is not allowed' };
    }
    return { ok: true, url: url.href, origin: url.origin };
  }

  if (!origins.includes(url.origin)) {
    return { ok: false, error: `Origin is not allowlisted: ${url.origin}` };
  }

  return { ok: true, url: url.href, origin: url.origin };
}

function isSubresourceAllowed(rawUrl, { pageUrl = null, allowedOrigins = DEFAULT_ALLOWED_ORIGINS } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return { ok: false, error: 'A resource URL is required' };
  }

  const lowered = rawUrl.toLowerCase();
  if (lowered.startsWith('data:') || lowered.startsWith('blob:') || lowered === 'about:blank') {
    return { ok: true, url: rawUrl, origin: null };
  }

  const parsed = parseHttpUrl(rawUrl);
  if (!parsed.ok) return parsed;
  const page = parseHttpUrl(pageUrl);
  if (!page.ok) {
    return { ok: false, error: 'The page origin is not known yet' };
  }

  const url = parsed.url;
  const pageOrigin = page.url;

  // A local fixture may use another local port for its assets. An external
  // page may never reach loopback services, which prevents a remote page from
  // probing or sending requests to the user's local machine.
  if (isLoopbackHost(pageOrigin.hostname) && isLoopbackHost(url.hostname)) {
    return { ok: true, url: url.href, origin: url.origin };
  }

  if (url.origin === pageOrigin.origin) {
    return { ok: true, url: url.href, origin: url.origin };
  }

  return { ok: false, error: `Cross-origin request blocked: ${url.origin}` };
}

function sanitizeUrlForAudit(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  const lowered = rawUrl.toLowerCase();
  if (lowered.startsWith('data:')) return 'data:';
  if (lowered.startsWith('blob:')) return 'blob:';

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return url.protocol.slice(0, 40);
    }
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return String(rawUrl).slice(0, 120);
  }
}

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  isLoopbackHost,
  parseAllowedOrigins,
  isNavigationAllowed,
  isSubresourceAllowed,
  sanitizeUrlForAudit,
};
