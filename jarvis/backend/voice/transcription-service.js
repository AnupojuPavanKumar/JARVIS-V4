'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { normalizeAudioPayload, validateWavPayload } = require('./audio-payload');

/**
 * Lease-gated local transcription.
 *
 * The voice lease is consumed before the payload is inspected, so a malformed,
 * oversized, replayed, or expired request can never reach the Whisper queue.
 * The temporary WAV is written with a random name and removed in a finally
 * block after the transcription settles. Audio is never uploaded.
 */
function createTranscriptionService({
  voicePolicy,
  queueTranscription,
  audioDirProvider,
  audit = () => {},
  fsImpl = fs,
  randomBytesImpl = randomBytes,
} = {}) {
  if (!voicePolicy) throw new TypeError('transcription service requires the voice policy');
  if (typeof queueTranscription !== 'function') {
    throw new TypeError('transcription service requires a queue function');
  }
  if (typeof audioDirProvider !== 'function') {
    throw new TypeError('transcription service requires an audio directory provider');
  }

  function fail(error, detail = error) {
    audit('VOICE_TRANSCRIBE', detail, 'BLOCKED');
    return { success: false, error };
  }

  async function handle(event, payload = {}) {
    const webContentsId = event && event.sender ? event.sender.id : 0;

    // Consume first even if the rest of the request is malformed. This makes
    // every lease strictly single-use and prevents replay from reaching Whisper.
    const lease = voicePolicy.consumeTranscriptionLease({
      leaseId: payload && payload.leaseId,
      webContentsId,
    });
    if (!lease.ok) return fail(lease.error || 'A valid local voice lease is required', lease.error);

    let audioBuffer;
    try {
      audioBuffer = normalizeAudioPayload(payload && payload.audio, { maxBytes: lease.maxBytes });
      validateWavPayload(audioBuffer, {
        maxBytes: lease.maxBytes,
        maxDurationMs: lease.maxDurationMs,
      });
    } catch (error) {
      if (audioBuffer) audioBuffer.fill(0);
      return fail('Invalid audio payload: ' + error.message, error.message);
    }

    const audioDir = path.resolve(audioDirProvider());
    const tempPath = path.join(audioDir, `audio_${randomBytesImpl(16).toString('hex')}.wav`);
    const resolvedPath = path.resolve(tempPath);
    if (resolvedPath !== tempPath || !resolvedPath.startsWith(audioDir + path.sep)) {
      if (audioBuffer) audioBuffer.fill(0);
      return fail('Refusing to write temporary audio outside the audio cache');
    }

    let written = false;
    try {
      fsImpl.mkdirSync(audioDir, { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(resolvedPath, audioBuffer, { flag: 'wx', mode: 0o600 });
      written = true;
      const result = await queueTranscription(resolvedPath);
      return result && typeof result === 'object'
        ? result
        : { success: false, error: 'Local transcription returned an invalid result' };
    } catch (error) {
      return fail('Local transcription failed: ' + error.message, error.message);
    } finally {
      // Guaranteed cleanup on success, timeout, Whisper error, and write error.
      if (written) {
        try { fsImpl.unlinkSync(resolvedPath); } catch (_) { /* already removed */ }
      }
      if (audioBuffer) audioBuffer.fill(0);
    }
  }

  return Object.freeze({ handle });
}

module.exports = { createTranscriptionService };
