/*
 * JARVIS local face unlock — display-only renderer.
 *
 * The main renderer never receives camera frames, runs face inference, or
 * submits embeddings. Camera capture, liveness, and embedding generation live
 * in a separate sandboxed verifier webContents. This module only starts or
 * cancels a verifier attempt and presents non-sensitive status on the existing
 * lock screen and enrollment modal.
 *
 * Face verification can only clear the UI session lock. It is deliberately not
 * connected to approvals, command execution, integrations, or agent actions.
 */

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const state = {
  initialized: false,
  status: null,
  running: false,
  mode: null,
  scanId: 0,
  setupActive: false,
  autoSuppressed: false,
  windowVisible: true,
  booted: false,
  autoTimer: null,
  unlockTimer: null,
  pinKeyHandler: null,
  settingsObserver: null,
  setupObserver: null,
  toastTimer: null,
  toastHideTimer: null,
  lastStatusText: '',
  enrollExpiresAt: 0,
};

const $ = id => document.getElementById(id);

function authScreen() {
  return $('auth-screen');
}

function authScreenVisible() {
  const screen = authScreen();
  return !!screen && !screen.classList.contains('hidden');
}

function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `show ${type}`;
  clearTimeout(state.toastTimer);
  clearTimeout(state.toastHideTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.add('hide');
    state.toastHideTimer = setTimeout(() => { toast.className = ''; }, 300);
  }, 3200);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHidden(id, hidden) {
  const el = $(id);
  if (el) el.classList.toggle('hidden', !!hidden);
}

function showAuthError(message) {
  const el = $('auth-face-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function showSetupError(message) {
  const el = $('face-setup-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function openFaceSetupModal() {
  const modal = $('face-setup-modal');
  if (modal) modal.hidden = false;
}

function setAuthStatus(message) {
  if (state.lastStatusText === message) return;
  state.lastStatusText = message;
  setText('auth-face-status', message);
  const live = $('auth-face-live');
  if (live && !live.classList.contains('hidden') && authScreenVisible()) {
    setText('auth-subtitle', message);
  }
}

function setSetupStatus(message) {
  setText('face-setup-status', message);
}

function faceConfigured() {
  return !!(
    state.status
    && state.status.ok !== false
    && state.status.available !== false
    && state.status.enrolled === true
    && state.status.enabled === true
  );
}

function faceStatusUsable() {
  return !!(state.status && state.status.ok !== false && state.status.available !== false);
}

async function refreshStatus() {
  if (!window.jarvis || typeof window.jarvis.faceStatus !== 'function') return null;
  try {
    const result = await window.jarvis.faceStatus();
    state.status = result || null;
  } catch (error) {
    state.status = {
      ok: false,
      available: false,
      enrolled: false,
      enabled: false,
      error: String(error && error.message || error),
    };
  }
  updateAuthFacePanel();
  renderSettings();
  return state.status;
}

function updateAuthFacePanel() {
  const panel = $('auth-face-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !faceConfigured());
  if (!faceConfigured()) {
    setHidden('auth-face-live', true);
    setHidden('auth-face-btn', true);
    setHidden('auth-face-cancel', true);
    return;
  }
  if (!state.running) {
    setHidden('auth-face-live', true);
    setHidden('auth-face-btn', false);
    setHidden('auth-face-cancel', true);
    showAuthError('');
    setAuthStatus('LOCAL FACE SCAN READY');
  }
}

function renderSettings() {
  const enabled = $('cfg-face-enabled');
  const statusLine = $('face-settings-status');
  const enrollBtn = $('face-enroll-btn');
  const deleteBtn = $('face-delete-btn');
  if (!enabled || !statusLine || !enrollBtn || !deleteBtn) return;
  const status = state.status;
  const showDeletePin = !!(status && status.enrolled === true && status.hasPin === true);
  setHidden('face-delete-pin', !showDeletePin);
  if (!status) {
    statusLine.textContent = 'Face unlock status unavailable.';
    enabled.disabled = true;
    enrollBtn.disabled = true;
    deleteBtn.disabled = true;
    return;
  }
  if (status.available === false || status.ok === false) {
    const reason = status.error || 'Local face verifier unavailable.';
    statusLine.textContent = reason;
    enabled.checked = false;
    enabled.disabled = true;
    enrollBtn.disabled = true;
    deleteBtn.disabled = !status.enrolled;
    return;
  }
  const enrolled = status.enrolled === true;
  enabled.checked = enrolled && status.enabled === true;
  enabled.disabled = !enrolled;
  enrollBtn.disabled = false;
  enrollBtn.textContent = enrolled ? 'RE-ENROLL FACE' : 'ENROLL FACE';
  deleteBtn.disabled = !enrolled;
  if (!status.hasPin) {
    statusLine.textContent = 'A 4-digit PIN is required before face enrollment.';
  } else if (enrolled) {
    statusLine.textContent = `Face profile encrypted locally · ${status.samples || 0} template${(status.samples || 0) === 1 ? '' : 's'} · ${status.enabled ? 'enabled' : 'disabled'}`;
  } else {
    statusLine.textContent = 'No face enrolled. Set up face unlock to use the camera on the lock screen.';
  }
}

function installAuthUnlockWrapper() {
  if (!window.Auth || window.Auth.__jarvisFaceWrapped) return;
  const originalUnlock = window.Auth._unlock.bind(window.Auth);
  window.Auth._unlock = function faceAwareUnlock() {
    if (state.booted) {
      hideAuthScreen();
      return;
    }
    state.booted = true;
    originalUnlock();
  };
  window.Auth.__jarvisFaceWrapped = true;
}

function hideAuthScreen() {
  const screen = authScreen();
  if (!screen) return;
  removePinKeyHandler();
  clearTimeout(state.autoTimer);
  state.autoTimer = null;
  screen.classList.add('unlocking');
  clearTimeout(state.unlockTimer);
  state.unlockTimer = setTimeout(() => {
    screen.classList.add('hidden');
    screen.classList.remove('unlocking');
    state.unlockTimer = null;
  }, 600);
}

function showLockScreen() {
  const screen = authScreen();
  if (!screen) return;
  clearTimeout(state.unlockTimer);
  state.unlockTimer = null;
  screen.classList.remove('hidden', 'unlocking');
  if (window.Auth) {
    window.Auth._input = '';
    if (typeof window.Auth._updateDots === 'function') window.Auth._updateDots();
  }
  setText('auth-subtitle', 'IDENTITY VERIFICATION REQUIRED');
  setText('auth-hint', faceConfigured() ? 'Enter your PIN or use face unlock' : 'Enter your 4-digit PIN to access JARVIS');
  setHidden('auth-error', true);
  setHidden('auth-setup', true);
  showAuthError('');
  addPinKeyHandler();
  updateAuthFacePanel();
  if (state.windowVisible && faceConfigured() && !state.autoSuppressed) {
    scheduleAutoScan(450);
  }
}

function addPinKeyHandler() {
  if (state.pinKeyHandler) return;
  // Auth owns the initial lock screen. Reuse its handler instead of attaching a
  // second keydown listener that would type every digit twice.
  if (window.Auth && typeof window.Auth._keyHandler === 'function') return;
  state.pinKeyHandler = event => {
    if (!authScreenVisible()) return;
    const target = event.target;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (event.key >= '0' && event.key <= '9') {
      event.preventDefault();
      cancelScanForPin();
      if (window.Auth) window.Auth.pressKey(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      cancelScanForPin();
      if (window.Auth) window.Auth.pressKey('clear');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      cancelScanForPin();
      if (window.Auth) window.Auth.pressKey('enter');
    }
  };
  document.addEventListener('keydown', state.pinKeyHandler);
}

function removePinKeyHandler() {
  if (!state.pinKeyHandler) return;
  document.removeEventListener('keydown', state.pinKeyHandler);
  state.pinKeyHandler = null;
}

function cancelScanForPin() {
  if (!state.running || state.mode !== 'unlock') return;
  state.autoSuppressed = true;
  cancelVerifier('pin');
  updateAuthFacePanel();
  setAuthStatus('PIN ENTRY');
}

function scheduleAutoScan(delayMs) {
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(() => {
    state.autoTimer = null;
    if (!state.windowVisible || !authScreenVisible() || state.autoSuppressed) return;
    if (!faceConfigured() || state.running) return;
    startScan('unlock');
  }, Math.max(0, delayMs || 0));
}

function bindAuthButtons() {
  $('auth-face-btn')?.addEventListener('click', () => {
    state.autoSuppressed = false;
    showAuthError('');
    startScan('unlock');
  });
  $('auth-face-cancel')?.addEventListener('click', () => {
    state.autoSuppressed = true;
    cancelVerifier('cancelled');
    updateAuthFacePanel();
    setAuthStatus('PIN ENTRY');
  });
  // A physical PIN keypad press is an explicit request to stop the camera.
  $('auth-keypad')?.addEventListener('pointerdown', cancelScanForPin, true);
  $('auth-keypad')?.addEventListener('click', cancelScanForPin, true);
  document.addEventListener('keydown', event => {
    if (!authScreenVisible() || !state.running || state.mode !== 'unlock') return;
    const target = event.target;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if ((event.key >= '0' && event.key <= '9') || event.key === 'Backspace' || event.key === 'Enter') {
      cancelScanForPin();
    }
  }, true);
}

function bindSettings() {
  $('cfg-face-enabled')?.addEventListener('change', async event => {
    const enabled = event.target.checked;
    if (!window.jarvis || typeof window.jarvis.faceSetEnabled !== 'function') return;
    const result = await window.jarvis.faceSetEnabled({ enabled }).catch(error => ({ ok: false, error: String(error) }));
    if (!result || !result.ok) {
      event.target.checked = !enabled;
      showToast(result?.error || 'Could not update face unlock.', 'error');
      await refreshStatus();
      return;
    }
    state.status = result.status || state.status;
    updateAuthFacePanel();
    renderSettings();
    showToast(enabled ? 'Face unlock enabled.' : 'Face unlock disabled; PIN still required.', 'success');
  });
  $('face-enroll-btn')?.addEventListener('click', beginEnrollment);
  $('face-delete-btn')?.addEventListener('click', deleteFaceProfile);
  $('face-pin-save')?.addEventListener('click', savePinAndContinue);
  $('face-setup-cancel')?.addEventListener('click', () => {
    cancelEnrollment();
    window.closeModal?.('face-setup-modal');
  });
  $('face-setup-close')?.addEventListener('click', () => {
    state.setupActive = false;
    window.closeModal?.('face-setup-modal');
  });
  $('face-setup-modal')?.addEventListener('click', event => {
    if (event.target && event.target.classList.contains('modal-backdrop')) {
      cancelEnrollment();
    }
  });
}

function observeModals() {
  const settings = $('settings-modal');
  if (settings) {
    state.settingsObserver = new MutationObserver(() => {
      if (!settings.hidden) refreshStatus();
    });
    state.settingsObserver.observe(settings, { attributes: true, attributeFilter: ['hidden'] });
  }
  const setup = $('face-setup-modal');
  if (setup) {
    state.setupObserver = new MutationObserver(() => {
      if (setup.hidden && state.setupActive) {
        cancelEnrollment();
      }
    });
    state.setupObserver.observe(setup, { attributes: true, attributeFilter: ['hidden'] });
  }
}

function installVisibilityListeners() {
  window.jarvis?.onAuthLock?.(() => {
    state.autoSuppressed = false;
    // A startup lock arrives before the first boot; treat only a completed boot
    // as evidence that the next unlock is a tray re-open.
    state.booted = state.booted || window.__jarvisBooted === true;
    const setupWasOpen = state.setupActive;
    cancelEnrollment(false);
    if (setupWasOpen) window.closeModal?.('face-setup-modal');
    cancelVerifier('lock');
    showLockScreen();
  });
  window.jarvis?.onAppVisibility?.(payload => {
    state.windowVisible = payload.visible === true;
    if (!state.windowVisible) {
      const setupWasOpen = state.setupActive;
      cancelEnrollment(false);
      if (setupWasOpen) window.closeModal?.('face-setup-modal');
      cancelVerifier('hidden');
      return;
    }
    if (authScreenVisible() && faceConfigured() && !state.autoSuppressed) {
      scheduleAutoScan(350);
    }
  });
  document.addEventListener('visibilitychange', () => {
    state.windowVisible = !document.hidden;
    if (!state.windowVisible) {
      const setupWasOpen = state.setupActive;
      cancelEnrollment(false);
      if (setupWasOpen) window.closeModal?.('face-setup-modal');
      cancelVerifier('hidden');
    } else if (authScreenVisible() && faceConfigured() && !state.autoSuppressed) {
      scheduleAutoScan(350);
    }
  });
}

function installVerifierListeners() {
  window.jarvis?.onFaceVerifierStatus?.(payload => {
    if (!state.running) return;
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (message) setStatus(state.mode, message);
    if (Number.isFinite(payload.progress)) setProgress(payload.progress);
  });
  window.jarvis?.onFaceVerifierOutcome?.(payload => {
    if (!state.running) return;
    if (payload.purpose && state.mode && payload.purpose !== state.mode) return;
    if (state.mode === 'enroll') finishEnrollment(payload);
    else if (state.mode === 'unlock') finishUnlock(payload);
  });
  window.jarvis?.onFaceVerifierStop?.(payload => {
    if (!state.running) return;
    // Replacing one attempt with a newer one is not a user-visible failure.
    if (payload.reason === 'replaced' || payload.reason === 'enrollment-restarted') return;
    const mode = state.mode;
    state.running = false;
    state.mode = null;
    state.scanId += 1;
    if (mode === 'unlock') {
      state.autoSuppressed = true;
      showAuthLive(false);
      showAuthError('Face scan stopped. Use your PIN or try again.');
      setAuthStatus('PIN REQUIRED');
    } else if (mode === 'enroll') {
      showSetupCamera(true);
      setSetupStatus('ENROLLMENT STOPPED');
      showSetupError('Face enrollment stopped. Try again.');
      setProgress(0);
    }
  });
}

async function beginEnrollment() {
  if (state.setupActive || state.running) return;
  showSetupError('');
  await refreshStatus();
  if (!faceStatusUsable()) {
    showToast(state.status?.error || 'Local face verifier unavailable.', 'error');
    return;
  }
  state.setupActive = true;
  state.autoSuppressed = true;
  state.enrollExpiresAt = 0;
  setHidden('face-setup-pin', true);
  setHidden('face-setup-camera', true);
  setHidden('face-setup-done', true);
  showSetupError('');
  openFaceSetupModal();
  if (!state.status?.hasPin) {
    // P0-2: creating the fallback PIN is a first-run/setup-only operation.
    // An unlocked or explicit no-lock settings session cannot promote itself
    // to a new credential from the face-enrollment dialog.
    showSetupError('Face unlock requires a PIN created during first-run setup. Use local recovery if the PIN is unavailable.');
    return;
  }
  await startEnrollmentCamera();
}

async function savePinAndContinue() {
  const errorEl = $('face-pin-error');
  if (errorEl) {
    errorEl.textContent = 'Face unlock requires a PIN created during first-run setup.';
    errorEl.classList.remove('hidden');
  }
}

async function startEnrollmentCamera() {
  setHidden('face-setup-pin', true);
  setHidden('face-setup-done', true);
  setHidden('face-setup-camera', false);
  showSetupError('');
  setSetupStatus('STARTING ISOLATED LOCAL ENROLLMENT…');
  if (!window.jarvis || typeof window.jarvis.faceBeginEnrollment !== 'function') {
    showSetupError('Face enrollment is unavailable.');
    return;
  }
  const begin = await window.jarvis.faceBeginEnrollment().catch(error => ({ ok: false, error: String(error) }));
  if (!begin || !begin.ok) {
    setSetupStatus('ENROLLMENT UNAVAILABLE');
    showSetupError(begin?.error || 'Could not start face enrollment.');
    return;
  }
  state.enrollExpiresAt = Number(begin.expiresAt) || 0;
  await startScan('enroll');
}

async function deleteFaceProfile() {
  if (!state.status?.enrolled) return;
  let pin;
  if (state.status.hasPin) {
    const pinInput = $('face-delete-pin');
    pin = pinInput?.value?.trim() || '';
    if (!/^\d{4}$/.test(pin)) {
      showToast('Enter your current 4-digit PIN to remove face data.', 'error');
      pinInput?.focus();
      return;
    }
  }
  const result = await window.jarvis.faceDelete({ pin }).catch(error => ({ ok: false, error: String(error) }));
  if (!result || !result.ok) {
    showToast(result?.error || 'Could not remove face data.', 'error');
    return;
  }
  const pinInput = $('face-delete-pin');
  if (pinInput) pinInput.value = '';
  state.status = result.status || state.status;
  updateAuthFacePanel();
  renderSettings();
  showToast('Face data removed. PIN unlock remains available.', 'success');
}

function setProgress(percent) {
  const bar = $('face-progress-bar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function showAuthLive(show) {
  setHidden('auth-face-live', !show);
  setHidden('auth-face-btn', show);
  setHidden('auth-face-cancel', !show);
  state.lastStatusText = '';
  if (show) {
    setAuthStatus('POSITION YOUR FACE');
  } else {
    setText('auth-subtitle', 'IDENTITY VERIFICATION REQUIRED');
  }
}

function showSetupCamera(show) {
  setHidden('face-setup-camera', !show);
  if (show) setProgress(0);
}

function setStatus(mode, message) {
  if (mode === 'enroll') setSetupStatus(message);
  else setAuthStatus(message);
}

function cancelVerifier(reason) {
  const wasRunning = state.running;
  state.running = false;
  state.mode = null;
  state.scanId += 1;
  if (wasRunning) {
    try { window.jarvis?.faceCancelVerifier?.().catch?.(() => {}); } catch (_) { /* best effort */ }
  }
  if (authScreenVisible()) {
    showAuthLive(false);
    if (!faceConfigured()) setHidden('auth-face-panel', true);
  }
  if (state.setupActive) {
    setSetupStatus('SCAN STOPPED');
    setProgress(0);
  }
  return wasRunning;
}

async function cancelEnrollment(cancelToken = true) {
  const wasActive = state.setupActive || state.enrollExpiresAt > 0;
  state.setupActive = false;
  state.enrollExpiresAt = 0;
  if (state.running && state.mode === 'enroll') {
    cancelVerifier('enrollment-cancelled');
  }
  if (cancelToken && wasActive && window.jarvis?.faceCancelEnrollment) {
    try { await window.jarvis.faceCancelEnrollment(); } catch (_) { /* best effort */ }
  }
  setHidden('face-setup-camera', true);
  setHidden('face-setup-done', true);
  setProgress(0);
}

function finishUnlock(result) {
  state.running = false;
  state.mode = null;
  state.scanId += 1;
  showAuthLive(false);
  if (!result || !result.ok) {
    state.autoSuppressed = true;
    const message = result?.rateLimited
      ? 'Too many attempts. Use your PIN or wait 15 minutes.'
      : (result?.error || 'Face not recognized. Use your PIN or try again.');
    showAuthError(message);
    setAuthStatus('PIN REQUIRED');
    return;
  }
  state.autoSuppressed = true;
  showAuthError('');
  if (state.booted || !window.Auth || typeof window.Auth._unlock !== 'function') {
    showToast('Identity confirmed. Welcome back, sir.', 'success');
  }
  if (window.Auth && typeof window.Auth._unlock === 'function') {
    window.Auth._unlock();
  } else {
    hideAuthScreen();
  }
}

function finishEnrollment(result) {
  state.running = false;
  state.mode = null;
  state.scanId += 1;
  showSetupCamera(false);
  if (!result || !result.ok) {
    setSetupStatus('ENROLLMENT FAILED');
    showSetupError(result?.error || 'Could not save the face profile.');
    return;
  }
  state.status = result.status || state.status;
  state.setupActive = false;
  setHidden('face-setup-camera', true);
  setHidden('face-setup-pin', true);
  setHidden('face-setup-done', false);
  setProgress(100);
  updateAuthFacePanel();
  renderSettings();
  showToast('Face profile encrypted locally.', 'success');
}

async function startScan(mode) {
  if (state.running) return;
  if (mode === 'unlock' && !faceConfigured()) return;
  if (mode === 'enroll' && !state.setupActive) return;
  if (!window.jarvis || typeof window.jarvis.faceStartVerifier !== 'function') {
    handleScanError(mode, new Error('Trusted face verifier is unavailable'));
    return;
  }
  const scanId = ++state.scanId;
  state.running = true;
  state.mode = mode;
  showAuthError('');
  showSetupError('');
  if (mode === 'unlock') {
    showAuthLive(true);
    setHidden('auth-face-btn', true);
    setAuthStatus('STARTING ISOLATED FACE VERIFIER…');
  } else {
    showSetupCamera(true);
    setSetupStatus('STARTING ISOLATED FACE VERIFIER…');
    setProgress(0);
  }
  let result;
  try {
    result = await window.jarvis.faceStartVerifier({ purpose: mode });
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  if (scanId !== state.scanId) {
    if (result && result.ok) {
      try { await window.jarvis.faceCancelVerifier(); } catch (_) { /* best effort */ }
    }
    return;
  }
  if (!result || !result.ok) {
    state.running = false;
    state.mode = null;
    handleScanError(mode, new Error(result?.error || 'Could not start the local face verifier'));
    return;
  }
  if (mode === 'unlock') {
    setAuthStatus('SCANNING · ISOLATED LOCAL VERIFIER');
  } else {
    setSetupStatus('POSITION YOUR FACE · ISOLATED LOCAL VERIFIER');
  }
}

function handleScanError(mode, error) {
  const message = String(error && error.message || error || 'Face scan failed');
  console.warn('[FACE]', message);
  if (mode === 'unlock') {
    state.autoSuppressed = true;
    showAuthLive(false);
    showAuthError('Face unlock unavailable. Use your PIN.');
    setAuthStatus('PIN REQUIRED');
    return;
  }
  state.running = false;
  state.mode = null;
  setSetupStatus('ENROLLMENT STOPPED');
  showSetupError(message);
  setProgress(0);
  try { window.jarvis?.faceCancelEnrollment?.().catch?.(() => {}); } catch (_) { /* best effort */ }
}

function installFaceSettings() {
  // Wait for Auth.init to make its lock decision, then expose the face panel.
  return new Promise(resolve => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    } else {
      resolve();
    }
  });
}

async function waitForAuthInit() {
  for (let i = 0; i < 40; i += 1) {
    if (window.Auth && window.Auth._keyHandler !== null && window.Auth._keyHandler !== undefined) return;
    await wait(50);
  }
}

async function init() {
  if (state.initialized) return;
  state.initialized = true;
  installAuthUnlockWrapper();
  bindAuthButtons();
  bindSettings();
  observeModals();
  installVisibilityListeners();
  installVerifierListeners();
  await installFaceSettings();
  await waitForAuthInit();
  state.booted = window.__jarvisBooted === true || (!authScreenVisible() && !document.getElementById('boot-screen'));
  state.windowVisible = typeof document.visibilityState === 'string' ? document.visibilityState === 'visible' : true;
  await refreshStatus();
  if (state.windowVisible && authScreenVisible() && faceConfigured()) {
    scheduleAutoScan(650);
  }
}

init().catch(error => {
  console.warn('[FACE] initialization failed:', error);
});
