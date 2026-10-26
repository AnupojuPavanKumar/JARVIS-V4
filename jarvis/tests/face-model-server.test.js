'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FaceModelServer, REQUIRED_MODELS } = require('../backend/face/face-model-server');

function makeModelsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-face-models-test-'));
  for (const name of REQUIRED_MODELS) {
    fs.writeFileSync(path.join(dir, name), name.endsWith('.json') ? '{"format":"graph-model"}' : 'weights');
  }
  fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'not served');
  return dir;
}

test('face model server: serves only bundled model files over loopback', async t => {
  const dir = makeModelsDir();
  const server = new FaceModelServer({ modelsDir: dir, logger: { error: () => {} } });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(server.isAvailable(), true);
  const baseUrl = await server.start();
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/models\/$/);

  const jsonResponse = await fetch(`${baseUrl}blazeface.json`);
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers.get('content-type'), /application\/json/);
  assert.equal(await jsonResponse.text(), '{"format":"graph-model"}');
  assert.equal(jsonResponse.headers.get('access-control-allow-origin'), '*');

  const binResponse = await fetch(`${baseUrl}blazeface.bin`, { method: 'HEAD' });
  assert.equal(binResponse.status, 200);
  assert.equal(binResponse.headers.get('content-length'), String(Buffer.byteLength('weights')));

  const unexpected = await fetch(`${baseUrl}unexpected.txt`);
  assert.equal(unexpected.status, 404);

  const traversal = await fetch(`${baseUrl}..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 404);

  const post = await fetch(`${baseUrl}blazeface.json`, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('face model server: refuses to start when required models are missing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-face-models-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = new FaceModelServer({ modelsDir: dir });
  assert.equal(server.isAvailable(), false);
  await assert.rejects(() => server.start(), /missing/i);
  assert.equal(server.getBaseUrl(), null);
});

test('face model server: stop is idempotent', async () => {
  const server = new FaceModelServer({ modelsDir: path.join(__dirname, 'does-not-exist') });
  await server.stop();
  await server.stop();
  assert.equal(server.getBaseUrl(), null);
});
