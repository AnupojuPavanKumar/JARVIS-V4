/**
 * Face unlock IPC controller.
 *
 * Scope is intentionally narrow: face verification may only clear the
 * renderer's session lock. It is never wired to approvals, shell commands,
 * integrations, or any other privileged action. Those continue to require the
 * existing explicit approval flow.
 */

const { randomBytes } = require('crypto');
const { getAuthStatus, verifyPin } = require('../auth/auth-store');

const FACE_MAX_ATTEMPTS = 5;
const FACE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_TTL_MS = 2 * 60 * 1000;
const CAMERA_ARM_MS = 15000;

module.exports = function registerFaceController({
  ipcMain,
  app,
  faceStore,
  faceModelServer,
  sessionState,
  faceEnrollmentState,
  secAudit,
  mainWindowProvider,
  armCamera,
  disarmCamera,
}) {
  let faceAttempts = [];
  let enrollment = null;
  if (!sessionState || typeof sessionState.state !== 'string') {
    throw new TypeError('sessionState is required');
  }
  const state = sessionState;
  const isLocked = () => state.locked === true;
  const enrollmentStatus = faceEnrollmentState || {
    active: false,
    until: 0,
  };

  const authStatus = () => getAuthStatus(app.getPath('userData'));

  function rateLimitOk() {
    const now = Date.now();
    faceAttempts = faceAttempts.filter(timestamp => now - timestamp < FACE_ATTEMPT_WINDOW_MS);
    return faceAttempts.length < FACE_MAX_ATTEMPTS;
  }

  function clearEnrollment() {
    enrollment = null;
    enrollmentStatus.active = false;
    enrollmentStatus.until = 0;
  }

  function unlockSession(reason) {
    return sessionState.unlock(reason);
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
    return {
      ok: storeStatus.ok !== false,
      available: storeStatus.available !== false && modelsAvailable,
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
      error: storeStatus.error || (!modelsAvailable ? 'Bundled face models are unavailable' : undefined),
    };
  }

  function validateEmbeddingPayload(payload) {
    if (!payload || typeof payload !== 'object') return 'Face payload is required';
    if (payload.liveness !== true) return 'Liveness verification is required';
    const embedding = payload.embedding;
    if (!Array.isArray(embedding) || embedding.length < 128 || embedding.length > 2048) {
      return 'A valid face embedding is required';
    }
    if (!embedding.every(value => Number.isFinite(Number(value)))) {
      return 'The face embedding contains invalid values';
    }
    return null;
  }

  function validateEmbeddingsPayload(payload) {
    if (!payload || typeof payload !== 'object') return 'Face payload is required';
    if (payload.liveness !== true) return 'Liveness verification is required';
    const embeddings = payload.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length < 1 || embeddings.length > 5) {
      return 'One to five face samples are required';
    }
    const firstLength = Array.isArray(embeddings[0]) ? embeddings[0].length : 0;
    for (const embedding of embeddings) {
      if (!Array.isArray(embedding) || embedding.length !== firstLength) {
        return 'Face samples have inconsistent dimensions';
      }
      if (embedding.length < 128 || embedding.length > 2048) {
        return 'A face sample has an unexpected length';
      }
      if (!embedding.every(value => Number.isFinite(Number(value)))) {
        return 'A face sample contains invalid values';
      }
    }
    return null;
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
      const auth = await authStatus();
      if (!auth.hasPin) {
        return { ok: false, error: 'Set a 4-digit PIN before enrolling face unlock' };
      }
      const token = randomBytes(24).toString('hex');
      enrollment = { token, expiresAt: Date.now() + ENROLLMENT_TTL_MS };
      enrollmentStatus.active = true;
      enrollmentStatus.until = enrollment.expiresAt;
      secAudit('FACE_ENROLL_BEGIN', 'local enrollment session', 'SUCCESS');
      return { ok: true, token, expiresAt: enrollment.expiresAt, modelBaseUrl: faceModelServer.getBaseUrl() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('face-cancel-enrollment', async () => {
    clearEnrollment();
    secAudit('FACE_ENROLL_CANCEL', 'enrollment session cancelled', 'OK');
    return { ok: true };
  });

  ipcMain.handle('face-enroll', async (_event, payload) => {
    try {
      if (isLocked()) return { ok: false, error: 'Unlock JARVIS before enrolling a face' };
      if (!enrollment || !enrollmentStatus.active || Date.now() > enrollment.expiresAt) {
        clearEnrollment();
        return { ok: false, error: 'Enrollment session expired' };
      }
      if (!payload || payload.token !== enrollment.token) {
        return { ok: false, error: 'Enrollment token is invalid' };
      }
      const error = validateEmbeddingsPayload(payload);
      if (error) return { ok: false, error };
      const result = await faceStore.enroll(payload.embeddings, { threshold: 0.5 });
      clearEnrollment();
      if (!result.ok) return result;
      secAudit('FACE_ENROLL', `${payload.embeddings.length} local face template(s)`, 'SUCCESS');
      return { ok: true, status: await buildStatus() };
    } catch (error) {
      clearEnrollment();
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('face-verify', async (_event, payload) => {
    try {
      if (!state?.lockRequired || !isLocked()) {
        return { ok: false, error: 'The session is already unlocked' };
      }
      if (!rateLimitOk()) {
        secAudit('FACE_VERIFY', '***', 'RATE_LIMITED');
        return { ok: false, error: 'Too many face attempts. Try again in 15 minutes.', rateLimited: true };
      }
      if (!faceStore) return { ok: false, error: 'Face profile store is unavailable' };
      const error = validateEmbeddingPayload(payload);
      if (error) {
        faceAttempts.push(Date.now());
        secAudit('FACE_VERIFY', error, 'FAIL');
        return { ok: false, error };
      }
      const result = await faceStore.verify(payload.embedding);
      if (!result.ok) {
        faceAttempts.push(Date.now());
        secAudit('FACE_VERIFY', result.error || `similarity ${result.similarity}`, 'FAIL');
        return {
          ok: false,
          error: result.error || 'Face not recognized',
          similarity: result.similarity,
          threshold: result.threshold,
        };
      }
      faceAttempts = [];
      unlockSession('face verified');
      if (typeof disarmCamera === 'function') disarmCamera();
      secAudit('FACE_VERIFY', `local match similarity ${result.similarity}`, 'SUCCESS');
      return { ok: true, similarity: result.similarity, threshold: result.threshold };
    } catch (error) {
      return { ok: false, error: error.message };
    }
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
          secAudit('FACE_DELETE', 'PIN check failed', 'FAIL');
          return { ok: false, error: 'Current PIN is incorrect' };
        }
      }
      const result = await faceStore.remove();
      if (!result.ok) return result;
      secAudit('FACE_DELETE', 'face profile removed', 'SUCCESS');
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
      const result = await faceStore.setEnabled(payload.enabled);
      if (!result.ok) return result;
      secAudit('FACE_SET_ENABLED', String(payload.enabled), 'SUCCESS');
      return { ok: true, status: await buildStatus() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('face-arm-camera', async (_event, payload = {}) => {
    try {
      const mainWindow = mainWindowProvider ? mainWindowProvider() : null;
      if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
        return { ok: false, error: 'The JARVIS window must be visible to use the camera' };
      }
      const purpose = payload.purpose;
      if (purpose === 'unlock') {
        if (!isLocked()) return { ok: false, error: 'The session is already unlocked' };
        if (!faceStore) return { ok: false, error: 'Face unlock is unavailable' };
        const status = await faceStore.getStatus();
        if (!status.ok || !status.enrolled || !status.enabled) {
          return { ok: false, error: 'Face unlock is not enabled' };
        }
      } else if (purpose === 'enroll') {
        if (isLocked()) return { ok: false, error: 'Unlock JARVIS before enrolling a face' };
        if (!enrollmentStatus.active || Date.now() > (enrollmentStatus.until || 0)) {
          return { ok: false, error: 'No active face enrollment session' };
        }
      } else {
        return { ok: false, error: 'Invalid camera purpose' };
      }
      if (typeof armCamera !== 'function') return { ok: false, error: 'Camera permission gate is unavailable' };
      armCamera(CAMERA_ARM_MS);
      secAudit('FACE_CAMERA_ARM', purpose, 'ALLOW');
      return { ok: true, timeoutMs: CAMERA_ARM_MS };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('face-disarm-camera', async () => {
    if (typeof disarmCamera === 'function') disarmCamera();
    return { ok: true };
  });
};
