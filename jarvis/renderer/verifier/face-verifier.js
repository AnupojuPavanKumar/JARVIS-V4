'use strict';

/*
 * Trusted local face verifier page.
 *
 * This page runs inside a hidden, sandboxed BrowserWindow with its own minimal
 * preload. It is the only webContents allowed camera access. It performs local
 * capture, liveness checks, and embedding generation with bundled Human/TFJS
 * models, then returns a nonce-bound result to the main process.
 *
 * Privacy rules:
 *  - Frames stay in this hidden verifier window.
 *  - Nothing is written to disk, IndexedDB, localStorage, or the network.
 *  - Only numeric embeddings or enrollment samples leave this page.
 *  - The stream and tensors are stopped/disposed on every exit path.
 */

const MIN_FACE_SIZE = 160;
const MIN_CONFIDENCE = 0.5;
const MIN_LIVENESS = 0.5;
const ENROLL_SAMPLES = 3;
const MAX_SCAN_MS = 25000;
const LOOPBACK_MODEL_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/models\/$/;

const state = {
  nonce: null,
  purpose: null,
  deadline: 0,
  modelBaseUrl: null,
  started: false,
  running: false,
  cancelled: false,
  resultSent: false,
  stream: null,
  video: null,
  human: null,
  lastTensor: null,
  lastMessage: '',
  lastProgress: null,
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function reportProgress(message, progress) {
  if (state.cancelled) return;
  const nextMessage = typeof message === 'string' ? message.slice(0, 90) : '';
  if (!nextMessage) return;
  const hasProgress = Number.isFinite(progress);
  const nextProgress = hasProgress ? Math.max(0, Math.min(100, Math.round(progress))) : null;
  if (nextMessage === state.lastMessage && nextProgress === state.lastProgress) return;
  state.lastMessage = nextMessage;
  state.lastProgress = nextProgress;
  const payload = { message: nextMessage };
  if (nextProgress !== null) payload.progress = nextProgress;
  try {
    window.faceVerifier?.reportProgress?.(payload);
  } catch (_) { /* the main process may already be closing the verifier */ }
}

function disposeLastTensor() {
  if (!state.lastTensor) return;
  try { state.human?.tf?.dispose?.(state.lastTensor); } catch (_) { /* best effort */ }
  state.lastTensor = null;
}

function stopStream() {
  if (state.stream) {
    try { state.stream.getTracks().forEach(track => track.stop()); } catch (_) { /* best effort */ }
    state.stream = null;
  }
  if (state.video) {
    try { state.video.pause(); } catch (_) { /* best effort */ }
    try { state.video.srcObject = null; } catch (_) { /* best effort */ }
  }
}

function cleanup() {
  disposeLastTensor();
  stopStream();
}

function stop(reason) {
  if (state.cancelled) return;
  state.cancelled = true;
  state.running = false;
  state.lastMessage = '';
  state.lastProgress = null;
  cleanup();
  if (reason && !state.resultSent) {
    // No result is sent for a main-owned cancel/stop. The main process already
    // knows why the lease ended.
  }
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
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
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

async function ensureHuman(modelBaseUrl) {
  if (state.human) return state.human;
  const HumanCtor = window.Human?.Human || window.Human;
  if (typeof HumanCtor !== 'function') throw new Error('Local face engine did not initialize');
  const human = new HumanCtor({
    modelBasePath: modelBaseUrl,
    backend: 'webgl',
    cacheModels: false,
    debug: false,
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 1, minConfidence: 0.5 },
      mesh: { enabled: true },
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

async function sendResult(payload) {
  if (state.cancelled || state.resultSent) return;
  state.resultSent = true;
  try {
    await window.faceVerifier?.reportResult?.(payload);
  } catch (_) { /* the main process may already have closed the verifier */ }
}

async function runScan(human) {
  const video = state.video;
  if (!video || !human) throw new Error('Local face engine is not ready');
  const startedAt = Date.now();
  const hardStopAt = Math.min(state.deadline - 250, startedAt + MAX_SCAN_MS);
  let blinkStartedAt = 0;
  let blinkSeen = false;
  let samples = [];
  const requiredSamples = state.purpose === 'enroll' ? ENROLL_SAMPLES : 1;

  while (!state.cancelled && state.running) {
    if (Date.now() > hardStopAt) {
      throw new Error('Face scan timed out. Try again with better lighting.');
    }
    const result = await human.detect(video);
    disposeLastTensor();
    if (state.cancelled) return;
    const faces = result && Array.isArray(result.face) ? result.face : [];
    if (faces.length !== 1) {
      reportProgress('SHOW ONE FACE IN THE FRAME');
      await wait(120);
      continue;
    }

    const face = faces[0];
    if (face.tensor) state.lastTensor = face.tensor;
    const gestures = faceGestures(result);
    const blinking = isBlinkGesture(gestures);
    const now = Date.now();
    if (blinking && blinkStartedAt === 0) blinkStartedAt = now;
    if (!blinking && blinkStartedAt > 0) {
      const duration = now - blinkStartedAt;
      if (duration >= 10 && duration <= 900) blinkSeen = true;
      blinkStartedAt = 0;
    } else if (blinking && blinkStartedAt > 0 && now - blinkStartedAt > 1200) {
      blinkStartedAt = 0;
    }

    const checks = faceChecks(face, gestures);
    if (!checks.confidence) reportProgress('HOLD STILL · CHECKING FACE');
    else if (!checks.size) reportProgress('MOVE A LITTLE CLOSER');
    else if (!checks.facing) reportProgress('FACE THE CAMERA');
    else if (!checks.looking) reportProgress('LOOK AT THE SCREEN');
    else if (!checks.real || !checks.live) reportProgress('LIVENESS CHECK · HOLD STILL');
    else if (!blinkSeen) reportProgress('BLINK ONCE TO VERIFY');
    else if (!checks.embedding) reportProgress('BUILDING LOCAL EMBEDDING…');
    else {
      const embedding = Array.from(face.embedding, Number);
      if (!embedding.every(Number.isFinite)) {
        throw new Error('The local face embedding was invalid');
      }
      if (state.purpose === 'unlock') {
        reportProgress('VERIFYING LOCAL MATCH…');
        await sendResult({
          nonce: state.nonce,
          purpose: 'unlock',
          liveness: true,
          embedding,
        });
        return;
      }

      samples.push(embedding);
      const progress = Math.round((samples.length / requiredSamples) * 100);
      reportProgress(`CAPTURING SAMPLE ${samples.length}/${requiredSamples}`, progress);
      if (samples.length >= requiredSamples) {
        if (!pairwiseConsistent(samples)) {
          samples = [];
          blinkSeen = false;
          blinkStartedAt = 0;
          reportProgress('SAMPLES DID NOT MATCH · TRY AGAIN', 0);
          await wait(500);
          continue;
        }
        reportProgress('SENDING LOCAL TEMPLATE…', 100);
        await sendResult({
          nonce: state.nonce,
          purpose: 'enroll',
          liveness: true,
          embeddings: samples,
        });
        return;
      }
      await wait(600);
    }
    await wait(90);
  }
}

async function run() {
  state.running = true;
  try {
    reportProgress('REQUESTING LOCAL CAMERA…', 0);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
    } catch (_) {
      throw new Error('Camera unavailable. Use your PIN.');
    }
    state.stream = stream;
    if (state.cancelled) return;

    const video = document.getElementById('verifier-video');
    if (!video) throw new Error('Local camera surface is unavailable');
    state.video = video;
    video.srcObject = stream;
    await video.play();
    await wait(250);
    if (state.cancelled) return;

    reportProgress('LOADING LOCAL FACE ENGINE…', 0);
    const human = await ensureHuman(state.modelBaseUrl);
    if (state.cancelled) return;
    reportProgress('POSITION YOUR FACE IN THE FRAME', 0);
    await runScan(human);
  } catch (error) {
    if (state.cancelled || state.resultSent) return;
    const message = String(error && error.message || error || 'Local face scan failed').slice(0, 180);
    reportProgress(message, 0);
    await sendResult({
      nonce: state.nonce,
      purpose: state.purpose,
      error: message,
    });
  } finally {
    state.running = false;
    cleanup();
  }
}

function acceptStart(payload = {}) {
  if (state.started || state.running) return;
  const purpose = payload.purpose === 'unlock' || payload.purpose === 'enroll' ? payload.purpose : null;
  const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
  const deadline = Number(payload.deadline);
  const modelBaseUrl = typeof payload.modelBaseUrl === 'string' ? payload.modelBaseUrl : '';
  if (!purpose || nonce.length < 32 || !Number.isFinite(deadline) || deadline <= Date.now()) return;
  if (!LOOPBACK_MODEL_URL.test(modelBaseUrl)) return;

  state.started = true;
  state.cancelled = false;
  state.resultSent = false;
  state.purpose = purpose;
  state.nonce = nonce;
  state.deadline = deadline;
  state.modelBaseUrl = modelBaseUrl;
  state.lastMessage = '';
  state.lastProgress = null;
  run().catch(() => { /* run() owns error reporting and cleanup */ });
}

if (window.faceVerifier) {
  window.faceVerifier.onStart(acceptStart);
  window.faceVerifier.onStop(payload => stop(payload && payload.reason));
}
