/**
 * Face unlock IPC controller.
 *
 * Scope is intentionally narrow: face verification may only clear the
 * renderer's session lock. It is never wired to approvals, shell commands,
 * integrations, or any other privileged action. Those continue to require the
 * existing explicit approval flow.
 *
 * Trust boundary:
 *  - The main renderer never receives camera access and cannot submit an
 *    embedding or assert liveness.
 *  - A dedicated sandboxed verifier webContents performs capture, liveness, and
 *    embedding generation. Its IPC channels are restricted to that exact
 *    webContents by the main-owned IPC guard.
 *  - Main issues one-time challenges with a short expiry. Every result is bound
 *    to a nonce, purpose, session state, and an active camera lease. A challenge
 *    is consumed before any asynchronous template comparison.
 */

'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');
const { getAuthStatus, verifyPin } = require('../auth/auth-store');

const FACE_MAX_ATTEMPTS = 5;
const FACE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_CHALLENGE_TTL_MS = 30 * 1000;
const MIN_CHALLENGE_TTL_MS = 1000;
const MAX_ENROLL_SAMPLES = 5;

function nonceMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

module.exports = function registerFaceController({
  ipcMain,
  app,
  faceStore,
  faceModelServer,
  sessionState,
  faceEnrollmentState,
  secAudit,
  mainWindowProvider,
  verifier,
  armCamera,
  disarmCamera,
  isCameraArmed,
  sendRenderer,
  now = () => Date.now(),
  makeNonce = () => randomBytes(32).toString('hex'),
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('ipcMain with handle/on is required');
  }
  if (!sessionState || typeof sessionState.state !== 'string') {
    throw new TypeError('sessionState is required');
  }

  let faceAttempts = [];
  let enrollment = null;
  let activeChallenge = null;
  let startInFlight = false;
  const state = sessionState;
  const enrollmentStatus = faceEnrollmentState || { active: false, until: 0 };
  const isLocked = () => state.locked === true;
  const isPrivileged = () => state.state === 'unlocked' || state.state === 'no-lock';
  const audit = (action, detail, verdict) => {
    try { secAudit(action, detail, verdict); } catch (_) { /* audit must not break auth */ }
  };

  const authStatus = () => getAuthStatus(app.getPath('userData'));

  function notifyRenderer(channel, payload) {
    if (typeof sendRenderer !== 'function') return;
    try { sendRenderer(channel, payload); } catch (_) { /* renderer may be closing */ }
  }

  function rateLimitOk() {
    const current = now();
    faceAttempts = faceAttempts.filter(timestamp => current - timestamp < FACE_ATTEMPT_WINDOW_MS);
    return faceAttempts.length < FACE_MAX_ATTEMPTS;
  }

  function recordFailure() {
    faceAttempts.push(now());
  }

  function clearEnrollment() {
    enrollment = null;
    enrollmentStatus.active = false;
    enrollmentStatus.until = 0;
  }

  function enrollmentSessionActive() {
    return !!enrollment
      && enrollmentStatus.active === true
      && now() <= enrollment.expiresAt
      && now() <= (enrollmentStatus.until || 0);
  }

  function disarm() {
    if (typeof disarmCamera === 'function') {
      try { disarmCamera(); } catch (_) { /* best effort */ }
    }
  }

  function stopVerifier(reason) {
    if (verifier && typeof verifier.stop === 'function') {
      try { verifier.stop(reason); } catch (_) { /* best effort */ }
    }
    disarm();
  }

  function cancelVerifier(reason = 'cancelled') {
    const wasActive = activeChallenge !== null;
    activeChallenge = null;
    stopVerifier(reason);
    if (wasActive) notifyRenderer('face-verifier-stop', { reason });
    return wasActive;
  }

  function verifierAvailable() {
    if (!verifier || typeof verifier.start !== 'function') return false;
    if (typeof verifier.isAvailable === 'function') return verifier.isAvailable() === true;
    return true;
  }

  async function buildStatus() {
    const auth = await authStatus();
    let storeStatus;
    if (!faceStore) {
      storeStatus = {
        ok: false,
        available: false,
        enrolled: false,
        enabled: false,
        samples: 0,
        threshold: 0.5,
        error: 'Face profile store is unavailable',
      };
    } else {
      try {
        storeStatus = await faceStore.getStatus();
      } catch (error) {
        storeStatus = {
          ok: false,
          available: false,
          enrolled: false,
          enabled: false,
          samples: 0,
          threshold: 0.5,
          error: error.message,
        };
      }
    }
    const modelsAvailable = !!faceModelServer
      && typeof faceModelServer.isAvailable === 'function'
      && faceModelServer.isAvailable()
      && typeof faceModelServer.getBaseUrl === 'function'
      && !!faceModelServer.getBaseUrl();
    const trustedVerifierAvailable = verifierAvailable();
    const available = storeStatus.available !== false && modelsAvailable && trustedVerifierAvailable;
    let error = storeStatus.error;
    if (!error && !modelsAvailable) error = 'Bundled face models are unavailable';
    if (!error && !trustedVerifierAvailable) error = 'Trusted face verifier is unavailable';
    return {
      ok: storeStatus.ok !== false,
      available,
      enrolled: storeStatus.enrolled === true,
      enabled: storeStatus.enabled === true,
      samples: storeStatus.samples || 0,
      threshold: storeStatus.threshold || 0.5,
      hasPin: auth.hasPin === true,
      skipPin: auth.skipPin === true,
      lockRequired: auth.hasPin === true || storeStatus.enrolled === true,
      modelBaseUrl: faceModelServer ? faceModelServer.getBaseUrl() : null,
      createdAt: storeStatus.createdAt || null,
      updatedAt: storeStatus.updatedAt || null,
      error,
    };
  }

  function validateEmbedding(embedding) {
    if (!Array.isArray(embedding) || embedding.length < 128 || embedding.length > 2048) {
      return 'A valid face embedding is required';
    }
    if (!embedding.every(value => Number.isFinite(Number(value)))) {
      return 'The face embedding contains invalid values';
    }
    return null;
  }

  function validateEmbeddings(embeddings) {
    if (!Array.isArray(embeddings) || embeddings.length < 1 || embeddings.length > MAX_ENROLL_SAMPLES) {
      return 'One to five face samples are required';
    }
    const firstLength = Array.isArray(embeddings[0]) ? embeddings[0].length : 0;
    for (const embedding of embeddings) {
      if (!Array.isArray(embedding) || embedding.length !== firstLength) {
        return 'Face samples have inconsistent dimensions';
      }
      const error = validateEmbedding(embedding);
      if (error) return error;
    }
    return null;
  }

  function publishResult(payload) {
    notifyRenderer('face-verifier-outcome', payload);
    return payload;
  }

  ipcMain.handle('face-status', async () => {
    try {
      return await buildStatus();
    } catch (error) {
      return { ok: false, available: false, enrolled: false, enabled: false, error: error.message };
    }
  });

  ipcMain.handle('face-begin-enrollment', async () => {
    try {
      if (isLocked()) return { ok: false, error: 'Unlock JARVIS before enrolling a face' };
      if (!faceStore || !faceStore.encryptionAvailable()) {
        return { ok: false, error: 'OS encryption is unavailable; face data cannot be stored' };
      }
      if (!faceModelServer || faceModelServer.isAvailable() !== true) {
        return { ok: false, error: 'Bundled face models are unavailable' };
      }
      if (!verifierAvailable()) {
        return { ok: false, error: 'Trusted face verifier is unavailable' };
      }
      const auth = await authStatus();
      if (!auth.hasPin) {
        return { ok: false, error: 'Set a 4-digit PIN before enrolling face unlock' };
      }
      cancelVerifier('enrollment-restarted');
      const token = randomBytes(24).toString('hex');
      enrollment = { token, expiresAt: now() + ENROLLMENT_TTL_MS };
      enrollmentStatus.active = true;
      enrollmentStatus.until = enrollment.expiresAt;
      audit('FACE_ENROLL_BEGIN', 'local enrollment session', 'SUCCESS');
      return {
        ok: true,
        expiresAt: enrollment.expiresAt,
        timeoutMs: ENROLLMENT_TTL_MS,
      };
    } catch (error) {
      clearEnrollment();
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('face-cancel-enrollment', async () => {
    const wasActive = !!enrollment || enrollmentStatus.active === true;
    clearEnrollment();
    cancelVerifier('enrollment-cancelled');
    if (wasActive) audit('FACE_ENROLL_CANCEL', 'enrollment session cancelled', 'OK');
    return { ok: true };
  });

  ipcMain.handle('face-start-verifier', async (_event, payload = {}) => {
    if (startInFlight) {
      return { ok: false, error: 'A face attempt is already starting' };
    }
    startInFlight = true;
    try {
      const purpose = payload && typeof payload === 'object' ? payload.purpose : null;
      if (purpose !== 'unlock' && purpose !== 'enroll') {
        return { ok: false, error: 'Invalid face camera purpose' };
      }
      const mainWindow = mainWindowProvider ? mainWindowProvider() : null;
      if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
        return { ok: false, error: 'The JARVIS window must be visible to use the camera' };
      }
      if (!verifierAvailable()) {
        return { ok: false, error: 'Trusted face verifier is unavailable; use your PIN' };
      }
      if (!faceModelServer || faceModelServer.isAvailable() !== true || !faceModelServer.getBaseUrl()) {
        return { ok: false, error: 'Bundled face models are unavailable' };
      }
      if (typeof armCamera !== 'function') {
        return { ok: false, error: 'Camera permission gate is unavailable' };
      }

      let ttl = challengeTtlMs;
      if (purpose === 'unlock') {
        if (!state.lockRequired || !isLocked()) {
          return { ok: false, error: 'The session is already unlocked' };
        }
        if (!rateLimitOk()) {
          audit('FACE_VERIFY', '***', 'RATE_LIMITED');
          return { ok: false, error: 'Too many face attempts. Try again in 15 minutes.', rateLimited: true };
        }
        if (!faceStore) return { ok: false, error: 'Face profile store is unavailable' };
        if (typeof faceStore.encryptionAvailable === 'function' && !faceStore.encryptionAvailable()) {
          return { ok: false, error: 'OS encryption is unavailable; face unlock is disabled' };
        }
        const status = await faceStore.getStatus();
        if (!status || status.ok === false || status.enrolled !== true || status.enabled !== true) {
          return { ok: false, error: 'Face unlock is not enabled' };
        }
      } else {
        if (!isPrivileged()) {
          return { ok: false, error: 'Unlock JARVIS before enrolling a face' };
        }
        if (!enrollmentSessionActive()) {
          clearEnrollment();
          return { ok: false, error: 'Enrollment session expired' };
        }
        if (!faceStore || (typeof faceStore.encryptionAvailable === 'function' && !faceStore.encryptionAvailable())) {
          return { ok: false, error: 'OS encryption is unavailable; face data cannot be stored' };
        }
        const auth = await authStatus();
        if (!auth.hasPin) {
          return { ok: false, error: 'Set a 4-digit PIN before enrolling face unlock' };
        }
        const remaining = enrollment.expiresAt - now();
        ttl = Math.max(MIN_CHALLENGE_TTL_MS, Math.min(challengeTtlMs, remaining));
      }

      cancelVerifier('replaced');
      const nonce = makeNonce();
      if (typeof nonce !== 'string' || nonce.length < 32) {
        return { ok: false, error: 'Could not create a face challenge' };
      }
      const challenge = {
        nonce,
        purpose,
        issuedAt: now(),
        expiresAt: now() + ttl,
        enrollmentToken: purpose === 'enroll' ? enrollment.token : null,
      };
      activeChallenge = challenge;
      armCamera(ttl);
      const started = await verifier.start({
        purpose,
        nonce,
        deadline: challenge.expiresAt,
        modelBaseUrl: faceModelServer.getBaseUrl(),
      });
      if (!started || started.ok === false) {
        activeChallenge = null;
        disarm();
        return { ok: false, error: (started && started.error) || 'The face verifier could not start' };
      }
      audit('FACE_VERIFIER_START', purpose, 'ALLOW');
      return {
        ok: true,
        purpose,
        expiresAt: challenge.expiresAt,
        timeoutMs: ttl,
      };
    } catch (error) {
      if (activeChallenge) {
        activeChallenge = null;
        stopVerifier('start-failed');
      }
      return { ok: false, error: error.message };
    } finally {
      startInFlight = false;
    }
  });

  function rejectResult(purpose, error, extra = {}) {
    stopVerifier('result-rejected');
    if (purpose === 'enroll') clearEnrollment();
    const payload = { ok: false, purpose, error, ...extra };
    audit('FACE_VERIFY', error, 'FAIL');
    return publishResult(payload);
  }

  ipcMain.handle('face-verifier-result', async (_event, payload = {}) => {
    const challenge = activeChallenge;
    // Consume the challenge before any asynchronous work. A replayed result
    // finds no active challenge even if template comparison is still running.
    activeChallenge = null;

    if (!challenge) {
      audit('FACE_VERIFIER_RESULT', 'no active challenge', 'FAIL');
      return { ok: false, error: 'No active face challenge' };
    }

    const purpose = challenge.purpose;
    try {
      if (!payload || typeof payload !== 'object') {
        return rejectResult(purpose, 'Invalid face verifier result');
      }
      if (!nonceMatches(challenge.nonce, payload.nonce)) {
        return rejectResult(purpose, 'Face challenge is invalid');
      }
      if (payload.purpose !== purpose) {
        return rejectResult(purpose, 'Face challenge purpose does not match');
      }
      if (now() > challenge.expiresAt) {
        return rejectResult(purpose, 'Face challenge expired');
      }
      if (typeof isCameraArmed !== 'function' || isCameraArmed() !== true) {
        return rejectResult(purpose, 'Face camera lease expired');
      }
      if (payload.error) {
        stopVerifier('verifier-error');
        const error = String(payload.error).slice(0, 240) || 'Face verifier failed';
        const result = { ok: false, purpose, error };
        audit('FACE_VERIFIER_RESULT', error, 'FAIL');
        return publishResult(result);
      }
      if (payload.liveness !== true) {
        if (purpose === 'unlock') recordFailure();
        return rejectResult(purpose, 'Liveness verification is required');
      }

      if (purpose === 'unlock') {
        if (!state.lockRequired || !isLocked()) {
          return rejectResult(purpose, 'The session is already unlocked');
        }
        if (!rateLimitOk()) {
          return rejectResult(purpose, 'Too many face attempts. Try again in 15 minutes.', { rateLimited: true });
        }
        const error = validateEmbedding(payload.embedding);
        if (error) {
          recordFailure();
          return rejectResult(purpose, error);
        }
        if (!faceStore) {
          return rejectResult(purpose, 'Face profile store is unavailable');
        }
        const embedding = payload.embedding.map(Number);
        const result = await faceStore.verify(embedding);
        if (!result.ok) {
          recordFailure();
          const message = result.error || 'Face not recognized';
          stopVerifier('verification-failed');
          const response = {
            ok: false,
            purpose,
            error: message,
            similarity: result.similarity,
            threshold: result.threshold,
          };
          audit('FACE_VERIFY', result.error || `similarity ${result.similarity}`, 'FAIL');
          return publishResult(response);
        }
        faceAttempts = [];
        state.unlock('face verified');
        stopVerifier('unlocked');
        audit('FACE_VERIFY', `local match similarity ${result.similarity}`, 'SUCCESS');
        const response = {
          ok: true,
          purpose,
          similarity: result.similarity,
          threshold: result.threshold,
        };
        return publishResult(response);
      }

      // Enrollment is only valid while the session is privileged and the
      // one-time enrollment session is still open. The challenge carries the
      // enrollment token, so a stale verifier result cannot enroll later.
      if (!isPrivileged()) {
        return rejectResult(purpose, 'Unlock JARVIS before enrolling a face');
      }
      if (!enrollmentSessionActive()) {
        return rejectResult(purpose, 'Enrollment session expired');
      }
      if (!challenge.enrollmentToken || challenge.enrollmentToken !== enrollment.token) {
        return rejectResult(purpose, 'Enrollment session is invalid');
      }
      const error = validateEmbeddings(payload.embeddings);
      if (error) {
        return rejectResult(purpose, error);
      }
      if (!faceStore) {
        return rejectResult(purpose, 'Face profile store is unavailable');
      }
      const embeddings = payload.embeddings.map(embedding => embedding.map(Number));
      const result = await faceStore.enroll(embeddings, { threshold: 0.5 });
      clearEnrollment();
      if (!result.ok) {
        return rejectResult(purpose, result.error || 'Could not store the face profile');
      }
      stopVerifier('enrolled');
      audit('FACE_ENROLL', `${embeddings.length} local face template(s)`, 'SUCCESS');
      return publishResult({
        ok: true,
        purpose,
        status: await buildStatus(),
      });
    } catch (error) {
      if (purpose === 'enroll') clearEnrollment();
      stopVerifier('error');
      audit('FACE_VERIFIER_RESULT', error.message, 'ERROR');
      return publishResult({ ok: false, purpose, error: error.message });
    }
  });

  // Display-only status from the trusted verifier. It cannot change session
  // state or carry face data; the main renderer only renders the text.
  ipcMain.on('face-verifier-progress', (_event, payload = {}) => {
    if (!activeChallenge) return;
    if (!payload || typeof payload !== 'object') return;
    const message = typeof payload.message === 'string'
      ? payload.message.trim().slice(0, 90)
      : '';
    if (!message) return;
    const progress = Number(payload.progress);
    const status = { purpose: activeChallenge.purpose, message };
    if (Number.isFinite(progress)) {
      status.progress = Math.max(0, Math.min(100, Math.round(progress)));
    }
    notifyRenderer('face-verifier-status', status);
  });

  ipcMain.handle('face-cancel-verifier', async () => {
    const cancelled = cancelVerifier('renderer-cancelled');
    return { ok: true, cancelled };
  });

  ipcMain.handle('face-delete', async (_event, payload = {}) => {
    try {
      if (isLocked()) return { ok: false, error: 'Unlock JARVIS before removing face data' };
      if (!faceStore) return { ok: false, error: 'Face profile store is unavailable' };
      const auth = await authStatus();
      if (auth.hasPin) {
        if (typeof payload.pin !== 'string') {
          return { ok: false, error: 'Current PIN is required to remove face data' };
        }
        const pinResult = await verifyPin(app.getPath('userData'), payload.pin);
        if (!pinResult.ok) {
          audit('FACE_DELETE', 'PIN check failed', 'FAIL');
          return { ok: false, error: 'Current PIN is incorrect' };
        }
      }
      cancelVerifier('profile-delete');
      const result = await faceStore.remove();
      if (!result.ok) return result;
      audit('FACE_DELETE', 'face profile removed', 'SUCCESS');
      return { ok: true, status: await buildStatus() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('face-set-enabled', async (_event, payload = {}) => {
    try {
      if (isLocked()) return { ok: false, error: 'Unlock JARVIS before changing face settings' };
      if (!faceStore) return { ok: false, error: 'Face profile store is unavailable' };
      if (typeof payload.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be a boolean' };
      }
      if (!payload.enabled) cancelVerifier('face-disabled');
      const result = await faceStore.setEnabled(payload.enabled);
      if (!result.ok) return result;
      audit('FACE_SET_ENABLED', String(payload.enabled), 'SUCCESS');
      return { ok: true, status: await buildStatus() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // The verifier surface calls this when its window closes, crashes, or reaches
  // the main-owned deadline. A cancelled challenge must never remain usable.
  function handleVerifierStopped(reason = 'stopped') {
    if (!activeChallenge) return false;
    const purpose = activeChallenge.purpose;
    activeChallenge = null;
    disarm();
    if (purpose === 'enroll') clearEnrollment();
    const safeReason = String(reason || 'stopped').slice(0, 80);
    audit('FACE_VERIFIER_STOP', `${purpose}:${safeReason}`, 'INFO');
    notifyRenderer('face-verifier-stop', { purpose, reason: safeReason });
    return true;
  }

  return Object.freeze({
    cancelVerifier,
    verifierAvailable,
    handleVerifierStopped,
  });
};
