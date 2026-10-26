'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ALLOWED_ORIGINS,
  parseAllowedOrigins,
  isNavigationAllowed,
  isSubresourceAllowed,
  sanitizeUrlForAudit,
} = require('../core/browser/browser-policy');

test('browser allowlist includes loopback defaults and configured origins', () => {
  const origins = parseAllowedOrigins('https://example.com, http://127.0.0.1:3000, not-a-url');
  for (const origin of DEFAULT_ALLOWED_ORIGINS) {
    assert.ok(origins.includes(origin), `${origin} should remain allowed`);
  }
  assert.ok(origins.includes('https://example.com'));
  assert.ok(origins.includes('http://127.0.0.1:3000'));
  assert.ok(!origins.includes('not-a-url'));
});

test('loopback navigation is port-agnostic for local fixtures', () => {
  const origins = parseAllowedOrigins('');
  assert.equal(isNavigationAllowed('http://127.0.0.1:43210/index.html', origins).ok, true);
  assert.equal(isNavigationAllowed('http://localhost:8080/test', origins).ok, true);
  assert.equal(isNavigationAllowed('http://[::1]:9999/test', origins).ok, true);
});

test('external navigation requires an exact allowlisted origin', () => {
  const origins = parseAllowedOrigins('https://example.com');
  assert.equal(isNavigationAllowed('https://example.com/a?token=secret#frag', origins).ok, true);
  assert.equal(isNavigationAllowed('https://sub.example.com/a', origins).ok, false);
  assert.equal(isNavigationAllowed('https://example.org/a', origins).ok, false);
});

test('unsafe URL schemes, credentials, and lookalike hosts are rejected', () => {
  const origins = parseAllowedOrigins('https://example.com');
  assert.equal(isNavigationAllowed('javascript:alert(1)', origins).ok, false);
  assert.equal(isNavigationAllowed('file:///C:/Windows/win.ini', origins).ok, false);
  assert.equal(isNavigationAllowed('https://user:pass@example.com/', origins).ok, false);
  assert.equal(isNavigationAllowed('http://127.0.0.1.evil.com/', origins).ok, false);
  assert.equal(isNavigationAllowed('not a url', origins).ok, false);
});

test('subresources stay on the page origin and cannot reach loopback from the web', () => {
  const origins = parseAllowedOrigins('https://example.com');
  const externalPage = 'https://example.com/app';

  assert.equal(isSubresourceAllowed('https://example.com/app.js', {
    pageUrl: externalPage,
    allowedOrigins: origins,
  }).ok, true);
  assert.equal(isSubresourceAllowed('https://cdn.example.net/app.js', {
    pageUrl: externalPage,
    allowedOrigins: origins,
  }).ok, false);
  assert.equal(isSubresourceAllowed('http://127.0.0.1:11434/api/tags', {
    pageUrl: externalPage,
    allowedOrigins: origins,
  }).ok, false);

  assert.equal(isSubresourceAllowed('http://127.0.0.1:5000/style.css', {
    pageUrl: 'http://127.0.0.1:43210/index.html',
    allowedOrigins: origins,
  }).ok, true);
  assert.equal(isSubresourceAllowed('data:image/png;base64,AA==', {
    pageUrl: externalPage,
    allowedOrigins: origins,
  }).ok, true);
  assert.equal(isSubresourceAllowed('blob:https://example.com/123', {
    pageUrl: externalPage,
    allowedOrigins: origins,
  }).ok, true);
});

test('audit URLs drop credentials, query strings, and fragments', () => {
  assert.equal(
    sanitizeUrlForAudit('https://user:pass@example.com/private/path?token=secret#fragment'),
    'https://example.com/private/path'
  );
  assert.equal(sanitizeUrlForAudit('data:text/html,secret'), 'data:');
  assert.equal(sanitizeUrlForAudit('javascript:alert(1)'), 'javascript:');
});
