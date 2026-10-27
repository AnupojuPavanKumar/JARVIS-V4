'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerFaceController = require('../backend/controllers/FaceController');
const { writePin } = require('../backend/auth/auth-store');
const { createSessionState } = require('../backend/security/session-state');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-face-controller-test-'));
}

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    on(channel, listener) { listeners.set(channel, listener); },
    invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, payload);
    },
    send(channel, payload) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`No listener for ${channel}`);
      return listener({}, payload);
    },
  };
}

function embedding(value = 1) {
  return new Array(128).fill(0).map((_, index) => (index === 0 ? value : 0.01));
}

function makeHarness(dir, overrides = {}) {
  const ipcMain = fakeIpc();
  const clock = { now: 1_000_000 };
  const calls = {
    arm: 0,
    disarm: 0,
    armTtl: null,
    start: [],
    stop: [],
    events: [],
    enrolled: [],
    verified: [],
  };
  const storeStatus = {
    ok: true,
    available: true,
    enrolled: true,
    enabled: true,
    samples: 3,
    threshold: 0.5,
  };
  const faceStore = {
    encryptionAvailable: () => true,
    getStatus: async () => ({ ...storeStatus }),
    verify: async value => {
      calls.verified.push(value);
      return { ok: true, similarity: 0.82, threshold: 0.5, samples: 3 };
    },
    enroll: async embeddings => {
      calls.enrolled.push(embeddings);
      return { ok: true, status: { ...storeStatus, enrolled: true, samples: embeddings.length } };
    },
    setEnabled: async enabled => {
      storeStatus.enabled = enabled;
      return { ok: true, status: { ...storeStatus } };
    },
    remove: async () => {
      storeStatus.enrolled = false;
      storeStatus.enabled = false;
      storeStatus.samples = 0;
      return { ok: true, status: { ...storeStatus } };
    },
    ...overrides.faceStore,
  };
  const sessionState = overrides.sessionState
    || createSessionState({ initial: overrides.locked === false ? 'unlocked' : 'locked' });
  const faceEnrollmentState = { active: false, until: 0 };
  const faceModelServer = {
    isAvailable: () => true,
    getBaseUrl: () => 'http://127.0.0.1:43210/models/',
    ...overrides.faceModelServer,
  };
  let cameraArmed = false;
  const verifier = {
    isAvailable: () => true,
    start: async payload => {
      calls.start.push(payload);
      return { ok: true, expiresAt: payload.deadline };
    },
    stop: reason => { calls.stop.push(reason); },
    ...overrides.verifier,
  };
  const controller = registerFaceController({
    ipcMain,
    app: { getPath: () => dir },
    faceStore,
    faceModelServer,
    sessionState,
    faceEnrollmentState,
    secAudit: () => {},
    mainWindowProvider: overrides.mainWindowProvider
      || (() => ({ isDestroyed: () => false, isVisible: () => true })),
    verifier,
    armCamera: ttl => {
      calls.arm += 1;
      calls.armTtl = ttl;
      cameraArmed = true;
    },
    disarmCamera: () => {
      calls.disarm += 1;
      cameraArmed = false;
    },
    isCameraArmed: () => cameraArmed,
    sendRenderer: (channel, payload) => calls.events.push({ channel, payload }),
    now: () => clock.now,
    challengeTtlMs: overrides.challengeTtlMs ?? 30_000,
  });
  return {
    ipcMain,
    sessionState,
    faceEnrollmentState,
    calls,
    faceStore,
    verifier,
    controller,
    clock,
    isCameraArmed: () => cameraArmed,
    setCameraArmed: value => { cameraArmed = value === true; },
  };
}

async function startVerifier(harness, purpose = 'unlock') {
  const started = await harness.ipcMain.invoke('face-start-verifier', { purpose });
  assert.equal(started.ok, true, started.error);
  const challenge = harness.calls.start[harness.calls.start.length - 1];
  assert.ok(challenge, 'verifier.start must receive the challenge');
  return { started, challenge };
}

function unlockResult(challenge, overrides = {}) {
  return {
    nonce: challenge.nonce,
    purpose: 'unlock',
    liveness: true,
    embedding: embedding(),
    ...overrides,
  };
}

test('face controller: status exposes configuration but never embeddings', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);
  const status = await h.ipcMain.invoke('face-status');
  assert.equal(status.ok, true);
  assert.equal(status.available, true);
  assert.equal(status.enrolled, true);
  assert.equal(status.hasPin, true);
  assert.equal(status.lockRequired, true);
  assert.equal(status.modelBaseUrl, 'http://127.0.0.1:43210/models/');
  assert.equal('embeddings' in status, false);
});

test('face controller: unlock issues a one-time challenge and only clears the session lock', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);

  const { started, challenge } = await startVerifier(h);
  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  assert.equal(challenge.purpose, 'unlock');
  assert.equal(challenge.modelBaseUrl, 'http://127.0.0.1:43210/models/');
  assert.equal(challenge.deadline, started.expiresAt);
  assert.equal(h.calls.arm, 1);
  assert.equal(h.calls.armTtl, started.timeoutMs);
  assert.equal(h.isCameraArmed(), true);

  const result = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
  assert.equal(result.ok, true);
  assert.equal(result.purpose, 'unlock');
  assert.equal(h.sessionState.state, 'unlocked');
  assert.equal(h.isCameraArmed(), false);
  assert.ok(h.calls.verified.length === 1);
  assert.ok(h.calls.stop.includes('unlocked'));
  assert.ok(h.calls.events.some(event => (
    event.channel === 'face-verifier-outcome' && event.payload.ok === true
  )));
});

test('face controller: a verifier result is one-time and cannot be replayed', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);
  const { challenge } = await startVerifier(h);
  const first = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
  assert.equal(first.ok, true);

  const replay = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
  assert.equal(replay.ok, false);
  assert.match(replay.error, /No active face challenge/);
  assert.equal(h.calls.verified.length, 1);
});

test('face controller: wrong nonce, purpose, and missing camera lease are rejected', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');

  const wrongNonce = makeHarness(dir);
  const nonceRun = await startVerifier(wrongNonce);
  const badNonce = await wrongNonce.ipcMain.invoke(
    'face-verifier-result',
    unlockResult(nonceRun.challenge, { nonce: 'f'.repeat(64) })
  );
  assert.equal(badNonce.ok, false);
  assert.match(badNonce.error, /challenge is invalid/);
  assert.equal(wrongNonce.calls.verified.length, 0);
  const consumed = await wrongNonce.ipcMain.invoke(
    'face-verifier-result',
    unlockResult(nonceRun.challenge)
  );
  assert.match(consumed.error, /No active face challenge/);

  const wrongPurpose = makeHarness(dir);
  const purposeRun = await startVerifier(wrongPurpose);
  const badPurpose = await wrongPurpose.ipcMain.invoke(
    'face-verifier-result',
    unlockResult(purposeRun.challenge, { purpose: 'enroll' })
  );
  assert.equal(badPurpose.ok, false);
  assert.match(badPurpose.error, /purpose does not match/);

  const lease = makeHarness(dir);
  const leaseRun = await startVerifier(lease);
  lease.setCameraArmed(false);
  const noLease = await lease.ipcMain.invoke(
    'face-verifier-result',
    unlockResult(leaseRun.challenge)
  );
  assert.equal(noLease.ok, false);
  assert.match(noLease.error, /camera lease expired/);
  assert.equal(lease.calls.verified.length, 0);
});

test('face controller: an expired challenge is rejected before template comparison', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { challengeTtlMs: 1000 });
  const { started, challenge } = await startVerifier(h);
  h.clock.now = started.expiresAt + 1;
  const expired = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);
  assert.equal(h.calls.verified.length, 0);
});

test('face controller: liveness is required and does not unlock', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);
  const { challenge } = await startVerifier(h);
  const result = await h.ipcMain.invoke(
    'face-verifier-result',
    unlockResult(challenge, { liveness: false })
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Liveness/);
  assert.equal(h.sessionState.state, 'locked');
  assert.equal(h.calls.verified.length, 0);
});

test('face controller: a changed session state invalidates an in-flight unlock', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);
  const { challenge } = await startVerifier(h);
  h.sessionState.unlock('PIN entered');
  const result = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
  assert.equal(result.ok, false);
  assert.match(result.error, /already unlocked/);
  assert.equal(h.calls.verified.length, 0);
});

test('face controller: failed unlocks are rate-limited after five attempts', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, {
    faceStore: { verify: async () => ({ ok: false, similarity: 0.1, threshold: 0.5 }) },
  });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(h.sessionState.state, 'locked');
    const { challenge } = await startVerifier(h);
    const result = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
    assert.equal(result.ok, false);
    assert.equal(h.sessionState.state, 'locked');
  }
  const limited = await h.ipcMain.invoke('face-start-verifier', { purpose: 'unlock' });
  assert.equal(limited.ok, false);
  assert.equal(limited.rateLimited, true);
  assert.equal(h.calls.start.length, 5);
});

test('face controller: verifier unavailable disables face unlock instead of falling back', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { verifier: { isAvailable: () => false } });
  const status = await h.ipcMain.invoke('face-status');
  assert.equal(status.available, false);
  assert.match(status.error, /Trusted face verifier is unavailable/);

  const started = await h.ipcMain.invoke('face-start-verifier', { purpose: 'unlock' });
  assert.equal(started.ok, false);
  assert.match(started.error, /use your PIN/);
  assert.equal(h.calls.arm, 0);
});

test('face controller: verifier must start before a challenge can be used', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, {
    verifier: { start: async () => ({ ok: false, error: 'Trusted face verifier could not start' }) },
  });
  const started = await h.ipcMain.invoke('face-start-verifier', { purpose: 'unlock' });
  assert.equal(started.ok, false);
  assert.equal(h.isCameraArmed(), false);
  const result = await h.ipcMain.invoke('face-verifier-result', {
    nonce: 'a'.repeat(64),
    purpose: 'unlock',
    liveness: true,
    embedding: embedding(),
  });
  assert.match(result.error, /No active face challenge/);
});

test('face controller: overlapping starts are rejected', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);
  let release;
  h.verifier.start = payload => new Promise(resolve => {
    release = () => resolve({ ok: true, expiresAt: payload.deadline });
  });

  const first = h.ipcMain.invoke('face-start-verifier', { purpose: 'unlock' });
  await new Promise(resolve => setImmediate(resolve));
  const second = await h.ipcMain.invoke('face-start-verifier', { purpose: 'unlock' });
  assert.equal(second.ok, false);
  assert.match(second.error, /already starting/);
  release();
  assert.equal((await first).ok, true);
});

test('face controller: hidden or missing main window denies camera use', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, {
    mainWindowProvider: () => ({ isDestroyed: () => false, isVisible: () => false }),
  });
  const result = await h.ipcMain.invoke('face-start-verifier', { purpose: 'unlock' });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be visible/);
  assert.equal(h.calls.arm, 0);
});

test('face controller: enrollment requires a PIN, an active session, and the verifier boundary', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { locked: false });

  const begin = await h.ipcMain.invoke('face-begin-enrollment');
  assert.equal(begin.ok, true);
  assert.equal('token' in begin, false, 'enrollment token must stay in main');
  assert.equal(h.faceEnrollmentState.active, true);

  const { challenge } = await startVerifier(h, 'enroll');
  assert.equal(challenge.purpose, 'enroll');

  const noLiveness = await h.ipcMain.invoke('face-verifier-result', {
    nonce: challenge.nonce,
    purpose: 'enroll',
    liveness: false,
    embeddings: [embedding()],
  });
  assert.equal(noLiveness.ok, false);
  assert.equal(h.faceEnrollmentState.active, false, 'a rejected enrollment consumes the session');
  assert.equal(h.calls.enrolled.length, 0);
});

test('face controller: successful enrollment stores samples and clears the session', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { locked: false });

  const begin = await h.ipcMain.invoke('face-begin-enrollment');
  assert.equal(begin.ok, true);
  const { challenge } = await startVerifier(h, 'enroll');
  const result = await h.ipcMain.invoke('face-verifier-result', {
    nonce: challenge.nonce,
    purpose: 'enroll',
    liveness: true,
    embeddings: [embedding(1), embedding(0.9), embedding(0.8)],
  });
  assert.equal(result.ok, true);
  assert.equal(result.purpose, 'enroll');
  assert.equal(result.status.enrolled, true);
  assert.equal(h.calls.enrolled.length, 1);
  assert.equal(h.calls.enrolled[0].length, 3);
  assert.equal(h.faceEnrollmentState.active, false);
  assert.equal(h.isCameraArmed(), false);
});

test('face controller: enrollment needs a usable PIN and a privileged session', async t => {
  const withoutPinDir = tempDir();
  t.after(() => fs.rmSync(withoutPinDir, { recursive: true, force: true }));
  const withoutPin = makeHarness(withoutPinDir, { locked: false });
  const noPin = await withoutPin.ipcMain.invoke('face-begin-enrollment');
  assert.equal(noPin.ok, false);
  assert.match(noPin.error, /PIN/i);

  const lockedDir = tempDir();
  t.after(() => fs.rmSync(lockedDir, { recursive: true, force: true }));
  await writePin(lockedDir, '1234');
  const locked = makeHarness(lockedDir);
  const lockedBegin = await locked.ipcMain.invoke('face-begin-enrollment');
  assert.equal(lockedBegin.ok, false);
  assert.match(lockedBegin.error, /Unlock JARVIS/);
  const lockedStart = await locked.ipcMain.invoke('face-start-verifier', { purpose: 'enroll' });
  assert.equal(lockedStart.ok, false);
  assert.match(lockedStart.error, /Unlock JARVIS/);
});

test('face controller: cancelled or stale enrollment cannot be completed later', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { locked: false });

  const begin = await h.ipcMain.invoke('face-begin-enrollment');
  assert.equal(begin.ok, true);
  const { challenge } = await startVerifier(h, 'enroll');
  await h.ipcMain.invoke('face-cancel-enrollment');
  assert.equal(h.faceEnrollmentState.active, false);

  const cancelled = await h.ipcMain.invoke('face-verifier-result', {
    nonce: challenge.nonce,
    purpose: 'enroll',
    liveness: true,
    embeddings: [embedding()],
  });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /No active face challenge/);

  const restarted = await h.ipcMain.invoke('face-start-verifier', { purpose: 'enroll' });
  assert.equal(restarted.ok, false);
  assert.match(restarted.error, /Enrollment session expired/);
  assert.equal(h.calls.enrolled.length, 0);
});

test('face controller: enrollment challenge expires with the main-owned clock', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { locked: false, challengeTtlMs: 1000 });
  await h.ipcMain.invoke('face-begin-enrollment');
  const { started, challenge } = await startVerifier(h, 'enroll');
  h.clock.now = started.expiresAt + 1;
  const result = await h.ipcMain.invoke('face-verifier-result', {
    nonce: challenge.nonce,
    purpose: 'enroll',
    liveness: true,
    embeddings: [embedding()],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/);
  assert.equal(h.calls.enrolled.length, 0);
});

test('face controller: progress is display-only, bounded, and tied to the challenge', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);

  h.ipcMain.send('face-verifier-progress', { message: 'POSITION YOUR FACE', progress: 42 });
  assert.equal(h.calls.events.length, 0, 'progress without a challenge is ignored');

  const { challenge } = await startVerifier(h);
  h.ipcMain.send('face-verifier-progress', {
    message: `  ${'X'.repeat(200)}  `,
    progress: 140,
    embedding: embedding(),
  });
  const status = h.calls.events.find(event => event.channel === 'face-verifier-status');
  assert.ok(status);
  assert.equal(status.payload.purpose, 'unlock');
  assert.equal(status.payload.message.length, 90);
  assert.equal(status.payload.progress, 100);
  assert.equal('embedding' in status.payload, false);

  h.ipcMain.send('face-verifier-progress', { message: '', progress: 10 });
  assert.equal(h.calls.events.filter(event => event.channel === 'face-verifier-status').length, 1);
  assert.ok(challenge.nonce);
});

test('face controller: unexpected verifier stop consumes the challenge and disarms', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir);
  const { challenge } = await startVerifier(h);

  assert.equal(h.controller.handleVerifierStopped('expired'), true);
  assert.equal(h.isCameraArmed(), false);
  assert.ok(h.calls.events.some(event => (
    event.channel === 'face-verifier-stop' && event.payload.reason === 'expired'
  )));
  assert.equal(h.controller.handleVerifierStopped('expired'), false);

  const result = await h.ipcMain.invoke('face-verifier-result', unlockResult(challenge));
  assert.match(result.error, /No active face challenge/);
  assert.equal(h.calls.verified.length, 0);
});

test('face controller: delete requires the current PIN and removes the profile', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { locked: false });
  const wrong = await h.ipcMain.invoke('face-delete', { pin: '0000' });
  assert.equal(wrong.ok, false);
  const removed = await h.ipcMain.invoke('face-delete', { pin: '1234' });
  assert.equal(removed.ok, true);
  assert.equal(removed.status.enrolled, false);
  assert.equal(h.sessionState.lockRequired, true);
});

test('face controller: enable toggle requires an unlocked session', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const h = makeHarness(dir, { locked: true });
  const locked = await h.ipcMain.invoke('face-set-enabled', { enabled: false });
  assert.equal(locked.ok, false);
  h.sessionState.unlock('test');
  const unlocked = await h.ipcMain.invoke('face-set-enabled', { enabled: false });
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.status.enabled, false);
});
