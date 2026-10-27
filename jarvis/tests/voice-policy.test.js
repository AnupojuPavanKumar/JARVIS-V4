'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  createVoicePolicy,
  SETTINGS_FILE,
  SETTINGS_VERSION,
  MAX_OUTSTANDING_LEASES,
} = require('../backend/voice/voice-policy');

function clock(start = 1000000) {
  let value = start;
  return {
    now: () => value,
    advance: ms => { value += ms; },
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-policy-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
  return dir;
}

function makePolicy(t, overrides = {}) {
  const time = clock();
  const dir = tempDir(t);
  const state = { locked: false, visible: true };
  const audit = [];
  const policy = createVoicePolicy({
    baseDir: dir,
    now: time.now,
    getSessionLocked: () => state.locked,
    isWindowVisible: () => state.visible,
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
    ...overrides,
  });
  return { policy, time, dir, state, audit };
}

const SENDER = 42;
const NONCE_RE = /^[0-9a-f]{64}$/;

test('voice policy: wake word is explicit opt-in and defaults off', t => {
  const { policy, dir, state } = makePolicy(t);

  assert.equal(policy.status().wakeWordEnabled, false);
  assert.equal(policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER }).ok, false);
  assert.equal(policy.armCapture({ purpose: 'one-shot', webContentsId: SENDER }).ok, true);

  state.locked = true;
  assert.equal(policy.armCapture({ purpose: 'one-shot', webContentsId: SENDER }).ok, false);
  assert.equal(fs.existsSync(path.join(dir, SETTINGS_FILE)), false);
});

test('voice policy: the opt-in persists in main and reloads', t => {
  const { policy, dir } = makePolicy(t);

  const enabled = policy.setWakeWordEnabled(true);
  assert.equal(enabled.ok, true);
  assert.equal(enabled.wakeWordEnabled, true);

  const file = path.join(dir, SETTINGS_FILE);
  assert.equal(fs.existsSync(file), true);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stored, { version: SETTINGS_VERSION, wakeWordEnabled: true });

  const reloaded = createVoicePolicy({
    baseDir: dir,
    getSessionLocked: () => false,
    isWindowVisible: () => true,
  });
  assert.equal(reloaded.status().wakeWordEnabled, true);
});

test('voice policy: a damaged settings file fails closed', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{not json', 'utf8');
  const audit = [];
  const policy = createVoicePolicy({
    baseDir: dir,
    getSessionLocked: () => false,
    isWindowVisible: () => true,
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
  });

  assert.equal(policy.status().wakeWordEnabled, false);
  assert.ok(policy.status().settingsError);
  assert.ok(audit.some(entry => entry.action === 'VOICE_SETTINGS_READ' && entry.verdict === 'FAIL'));
});

test('voice policy: renderer duration is ignored and capture expires on the main clock', t => {
  const { policy, time } = makePolicy(t, {
    captureTtlMs: { 'wake-word': 5000, 'one-shot': 2000 },
  });
  policy.setWakeWordEnabled(true);

  const result = policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });
  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 5000);
  assert.equal(result.captureId.length, 64);
  assert.equal(policy.isCaptureActive({ webContentsId: SENDER }), true);

  time.advance(4999);
  assert.equal(policy.isCaptureActive({ webContentsId: SENDER }), true);
  time.advance(1);
  assert.equal(policy.isCaptureActive({ webContentsId: SENDER }), false);
  assert.equal(policy.status().capture, null);
});

test('voice policy: one-shot capture is denied while locked but wake-word capture is allowed', t => {
  const { policy, state } = makePolicy(t);
  policy.setWakeWordEnabled(true);
  state.locked = true;

  assert.equal(policy.armCapture({ purpose: 'one-shot', webContentsId: SENDER }).ok, false);
  assert.equal(policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER }).ok, true);
  assert.equal(policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, true);

  assert.equal(policy.setWakeWordEnabled(false).ok, true);
  assert.equal(policy.isCaptureActive({ webContentsId: SENDER }), false);
});

test('voice policy: new opt-in is denied while locked but an existing opt-in can be re-asserted', t => {
  const { policy, state } = makePolicy(t);
  state.locked = true;

  assert.equal(policy.setWakeWordEnabled(true).ok, false);
  assert.equal(policy.status().wakeWordEnabled, false);

  state.locked = false;
  assert.equal(policy.setWakeWordEnabled(true).ok, true);
  state.locked = true;
  assert.equal(policy.setWakeWordEnabled(true).ok, true);
  assert.equal(policy.status().wakeWordEnabled, true);
});

test('voice policy: capture requires a visible window and the issuing renderer', t => {
  const { policy, state } = makePolicy(t);
  policy.setWakeWordEnabled(true);

  state.visible = false;
  assert.equal(policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER }).ok, false);
  state.visible = true;

  const result = policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });
  assert.equal(result.ok, true);
  assert.equal(policy.isCaptureActive({ webContentsId: SENDER + 1 }), false);
  assert.equal(policy.disarmCapture({ webContentsId: SENDER + 1 }).ok, false);
  assert.equal(policy.disarmCapture({ webContentsId: SENDER, captureId: 'stale' }).ok, false);
  assert.equal(policy.disarmCapture({ webContentsId: SENDER, captureId: result.captureId }).ok, true);
  assert.equal(policy.isCaptureActive({ webContentsId: SENDER }), false);
});

test('voice policy: transcription leases are nonce-bound, single-use, and expire', t => {
  const { policy, time, state } = makePolicy(t, { transcribeTtlMs: 1000 });
  policy.setWakeWordEnabled(true);
  policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });

  const first = policy.issueTranscriptionLease({ webContentsId: SENDER });
  assert.equal(first.ok, true);
  assert.match(first.leaseId, NONCE_RE);
  assert.equal(first.maxBytes, 5 * 1024 * 1024);
  assert.equal(first.maxDurationMs, 15000);

  const use = policy.consumeTranscriptionLease({ leaseId: first.leaseId, webContentsId: SENDER });
  assert.equal(use.ok, true);
  assert.equal(use.purpose, 'wake-word');

  const replay = policy.consumeTranscriptionLease({ leaseId: first.leaseId, webContentsId: SENDER });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /missing or has already been used/);

  const second = policy.issueTranscriptionLease({ webContentsId: SENDER });
  time.advance(1000);
  const expired = policy.consumeTranscriptionLease({ leaseId: second.leaseId, webContentsId: SENDER });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);

  assert.equal(policy.consumeTranscriptionLease({ leaseId: 'not-a-nonce', webContentsId: SENDER }).ok, false);
  assert.equal(policy.consumeTranscriptionLease({ leaseId: crypto.randomBytes(32).toString('hex'), webContentsId: SENDER }).ok, false);
});

test('voice policy: leases are bound to the issuing window and current session policy', t => {
  const { policy, state } = makePolicy(t);
  policy.setWakeWordEnabled(true);
  policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });

  const lease = policy.issueTranscriptionLease({ webContentsId: SENDER });
  assert.equal(lease.ok, true);
  assert.equal(policy.consumeTranscriptionLease({ leaseId: lease.leaseId, webContentsId: SENDER + 1 }).ok, false);
  assert.equal(policy.consumeTranscriptionLease({ leaseId: lease.leaseId, webContentsId: SENDER }).ok, true);

  const second = policy.issueTranscriptionLease({ webContentsId: SENDER });
  assert.equal(second.ok, true);
  state.visible = false;
  assert.equal(policy.consumeTranscriptionLease({ leaseId: second.leaseId, webContentsId: SENDER }).ok, false);

  state.visible = true;
  const third = policy.issueTranscriptionLease({ webContentsId: SENDER });
  assert.equal(third.ok, true);
  assert.equal(policy.setWakeWordEnabled(false).ok, true);
  assert.equal(policy.consumeTranscriptionLease({ leaseId: third.leaseId, webContentsId: SENDER }).ok, false);
});

test('voice policy: one-shot leases are invalid once the session locks', t => {
  const { policy, state } = makePolicy(t);
  const capture = policy.armCapture({ purpose: 'one-shot', webContentsId: SENDER });
  assert.equal(capture.ok, true);

  const lease = policy.issueTranscriptionLease({ webContentsId: SENDER });
  assert.equal(lease.ok, true);
  state.locked = true;

  const result = policy.consumeTranscriptionLease({ leaseId: lease.leaseId, webContentsId: SENDER });
  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable while JARVIS is locked/);
});

test('voice policy: outstanding leases and issuance rate are bounded', t => {
  const { policy, time } = makePolicy(t, {
    transcribeTtlMs: 60000,
    leaseRate: { limit: 100, windowMs: 60000 },
  });
  policy.setWakeWordEnabled(true);
  policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });

  const leases = [];
  for (let i = 0; i < MAX_OUTSTANDING_LEASES; i += 1) {
    const lease = policy.issueTranscriptionLease({ webContentsId: SENDER });
    assert.equal(lease.ok, true);
    leases.push(lease);
  }
  assert.equal(policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, false);

  policy.consumeTranscriptionLease({ leaseId: leases[0].leaseId, webContentsId: SENDER });
  time.advance(1);
  assert.equal(policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, true);

  const ratePolicy = makePolicy(t, {
    transcribeTtlMs: 60000,
    leaseRate: { limit: 2, windowMs: 60000 },
  });
  ratePolicy.policy.setWakeWordEnabled(true);
  ratePolicy.policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });
  assert.equal(ratePolicy.policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, true);
  assert.equal(ratePolicy.policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, true);
  assert.equal(ratePolicy.policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, false);
  ratePolicy.time.advance(60000);
  assert.equal(ratePolicy.policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, true);
});

test('voice policy: revocation clears capture and every outstanding lease', t => {
  const { policy } = makePolicy(t);
  policy.setWakeWordEnabled(true);
  policy.armCapture({ purpose: 'wake-word', webContentsId: SENDER });
  const lease = policy.issueTranscriptionLease({ webContentsId: SENDER });
  assert.equal(lease.ok, true);

  policy.revokeAll('window-hidden');
  assert.equal(policy.status().capture, null);
  assert.equal(policy.issueTranscriptionLease({ webContentsId: SENDER }).ok, false);
  assert.equal(policy.consumeTranscriptionLease({ leaseId: lease.leaseId, webContentsId: SENDER }).ok, false);
});
