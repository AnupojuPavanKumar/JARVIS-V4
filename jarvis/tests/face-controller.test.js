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
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, payload);
    },
  };
}

function embedding(value = 1) {
  return new Array(128).fill(0).map((_, index) => (index === 0 ? value : 0.01));
}

function makeHarness(dir, overrides = {}) {
  const ipcMain = fakeIpc();
  const calls = { arm: 0, disarm: 0, enrolled: [] };
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
    verify: async () => ({ ok: true, similarity: 0.82, threshold: 0.5, samples: 3 }),
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
  registerFaceController({
    ipcMain,
    app: { getPath: () => dir },
    faceStore,
    faceModelServer,
    sessionState,
    faceEnrollmentState,
    secAudit: () => {},
    mainWindowProvider: () => ({ isDestroyed: () => false, isVisible: () => true }),
    armCamera: () => { calls.arm += 1; },
    disarmCamera: () => { calls.disarm += 1; },
  });
  return { ipcMain, sessionState, faceEnrollmentState, calls, faceStore };
}

test('face controller: status exposes configuration but not embeddings', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain } = makeHarness(dir);
  const status = await ipcMain.invoke('face-status');
  assert.equal(status.ok, true);
  assert.equal(status.available, true);
  assert.equal(status.enrolled, true);
  assert.equal(status.hasPin, true);
  assert.equal(status.lockRequired, true);
  assert.equal(status.modelBaseUrl, 'http://127.0.0.1:43210/models/');
  assert.equal('embeddings' in status, false);
});

test('face controller: successful verification only clears the session lock', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain, sessionState, calls } = makeHarness(dir);
  const result = await ipcMain.invoke('face-verify', { embedding: embedding(), liveness: true });
  assert.equal(result.ok, true);
  assert.equal(sessionState.state, 'unlocked');
  assert.equal(calls.disarm, 1);
});

test('face controller: verification is rate-limited after five failures', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain, sessionState } = makeHarness(dir, {
    faceStore: { verify: async () => ({ ok: false, similarity: 0.1, threshold: 0.5 }) },
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(sessionState.state, 'locked');
    const result = await ipcMain.invoke('face-verify', { embedding: embedding(), liveness: true });
    assert.equal(result.ok, false);
  }
  const limited = await ipcMain.invoke('face-verify', { embedding: embedding(), liveness: true });
  assert.equal(limited.ok, false);
  assert.equal(limited.rateLimited, true);
});

test('face controller: camera arm requires a visible window and explicit purpose', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain, sessionState, calls } = makeHarness(dir);
  const unlock = await ipcMain.invoke('face-arm-camera', { purpose: 'unlock' });
  assert.equal(unlock.ok, true);
  assert.equal(calls.arm, 1);

  sessionState.unlock('test');
  const noLongerLocked = await ipcMain.invoke('face-arm-camera', { purpose: 'unlock' });
  assert.equal(noLongerLocked.ok, false);

  const badPurpose = await ipcMain.invoke('face-arm-camera', { purpose: 'other' });
  assert.equal(badPurpose.ok, false);
});

test('face controller: enrollment requires a PIN, an active token, and liveness', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain, sessionState, faceEnrollmentState, calls } = makeHarness(dir, { locked: false });

  const begin = await ipcMain.invoke('face-begin-enrollment');
  assert.equal(begin.ok, true);
  assert.match(begin.token, /^[0-9a-f]{48}$/);
  assert.equal(faceEnrollmentState.active, true);

  const armed = await ipcMain.invoke('face-arm-camera', { purpose: 'enroll' });
  assert.equal(armed.ok, true);

  const noLiveness = await ipcMain.invoke('face-enroll', {
    token: begin.token,
    embeddings: [embedding()],
    liveness: false,
  });
  assert.equal(noLiveness.ok, false);

  const wrongToken = await ipcMain.invoke('face-enroll', {
    token: 'bad',
    embeddings: [embedding()],
    liveness: true,
  });
  assert.equal(wrongToken.ok, false);

  const enrolled = await ipcMain.invoke('face-enroll', {
    token: begin.token,
    embeddings: [embedding(), embedding(), embedding()],
    liveness: true,
  });
  assert.equal(enrolled.ok, true);
  assert.equal(calls.enrolled.length, 1);
  assert.equal(faceEnrollmentState.active, false);
});

test('face controller: enrollment is rejected without a usable PIN', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ipcMain } = makeHarness(dir, { locked: false });
  const begin = await ipcMain.invoke('face-begin-enrollment');
  assert.equal(begin.ok, false);
  assert.match(begin.error, /PIN/i);
});

test('face controller: delete requires the current PIN and removes the profile', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain, sessionState } = makeHarness(dir, { locked: false });
  const wrong = await ipcMain.invoke('face-delete', { pin: '0000' });
  assert.equal(wrong.ok, false);
  const removed = await ipcMain.invoke('face-delete', { pin: '1234' });
  assert.equal(removed.ok, true);
  assert.equal(removed.status.enrolled, false);
  assert.equal(sessionState.lockRequired, true);
});

test('face controller: enable toggle requires an unlocked session', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writePin(dir, '1234');
  const { ipcMain, sessionState } = makeHarness(dir, { locked: true });
  const locked = await ipcMain.invoke('face-set-enabled', { enabled: false });
  assert.equal(locked.ok, false);
  sessionState.unlock('test');
  const unlocked = await ipcMain.invoke('face-set-enabled', { enabled: false });
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.status.enabled, false);
});
