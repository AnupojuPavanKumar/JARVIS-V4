'use strict';

const { isAnyArrayBuffer } = require('node:util').types;

// Renderer audio can arrive as a Buffer, a plain Uint8Array, or an ArrayBuffer
// depending on the Electron/contextBridge version. Normalize once before the
// main process writes the temporary file.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIN_WAV_BYTES = 44;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;
const MAX_CHANNELS = 8;
const PCM_FORMAT = 1;
const PCM_BITS_PER_SAMPLE = 16;

function normalizeAudioPayload(payload, { maxBytes = MAX_AUDIO_BYTES } = {}) {
  let bytes;

  if (Buffer.isBuffer(payload)) {
    bytes = payload;
  } else if (isAnyArrayBuffer(payload)) {
    bytes = Buffer.from(payload);
  } else if (ArrayBuffer.isView(payload)) {
    bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  } else if (payload && payload.type === 'Buffer' && Array.isArray(payload.data)) {
    bytes = Buffer.from(payload.data);
  } else {
    throw new Error('Unsupported audio payload type');
  }

  const limit = Number(maxBytes);
  const boundedLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.trunc(limit), MAX_AUDIO_BYTES)
    : MAX_AUDIO_BYTES;

  if (bytes.length === 0) throw new Error('Empty audio payload');
  if (bytes.length > boundedLimit) throw new Error('Audio payload is too large');
  return bytes;
}

function ascii(buffer, offset, length) {
  return buffer.toString('latin1', offset, offset + length);
}

/**
 * Strict parser for the local voice WAV format.
 *
 * The renderer produces a mono 16-bit PCM WAV. Accepting only that exact format
 * keeps the Whisper sidecar away from compressed containers, float PCM, and
 * malformed chunk lengths. The duration bound uses the declared data chunk so
 * an oversized file cannot hide behind a short header.
 */
function parseWavPayload(bytes, {
  maxBytes = MAX_AUDIO_BYTES,
  maxDurationMs = 15000,
} = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('Audio payload must be a Buffer');
  }

  const byteLimit = Number(maxBytes);
  const boundedBytes = Number.isFinite(byteLimit) && byteLimit > 0
    ? Math.min(Math.trunc(byteLimit), MAX_AUDIO_BYTES)
    : MAX_AUDIO_BYTES;
  if (bytes.length > boundedBytes) throw new Error('Audio payload is too large');
  if (bytes.length < MIN_WAV_BYTES) throw new Error('Audio payload is not a valid WAV file');

  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Audio payload is not a valid WAV file');
  }

  const riffSize = bytes.readUInt32LE(4);
  if (riffSize < 36 || riffSize + 8 !== bytes.length) {
    throw new Error('WAV container length is invalid');
  }

  let offset = 12;
  let format = null;
  let dataSize = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > bytes.length) throw new Error('WAV chunk length is invalid');

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('WAV format chunk is invalid');
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        byteRate: bytes.readUInt32LE(chunkStart + 8),
        blockAlign: bytes.readUInt16LE(chunkStart + 12),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data' && dataSize === null) {
      dataSize = chunkSize;
    }

    // RIFF chunks are word-aligned. The renderer emits even-sized chunks, but
    // tolerate a single pad byte for completeness.
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!format) throw new Error('WAV format chunk is missing');
  if (dataSize === null) throw new Error('WAV data chunk is missing');
  if (format.audioFormat !== PCM_FORMAT) throw new Error('WAV audio must be 16-bit PCM');
  if (format.bitsPerSample !== PCM_BITS_PER_SAMPLE) {
    throw new Error('WAV audio must be 16-bit PCM');
  }
  if (format.channels < 1 || format.channels > MAX_CHANNELS) {
    throw new Error('WAV channel count is invalid');
  }
  if (format.sampleRate < MIN_SAMPLE_RATE || format.sampleRate > MAX_SAMPLE_RATE) {
    throw new Error('WAV sample rate is invalid');
  }

  const expectedBlockAlign = format.channels * (PCM_BITS_PER_SAMPLE / 8);
  const expectedByteRate = format.sampleRate * expectedBlockAlign;
  if (format.blockAlign !== expectedBlockAlign || format.byteRate !== expectedByteRate) {
    throw new Error('WAV format metadata is inconsistent');
  }
  if (dataSize === 0) throw new Error('WAV audio is empty');
  if (dataSize % expectedBlockAlign !== 0) {
    throw new Error('WAV data length is not aligned to its frame size');
  }

  const durationMs = Math.round((dataSize / expectedByteRate) * 1000);
  const durationLimit = Number(maxDurationMs);
  const boundedDuration = Number.isFinite(durationLimit) && durationLimit > 0
    ? Math.trunc(durationLimit)
    : 15000;
  if (durationMs > boundedDuration) {
    throw new Error(`WAV audio is longer than ${Math.round(boundedDuration / 1000)} seconds`);
  }

  return {
    bytes: bytes.length,
    dataBytes: dataSize,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    durationMs,
  };
}

function validateWavPayload(bytes, options = {}) {
  return parseWavPayload(bytes, options);
}

module.exports = {
  normalizeAudioPayload,
  parseWavPayload,
  validateWavPayload,
  MAX_AUDIO_BYTES,
  MIN_WAV_BYTES,
};
