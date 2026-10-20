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

function makeSignedSkillsDir(manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-manifest-test-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifestRaw = JSON.stringify(manifest);
  const signature = crypto.sign(null, Buffer.from(manifestRaw), privateKey);

  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestRaw);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), signature);

  return { dir, publicPem, manifestRaw };
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
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

test('loads skills with matching script hashes and leaves unhashed skills alone', async () => {
  const script = "console.log(JSON.stringify({ ok: true }));\n";
  const manifest = {
    version: '1.0',
    skills: [
      { id: 'hashed', script: 'hashed.js', scriptHash: sha256(script), type: 'js', risk: 'read', params: {} },
      { id: 'legacy', script: 'missing.js', type: 'js', risk: 'read', params: {} },
    ],
  };
  const { dir, publicPem } = makeSignedSkillsDir(manifest, { 'hashed.js': script });
  const warnings = [];
  try {
    const result = await loadVerifiedSkillsManifest({
      skillsDir: dir,
      publicKeyPem: publicPem,
      log: message => warnings.push(message),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.skills.map(skill => skill.id), ['hashed', 'legacy']);
    assert.deepEqual(result.excluded, []);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('excludes only the skill whose script hash no longer matches', async () => {
  const goodScript = 'console.log("good");\n';
  const badScript = 'console.log("original");\n';
  const manifest = {
    version: '1.0',
    skills: [
      { id: 'good', script: 'good.js', scriptHash: sha256(goodScript), type: 'js', risk: 'read', params: {} },
      { id: 'bad', script: 'bad.js', scriptHash: sha256(badScript), type: 'js', risk: 'read', params: {} },
    ],
  };
  const { dir, publicPem } = makeSignedSkillsDir(manifest, {
    'good.js': goodScript,
    'bad.js': badScript,
  });
  const warnings = [];
  try {
    fs.writeFileSync(path.join(dir, 'bad.js'), 'console.log("tampered");\n');

    const result = await loadVerifiedSkillsManifest({
      skillsDir: dir,
      publicKeyPem: publicPem,
      log: message => warnings.push(message),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.skills.map(skill => skill.id), ['good']);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].id, 'bad');
    assert.match(result.excluded[0].reason, /Skill 'bad' excluded: script hash mismatch/);
    assert.match(result.excluded[0].reason, /tampered/);
    assert.deepEqual(warnings, [result.excluded[0].reason]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('excludes a hashed skill whose script file is missing', async () => {
  const manifest = {
    version: '1.0',
    skills: [
      { id: 'apply_patch', script: 'apply_patch.js', scriptHash: sha256('missing'), type: 'js', risk: 'write', params: {} },
    ],
  };
  const { dir, publicPem } = makeSignedSkillsDir(manifest);
  try {
    const result = await loadVerifiedSkillsManifest({
      skillsDir: dir,
      publicKeyPem: publicPem,
      log: () => {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.skills, []);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].id, 'apply_patch');
    assert.match(result.excluded[0].reason, /script file missing/);
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
    assert.deepEqual(result, { ok: true, skills: [], excluded: [], manifestRaw: '' });
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
