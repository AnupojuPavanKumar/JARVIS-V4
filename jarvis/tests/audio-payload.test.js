'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAudioPayload, MAX_AUDIO_BYTES } = require('../backend/voice/audio-payload');

test('audio payload: accepts the ArrayBuffer sent by the renderer bridge', () => {
  const source = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
  const normalized = normalizeAudioPayload(source.buffer);

  assert.ok(Buffer.isBuffer(normalized));
  assert.deepEqual([...normalized], [...source]);
});

test('audio payload: accepts Buffer, typed-array, and serialized Buffer forms', () => {
  const expected = [1, 2, 3, 4];

  assert.deepEqual([...normalizeAudioPayload(Buffer.from(expected))], expected);
  assert.deepEqual([...normalizeAudioPayload(new Uint8Array(expected))], expected);
  assert.deepEqual([...normalizeAudioPayload({ type: 'Buffer', data: expected })], expected);
});

test('audio payload: rejects empty and unsupported values', () => {
  assert.throws(() => normalizeAudioPayload(new ArrayBuffer(0)), /Empty audio payload/);
  assert.throws(() => normalizeAudioPayload('not audio'), /Unsupported audio payload type/);
  assert.throws(() => normalizeAudioPayload(null), /Unsupported audio payload type/);
});

test('audio payload: enforces the maximum size', () => {
  assert.throws(
    () => normalizeAudioPayload(new Uint8Array(MAX_AUDIO_BYTES + 1)),
    /too large/
  );
});
