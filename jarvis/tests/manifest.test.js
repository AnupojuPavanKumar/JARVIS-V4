'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadVerifiedSkillsManifest,
  verifyManifestSignature,
} = require('../core/skills/manifest');

function makeSignedSkillsDir(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-manifest-test-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifestRaw = JSON.stringify(manifest);
  const signature = crypto.sign(null, Buffer.from(manifestRaw), privateKey);

  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestRaw);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), signature);

  return { dir, publicPem, manifestRaw };
}

test('loads a correctly signed manifest', async () => {
  const manifest = {
    version: '1.0',
    skills: [{ id: 'echo', script: 'echo.js', type: 'js', risk: 'read', params: {} }],
  };
  const { dir, publicPem } = makeSignedSkillsDir(manifest);
  try {
    const result = await loadVerifiedSkillsManifest({
      skillsDir: dir,
      publicKeyPem: publicPem,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.skills, manifest.skills);
    assert.equal(result.manifestRaw, JSON.stringify(manifest));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a tampered manifest, missing signature, and bad key', async () => {
  const manifest = { version: '1.0', skills: [] };
  const { dir, publicPem, manifestRaw } = makeSignedSkillsDir(manifest);
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${manifestRaw} `);
    const tampered = await loadVerifiedSkillsManifest({ skillsDir: dir, publicKeyPem: publicPem });
    assert.equal(tampered.ok, false);
    assert.match(tampered.error, /signature invalid/);

    fs.writeFileSync(path.join(dir, 'manifest.json'), manifestRaw);

    const badKey = await loadVerifiedSkillsManifest({
      skillsDir: dir,
      publicKeyPem: 'not a key',
    });
    assert.equal(badKey.ok, false);
    assert.match(badKey.error, /signature invalid/);

    fs.rmSync(path.join(dir, 'manifest.sig'));
    const unsigned = await loadVerifiedSkillsManifest({ skillsDir: dir, publicKeyPem: publicPem });
    assert.equal(unsigned.ok, false);
    assert.match(unsigned.error, /no signature file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns an empty catalog when no manifest exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-manifest-empty-'));
  try {
    const result = await loadVerifiedSkillsManifest({ skillsDir: dir });
    assert.deepEqual(result, { ok: true, skills: [], manifestRaw: '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifies the repository manifest with the embedded public key', async () => {
  const skillsDir = path.join(__dirname, '..', 'skills');
  const result = await loadVerifiedSkillsManifest({ skillsDir });
  assert.equal(result.ok, true);
  assert.equal(result.skills.length >= 20, true);
  assert.equal(verifyManifestSignature(result.manifestRaw, fs.readFileSync(path.join(skillsDir, 'manifest.sig'))).ok, true);
});
