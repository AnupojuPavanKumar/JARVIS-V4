'use strict';

const { isAnyArrayBuffer } = require('node:util').types;

// Renderer audio can arrive as a Buffer, a plain Uint8Array, or an ArrayBuffer
// depending on the Electron/contextBridge version. Normalize once before the
// main process writes the temporary file.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function normalizeAudioPayload(payload) {
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

  if (bytes.length === 0) throw new Error('Empty audio payload');
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('Audio payload is too large');
  return bytes;
}

module.exports = { normalizeAudioPayload, MAX_AUDIO_BYTES };
