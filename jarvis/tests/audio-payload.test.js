'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAudioPayload,
  parseWavPayload,
  validateWavPayload,
  MAX_AUDIO_BYTES,
} = require('../backend/voice/audio-payload');

function makeWav({ frames = 1600, sampleRate = 16000, channels = 1, bits = 16, format = 1 } = {}) {
  const blockAlign = channels * (bits / 8);
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

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

test('audio payload: accepts the 16 kHz mono PCM WAV produced by the renderer', () => {
  const metadata = parseWavPayload(makeWav({ frames: 16000 }));
  assert.equal(metadata.sampleRate, 16000);
  assert.equal(metadata.channels, 1);
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.durationMs, 1000);
});

test('audio payload: rejects non-WAV, compressed, and malformed containers', () => {
  assert.throws(() => validateWavPayload(Buffer.from('not a wave file')), /not a valid WAV/);
  assert.throws(() => validateWavPayload(makeWav({ format: 3 })), /16-bit PCM/);
  assert.throws(() => validateWavPayload(makeWav({ bits: 8 })), /16-bit PCM/);
  assert.throws(() => validateWavPayload(makeWav({ channels: 0 })), /channel count/);
  assert.throws(() => validateWavPayload(makeWav({ sampleRate: 1000 })), /sample rate/);

  const truncated = makeWav();
  truncated.writeUInt32LE(truncated.length * 2, 4);
  assert.throws(() => validateWavPayload(truncated), /container length/);

  const badDataLength = makeWav();
  badDataLength.writeUInt32LE(0xffffff, 40);
  assert.throws(() => validateWavPayload(badDataLength), /chunk length/);
});

test('audio payload: enforces the main-owned byte and duration bounds', () => {
  assert.throws(
    () => validateWavPayload(makeWav({ frames: 16000 }), { maxBytes: 100 }),
    /too large/
  );
  assert.throws(
    () => validateWavPayload(makeWav({ frames: 16000 * 16 }), { maxDurationMs: 15000 }),
    /longer than 15 seconds/
  );
  assert.doesNotThrow(() => validateWavPayload(makeWav({ frames: 16000 * 15 }), { maxDurationMs: 15000 }));
});

test('audio payload: stringify-generated Buffer form carries a valid WAV', () => {
  const bytes = makeWav();
  const normalized = normalizeAudioPayload(JSON.parse(JSON.stringify(bytes)));
  assert.equal(parseWavPayload(normalized).durationMs, 100);
});
