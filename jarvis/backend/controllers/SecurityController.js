const path = require('path');
const fs = require('fs');
const {
  AUTH_STATUS,
  PIN_RE,
  createPinRateLimiter,
  readAuth,
  resetAuth,
  verifyPin,
  writePin,
  writeSkipPin,
} = require('../auth/auth-store');
const { PROFILE_FILE: FACE_PROFILE_FILE } = require('../face/face-profile-store');
const {
  buildConsentRequest,
  createCapabilityStore,
  isCapabilityId,
} = require('../security/capability-store');

// Durable audit evidence is required only for capabilities that create
// terminal, screen, or file-export effects. Microphone and face camera paths
// stay independent so PIN/face unlock remains available when audit storage is
// degraded.
const AUDIT_SCOPED_CAPABILITIES = Object.freeze([
  'terminal',
  'screen-capture',
  'export-save',
]);

module.exports = function registerSecurityController({
  ipcMain,
  app,
  dialog = null,
  mainWindowProvider = () => null,
  secAudit,
  sessionState = null,
  faceStore = null,
  capabilityStore = null,
  pinRateLimiter = null,
  auditStatus = null,
}) {
  const state = sessionState;
  const capabilities = capabilityStore || createCapabilityStore({ audit: secAudit });
  const rateLimiter = pinRateLimiter || createPinRateLimiter({
    userDataPath: app.getPath('userData'),
  });
  const currentState = () => (typeof state?.state === 'string' ? state.state : null);
  const unlockAfterCredential = reason => {
    if (sessionState && typeof sessionState.unlock === 'function') {
      return sessionState.unlock(reason);
    }
    return false;
  };
  const enterNoLock = reason => {
    if (sessionState && typeof sessionState.markNoLock === 'function') {
      return sessionState.markNoLock(reason);
    }
  };
  const lockAfterSetup = reason => {
    if (sessionState && typeof sessionState.markLocked === 'function') {
      return sessionState.markLocked(reason);
    }
    return false;
  };
  const enterError = reason => {
    if (sessionState && typeof sessionState.enterError === 'function') {
      return sessionState.enterError(reason);
    }
    return false;
  };
  
  // ─── Main-owned capability broker ────────────────────────────────
  // sec-config.json is legacy input only. It is never copied into live policy
  // and it can never enable terminal or screen capture by itself.
  const secConfigFile = () => path.join(app.getPath('userData'), 'sec-config.json');
  const securityPreferencesFile = () => path.join(app.getPath('userData'), 'security-preferences.json');
  const LEGACY_NOTICE_KEY = 'legacyCapabilityNoticeAcknowledged';

  const auditStatusView = () => {
    if (typeof auditStatus === 'function') {
      try {
        return auditStatus();
      } catch (error) {
        return Object.freeze({
          durable: false,
          mode: 'memory',
          integrity: 'unavailable',
          warning: `Audit status could not be read: ${error.message}`,
          reason: error.message,
        });
      }
    }
    return auditStatus && typeof auditStatus === 'object' ? auditStatus : null;
  };

  const auditUnavailable = () => {
    const view = auditStatusView();
    return !!(view && view.durable === false);
  };

  const scopedByAudit = capabilityId => AUDIT_SCOPED_CAPABILITIES.includes(capabilityId);

  const capabilityPayload = extra => {
    const audit = auditStatusView();
    return {
      ok: true,
      state: currentState(),
      capabilities: capabilities.snapshot(),
      ...(audit ? { audit } : {}),
      ...extra,
    };
  };

  const capabilityDenied = (error, extra = {}) => {
    const audit = auditStatusView();
    return {
      ok: false,
      error,
      state: currentState(),
      capabilities: capabilities.snapshot(),
      ...(audit ? { audit } : {}),
      ...extra,
    };
  };

  async function readJsonFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async function readLegacySecurityConfig() {
    const raw = await readJsonFile(secConfigFile());
    if (!raw || typeof raw !== 'object') {
      return { detected: false, terminalRequested: false, screenCaptureRequested: false };
    }
    return {
      detected: true,
      terminalRequested: raw.terminalEnabled === true,
      screenCaptureRequested: raw.screenCaptureEnabled === true,
    };
  }

  async function readSecurityPreferences() {
    const raw = await readJsonFile(securityPreferencesFile());
    return raw && typeof raw === 'object' ? raw : {};
  }

  async function writeSecurityPreferences(preferences) {
    try {
      await fs.promises.writeFile(
        securityPreferencesFile(),
        JSON.stringify(preferences, null, 2),
        'utf8',
      );
    } catch (error) {
      secAudit('SECURITY_PREFERENCES_WRITE', error.message, 'ERROR');
    }
  }

  function showLegacyNotice(legacy) {
    if (!dialog || typeof dialog.showMessageBox !== 'function') return null;
    const win = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
    if (!win || win.isDestroyed?.()) return null;
    return dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Keep access disabled'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'JARVIS — Legacy Security Settings',
      message: 'Legacy security settings cannot grant capabilities.',
      detail: [
        'JARVIS found an older sec-config.json that requested:',
        legacy.terminalRequested ? '- terminal command execution' : null,
        legacy.screenCaptureRequested ? '- screen capture' : null,
        '',
        'Those old settings are treated as untrusted information and have not been applied. Request terminal or screenshot access from the Security panel, where main will ask for native consent.',
      ].filter(Boolean).join('\n'),
    });
  }

  async function showLegacyNoticeOnce(legacy) {
    if (!legacy.terminalRequested && !legacy.screenCaptureRequested) return;
    const preferences = await readSecurityPreferences();
    if (preferences[LEGACY_NOTICE_KEY] === true) return;
    try {
      const shown = showLegacyNotice(legacy);
      if (!shown) return;
      await shown;
      preferences[LEGACY_NOTICE_KEY] = true;
      await writeSecurityPreferences(preferences);
      secAudit('LEGACY_CONFIG_IGNORED', 'legacy capability settings kept disabled', 'WARN');
    } catch (error) {
      secAudit('LEGACY_CONFIG_NOTICE', error.message, 'WARN');
    }
  }

  ipcMain.handle('security-get', async () => {
    const legacy = await readLegacySecurityConfig();
    await showLegacyNoticeOnce(legacy);
    const preferences = await readSecurityPreferences();
    return capabilityPayload({
      legacy: {
        detected: legacy.detected,
        terminalRequested: legacy.terminalRequested,
        screenCaptureRequested: legacy.screenCaptureRequested,
        ignored: true,
        noticeAcknowledged: preferences[LEGACY_NOTICE_KEY] === true,
      },
    });
  });

  ipcMain.handle('security-request', async (_, payload = {}) => {
    if (!state || state.canUsePrivileges !== true) {
      secAudit('CAPABILITY_REQUEST', 'session is not privileged', 'DENIED');
      return capabilityDenied('Unlock JARVIS before requesting capabilities');
    }
    const capabilityId = payload && typeof payload === 'object' ? payload.capability : null;
    if (!isCapabilityId(capabilityId)) {
      secAudit('CAPABILITY_REQUEST', String(capabilityId), 'DENIED');
      return capabilityDenied('Unknown capability');
    }
    if (scopedByAudit(capabilityId) && auditUnavailable()) {
      secAudit('CAPABILITY_REQUEST', `${capabilityId}: durable audit unavailable`, 'DENIED');
      return capabilityDenied('Audit logging is unavailable; this capability is disabled');
    }
    const current = capabilities.status(capabilityId);
    if (!current.requestable) {
      secAudit('CAPABILITY_REQUEST', capabilityId, 'DENIED');
      return capabilityDenied('This capability is not directly requestable');
    }
    if (current.granted) {
      return capabilityPayload();
    }

    let consent;
    try {
      consent = buildConsentRequest(capabilityId);
    } catch (error) {
      secAudit('CAPABILITY_REQUEST', `${capabilityId}: ${error.message}`, 'DENIED');
      return capabilityDenied(error.message);
    }

    const win = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
    if (!dialog || typeof dialog.showMessageBox !== 'function'
      || !win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      secAudit('CAPABILITY_REQUEST', `${capabilityId}: no native consent surface`, 'DENIED');
      return capabilityDenied('Native permission dialog is unavailable');
    }

    let approved = false;
    try {
      const result = await dialog.showMessageBox(win, consent);
      approved = !!result && result.response === 0;
    } catch (error) {
      secAudit('CAPABILITY_REQUEST', `${capabilityId}: ${error.message}`, 'DENIED');
      return capabilityDenied('Permission dialog failed');
    }

    if (!approved) {
      secAudit('CAPABILITY_DENY', capabilityId, 'DENIED');
      return capabilityDenied('Permission denied', { denied: true });
    }

    if (scopedByAudit(capabilityId) && auditUnavailable()) {
      secAudit('CAPABILITY_REQUEST', `${capabilityId}: durable audit unavailable after consent`, 'DENIED');
      return capabilityDenied('Audit logging became unavailable; this capability was not granted');
    }

    capabilities.grant(capabilityId);
    return capabilityPayload();
  });

  ipcMain.handle('security-revoke', async (_, payload = {}) => {
    if (payload && payload.all === true) {
      capabilities.revokeAll('renderer requested revoke');
      return capabilityPayload();
    }
    const capabilityId = payload && typeof payload === 'object' ? payload.capability : null;
    if (!isCapabilityId(capabilityId)) {
      return capabilityDenied('Unknown capability');
    }
    capabilities.revoke(capabilityId, 'renderer requested revoke');
    return capabilityPayload();
  });

  ipcMain.handle('sec-classify-command', async (_, cmd) => {
    const { classifyCommand } = require('../../ipc-policy');
    const v = classifyCommand(cmd);
    return { verdict: v };
  });

  // ─── Authentication ──────────────────────────────────────────────
  // The PIN is the fallback whenever face unlock is enrolled. Face setup is
  // blocked in FaceController unless a usable PIN already exists. Auth state
  // transitions are main-owned; the renderer only receives command-specific
  // results and can never write the credential file directly.
  async function showAuthConfirmation({ title, message, detail, auditAction, auditTarget }) {
    if (!dialog || typeof dialog.showMessageBox !== 'function') {
      secAudit(auditAction, auditTarget, 'BLOCKED - native confirmation unavailable');
      return false;
    }
    const win = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      secAudit(auditAction, auditTarget, 'BLOCKED - confirmation window unavailable');
      return false;
    }
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Continue', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title,
        message,
        detail,
      });
      return !!result && result.response === 0;
    } catch (error) {
      secAudit(auditAction, `${auditTarget}: ${error.message}`, 'BLOCKED - confirmation failed');
      return false;
    }
  }

  function rateLimitResponse(limit) {
    if (limit && limit.error) {
      enterError('PIN rate limiter metadata is unavailable');
      secAudit('AUTH_RATE_LIMIT', limit.error, 'FAIL_CLOSED');
      return {
        ok: false,
        error: 'Authentication state is unreadable. Local recovery is required.',
        rateLimited: true,
        recoveryRequired: true,
        limiterDegraded: true,
      };
    }
    secAudit('AUTH_VERIFY', '***', 'RATE_LIMITED');
    return {
      ok: false,
      error: 'Too many PIN attempts. Try again in 15 minutes.',
      rateLimited: true,
      retryAfterMs: limit ? limit.retryAfterMs : 0,
    };
  }

  ipcMain.handle('auth-load', async () => {
    try {
      const auth = await readAuth(app.getPath('userData'));
      const payload = {
        ok: auth.ok === true,
        state: currentState(),
        status: auth.status,
        data: auth.ok
          ? {
            hasPin: auth.hasPin === true,
            skipPin: auth.skipPin === true,
            status: auth.status,
            recoveredFromBackup: auth.recoveredFromBackup === true,
          }
          : null,
      };
      if (!auth.ok) {
        payload.error = auth.error || 'Auth record is corrupt';
        payload.recoveryRequired = true;
      }
      return payload;
    } catch (error) {
      enterError('Auth status read failed');
      return {
        ok: false,
        state: currentState(),
        status: AUTH_STATUS.CORRUPT,
        data: null,
        error: error.message,
        recoveryRequired: true,
      };
    }
  });

  ipcMain.handle('auth-setup-pin', async (_, payload = {}) => {
    if (currentState() !== 'setup') {
      secAudit('AUTH_SETUP_PIN', 'setup requested outside first-run setup', 'DENIED');
      return { ok: false, error: 'PIN setup is only available during first-run setup' };
    }
    try {
      const auth = await readAuth(app.getPath('userData'));
      if (!auth.ok) {
        return { ok: false, error: 'Auth file is corrupt. Local recovery is required.', recoveryRequired: true };
      }
      if (auth.status !== AUTH_STATUS.MISSING || auth.exists) {
        return { ok: false, error: 'A credential already exists. Use the lock screen to unlock.' };
      }
      const pin = payload && payload.pin;
      if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
        return { ok: false, error: 'PIN must be exactly 4 digits' };
      }
      const written = await writePin(app.getPath('userData'), pin);
      if (!written.ok) {
        secAudit('AUTH_SETUP_PIN', written.error, 'FAIL');
        return { ok: false, error: written.error || 'Could not save PIN' };
      }
      // A newly stored PIN always requires one verification. Setup must not
      // auto-unlock the session.
      if (!lockAfterSetup('first-run PIN stored; PIN entry required')) {
        enterError('Session could not transition to locked after PIN setup');
        return { ok: false, error: 'PIN saved, but the session could not be locked. Restart JARVIS.' };
      }
      secAudit('AUTH_SETUP_PIN', 'first-run PIN stored', 'SUCCESS');
      return { ok: true, state: currentState(), requiresUnlock: true };
    } catch (error) {
      secAudit('AUTH_SETUP_PIN', error.message, 'ERROR');
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('auth-skip', async () => {
    if (currentState() !== 'setup') {
      secAudit('AUTH_SKIP', 'skip requested outside first-run setup', 'DENIED');
      return { ok: false, error: 'Skipping the PIN is only available during first-run setup' };
    }
    try {
      const auth = await readAuth(app.getPath('userData'));
      if (!auth.ok || auth.status !== AUTH_STATUS.MISSING || auth.exists) {
        return { ok: false, error: 'A credential already exists; the PIN cannot be skipped' };
      }

      let faceStatus = null;
      const faceProfilePath = path.join(app.getPath('userData'), FACE_PROFILE_FILE);
      if (faceStore && typeof faceStore.getStatus === 'function') {
        faceStatus = await faceStore.getStatus();
        const unreadableProfile = faceStatus && faceStatus.available === false && fs.existsSync(faceProfilePath);
        if (!faceStatus || faceStatus.ok !== true || faceStatus.enrolled || unreadableProfile) {
          secAudit('AUTH_SKIP', 'face profile unavailable or enrolled', 'DENIED');
          return { ok: false, error: 'Remove face unlock before skipping the PIN' };
        }
      } else if (fs.existsSync(faceProfilePath)) {
        secAudit('AUTH_SKIP', 'face profile file present', 'DENIED');
        return { ok: false, error: 'Remove face unlock before skipping the PIN' };
      }

      const approved = await showAuthConfirmation({
        title: 'JARVIS — Skip PIN Protection',
        message: 'Run JARVIS without a local lock?',
        detail: [
          'This stores an explicit no-PIN choice for this Windows account.',
          'Anyone who can use this Windows account will be able to open JARVIS without a PIN or face check.',
          'Terminal and screen-capture permissions remain separately controlled by native confirmations.',
        ].join('\n'),
        auditAction: 'AUTH_SKIP',
        auditTarget: 'explicit no-lock choice',
      });
      if (!approved) {
        secAudit('AUTH_SKIP', 'native confirmation cancelled', 'DENIED');
        return { ok: false, error: 'PIN skip cancelled' };
      }

      const written = await writeSkipPin(app.getPath('userData'));
      if (!written.ok) {
        secAudit('AUTH_SKIP', written.error, 'FAIL');
        return { ok: false, error: written.error || 'Could not save skip choice' };
      }
      if (!enterNoLock('explicit no-lock choice confirmed natively')) {
        enterError('Session could not enter no-lock mode after skip');
        return { ok: false, error: 'Skip choice saved, but the session could not unlock. Restart JARVIS.' };
      }
      secAudit('AUTH_SKIP', 'explicit no-lock choice confirmed natively', 'SUCCESS');
      return { ok: true, state: currentState() };
    } catch (error) {
      secAudit('AUTH_SKIP', error.message, 'ERROR');
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('auth-verify', async (_, pin) => {
    if (currentState() !== 'locked') {
      return { ok: false, error: 'No locked session is available', state: currentState() };
    }
    try {
      const limit = await rateLimiter.check();
      if (!limit.allowed) return rateLimitResponse(limit);

      const auth = await readAuth(app.getPath('userData'));
      if (!auth.ok || auth.status !== AUTH_STATUS.USABLE_PIN) {
        enterError('No usable PIN record while locked');
        secAudit('AUTH_VERIFY', auth.error || auth.status, 'FAIL_CLOSED');
        return {
          ok: false,
          error: 'No usable PIN is available. Local recovery is required.',
          recoveryRequired: true,
        };
      }
      if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
        secAudit('AUTH_VERIFY', 'invalid PIN format', 'FAIL');
        return { ok: false, error: 'Invalid PIN format' };
      }

      const result = await verifyPin(app.getPath('userData'), pin);
      if (!result.ok) {
        const recorded = await rateLimiter.recordFailure();
        secAudit('AUTH_VERIFY', '***', 'FAIL');
        return {
          ok: false,
          error: result.error || 'Incorrect PIN',
          limiterDegraded: recorded.degraded === true,
        };
      }

      const cleared = await rateLimiter.clear();
      secAudit('AUTH_VERIFY', '***', 'SUCCESS');
      unlockAfterCredential('PIN verified');
      return {
        ok: true,
        state: currentState(),
        limiterDegraded: cleared.degraded === true,
      };
    } catch (error) {
      secAudit('AUTH_VERIFY', error.message, 'ERROR');
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('auth-change-pin', async (_, payload = {}) => {
    if (currentState() !== 'unlocked') {
      return { ok: false, error: 'PIN changes require an unlocked session', state: currentState() };
    }
    try {
      const limit = await rateLimiter.check();
      if (!limit.allowed) return rateLimitResponse(limit);

      const auth = await readAuth(app.getPath('userData'));
      if (!auth.ok || auth.status !== AUTH_STATUS.USABLE_PIN) {
        enterError('No usable PIN record while changing PIN');
        return { ok: false, error: 'No usable PIN is available. Local recovery is required.', recoveryRequired: true };
      }
      const currentPin = payload && payload.currentPin;
      const newPin = payload && payload.newPin;
      if (typeof currentPin !== 'string' || !PIN_RE.test(currentPin)) {
        return { ok: false, error: 'Current PIN must be exactly 4 digits' };
      }
      if (typeof newPin !== 'string' || !PIN_RE.test(newPin)) {
        return { ok: false, error: 'New PIN must be exactly 4 digits' };
      }

      const verified = await verifyPin(app.getPath('userData'), currentPin);
      if (!verified.ok) {
        const recorded = await rateLimiter.recordFailure();
        secAudit('AUTH_CHANGE_PIN', '***', 'FAIL');
        return {
          ok: false,
          error: 'Current PIN incorrect',
          limiterDegraded: recorded.degraded === true,
        };
      }

      const written = await writePin(app.getPath('userData'), newPin);
      if (!written.ok) {
        secAudit('AUTH_CHANGE_PIN', written.error, 'FAIL');
        return { ok: false, error: written.error || 'Could not save new PIN' };
      }
      const cleared = await rateLimiter.clear();
      secAudit('AUTH_CHANGE_PIN', '***', 'SUCCESS');
      return {
        ok: true,
        state: currentState(),
        limiterDegraded: cleared.degraded === true,
      };
    } catch (error) {
      secAudit('AUTH_CHANGE_PIN', error.message, 'ERROR');
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('auth-recover-reset', async () => {
    if (currentState() !== 'error') {
      return { ok: false, error: 'Local recovery is only available from the auth error state' };
    }
    const approved = await showAuthConfirmation({
      title: 'JARVIS — Reset Local Lock',
      message: 'Delete the local PIN and face data?',
      detail: [
        'This deletes the JARVIS PIN file, its last-known-good backup, the persisted PIN rate-limit state, and the enrolled local face profile.',
        'Chats, documents, settings, and application files are not removed.',
        'JARVIS will return to first-run setup and require a new PIN or a new explicit skip choice.',
      ].join('\n'),
      auditAction: 'AUTH_RECOVER_RESET',
      auditTarget: 'local PIN and face data',
    });
    if (!approved) {
      secAudit('AUTH_RECOVER_RESET', 'native confirmation cancelled', 'DENIED');
      return { ok: false, error: 'Local recovery cancelled' };
    }

    try {
      let faceRemoved = false;
      if (faceStore && typeof faceStore.remove === 'function') {
        const removed = await faceStore.remove();
        if (!removed || removed.ok !== true) {
          throw new Error((removed && removed.error) || 'Could not remove face profile');
        }
        faceRemoved = true;
      }
      if (!faceRemoved) {
        await fs.promises.rm(path.join(app.getPath('userData'), FACE_PROFILE_FILE), { force: true });
      }

      const reset = await resetAuth(app.getPath('userData'));
      if (!reset.ok) throw new Error(reset.error || 'Could not reset auth store');
      try { await rateLimiter.clear(); } catch { /* the auth reset already removed the rate file */ }

      if (!state || typeof state.markSetup !== 'function' || !state.markSetup('local lock recovery completed')) {
        throw new Error('Auth data was reset, but the session could not enter setup');
      }
      secAudit('AUTH_RECOVER_RESET', 'local PIN and face data removed; setup restored', 'SUCCESS');
      return { ok: true, state: currentState() };
    } catch (error) {
      secAudit('AUTH_RECOVER_RESET', error.message, 'FAIL');
      return { ok: false, error: error.message, state: currentState() };
    }
  });

};
