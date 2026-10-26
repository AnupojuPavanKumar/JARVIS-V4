'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('local voice: renderer captures audio and uses the local Whisper IPC', () => {
  const source = read('renderer/modules/wakeWord.js');
  assert.match(source, /getUserMedia/);
  assert.match(source, /createScriptProcessor/);
  assert.match(source, /AudioContext/);
  assert.match(source, /transcribeAudio/);
  assert.doesNotMatch(source, /SpeechRecognition|webkitSpeechRecognition/);
  assert.doesNotMatch(source, /MediaRecorder/);
});

test('local voice: shared helpers load before the wake-word module', () => {
  const html = read('renderer/index.html');
  const utils = html.indexOf('modules/voiceUtils.js');
  const wake = html.indexOf('modules/wakeWord.js');
  assert.ok(utils !== -1, 'voiceUtils.js is loaded');
  assert.ok(wake !== -1, 'wakeWord.js is loaded');
  assert.ok(utils < wake, 'voiceUtils.js loads before wakeWord.js');
});

test('local voice: main process gates microphone access and registers IPC', () => {
  const main = read('main.js');
  assert.match(main, /createMicrophoneGate/);
  assert.match(main, /installMediaPermissionHandlers/);
  assert.match(main, /voice-arm-microphone/);
  assert.match(main, /voice-disarm-microphone/);
  assert.match(main, /backgroundThrottling:\s*false/);
  assert.match(main, /payload\.lockScreen === true/);
  assert.match(main, /wake-word capture/);
});

test('local voice: main process normalizes IPC audio before writing the temp file', () => {
  const source = read('backend/controllers/AIController.js');
  assert.match(source, /normalizeAudioPayload/);
  assert.match(source, /writeFileSync\(resolvedPath, audioBuffer\)/);
});

test('local voice: captured PCM is encoded as WAV before local transcription', () => {
  const source = read('renderer/modules/wakeWord.js');
  assert.match(source, /encodeWav/);
  assert.match(source, /captureNode/);
  const utils = read('renderer/modules/voiceUtils.js');
  assert.match(utils, /function encodeWav/);
  assert.match(utils, /targetRate/);
});

test('local voice: Whisper server decodes PCM WAV without requiring ffmpeg', () => {
  const source = read('skills/transcribe_server.py');
  assert.match(source, /import wave/);
  assert.match(source, /def read_wav/);
  assert.match(source, /looks_like_wav/);
});

test('local voice: preload exposes the permission gate and tray focus bridge', () => {
  const preload = read('preload.js');
  assert.match(preload, /voiceArmMicrophone/);
  assert.match(preload, /voiceDisarmMicrophone/);
  assert.match(preload, /focusWindow/);
  const windows = read('backend/controllers/WindowController.js');
  assert.match(windows, /focus-window/);
});

test('local voice: persisted wake word can start while locked but commands stay gated', () => {
  const source = read('renderer/modules/wakeWord.js');
  assert.match(source, /allowLocked:\s*true/);
  assert.match(source, /if \(locked && !options\.allowLocked\)/);
  assert.match(source, /ensureCapture\(\{ lockScreen: options\.allowLocked === true \}\)/);
  assert.match(source, /armMicrophone\(\{ lockScreen: options\.lockScreen === true \}\)/);
  assert.match(source, /if \(locked\) \{\s*const wake = matchWakePhrase/);
});

test('local voice: renderer exposes a barge-in stop path and speech events', () => {
  const source = read('renderer/renderer.js');
  assert.match(source, /window\.stopSpeaking\s*=/);
  assert.match(source, /jarvis:speech-start/);
  assert.match(source, /jarvis:speech-stop/);
});
