'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appAssetPath } = require('../asar-paths');

const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UNAVAILABLE_PREFIX = 'Local transcription is unavailable';

function unavailable(detail) {
  return `${UNAVAILABLE_PREFIX}: ${detail}`;
}

function normalizedRelative(value) {
  return String(value || '').replace(/\\/g, '/');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return 'the asset manifest is missing';
  }
  const root = normalizedRelative(manifest.root).replace(/\/+$/, '');
  if (!root || root.startsWith('/') || root.split('/').includes('..')) {
    return 'the asset manifest root is invalid';
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return 'the asset manifest has no files';
  }

  const roles = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object') return 'an asset entry is invalid';
    if (!ROLE_RE.test(entry.role)) return `asset role "${entry.role}" is invalid`;
    if (roles.has(entry.role)) return `asset role "${entry.role}" is duplicated`;
    roles.add(entry.role);

    const relative = normalizedRelative(entry.relativePath);
    if (
      !relative
      || relative.startsWith('/')
      || relative.split('/').includes('..')
      || !relative.startsWith(root + '/')
    ) {
      return `asset path for "${entry.role}" must stay under ${root}`;
    }
    if (!SHA256_RE.test(entry.sha256)) {
      return `asset hash for "${entry.role}" is invalid`;
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      return `asset size for "${entry.role}" is invalid`;
    }
  }

  for (const required of ['executable', 'model']) {
    if (!roles.has(required)) return `the asset manifest is missing the ${required} role`;
  }

  return null;
}

function hashFile(filePath, fsImpl, cryptoImpl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, digest) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(digest);
    };

    let stream;
    try {
      stream = fsImpl.createReadStream(filePath);
    } catch (error) {
      finish(error);
      return;
    }

    const hash = cryptoImpl.createHash('sha256');
    stream.on('error', error => finish(error));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => finish(null, hash.digest('hex')));
  });
}

/**
 * Verify the native Whisper runtime before it is exposed to voice requests.
 *
 * The manifest pins the exact byte size and SHA-256 of every executable, DLL,
 * and model we ship. A missing, truncated, or modified file disables local
 * transcription only; the rest of JARVIS keeps running. Verification is async
 * so hashing a large model never blocks the Electron main thread.
 */
async function verifyWhisperAssets({
  appPath,
  manifest,
  fsImpl = fs,
  cryptoImpl = crypto,
} = {}) {
  const manifestError = validateManifest(manifest);
  if (manifestError) {
    return { ok: false, error: unavailable(manifestError) };
  }

  const root = normalizedRelative(manifest.root).replace(/\/+$/, '');
  const rootPath = appAssetPath(appPath, ...root.split('/'));
  if (!rootPath) {
    return { ok: false, error: unavailable('the app path is unknown') };
  }

  const paths = { root: rootPath };
  for (const entry of manifest.files) {
    const relative = normalizedRelative(entry.relativePath);
    const resolved = appAssetPath(appPath, ...relative.split('/'));
    if (!resolved) {
      return { ok: false, error: unavailable(`cannot resolve ${relative}`) };
    }
    paths[entry.role] = resolved;

    let stat;
    try {
      stat = fsImpl.statSync(resolved);
    } catch (_) {
      return { ok: false, error: unavailable(`${relative} is missing`) };
    }
    if (!stat.isFile()) {
      return { ok: false, error: unavailable(`${relative} is not a file`) };
    }
    if (stat.size !== entry.bytes) {
      return { ok: false, error: unavailable(`${relative} has an unexpected size`) };
    }

    let digest;
    try {
      digest = await hashFile(resolved, fsImpl, cryptoImpl);
    } catch (_) {
      return { ok: false, error: unavailable(`${relative} could not be read`) };
    }
    if (digest !== entry.sha256) {
      return { ok: false, error: unavailable(`${relative} failed integrity verification`) };
    }
  }

  return { ok: true, paths: Object.freeze(paths) };
}

module.exports = {
  ROLE_RE,
  UNAVAILABLE_PREFIX,
  unavailable,
  validateManifest,
  hashFile,
  verifyWhisperAssets,
};
