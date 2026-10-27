'use strict';

// Files that must never enter project context, document indexing, or model
// prompts. Names are matched case-insensitively against a normalized relative
// path, so this applies equally to the project scanner and the local document
// index.

const SECRET_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.cer',
  '.jks', '.keystore', '.ppk', '.kdbx',
]);

const SECRET_BASENAMES = [
  /^\.env(?:$|\.)/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.git-credentials$/,
  /^\.pgpass$/,
  /^known_hosts$/,
  /^id_(?:rsa|ed25519|ecdsa|dsa)/,
  /^credentials(?:$|[._-])/,
  /^secrets?(?:$|[._-])/,
  /^wallet\.dat$/,
];

const SECRET_DIRECTORIES = new Set([
  '.aws', '.ssh', '.gnupg', '.azure', '.kube', '.docker',
]);

function normalizeRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .toLowerCase();
}

function isSecretFileName(name) {
  const base = String(name || '').toLowerCase();
  if (!base) return false;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  if (SECRET_EXTENSIONS.has(ext)) return true;
  return SECRET_BASENAMES.some(pattern => pattern.test(base));
}

function isSecretProjectFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(segment => SECRET_DIRECTORIES.has(segment))) return true;
  return isSecretFileName(segments[segments.length - 1] || '');
}

module.exports = {
  SECRET_EXTENSIONS,
  SECRET_DIRECTORIES,
  isSecretFileName,
  isSecretProjectFile,
};
