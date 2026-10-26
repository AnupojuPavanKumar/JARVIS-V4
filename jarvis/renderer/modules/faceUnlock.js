/*
 * JARVIS local face unlock.
 *
 * Privacy model:
 *  - Camera access is armed only for one explicit unlock/enrollment attempt.
 *  - Inference runs locally in this renderer with bundled Human/TFJS models.
 *  - Only numeric embeddings cross IPC. Frames are never persisted or sent.
 *  - Face verification can only clear the UI session lock. It is deliberately
 *    not connected to approvals, command execution, or integrations.
 */

const FACE_MODEL_SCRIPT = 'vendor/human/human.js';
const SCAN_TIMEOUT_MS = 25000;
const MIN_FACE_SIZE = 160;
const MIN_CONFIDENCE = 0.5;
const MIN_LIVENESS = 0.5;
const ENROLL_SAMPLES = 3;

const state = {
  initialized: false,
  status: null,
  running: false,
  mode: null,
  scanId: 0,
  abort: false,
  human: null,
  stream: null,
  video: null,
  lastTensor: null,
  enrollToken: null,
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
};

const $ = id => document.getElementById(id);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    state.status = { ok: false, available: false, enrolled: false, enabled: false, error: String(error && error.message || error) };
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
  const deletePin = $('face-delete-pin');
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
    const reason = status.error || 'Local face engine unavailable.';
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
  stopScan('pin');
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
    stopScan('cancelled');
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
    showLockScreen();
  });
  window.jarvis?.onAppVisibility?.(payload => {
    state.windowVisible = payload.visible === true;
    if (!state.windowVisible) {
      const setupWasOpen = state.setupActive;
      cancelEnrollment(false);
      if (setupWasOpen) window.closeModal?.('face-setup-modal');
      stopScan('hidden');
      return;
    }
    if (authScreenVisible() && faceConfigured() && !state.autoSuppressed) {
      scheduleAutoScan(350);
    }
  });
  window.jarvis?.onFaceCameraStop?.(() => {
    const setupWasOpen = state.setupActive;
    cancelEnrollment(false);
    if (setupWasOpen) window.closeModal?.('face-setup-modal');
    stopScan('camera-stop');
  });
  document.addEventListener('visibilitychange', () => {
    state.windowVisible = !document.hidden;
    if (!state.windowVisible) {
      const setupWasOpen = state.setupActive;
      cancelEnrollment(false);
      if (setupWasOpen) window.closeModal?.('face-setup-modal');
      stopScan('hidden');
    } else if (authScreenVisible() && faceConfigured() && !state.autoSuppressed) {
      scheduleAutoScan(350);
    }
  });
}

async function beginEnrollment() {
  if (state.setupActive || state.running) return;
  showSetupError('');
  await refreshStatus();
  if (!faceStatusUsable()) {
    showToast(state.status?.error || 'Local face engine unavailable.', 'error');
    return;
  }
  state.setupActive = true;
  state.autoSuppressed = true;
  state.enrollToken = null;
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
  setSetupStatus('STARTING LOCAL ENROLLMENT…');
  if (!window.jarvis || typeof window.jarvis.faceBeginEnrollment !== 'function') {
    showSetupError('Face enrollment is unavailable.');
    return;
  }
  const begin = await window.jarvis.faceBeginEnrollment().catch(error => ({ ok: false, error: String(error) }));
  if (!begin || !begin.ok) {
    showSetupError(begin?.error || 'Could not start face enrollment.');
    setHidden('face-setup-camera', true);
    setHidden('face-setup-done', true);
    return;
  }
  state.enrollToken = begin.token;
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

async function loadHumanScript() {
  if (window.Human && (window.Human.Human || typeof window.Human === 'function')) return;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-jarvis-human]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Local face engine script failed to load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = FACE_MODEL_SCRIPT;
    script.async = true;
    script.dataset.jarvisHuman = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Local face engine script failed to load'));
    document.head.appendChild(script);
  });
}

async function ensureHuman() {
  if (state.human) return state.human;
  if (!state.status?.modelBaseUrl) throw new Error('Local face model server is unavailable');
  await loadHumanScript();
  const HumanCtor = window.Human?.Human || window.Human;
  if (typeof HumanCtor !== 'function') throw new Error('Local face engine did not initialize');
  const human = new HumanCtor({
    modelBasePath: state.status.modelBaseUrl,
    backend: 'webgl',
    cacheModels: true,
    debug: false,
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 1, minConfidence: 0.5 },
      mesh: { enabled: true },
      // Iris landmarks are required for the "looking center" check.
      iris: { enabled: true },
      emotion: { enabled: false },
      description: { enabled: true },
      antispoof: { enabled: true },
      liveness: { enabled: true },
      gear: { enabled: false },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: true },
    segmentation: { enabled: false },
  });
  await human.load();
  state.human = human;
  return human;
}

function disposeLastTensor() {
  if (!state.lastTensor || !state.human?.tf?.dispose) {
    state.lastTensor = null;
    return;
  }
  try { state.human.tf.dispose(state.lastTensor); } catch (_) { /* best effort */ }
  state.lastTensor = null;
}

async function armCamera(purpose) {
  if (!window.jarvis || typeof window.jarvis.faceArmCamera !== 'function') {
    throw new Error('Camera permission gate is unavailable');
  }
  const result = await window.jarvis.faceArmCamera({ purpose });
  if (!result || !result.ok) throw new Error(result?.error || 'Camera access was denied');
}

async function releaseCamera() {
  if (state.stream) {
    try { state.stream.getTracks().forEach(track => track.stop()); } catch (_) { /* best effort */ }
    state.stream = null;
  }
  if (state.video) {
    try { state.video.pause(); } catch (_) { /* best effort */ }
    try { state.video.srcObject = null; } catch (_) { /* best effort */ }
    state.video = null;
  }
  try { await window.jarvis?.faceDisarmCamera?.(); } catch (_) { /* best effort */ }
}

function stopScan(reason) {
  if (!state.running && !state.stream) return;
  state.abort = true;
  state.running = false;
  state.scanId += 1;
  clearTimeout(state.autoTimer);
  state.autoTimer = null;
  disposeLastTensor();
  releaseCamera();
  state.mode = null;
  if (authScreenVisible()) {
    showAuthLive(false);
    if (!faceConfigured()) setHidden('auth-face-panel', true);
  }
  if (state.setupActive) {
    setSetupStatus(reason === 'hidden' ? 'SCAN STOPPED' : 'SCAN STOPPED');
    setProgress(0);
  }
}

async function cancelEnrollment(cancelToken = true) {
  const wasActive = state.setupActive || !!state.enrollToken;
  state.setupActive = false;
  state.enrollToken = null;
  if (state.running && state.mode === 'enroll') {
    stopScan('cancelled');
  }
  if (cancelToken && wasActive && window.jarvis?.faceCancelEnrollment) {
    try { await window.jarvis.faceCancelEnrollment(); } catch (_) { /* best effort */ }
  }
  setHidden('face-setup-camera', true);
  setHidden('face-setup-done', true);
  setProgress(0);
}

function faceGestures(result) {
  const raw = result && result.gesture;
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : Object.values(raw);
  return values.map(item => item && item.gesture).filter(Boolean);
}

function isBlinkGesture(gestures) {
  return gestures.includes('blink left eye') || gestures.includes('blink right eye');
}

function faceChecks(face, gestures) {
  const box = Array.isArray(face.box) ? face.box : [];
  const width = Number(box[2]) || 0;
  const height = Number(box[3]) || 0;
  const confidence = Math.max(Number(face.faceScore) || 0, Number(face.boxScore) || 0);
  return {
    confidence: confidence >= MIN_CONFIDENCE,
    size: Math.min(width, height) >= MIN_FACE_SIZE,
    facing: gestures.includes('facing center'),
    looking: gestures.includes('looking center'),
    real: (Number(face.real) || 0) >= MIN_LIVENESS,
    live: (Number(face.live) || 0) >= MIN_LIVENESS,
    embedding: Array.isArray(face.embedding) && face.embedding.length >= 128,
  };
}

function pairwiseConsistent(samples) {
  if (samples.length < 2) return true;
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      let dot = 0;
      let left = 0;
      let right = 0;
      const a = samples[i];
      const b = samples[j];
      if (a.length !== b.length) return false;
      for (let k = 0; k < a.length; k += 1) {
        dot += a[k] * b[k];
        left += a[k] * a[k];
        right += b[k] * b[k];
      }
      if (left <= 0 || right <= 0) return false;
      if (dot / (Math.sqrt(left) * Math.sqrt(right)) < 0.55) return false;
    }
  }
  return true;
}

async function runScan(scanId, mode) {
  const video = state.video;
  const human = state.human;
  if (!video || !human) throw new Error('Local face engine is not ready');
  const startedAt = performance.now();
  let blinkStartedAt = 0;
  let blinkSeen = false;
  let embedding = null;
  let samples = [];
  const requiredSamples = mode === 'enroll' ? ENROLL_SAMPLES : 1;

  while (state.running && !state.abort && state.scanId === scanId) {
    if (performance.now() - startedAt > SCAN_TIMEOUT_MS) {
      throw new Error('Face scan timed out. Try again with better lighting.');
    }
    if (!state.windowVisible) throw new Error('The window was hidden');
    const result = await human.detect(video);
    disposeLastTensor();
    const faces = result && Array.isArray(result.face) ? result.face : [];
    if (faces.length !== 1) {
      setStatus(mode, 'SHOW ONE FACE IN THE FRAME');
      await wait(120);
      continue;
    }
    const face = faces[0];
    if (face.tensor) state.lastTensor = face.tensor;
    const gestures = faceGestures(result);
    const blinking = isBlinkGesture(gestures);
    const now = performance.now();
    if (blinking && blinkStartedAt === 0) blinkStartedAt = now;
    if (!blinking && blinkStartedAt > 0) {
      const duration = now - blinkStartedAt;
      if (duration >= 10 && duration <= 900) blinkSeen = true;
      blinkStartedAt = 0;
    } else if (blinking && blinkStartedAt > 0 && now - blinkStartedAt > 1200) {
      blinkStartedAt = 0;
    }

    const checks = faceChecks(face, gestures);
    if (!checks.confidence) setStatus(mode, 'HOLD STILL · CHECKING FACE');
    else if (!checks.size) setStatus(mode, 'MOVE A LITTLE CLOSER');
    else if (!checks.facing) setStatus(mode, 'FACE THE CAMERA');
    else if (!checks.looking) setStatus(mode, 'LOOK AT THE SCREEN');
    else if (!checks.real || !checks.live) setStatus(mode, 'LIVENESS CHECK · HOLD STILL');
    else if (!blinkSeen) setStatus(mode, 'BLINK ONCE TO VERIFY');
    else if (!checks.embedding) setStatus(mode, 'BUILDING LOCAL EMBEDDING…');
    else {
      const nextEmbedding = Array.from(face.embedding);
      if (mode === 'unlock') {
        embedding = nextEmbedding;
        break;
      }
      samples.push(nextEmbedding);
      const progress = Math.round((samples.length / requiredSamples) * 100);
      setProgress(progress);
      setStatus(mode, `CAPTURING SAMPLE ${samples.length}/${requiredSamples}`);
      if (samples.length >= requiredSamples) {
        if (!pairwiseConsistent(samples)) {
          samples = [];
          blinkSeen = false;
          setProgress(0);
          setStatus(mode, 'SAMPLES DID NOT MATCH · TRY AGAIN');
          await wait(500);
          continue;
        }
        break;
      }
      await wait(600);
    }
    await wait(90);
  }

  disposeLastTensor();
  if (state.abort || state.scanId !== scanId) return;
  if (mode === 'unlock' && embedding) {
    await finishUnlock(embedding);
    return;
  }
  if (mode === 'enroll' && samples.length >= requiredSamples) {
    await finishEnrollment(samples);
    return;
  }
  throw new Error('Face scan did not complete. Try again.');
}

function setStatus(mode, message) {
  if (mode === 'enroll') setSetupStatus(message);
  else setAuthStatus(message);
}

async function finishUnlock(embedding) {
  setAuthStatus('VERIFYING LOCAL MATCH…');
  const result = await window.jarvis.faceVerify({ embedding, liveness: true }).catch(error => ({ ok: false, error: String(error) }));
  state.running = false;
  state.abort = false;
  await releaseCamera();
  state.mode = null;
  if (!result || !result.ok) {
    state.autoSuppressed = true;
    showAuthLive(false);
    showAuthError(result?.rateLimited
      ? 'Too many attempts. Use your PIN or wait 15 minutes.'
      : 'Face not recognized. Use your PIN or try again.');
    setAuthStatus('PIN REQUIRED');
    return;
  }
  state.autoSuppressed = true;
  showAuthError('');
  showAuthLive(false);
  if (state.booted || !window.Auth || typeof window.Auth._unlock !== 'function') {
    showToast('Identity confirmed. Welcome back, sir.', 'success');
  }
  if (window.Auth && typeof window.Auth._unlock === 'function') {
    window.Auth._unlock();
  } else {
    hideAuthScreen();
  }
}

async function finishEnrollment(samples) {
  setSetupStatus('ENCRYPTING LOCAL FACE PROFILE…');
  const result = await window.jarvis.faceEnroll({
    token: state.enrollToken,
    embeddings: samples,
    liveness: true,
  }).catch(error => ({ ok: false, error: String(error) }));
  state.running = false;
  state.abort = false;
  await releaseCamera();
  state.mode = null;
  state.enrollToken = null;
  if (!result || !result.ok) {
    setStatus('enroll', 'ENROLLMENT FAILED');
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
  if (mode === 'enroll' && !state.enrollToken) return;
  const scanId = ++state.scanId;
  state.running = true;
  state.abort = false;
  state.mode = mode;
  showAuthError('');
  showSetupError('');
  if (mode === 'unlock') {
    showAuthLive(true);
    setHidden('auth-face-btn', true);
    setAuthStatus('REQUESTING LOCAL CAMERA…');
  } else {
    showSetupCamera(true);
    setSetupStatus('REQUESTING LOCAL CAMERA…');
    setProgress(0);
  }
  try {
    await armCamera(mode);
    if (scanId !== state.scanId) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
    if (scanId !== state.scanId) {
      try { stream.getTracks().forEach(track => track.stop()); } catch (_) { /* best effort */ }
      return;
    }
    state.stream = stream;
    const video = mode === 'enroll' ? $('face-setup-video') : $('auth-face-video');
    if (!video) throw new Error('Face preview is unavailable');
    state.video = video;
    video.srcObject = stream;
    await video.play();
    await wait(150);
    setStatus(mode, 'LOADING LOCAL FACE ENGINE…');
    await ensureHuman();
    if (scanId !== state.scanId) return;
    setStatus(mode, 'POSITION YOUR FACE IN THE FRAME');
    await runScan(scanId, mode);
  } catch (error) {
    if (scanId !== state.scanId) return;
    await handleScanError(mode, error);
  } finally {
    if (scanId === state.scanId) {
      state.running = false;
      state.mode = null;
      await releaseCamera();
      if (mode === 'unlock') {
        if (authScreenVisible()) {
          showAuthLive(false);
          if (!faceConfigured()) setHidden('auth-face-panel', true);
        }
      } else if (state.setupActive) {
        showSetupCamera(false);
      }
    }
  }
}

async function handleScanError(mode, error) {
  const message = String(error && error.message || error || 'Face scan failed');
  console.warn('[FACE]', message);
  if (mode === 'unlock') {
    state.autoSuppressed = true;
    showAuthLive(false);
    showAuthError(`Face unlock unavailable. Use your PIN.`);
    setAuthStatus('PIN REQUIRED');
  } else {
    setSetupStatus('ENROLLMENT STOPPED');
    showSetupError(message);
    await cancelEnrollment(true);
    if (state.setupActive) {
      setHidden('face-setup-camera', true);
    }
  }
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
