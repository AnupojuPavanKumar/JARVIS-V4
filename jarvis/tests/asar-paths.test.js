'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { unpackedPath, appAssetPath } = require('../backend/asar-paths');

test('asar paths: unpacked child-process paths are mapped beside the archive', () => {
  const packed = path.join('C:', 'JARVIS', 'resources', 'app.asar', 'bin', 'whisper', 'whisper-cli.exe');
  const expected = path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked', 'bin', 'whisper', 'whisper-cli.exe');
  assert.equal(unpackedPath(packed), expected);
});

test('asar paths: the archive root itself is mapped', () => {
  const packed = path.join('C:', 'JARVIS', 'resources', 'app.asar');
  const expected = path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked');
  assert.equal(unpackedPath(packed), expected);
});

test('asar paths: development and already-unpacked paths are unchanged', () => {
  const development = path.join('C:', 'JARVIS', 'bin', 'whisper', 'whisper-cli.exe');
  assert.equal(unpackedPath(development), development);
  const unpacked = path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked', 'bin', 'whisper', 'whisper-cli.exe');
  assert.equal(unpackedPath(unpacked), unpacked);
});

test('asar paths: empty input is handled safely', () => {
  assert.equal(unpackedPath(''), '');
  assert.equal(unpackedPath(null), '');
});

test('asar paths: app assets move beside the archive when packaged', () => {
  const appPath = path.join('C:', 'JARVIS', 'resources', 'app.asar');
  const resolved = appAssetPath(appPath, 'bin', 'whisper', 'whisper-cli.exe');
  assert.equal(
    resolved,
    path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked', 'bin', 'whisper', 'whisper-cli.exe')
  );
});

test('asar paths: app assets stay in the project directory during development', () => {
  const appPath = path.join('C:', 'JARVIS', 'app');
  const resolved = appAssetPath(appPath, ['bin', 'whisper', 'models', 'ggml-base.en.bin']);
  assert.equal(resolved, path.join('C:', 'JARVIS', 'app', 'bin', 'whisper', 'models', 'ggml-base.en.bin'));
});

test('asar paths: app asset helper rejects missing roots and filters empty segments', () => {
  assert.equal(appAssetPath('', 'bin'), '');
  assert.equal(appAssetPath(null, 'bin'), '');
  const appPath = path.join('C:', 'JARVIS', 'app');
  assert.equal(appAssetPath(appPath, ['', null, 'bin', undefined, 'whisper']), path.join(appPath, 'bin', 'whisper'));
});
