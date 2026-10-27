'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { WHISPER_ASSET_MANIFEST } = require('../backend/voice/whisper-assets-manifest');
const { verifyWhisperAssets } = require('../backend/voice/whisper-assets');

const root = path.join(__dirname, '..');
const whisperDir = path.join(root, 'bin', 'whisper');

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

test('whisper packaging: every bundled runtime file is pinned and verifies', async () => {
  assert.equal(fs.existsSync(path.join(whisperDir, 'whisper-cli.exe')), true);
  assert.equal(fs.existsSync(path.join(whisperDir, 'models', 'ggml-base.en-q5_1.bin')), true);

  const pinned = WHISPER_ASSET_MANIFEST.files.map(entry => entry.relativePath.slice('bin/whisper/'.length));
  assert.deepEqual(
    pinned.slice().sort(),
    walk(whisperDir).sort(),
    'every file under bin/whisper must be covered by the integrity manifest'
  );

  const result = await verifyWhisperAssets({
    appPath: root,
    manifest: WHISPER_ASSET_MANIFEST,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.paths.executable, path.join(whisperDir, 'whisper-cli.exe'));
  assert.equal(result.paths.model, path.join(whisperDir, 'models', 'ggml-base.en-q5_1.bin'));
});

test('whisper packaging: a real packaged build verifies beside app.asar when present', async t => {
  const packagedApp = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(packagedApp)) {
    t.skip('no packaged build is present');
    return;
  }

  const result = await verifyWhisperAssets({
    appPath: packagedApp,
    manifest: WHISPER_ASSET_MANIFEST,
  });
  assert.equal(result.ok, true, result.error);
  assert.match(result.paths.executable, /app\.asar\.unpacked/);
  assert.match(result.paths.model, /app\.asar\.unpacked/);
});

test('whisper packaging: electron-builder unpacks the sidecar beside app.asar', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.build.asarUnpack.includes('bin/whisper/**'));
  assert.equal(pkg.build.files.some(pattern => pattern === '!bin/**'), false);
  assert.equal(pkg.build.win.target.some(target => target.arch.includes('x64')), true);
  assert.ok(
    pkg.build.win.signExts.includes('!whisper-cli.exe'),
    'the pinned sidecar must not be rewritten by code signing'
  );
});

test('whisper packaging: the app never falls back to Python or a cloud service', () => {
  const controller = fs.readFileSync(
    path.join(root, 'backend', 'controllers', 'AIController.js'),
    'utf8'
  );
  assert.doesNotMatch(controller, /transcribe_server\.py/);
  assert.doesNotMatch(controller, /spawn\(\s*['"]python['"]/);
  assert.doesNotMatch(controller, /openai-whisper|whisper\.load_model/);
});
