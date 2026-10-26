'use strict';

// Short-lived microphone permission gate.
//
// Phase 5A is explicitly opt-in: the renderer must ask the main process to arm
// the microphone before navigator.mediaDevices.getUserMedia({ audio: true })
// can succeed. The gate expires on its own and is bounded so a renderer bug or
// a stale session cannot leave capture armed indefinitely.
function createMicrophoneGate({
  now = () => Date.now(),
  defaultDurationMs = 4 * 60 * 60 * 1000,
  maxDurationMs = 12 * 60 * 60 * 1000,
} = {}) {
  let armedUntil = 0;

  function arm(durationMs) {
    const requested = Number(durationMs);
    const bounded = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1000), maxDurationMs)
      : defaultDurationMs;
    armedUntil = now() + bounded;
    return { ok: true, armedUntil, durationMs: bounded };
  }

  function disarm() {
    armedUntil = 0;
    return { ok: true };
  }

  function isArmed() {
    return now() < armedUntil;
  }

  function remainingMs() {
    return Math.max(0, armedUntil - now());
  }

  return { arm, disarm, isArmed, remainingMs };
}

module.exports = { createMicrophoneGate };
