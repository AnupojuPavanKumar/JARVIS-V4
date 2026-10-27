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

test('local voice: main owns the opt-in, capture policy, and microphone permission', () => {
  const main = read('main.js');
  assert.match(main, /createVoicePolicy/);
  assert.match(main, /voicePolicy\.isCaptureActive/);
  assert.match(main, /voicePolicy\??\.revokeAll/);
  assert.match(main, /voice-capture-revoked/);
  assert.match(main, /registerVoiceController/);
  assert.match(main, /installMediaPermissionHandlers/);
  assert.match(main, /backgroundThrottling:\s*false/);
  assert.doesNotMatch(main, /createMicrophoneGate/);
  assert.doesNotMatch(main, /payload\.lockScreen/);
  assert.doesNotMatch(main, /voiceMicrophoneGate/);
});

test('local voice: renderer accepts only main-owned capture purposes and leases', () => {
  const source = read('renderer/modules/wakeWord.js');
  assert.match(source, /voiceStatus/);
  assert.match(source, /voiceSetWakeWord/);
  assert.match(source, /voiceCreateTranscriptionLease/);
  assert.match(source, /voiceArmMicrophone\(purpose\)/);
  assert.match(source, /voiceDisarmMicrophone\(staleCaptureId\)/);
  assert.match(source, /leaseId:\s*lease\.leaseId/);
  assert.match(source, /audio:\s*audioPayload/);
  assert.match(source, /onVoiceCaptureRevoked/);
  assert.match(source, /onAppVisibility/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /lockScreen/);
  assert.doesNotMatch(source, /durationMs:\s*4\s*\*\s*60/);
  assert.doesNotMatch(source, /allowLocked/);
});

test('local voice: main revokes capture on hide, lock, reload, and quit', () => {
  const main = read('main.js');
  assert.match(main, /revokeVoiceAccess\('window-hidden'\)/);
  assert.match(main, /revokeVoiceAccess\('session-locked'\)/);
  assert.match(main, /revokeVoiceAccess\('renderer-boundary'\)/);
  assert.match(main, /voicePolicy\?\.revokeAll\('app-quit'\)/);
});

test('local voice: transcription is lease-gated and strictly validated', () => {
  const ai = read('backend/controllers/AIController.js');
  assert.match(ai, /createTranscriptionService/);
  assert.match(ai, /voicePolicy/);
  assert.doesNotMatch(ai, /normalizeAudioPayload/);
  assert.doesNotMatch(ai, /transcribe-audio[\s\S]{0,200}fs\.writeFileSync/);

  const service = read('backend/voice/transcription-service.js');
  assert.match(service, /consumeTranscriptionLease/);
  assert.match(service, /normalizeAudioPayload/);
  assert.match(service, /validateWavPayload/);
  assert.match(service, /finally\s*\{/);
  assert.match(service, /unlinkSync/);
  assert.match(service, /audioBuffer\.fill\(0\)/);
});

test('local voice: locked wake-word capture is main-policy driven, not renderer-asserted', () => {
  const policy = read('backend/voice/voice-policy.js');
  assert.match(policy, /purpose === 'one-shot' && locked/);
  assert.match(policy, /purpose === 'wake-word' && !wakeWordEnabled/);
  assert.match(policy, /isWindowVisible\(\)/);
  assert.match(policy, /NONCE_RE/);
  assert.match(policy, /leases\.delete\(leaseId\)/);

  const ipc = read('backend/security/ipc-session-policy.js');
  assert.match(ipc, /'voice-create-transcription-lease'/);
  assert.match(ipc, /'transcribe-audio': entry\(\[S\.LOCKED, S\.UNLOCKED, S\.NO_LOCK\]/);
});

test('local voice: captured PCM is encoded as WAV before local transcription', () => {
  const source = read('renderer/modules/wakeWord.js');
  assert.match(source, /encodeWav/);
  assert.match(source, /captureNode/);
  const utils = read('renderer/modules/voiceUtils.js');
  assert.match(utils, /function encodeWav/);
  assert.match(utils, /targetRate/);
});

test('local voice: packaged transcription uses the bundled native Whisper sidecar', () => {
  const ai = read('backend/controllers/AIController.js');
  assert.match(ai, /createWhisperSidecar/);
  assert.match(ai, /WHISPER_ASSET_MANIFEST/);
  assert.doesNotMatch(ai, /transcribe_server\.py/);
  assert.doesNotMatch(ai, /spawn\(\s*['"]python['"]/);
  assert.doesNotMatch(ai, /whisperRetries/);

  const sidecar = read('backend/voice/whisper-sidecar.js');
  assert.match(sidecar, /shell:\s*false/);
  assert.match(sidecar, /windowsHide:\s*true/);
  assert.match(sidecar, /stdio:\s*\['ignore',\s*'pipe',\s*'pipe'\]/);
  assert.match(sidecar, /'--model'/);
  assert.match(sidecar, /'--file'/);
  assert.match(sidecar, /--no-timestamps/);
  assert.match(sidecar, /--no-prints/);
  assert.match(sidecar, /--no-gpu/);
  assert.doesNotMatch(sidecar, /https?:\/\//);

  const manifest = read('backend/voice/whisper-assets-manifest.js');
  assert.match(manifest, /whisper-cli\.exe/);
  assert.match(manifest, /ggml-base\.en-q5_1\.bin/);

  const main = read('main.js');
  assert.match(main, /transcriptionStatus:\s*aiController/);
  assert.match(read('backend/controllers/VoiceController.js'), /transcriptionStatus/);
  assert.match(read('renderer/modules/wakeWord.js'), /transcriptionDiagnostic/);

  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.asarUnpack.includes('bin/whisper/**'));
});

test('local voice: preload exposes only the named voice bridges', () => {
  const preload = read('preload.js');
  assert.match(preload, /voiceStatus/);
  assert.match(preload, /voiceSetWakeWord/);
  assert.match(preload, /voiceArmMicrophone:\s*\(purpose\)/);
  assert.match(preload, /voiceDisarmMicrophone/);
  assert.match(preload, /voiceCreateTranscriptionLease/);
  assert.match(preload, /onVoiceCaptureRevoked/);
  assert.match(preload, /focusWindow/);
  const windows = read('backend/controllers/WindowController.js');
  assert.match(windows, /focus-window/);
});

test('local voice: renderer exposes a barge-in stop path and speech events', () => {
  const source = read('renderer/renderer.js');
  assert.match(source, /window\.stopSpeaking\s*=/);
  assert.match(source, /jarvis:speech-start/);
  assert.match(source, /jarvis:speech-stop/);
});
