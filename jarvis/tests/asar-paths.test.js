'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { unpackedPath } = require('../backend/asar-paths');

test('asar paths: unpacked child-process paths are mapped beside the archive', () => {
  const packed = path.join('C:', 'JARVIS', 'resources', 'app.asar', 'skills', 'transcribe_server.py');
  const expected = path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked', 'skills', 'transcribe_server.py');
  assert.equal(unpackedPath(packed), expected);
});

test('asar paths: the archive root itself is mapped', () => {
  const packed = path.join('C:', 'JARVIS', 'resources', 'app.asar');
  const expected = path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked');
  assert.equal(unpackedPath(packed), expected);
});

test('asar paths: development and already-unpacked paths are unchanged', () => {
  const development = path.join('C:', 'JARVIS', 'skills', 'transcribe_server.py');
  assert.equal(unpackedPath(development), development);
  const unpacked = path.join('C:', 'JARVIS', 'resources', 'app.asar.unpacked', 'skills', 'transcribe_server.py');
  assert.equal(unpackedPath(unpacked), unpacked);
});

test('asar paths: empty input is handled safely', () => {
  assert.equal(unpackedPath(''), '');
  assert.equal(unpackedPath(null), '');
});
