'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../renderer/modules/voiceUtils');

test('voice utils: wake phrase match is normalized and extracts an inline command', () => {
  assert.deepEqual(
    voice.matchWakePhrase('Hey, JARVIS — what time is it?'),
    { matched: true, command: 'what time is it', phrase: 'hey jarvis' }
  );
  assert.deepEqual(
    voice.matchWakePhrase('okay jarvis open settings'),
    { matched: true, command: 'open settings', phrase: 'okay jarvis' }
  );
  assert.equal(voice.matchWakePhrase('hey jarvis').command, '');
});

test('voice utils: wake phrase match requires a word boundary', () => {
  assert.equal(voice.matchWakePhrase('they jarvis said hello').matched, false);
  assert.equal(voice.matchWakePhrase('jarvis are you there').matched, false);
  assert.equal(voice.matchWakePhrase('').matched, false);
});

test('voice utils: stop commands are recognized without matching stopwatch', () => {
  assert.equal(voice.isStopCommand('Stop.'), true);
  assert.equal(voice.isStopCommand('stop the music'), true);
  assert.equal(voice.isStopCommand('never mind'), true);
  assert.equal(voice.isStopCommand('stopwatch'), false);
  assert.equal(voice.isStopCommand('please stop'), false);
});

test('voice utils: RMS is zero for centered samples and positive for signal', () => {
  assert.equal(voice.rmsFromTimeDomain([128, 128, 128, 128]), 0);
  assert.ok(voice.rmsFromTimeDomain([255, 1, 255, 1]) > 0.9);
  assert.equal(voice.rmsFromTimeDomain([]), 0);
});

test('voice utils: noise floor and utterance boundaries stay bounded', () => {
  const floor = voice.updateNoiseFloor(0.006, 0.02);
  assert.ok(floor >= 0.003 && floor <= 0.05);
  assert.equal(voice.shouldStartSpeech({ speechFrames: 2 }), false);
  assert.equal(voice.shouldStartSpeech({ speechFrames: 3 }), true);
  assert.equal(voice.shouldStartSpeech({ speechFrames: 3, transcribing: true }), false);
  assert.equal(voice.shouldEndSpeech({ recording: true, now: 1000, lastVoiceAt: 100, silenceMs: 700 }), true);
  assert.equal(voice.shouldEndSpeech({ recording: true, now: 1000, lastVoiceAt: 500, silenceMs: 700 }), false);
  assert.equal(voice.shouldEndSpeech({ recording: true, now: 13000, lastVoiceAt: 12000, maxDurationMs: 12000 }), true);
});

test('voice utils: WAV encoder produces 16 kHz mono PCM with a valid header', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const encoded = voice.encodeWav([input], 16000, 16000);
  const wav = Buffer.from(encoded);

  assert.ok(encoded instanceof ArrayBuffer);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.length, 44 + input.length * 2);
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(46), 16383);
  assert.equal(wav.readInt16LE(50), 32767);
  assert.equal(wav.readInt16LE(52), -32768);
});

test('voice utils: channel mixdown and resampling prepare 48 kHz audio for Whisper', () => {
  const mono = voice.mixToMono([
    new Float32Array([1, 1]),
    new Float32Array([0, 1]),
  ]);
  assert.deepEqual([...mono], [0.5, 1]);

  const resampled = voice.resampleLinear(new Float32Array(480).fill(0.25), 48000, 16000);
  assert.equal(resampled.length, 160);
  assert.ok([...resampled].every(sample => Math.abs(sample - 0.25) < 1e-6));

  const encoded = voice.audioBufferToWav({
    sampleRate: 48000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(480).fill(0.25),
  }, 16000);
  const wav = Buffer.from(encoded);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 320);
  assert.equal(wav.length, 364);
});
