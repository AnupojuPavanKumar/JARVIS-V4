'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Public half of the Ed25519 key used by sign-skills.js. The private key stays
// outside the repository; only this public key is needed to verify the manifest.
const SKILLS_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADeCN7rDcMvMG0eMeWcEs6HGhpa24JSSDiycp4ne0YiE=
-----END PUBLIC KEY-----`;

function createPublicKey(publicKeyPem = SKILLS_PUBLIC_KEY_PEM) {
  try {
    return crypto.createPublicKey(publicKeyPem);
  } catch {
    return null;
  }
}

function verifyManifestSignature(manifestRaw, sigRaw, publicKeyPem = SKILLS_PUBLIC_KEY_PEM) {
  const key = createPublicKey(publicKeyPem);
  if (!key) return { ok: false, reason: 'public-key unavailable' };

  try {
    const ok = crypto.verify(null, Buffer.from(manifestRaw), key, Buffer.from(sigRaw));
    return { ok, ...(ok ? {} : { reason: 'signature mismatch' }) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function loadVerifiedSkillsManifest({
  skillsDir,
  publicKeyPem = SKILLS_PUBLIC_KEY_PEM,
} = {}) {
  if (typeof skillsDir !== 'string' || !skillsDir.trim()) {
    throw new Error('loadVerifiedSkillsManifest requires skillsDir');
  }

  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: true, skills: [], manifestRaw: '' };
  }

  const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
  const sigPath = path.join(skillsDir, 'manifest.sig');
  if (!fs.existsSync(sigPath)) {
    return {
      ok: false,
      error: 'Skills manifest has no signature file (manifest.sig). Refusing to load skills.',
    };
  }

  const sigRaw = await fs.promises.readFile(sigPath);
  const verification = verifyManifestSignature(manifestRaw, sigRaw, publicKeyPem);
  if (!verification.ok) {
    return {
      ok: false,
      error: 'Skills manifest signature invalid. Refusing to load skills.',
    };
  }

  const manifest = JSON.parse(manifestRaw);
  return {
    ok: true,
    skills: Array.isArray(manifest.skills) ? manifest.skills : [],
    manifestRaw,
  };
}

module.exports = {
  SKILLS_PUBLIC_KEY_PEM,
  createPublicKey,
  verifyManifestSignature,
  loadVerifiedSkillsManifest,
};
