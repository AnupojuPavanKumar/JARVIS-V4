'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FaceProfileStore,
  PROFILE_FILE,
  DEFAULT_THRESHOLD,
  cosineSimilarity,
  validateEmbedding,
  validateEmbeddings,
} = require('../backend/face/face-profile-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-face-store-test-'));
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: buffer => {
      const raw = buffer.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext');
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

function vector(first = 1, length = 128) {
  const result = new Array(length).fill(0);
  result[0] = first;
  return result;
}

function store(dir, safeStorage = fakeSafeStorage()) {
  return new FaceProfileStore({ baseDir: dir, safeStorage, audit: () => {} });
}

test('face store: enrolls, reports metadata, and matches a probe locally', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faceStore = store(dir);
  const before = await faceStore.getStatus();
  assert.equal(before.enrolled, false);
  assert.equal(before.available, true);

  const enroll = await faceStore.enroll([vector(1), vector(0.98), vector(0.95)]);
  assert.equal(enroll.ok, true);
  assert.equal(enroll.status.enrolled, true);
  assert.equal(enroll.status.samples, 3);
  assert.equal(enroll.status.threshold, DEFAULT_THRESHOLD);
  assert.equal(enroll.status.enabled, true);

  const match = await faceStore.verify(vector(1));
  assert.equal(match.ok, true);
  assert.ok(match.similarity > 0.99);

  const miss = await faceStore.verify(vector(-1));
  assert.equal(miss.ok, false);
  assert.ok(miss.similarity < 0);
});

test('face store: encrypted file does not contain plaintext embeddings', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faceStore = store(dir);
  assert.equal((await faceStore.enroll([vector(1)])).ok, true);
  const raw = fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf8');
  assert.equal(raw.includes('embeddings'), false);
  assert.equal(raw.includes('createdAt'), false);
  assert.equal(raw.includes('"1"'), false);
});

test('face store: enable flag is persisted and blocks verification when disabled', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faceStore = store(dir);
  await faceStore.enroll([vector(1)]);
  const disabled = await faceStore.setEnabled(false);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.status.enabled, false);
  const result = await faceStore.verify(vector(1));
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/i);
  const enabled = await faceStore.setEnabled(true);
  assert.equal(enabled.ok, true);
  assert.equal((await faceStore.verify(vector(1))).ok, true);
});

test('face store: delete removes the encrypted profile', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faceStore = store(dir);
  await faceStore.enroll([vector(1)]);
  assert.equal(fs.existsSync(path.join(dir, PROFILE_FILE)), true);
  const removed = await faceStore.remove();
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(dir, PROFILE_FILE)), false);
  assert.equal((await faceStore.getStatus()).enrolled, false);
});

test('face store: refuses to operate when OS encryption is unavailable', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faceStore = store(dir, fakeSafeStorage(false));
  const status = await faceStore.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.enrolled, false);
  const enroll = await faceStore.enroll([vector(1)]);
  assert.equal(enroll.ok, false);
  assert.match(enroll.error, /encryption/i);
  assert.equal(fs.existsSync(path.join(dir, PROFILE_FILE)), false);
});

test('face store: corrupt profile is reported instead of treated as enrolled', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, PROFILE_FILE), Buffer.from('not a safeStorage payload'));
  const faceStore = store(dir);
  const status = await faceStore.getStatus();
  assert.equal(status.ok, false);
  assert.equal(status.enrolled, false);
  assert.match(status.error, /decrypt/i);
});

test('face store: validates embeddings before writing', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const faceStore = store(dir);
  assert.equal((await faceStore.enroll([])).ok, false);
  assert.equal((await faceStore.enroll([vector(1, 64)])).ok, false);
  assert.equal((await faceStore.enroll([vector(1), vector(1, 256)])).ok, false);
  const nonFinite = vector(1);
  nonFinite[3] = NaN;
  assert.equal((await faceStore.enroll([nonFinite])).ok, false);
  assert.equal(fs.existsSync(path.join(dir, PROFILE_FILE)), false);
});

test('face store: cosine similarity and validators handle malformed input', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([1, NaN], [1, 0]), 0);
  assert.match(validateEmbedding('x'), /array/i);
  assert.match(validateEmbeddings([vector(1), vector(1, 256)]), /inconsistent/i);
});
