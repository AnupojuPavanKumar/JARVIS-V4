'use strict';

// Main-process policy for links opened outside JARVIS.
//
// The renderer's action registry already restricts link clicks, but a
// compromised renderer must not be able to turn open-external into an
// arbitrary protocol launcher. Keep the validation here so every main-process
// external-open path can share the same rules.

const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set(['', '80', '443']);
// Control, zero-width, and bidi override characters are never valid in a URL
// displayed to the user or passed to the operating system.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

function reject(error) {
  return { ok: false, error };
}

function validateExternalUrl(value) {
  if (typeof value !== 'string') return reject('URL must be a string');
  const raw = value.trim();
  if (!raw) return reject('URL is empty');
  if (raw.length > MAX_URL_LENGTH) return reject('URL is too long');
  if (UNSAFE_CHARACTERS.test(raw)) return reject('URL contains unsafe characters');
  if (raw.startsWith('//')) return reject('URL must include an explicit scheme');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return reject('URL is not valid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject('Only http and https links may be opened');
  }
  if (parsed.username || parsed.password) {
    return reject('URLs with embedded credentials are not allowed');
  }
  if (!parsed.hostname || parsed.hostname.length > 253) {
    return reject('URL hostname is invalid');
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return reject('URL uses an unsupported port');
  }

  const hostname = parsed.hostname.toLowerCase();
  return {
    ok: true,
    url: parsed.href,
    origin: parsed.origin,
    hostname,
  };
}

module.exports = { validateExternalUrl, MAX_URL_LENGTH };
