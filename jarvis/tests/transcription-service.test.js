'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTranscriptionService } = require('../backend/voice/transcription-service');

function makeWav(frames = 1600, sampleRate = 16000) {
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function setup(t, { lease = {}, queue } = {}) {
  const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-transcription-'));
  t.after(() => {
    try { fs.rmSync(audioDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  const consumed = [];
  const queued = [];
  const policy = {
    consumeTranscriptionLease: input => {
      consumed.push(input);
      return {
        ok: true,
        purpose: 'wake-word',
        maxBytes: 5 * 1024 * 1024,
        maxDurationMs: 15000,
        ...lease,
      };
    },
  };
  const audits = [];
  const service = createTranscriptionService({
    voicePolicy: policy,
    queueTranscription: async resolvedPath => {
      const record = {
        path: resolvedPath,
        existed: fs.existsSync(resolvedPath),
        bytes: fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath).length : 0,
      };
      queued.push(record);
      if (typeof queue === 'function') return queue(resolvedPath, record);
      return { success: true, text: 'hello' };
    },
    audioDirProvider: () => audioDir,
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
  });

  return { service, audioDir, consumed, queued, audits, lease };
}

const EVENT = { sender: { id: 17 } };
const LEASE_ID = 'a'.repeat(64);

test('transcription service: rejects a missing or invalid lease before touching audio', async t => {
  const { service, consumed, queued, audits } = setup(t, {
    lease: { ok: false, error: 'lease rejected' },
  });

  const result = await service.handle(EVENT, { leaseId: LEASE_ID, audio: makeWav() });
  assert.equal(result.success, false);
  assert.match(result.error, /lease rejected/);
  assert.deepEqual(consumed, [{ leaseId: LEASE_ID, webContentsId: 17 }]);
  assert.deepEqual(queued, []);
  assert.ok(audits.some(entry => entry.verdict === 'BLOCKED'));
});

test('transcription service: consumes the lease before validating the WAV', async t => {
  const { service, consumed, queued } = setup(t);

  const result = await service.handle(EVENT, { leaseId: LEASE_ID, audio: Buffer.from('not wav') });
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid audio payload/);
  assert.equal(consumed.length, 1);
  assert.deepEqual(queued, []);
});

test('transcription service: accepts a valid WAV and deletes it in the finally path', async t => {
  const { service, audioDir, queued } = setup(t);
  const audio = makeWav();

  const result = await service.handle(EVENT, { leaseId: LEASE_ID, audio });
  assert.deepEqual(result, { success: true, text: 'hello' });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].existed, true);
  assert.equal(queued[0].bytes, audio.length);
  assert.match(path.basename(queued[0].path), /^audio_[0-9a-f]{32}\.wav$/);
  assert.equal(path.dirname(queued[0].path), audioDir);
  assert.equal(fs.existsSync(queued[0].path), false);
  assert.deepEqual(fs.readdirSync(audioDir), []);
  assert.deepEqual([...audio], new Array(audio.length).fill(0), 'raw audio is cleared from memory');
});

test('transcription service: cleanup still runs when Whisper fails', async t => {
  const { service, queued } = setup(t, {
    queue: () => ({ success: false, error: 'Whisper failed' }),
  });

  const result = await service.handle(EVENT, { leaseId: LEASE_ID, audio: makeWav() });
  assert.equal(result.success, false);
  assert.equal(result.error, 'Whisper failed');
  assert.equal(queued.length, 1);
  assert.equal(fs.existsSync(queued[0].path), false);
});

test('transcription service: cleanup still runs when the queue throws', async t => {
  const { service, queued } = setup(t, {
    queue: () => { throw new Error('queue exploded'); },
  });

  const result = await service.handle(EVENT, { leaseId: LEASE_ID, audio: makeWav() });
  assert.equal(result.success, false);
  assert.match(result.error, /queue exploded/);
  assert.equal(queued.length, 1);
  assert.equal(fs.existsSync(queued[0].path), false);
});

test('transcription service: enforces main-owned byte and duration limits', async t => {
  const bytes = setup(t, { lease: { maxBytes: 100 } });
  const byteResult = await bytes.service.handle(EVENT, { leaseId: LEASE_ID, audio: makeWav() });
  assert.equal(byteResult.success, false);
  assert.match(byteResult.error, /too large/);
  assert.deepEqual(bytes.queued, []);

  const duration = setup(t, { lease: { maxDurationMs: 1000 } });
  const durationResult = await duration.service.handle(EVENT, {
    leaseId: LEASE_ID,
    audio: makeWav(16000 * 2),
  });
  assert.equal(durationResult.success, false);
  assert.match(durationResult.error, /longer than 1 seconds/);
  assert.deepEqual(duration.queued, []);
});

test('transcription service: each request uses a fresh random temp name', async t => {
  const { service, queued } = setup(t);
  await service.handle(EVENT, { leaseId: LEASE_ID, audio: makeWav() });
  await service.handle(EVENT, { leaseId: LEASE_ID, audio: makeWav() });

  assert.equal(queued.length, 2);
  assert.notEqual(queued[0].path, queued[1].path);
});
