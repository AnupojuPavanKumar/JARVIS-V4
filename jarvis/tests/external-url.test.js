'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateExternalUrl } = require('../backend/security/external-url');

test('external URL policy: accepts reviewed http/https links', () => {
  const https = validateExternalUrl('https://docs.example.com/guide?q=1#start');
  assert.equal(https.ok, true);
  assert.equal(https.hostname, 'docs.example.com');
  assert.equal(https.origin, 'https://docs.example.com');
  assert.equal(https.url, 'https://docs.example.com/guide?q=1#start');

  const http = validateExternalUrl('http://example.com/');
  assert.equal(http.ok, true);
  assert.equal(http.origin, 'http://example.com');
});

test('external URL policy: rejects non-http schemes and relative URLs', () => {
  for (const value of [
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'data:text/html,<script>alert(1)</script>',
    'ms-settings:privacy',
    '//example.com/path',
    '/relative/path',
  ]) {
    assert.equal(validateExternalUrl(value).ok, false, value);
  }
});

test('external URL policy: rejects credentials, control characters, and unusual ports', () => {
  for (const value of [
    'https://user:password@example.com/',
    'https://user@example.com/',
    'https://example.com/\r\nLocation: https://evil.example/',
    'https://example.com/\u202Egnp.exe',
    'https://example.com:8443/',
    'https://example.com:22/',
  ]) {
    assert.equal(validateExternalUrl(value).ok, false, value);
  }
});

test('external URL policy: rejects malformed and oversized input', () => {
  assert.equal(validateExternalUrl(null).ok, false);
  assert.equal(validateExternalUrl('').ok, false);
  assert.equal(validateExternalUrl('https://').ok, false);
  assert.equal(validateExternalUrl(`https://example.com/${'a'.repeat(2048)}`).ok, false);
});
