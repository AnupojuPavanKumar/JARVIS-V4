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

// Drop only the skills whose script bytes no longer match the signed hash.
// A missing hash is allowed for backward compatibility; a present hash that
// cannot be verified excludes that single entry, never the whole manifest.
function filterSkillsByScriptHash(skills, skillsDir, { log = console.warn } = {}) {
  const allowed = [];
  const excluded = [];

  let realSkillsDir = null;
  try {
    realSkillsDir = fs.realpathSync(skillsDir);
  } catch {
    realSkillsDir = null;
  }

  function exclude(id, detail) {
    const reason = `Skill '${id}' excluded: ${detail}.`;
    excluded.push({ id, reason });
    if (typeof log === 'function') log(reason);
  }

  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill !== 'object') {
      allowed.push(skill);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(skill, 'scriptHash')) {
      allowed.push(skill);
      continue;
    }

    const id = typeof skill.id === 'string' && skill.id ? skill.id : '(unknown id)';

    if (typeof skill.scriptHash !== 'string' || !skill.scriptHash) {
      exclude(id, 'invalid scriptHash');
      continue;
    }
    if (typeof skill.script !== 'string' || !skill.script) {
      exclude(id, 'scriptHash present but script path missing');
      continue;
    }
    if (!realSkillsDir) {
      exclude(id, 'skills directory could not be resolved');
      continue;
    }

    let scriptPath;
    try {
      scriptPath = fs.realpathSync(path.resolve(realSkillsDir, skill.script));
    } catch {
      exclude(id, `script file missing (${skill.script}) — re-run sign-skills.js or restore the file`);
      continue;
    }

    const relative = path.relative(realSkillsDir, scriptPath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      exclude(id, `script path escapes skills directory (${skill.script})`);
      continue;
    }

    let actualHash;
    try {
      actualHash = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
    } catch {
      exclude(id, `script file could not be read (${skill.script})`);
      continue;
    }

    if (actualHash !== skill.scriptHash) {
      exclude(id, 'script hash mismatch — re-run sign-skills.js or script may have been tampered with');
      continue;
    }

    allowed.push(skill);
  }

  return { skills: allowed, excluded };
}

async function loadVerifiedSkillsManifest({
  skillsDir,
  publicKeyPem = SKILLS_PUBLIC_KEY_PEM,
  log = console.warn,
} = {}) {
  if (typeof skillsDir !== 'string' || !skillsDir.trim()) {
    throw new Error('loadVerifiedSkillsManifest requires skillsDir');
  }

  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: true, skills: [], excluded: [], manifestRaw: '' };
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
  const filtered = filterSkillsByScriptHash(
    Array.isArray(manifest.skills) ? manifest.skills : [],
    skillsDir,
    { log }
  );
  return {
    ok: true,
    skills: filtered.skills,
    excluded: filtered.excluded,
    manifestRaw,
  };
}

module.exports = {
  SKILLS_PUBLIC_KEY_PEM,
  createPublicKey,
  verifyManifestSignature,
  filterSkillsByScriptHash,
  loadVerifiedSkillsManifest,
};
