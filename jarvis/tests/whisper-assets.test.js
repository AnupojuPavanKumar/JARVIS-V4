'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateManifest, verifyWhisperAssets } = require('../backend/voice/whisper-assets');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function setup(t, files = { 'fake.exe': Buffer.from('native whisper'), 'model.bin': Buffer.from('model weights') }) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-whisper-assets-'));
  t.after(() => {
    try { fs.rmSync(appPath, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
  const root = path.join(appPath, 'bin', 'whisper');
  fs.mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return { appPath, root };
}

function manifestFor(files) {
  return {
    root: 'bin/whisper',
    files: Object.entries(files).map(([name, contents]) => ({
      role: name === 'fake.exe' ? 'executable' : 'model',
      relativePath: `bin/whisper/${name}`,
      sha256: sha256(contents),
      bytes: contents.length,
    })),
  };
}

test('whisper assets: valid executable and model verify with pinned hashes', async t => {
  const files = { 'fake.exe': Buffer.from('native whisper'), 'model.bin': Buffer.from('model weights') };
  const { appPath, root } = setup(t, files);

  const result = await verifyWhisperAssets({ appPath, manifest: manifestFor(files) });
  assert.equal(result.ok, true);
  assert.equal(result.paths.root, root);
  assert.equal(result.paths.executable, path.join(root, 'fake.exe'));
  assert.equal(result.paths.model, path.join(root, 'model.bin'));
  assert.equal(Object.isFrozen(result.paths), true);
});

test('whisper assets: a missing asset disables transcription with a clear diagnostic', async t => {
  const files = { 'fake.exe': Buffer.from('native whisper') };
  const { appPath } = setup(t, files);
  const manifest = manifestFor(files);
  manifest.files.push({
    role: 'model',
    relativePath: 'bin/whisper/model.bin',
    sha256: 'a'.repeat(64),
    bytes: 10,
  });

  const result = await verifyWhisperAssets({ appPath, manifest });
  assert.equal(result.ok, false);
  assert.match(result.error, /Local transcription is unavailable/);
  assert.match(result.error, /bin\/whisper\/model\.bin is missing/);
});

test('whisper assets: a modified asset is rejected by the pinned hash', async t => {
  const files = { 'fake.exe': Buffer.from('native whisper'), 'model.bin': Buffer.from('model weights') };
  const { appPath } = setup(t, files);
  const manifest = manifestFor(files);
  manifest.files[0].sha256 = 'b'.repeat(64);

  const result = await verifyWhisperAssets({ appPath, manifest });
  assert.equal(result.ok, false);
  assert.match(result.error, /failed integrity verification/);
});

test('whisper assets: a truncated asset is rejected by the pinned size', async t => {
  const files = { 'fake.exe': Buffer.from('native whisper'), 'model.bin': Buffer.from('model weights') };
  const { appPath } = setup(t, files);
  const manifest = manifestFor(files);
  manifest.files[0].bytes += 1;

  const result = await verifyWhisperAssets({ appPath, manifest });
  assert.equal(result.ok, false);
  assert.match(result.error, /unexpected size/);
});

test('whisper assets: directories and unreadable paths are rejected', async t => {
  const files = { 'fake.exe': Buffer.from('native whisper') };
  const { appPath } = setup(t, files);
  fs.mkdirSync(path.join(appPath, 'bin', 'whisper', 'model.bin'));

  const manifest = manifestFor(files);
  manifest.files.push({
    role: 'model',
    relativePath: 'bin/whisper/model.bin',
    sha256: 'c'.repeat(64),
    bytes: 1,
  });

  const result = await verifyWhisperAssets({ appPath, manifest });
  assert.equal(result.ok, false);
  assert.match(result.error, /is not a file/);
});

test('whisper assets: packaged paths resolve beside app.asar', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-whisper-packaged-'));
  t.after(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
  const whisperDir = path.join(base, 'resources', 'app.asar.unpacked', 'bin', 'whisper');
  fs.mkdirSync(path.join(whisperDir, 'models'), { recursive: true });
  const executable = Buffer.from('packaged executable');
  const model = Buffer.from('packaged model');
  fs.writeFileSync(path.join(whisperDir, 'fake.exe'), executable);
  fs.writeFileSync(path.join(whisperDir, 'models', 'model.bin'), model);

  const result = await verifyWhisperAssets({
    appPath: path.join(base, 'resources', 'app.asar'),
    manifest: {
      root: 'bin/whisper',
      files: [
        {
          role: 'executable',
          relativePath: 'bin/whisper/fake.exe',
          sha256: sha256(executable),
          bytes: executable.length,
        },
        {
          role: 'model',
          relativePath: 'bin/whisper/models/model.bin',
          sha256: sha256(model),
          bytes: model.length,
        },
      ],
    },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.paths.executable, path.join(whisperDir, 'fake.exe'));
  assert.equal(result.paths.model, path.join(whisperDir, 'models', 'model.bin'));
});

test('whisper assets: manifest paths cannot escape the sidecar directory', () => {
  const executable = {
    role: 'executable',
    relativePath: 'bin/whisper/fake.exe',
    sha256: 'a'.repeat(64),
    bytes: 1,
  };
  const model = {
    role: 'model',
    relativePath: 'bin/whisper/model.bin',
    sha256: 'b'.repeat(64),
    bytes: 1,
  };
  const base = { root: 'bin/whisper', files: [executable, model] };

  assert.equal(validateManifest(base), null);
  assert.match(
    validateManifest({ ...base, files: [executable] }),
    /missing the model role/
  );
  assert.match(validateManifest({ ...base, root: '../bin' }), /root is invalid/);
  assert.match(
    validateManifest({ ...base, files: [{ ...base.files[0], relativePath: 'bin/whisper/../evil.exe' }] }),
    /must stay under bin\/whisper/
  );
  assert.match(
    validateManifest({ ...base, files: [{ ...base.files[0], relativePath: 'skills/fake.exe' }] }),
    /must stay under bin\/whisper/
  );
  assert.match(
    validateManifest({ ...base, files: [{ ...base.files[0], role: 'executable' }, { ...base.files[0] }] }),
    /is duplicated/
  );
  assert.match(
    validateManifest({ ...base, files: [{ ...base.files[0], sha256: 'nope' }] }),
    /hash for "executable" is invalid/
  );
});
