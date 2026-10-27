'use strict';

/**
 * Main-owned microphone and transcription policy.
 *
 * The renderer never decides whether the lock screen may capture audio, how
 * long a microphone grant lasts, or whether an audio payload may be
 * transcribed. This module owns:
 *  - the persisted wake-word opt-in (voice-settings.json in userData);
 *  - bounded capture grants bound to the main renderer and a purpose;
 *  - short, single-use transcription leases with a nonce;
 *  - issuance/consumption rate limits.
 *
 * A capture grant is long enough for a continuous wake-word stream but is
 * always refreshed from main. A transcription lease is per-utterance and is
 * consumed before any audio validation or Whisper work. Audio bytes only ever
 * travel from the renderer to the local Whisper process; nothing is uploaded.
 *
 * Residual risk: a compromised main renderer can synthesize WAV bytes while a
 * main-approved lease exists, but it cannot obtain OS microphone permission
 * without an active capture grant and cannot transcribe outside a single-use
 * lease. Audio is deleted immediately after transcription.
 */

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const SETTINGS_FILE = 'voice-settings.json';
const SETTINGS_VERSION = 1;
const CAPTURE_PURPOSES = Object.freeze(['wake-word', 'one-shot']);
const DEFAULT_CAPTURE_TTL_MS = Object.freeze({
  'wake-word': 5 * 60 * 1000,
  'one-shot': 30 * 1000,
});
const DEFAULT_TRANSCRIBE_TTL_MS = 15 * 1000;
const DEFAULT_MAX_TRANSCRIBE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIBE_DURATION_MS = 15 * 1000;
const MAX_OUTSTANDING_LEASES = 2;
const DEFAULT_LEASE_RATE = Object.freeze({ limit: 30, windowMs: 60 * 1000 });
const DEFAULT_TRANSCRIBE_RATE = Object.freeze({ limit: 20, windowMs: 60 * 1000 });
const NONCE_RE = /^[0-9a-f]{64}$/;

function validWebContentsId(value) {
  return Number.isInteger(value) && value > 0;
}

function createVoicePolicy({
  baseDir,
  now = () => Date.now(),
  fsImpl = fs,
  getSessionLocked = () => false,
  isWindowVisible = () => true,
  audit = () => {},
  captureTtlMs = {},
  transcribeTtlMs = DEFAULT_TRANSCRIBE_TTL_MS,
  maxTranscribeBytes = DEFAULT_MAX_TRANSCRIBE_BYTES,
  maxTranscribeDurationMs = DEFAULT_MAX_TRANSCRIBE_DURATION_MS,
  leaseRate = DEFAULT_LEASE_RATE,
  transcribeRate = DEFAULT_TRANSCRIBE_RATE,
} = {}) {
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new TypeError('voice policy requires a base directory');
  }

  const settingsPath = path.join(baseDir, SETTINGS_FILE);
  const wakeWordTtl = Number(captureTtlMs['wake-word']) > 0
    ? Math.trunc(captureTtlMs['wake-word'])
    : DEFAULT_CAPTURE_TTL_MS['wake-word'];
  const oneShotTtl = Number(captureTtlMs['one-shot']) > 0
    ? Math.trunc(captureTtlMs['one-shot'])
    : DEFAULT_CAPTURE_TTL_MS['one-shot'];
  const transcriptionTtl = Number(transcribeTtlMs) > 0
    ? Math.trunc(transcribeTtlMs)
    : DEFAULT_TRANSCRIBE_TTL_MS;
  const transcriptionBytes = Number(maxTranscribeBytes) > 0
    ? Math.trunc(maxTranscribeBytes)
    : DEFAULT_MAX_TRANSCRIBE_BYTES;
  const transcriptionDuration = Number(maxTranscribeDurationMs) > 0
    ? Math.trunc(maxTranscribeDurationMs)
    : DEFAULT_MAX_TRANSCRIBE_DURATION_MS;

  let wakeWordEnabled = false;
  let settingsError = null;
  let capture = null;
  const leases = new Map();
  const leaseIssueTimes = [];
  const transcriptionTimes = [];

  function loadSettings() {
    try {
      if (typeof fsImpl.existsSync !== 'function' || !fsImpl.existsSync(settingsPath)) {
        wakeWordEnabled = false;
        settingsError = null;
        return;
      }
      const parsed = JSON.parse(fsImpl.readFileSync(settingsPath, 'utf8'));
      if (!parsed || parsed.version !== SETTINGS_VERSION || typeof parsed.wakeWordEnabled !== 'boolean') {
        throw new Error('unsupported voice settings format');
      }
      wakeWordEnabled = parsed.wakeWordEnabled === true;
      settingsError = null;
    } catch (error) {
      // A damaged preference file must not leave the microphone silently on.
      wakeWordEnabled = false;
      settingsError = String(error && error.message || error).slice(0, 180);
      audit('VOICE_SETTINGS_READ', settingsError, 'FAIL');
    }
  }

  function persistSettings() {
    const payload = JSON.stringify({
      version: SETTINGS_VERSION,
      wakeWordEnabled,
    }, null, 2);
    try {
      fsImpl.mkdirSync(baseDir, { recursive: true });
      const tempPath = `${settingsPath}.tmp`;
      fsImpl.writeFileSync(tempPath, payload, { mode: 0o600 });
      try {
        fsImpl.renameSync(tempPath, settingsPath);
      } catch (error) {
        // Windows can reject rename-over-existing. The old file is only removed
        // after the replacement has been written successfully.
        if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
          fsImpl.rmSync(settingsPath, { force: true });
          fsImpl.renameSync(tempPath, settingsPath);
        } else {
          throw error;
        }
      }
      settingsError = null;
      return { ok: true };
    } catch (error) {
      settingsError = String(error && error.message || error).slice(0, 180);
      audit('VOICE_SETTINGS_WRITE', settingsError, 'FAIL');
      return { ok: false, error: 'Could not save the local voice preference' };
    }
  }

  function pruneLeases() {
    const current = now();
    for (const [leaseId, lease] of leases) {
      if (current >= lease.expiresAt) leases.delete(leaseId);
    }
  }

  function expireCapture() {
    if (capture && now() >= capture.expiresAt) {
      capture = null;
      return true;
    }
    return false;
  }

  function takeRate(times, policy) {
    const limit = Number(policy && policy.limit);
    const windowMs = Number(policy && policy.windowMs);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      return false;
    }
    const cutoff = now() - windowMs;
    while (times.length > 0 && times[0] <= cutoff) times.shift();
    if (times.length >= limit) return false;
    times.push(now());
    return true;
  }

  function captureSnapshot() {
    if (expireCapture() || !capture) return null;
    return {
      active: true,
      purpose: capture.purpose,
      issuedAt: capture.issuedAt,
      expiresAt: capture.expiresAt,
    };
  }

  function isCaptureActive({ webContentsId } = {}) {
    if (!validWebContentsId(webContentsId)) return false;
    if (expireCapture() || !capture) return false;
    return capture.webContentsId === webContentsId;
  }

  function armCapture({ purpose, webContentsId } = {}) {
    if (!CAPTURE_PURPOSES.includes(purpose)) {
      return { ok: false, error: 'A valid local voice capture purpose is required' };
    }
    if (!validWebContentsId(webContentsId)) {
      return { ok: false, error: 'A trusted JARVIS window is required for microphone access' };
    }
    if (!isWindowVisible()) {
      return { ok: false, error: 'The JARVIS window must be visible to use the microphone' };
    }

    // An expired capture can leave short leases behind for a few seconds. They
    // belong to the old grant, so clear them before issuing a new capture.
    if (expireCapture()) leases.clear();

    const locked = getSessionLocked() === true;
    if (purpose === 'one-shot' && locked) {
      return { ok: false, error: 'Unlock JARVIS before using one-shot voice input' };
    }
    if (purpose === 'wake-word' && !wakeWordEnabled) {
      return { ok: false, error: 'Enable the local wake word before using lock-screen capture' };
    }

    const ttl = purpose === 'wake-word' ? wakeWordTtl : oneShotTtl;
    const issuedAt = now();
    if (capture && (capture.purpose !== purpose || capture.webContentsId !== webContentsId)) {
      // A change of purpose or sender invalidates any lease issued for the old
      // capture grant.
      leases.clear();
    }
    capture = {
      id: randomBytes(32).toString('hex'),
      purpose,
      webContentsId,
      issuedAt,
      expiresAt: issuedAt + ttl,
    };

    return {
      ok: true,
      captureId: capture.id,
      purpose,
      issuedAt,
      expiresAt: capture.expiresAt,
      durationMs: ttl,
      maxTranscribeBytes: transcriptionBytes,
      maxTranscribeDurationMs: transcriptionDuration,
    };
  }

  function disarmCapture({ webContentsId, captureId } = {}) {
    if (!capture) return { ok: true, active: false };
    if (!validWebContentsId(webContentsId) || capture.webContentsId !== webContentsId) {
      return { ok: false, error: 'No matching voice capture grant' };
    }
    if (captureId && capture.id !== captureId) {
      return { ok: false, error: 'Stale voice capture grant' };
    }
    capture = null;
    leases.clear();
    return { ok: true, active: false };
  }

  function revokeAll(reason = 'revoked') {
    capture = null;
    leases.clear();
    audit('VOICE_CAPTURE_REVOKE', String(reason).slice(0, 120), 'OK');
    return { ok: true };
  }

  // Issuing and consuming a lease must enforce the same main-owned authority.
  // Keep the predicate in one place so those paths cannot drift.
  function leaseAuthorityError(purpose) {
    if (getSessionLocked() === true && purpose !== 'wake-word') {
      return 'One-shot voice input is unavailable while JARVIS is locked';
    }
    if (purpose === 'wake-word' && !wakeWordEnabled) {
      return 'The local wake word is disabled';
    }
    return null;
  }

  function issueTranscriptionLease({ webContentsId } = {}) {
    if (!validWebContentsId(webContentsId)) {
      return { ok: false, error: 'A trusted JARVIS window is required for transcription' };
    }
    if (!isWindowVisible()) {
      return { ok: false, error: 'The JARVIS window must be visible to use voice input' };
    }
    if (expireCapture() || !capture || capture.webContentsId !== webContentsId) {
      return { ok: false, error: 'No active local voice capture' };
    }

    const authorityError = leaseAuthorityError(capture.purpose);
    if (authorityError) return { ok: false, error: authorityError };
    if (!takeRate(leaseIssueTimes, leaseRate)) {
      return { ok: false, error: 'Local voice is busy. Try again in a moment.' };
    }

    pruneLeases();
    if (leases.size >= MAX_OUTSTANDING_LEASES) {
      return { ok: false, error: 'Too many pending voice leases' };
    }

    const issuedAt = now();
    const leaseId = randomBytes(32).toString('hex');
    leases.set(leaseId, {
      purpose: capture.purpose,
      webContentsId,
      issuedAt,
      expiresAt: issuedAt + transcriptionTtl,
    });
    return {
      ok: true,
      leaseId,
      expiresAt: issuedAt + transcriptionTtl,
      maxBytes: transcriptionBytes,
      maxDurationMs: transcriptionDuration,
    };
  }

  function consumeTranscriptionLease({ leaseId, webContentsId } = {}) {
    if (typeof leaseId !== 'string' || !NONCE_RE.test(leaseId)) {
      return { ok: false, error: 'A valid single-use voice lease is required' };
    }
    if (!validWebContentsId(webContentsId)) {
      return { ok: false, error: 'A trusted JARVIS window is required for transcription' };
    }

    const lease = leases.get(leaseId);
    if (!lease) {
      return { ok: false, error: 'The voice lease is missing or has already been used' };
    }
    if (lease.webContentsId !== webContentsId) {
      return { ok: false, error: 'The voice lease does not belong to this window' };
    }

    // Consume before any validation or asynchronous work so a replay can never
    // reach Whisper, even if the audio payload is malformed.
    leases.delete(leaseId);

    if (now() >= lease.expiresAt) {
      return { ok: false, error: 'The voice lease has expired' };
    }
    if (!isWindowVisible()) {
      return { ok: false, error: 'The JARVIS window is not visible' };
    }
    const authorityError = leaseAuthorityError(lease.purpose);
    if (authorityError) return { ok: false, error: authorityError };
    if (!takeRate(transcriptionTimes, transcribeRate)) {
      return { ok: false, error: 'Local transcription is rate limited' };
    }

    return {
      ok: true,
      purpose: lease.purpose,
      maxBytes: transcriptionBytes,
      maxDurationMs: transcriptionDuration,
    };
  }

  function setWakeWordEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' };
    }
    // Re-asserting an opt-in that is already persisted is safe on the lock
    // screen: it cannot turn the microphone on by itself, and the capture gate
    // still requires visibility plus the main-owned policy to allow it.
    if (enabled && getSessionLocked() === true && !wakeWordEnabled) {
      return { ok: false, error: 'Unlock JARVIS before enabling the local wake word' };
    }

    const previous = wakeWordEnabled;
    if (previous === enabled) {
      return { ok: true, wakeWordEnabled, revokedWakeWord: false };
    }
    wakeWordEnabled = enabled;
    const persisted = persistSettings();
    if (!persisted.ok) {
      wakeWordEnabled = previous;
      return persisted;
    }

    let revokedWakeWord = false;
    if (!enabled) {
      if (capture && capture.purpose === 'wake-word') {
        capture = null;
        revokedWakeWord = true;
      }
      for (const [leaseId, lease] of leases) {
        if (lease.purpose === 'wake-word') {
          leases.delete(leaseId);
          revokedWakeWord = true;
        }
      }
    }

    audit('VOICE_WAKE_WORD_SETTING', enabled ? 'enabled' : 'disabled', 'ALLOW');
    return { ok: true, wakeWordEnabled, revokedWakeWord };
  }

  function status() {
    return {
      ok: true,
      wakeWordEnabled,
      settingsError,
      sessionLocked: getSessionLocked() === true,
      windowVisible: isWindowVisible() === true,
      capture: captureSnapshot(),
    };
  }

  loadSettings();

  return Object.freeze({
    status,
    setWakeWordEnabled,
    armCapture,
    disarmCapture,
    isCaptureActive,
    issueTranscriptionLease,
    consumeTranscriptionLease,
    revokeAll,
    getSettingsPath: () => settingsPath,
    getLimits: () => ({
      capture: { 'wake-word': wakeWordTtl, 'one-shot': oneShotTtl },
      transcriptionTtlMs: transcriptionTtl,
      maxBytes: transcriptionBytes,
      maxDurationMs: transcriptionDuration,
      maxOutstandingLeases: MAX_OUTSTANDING_LEASES,
    }),
  });
}

module.exports = {
  createVoicePolicy,
  SETTINGS_FILE,
  SETTINGS_VERSION,
  DEFAULT_CAPTURE_TTL_MS,
  DEFAULT_TRANSCRIBE_TTL_MS,
  DEFAULT_MAX_TRANSCRIBE_BYTES,
  DEFAULT_MAX_TRANSCRIBE_DURATION_MS,
  MAX_OUTSTANDING_LEASES,
};
