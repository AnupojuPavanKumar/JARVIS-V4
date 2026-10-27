'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerVoiceController = require('../backend/controllers/VoiceController');

function harness(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const webContents = { id: 17 };
  const mainWindow = { isDestroyed: () => false, webContents };
  const calls = [];
  const sent = [];
  const audits = [];
  const policy = {
    status: () => ({ ok: true, wakeWordEnabled: true }),
    setWakeWordEnabled: enabled => {
      calls.push(['setWakeWordEnabled', enabled]);
      return { ok: true, wakeWordEnabled: enabled, revokedWakeWord: enabled === false };
    },
    armCapture: input => {
      calls.push(['armCapture', input]);
      return { ok: true, purpose: input.purpose, durationMs: 5000, captureId: 'a'.repeat(64) };
    },
    disarmCapture: input => {
      calls.push(['disarmCapture', input]);
      return { ok: true, active: false };
    },
    issueTranscriptionLease: input => {
      calls.push(['issueTranscriptionLease', input]);
      return { ok: true, leaseId: 'b'.repeat(64) };
    },
    ...overrides,
  };

  registerVoiceController({
    ipcMain,
    voicePolicy: policy,
    mainWindowProvider: () => mainWindow,
    secAudit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    sendRenderer: (channel, payload) => sent.push({ channel, payload }),
  });

  return {
    handlers,
    calls,
    sent,
    audits,
    webContents,
    event: { sender: webContents },
    foreignEvent: { sender: { id: 99 } },
  };
}

test('voice controller: registers the main-owned voice channels', () => {
  const { handlers } = harness();
  assert.deepEqual([...handlers.keys()].sort(), [
    'voice-arm-microphone',
    'voice-create-transcription-lease',
    'voice-disarm-microphone',
    'voice-set-wake-word',
    'voice-status',
  ]);
});

test('voice controller: rejects senders other than the main renderer', async () => {
  const { handlers, calls, foreignEvent } = harness();

  assert.equal((await handlers.get('voice-status')(foreignEvent)).ok, true);
  const arm = await handlers.get('voice-arm-microphone')(foreignEvent, { purpose: 'wake-word' });
  assert.equal(arm.ok, false);
  const enable = await handlers.get('voice-set-wake-word')(foreignEvent, { enabled: true });
  assert.equal(enable.ok, false);
  const lease = await handlers.get('voice-create-transcription-lease')(foreignEvent);
  assert.equal(lease.ok, false);
  const disarm = await handlers.get('voice-disarm-microphone')(foreignEvent, {});
  assert.equal(disarm.ok, false);
  assert.deepEqual(calls, []);
});

test('voice controller: renderer lockScreen and duration cannot arm the microphone', async () => {
  const { handlers, calls, audits, event } = harness();
  const arm = handlers.get('voice-arm-microphone');

  const lockScreen = await arm(event, { purpose: 'wake-word', lockScreen: true });
  assert.equal(lockScreen.ok, false);
  assert.match(lockScreen.error, /owned by the main process/);

  const duration = await arm(event, { purpose: 'one-shot', durationMs: 4 * 60 * 60 * 1000 });
  assert.equal(duration.ok, false);

  const nested = await arm(event, { purpose: 'wake-word', lockScreen: false });
  assert.equal(nested.ok, false);
  assert.deepEqual(calls, []);
  assert.ok(audits.some(entry => entry.action === 'VOICE_MIC_ARM' && entry.verdict === 'BLOCKED'));
});

test('voice controller: forwards only the purpose and trusted sender id', async () => {
  const { handlers, calls, event } = harness();
  const result = await handlers.get('voice-arm-microphone')(event, { purpose: 'one-shot' });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['armCapture', { purpose: 'one-shot', webContentsId: 17 }]]);
});

test('voice controller: wake-word setting revokes capture when disabled', async () => {
  const { handlers, calls, sent, event } = harness();

  const enabled = await handlers.get('voice-set-wake-word')(event, { enabled: true });
  assert.equal(enabled.ok, true);
  assert.deepEqual(calls[0], ['setWakeWordEnabled', true]);
  assert.deepEqual(sent, []);

  const disabled = await handlers.get('voice-set-wake-word')(event, { enabled: false });
  assert.equal(disabled.ok, true);
  assert.deepEqual(sent, [{ channel: 'voice-capture-revoked', payload: { reason: 'wake-word-disabled' } }]);
});

test('voice controller: disarm uses the capture id and transcription lease uses the sender', async () => {
  const { handlers, calls, event } = harness();

  await handlers.get('voice-disarm-microphone')(event, { captureId: 'c'.repeat(64) });
  assert.deepEqual(calls[0], ['disarmCapture', { webContentsId: 17, captureId: 'c'.repeat(64) }]);

  const lease = await handlers.get('voice-create-transcription-lease')(event);
  assert.equal(lease.ok, true);
  assert.deepEqual(calls[1], ['issueTranscriptionLease', { webContentsId: 17 }]);
});

test('voice controller: status is read through main policy', async () => {
  const { handlers, event } = harness();
  const status = await handlers.get('voice-status')(event);
  assert.deepEqual(status, { ok: true, wakeWordEnabled: true });
});
