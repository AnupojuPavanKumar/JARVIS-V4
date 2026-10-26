// Shared, side-effect-free helpers for the local voice loop.
// Keeping these separate makes wake-phrase and VAD behavior testable in Node
// without booting Electron or opening a microphone.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JarvisVoiceUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const WAKE_PHRASES = ['hey jarvis', 'hi jarvis', 'okay jarvis', 'ok jarvis'];
  const STOP_PHRASES = ['stop', 'stop it', 'quiet', 'cancel', 'never mind', 'nevermind'];

  function normalizeTranscript(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchWakePhrase(text, phrases = WAKE_PHRASES) {
    const normalized = normalizeTranscript(text);
    if (!normalized) return { matched: false, command: '', phrase: '' };
    const padded = ` ${normalized} `;
    for (const candidate of phrases) {
      const phrase = normalizeTranscript(candidate);
      if (!phrase) continue;
      // Word-boundary match in a padded string avoids false positives such as
      // "they jarvis" while still matching the phrase at either end.
      const index = padded.indexOf(` ${phrase} `);
      if (index !== -1) {
        const command = padded.slice(index + phrase.length + 1).trim();
        return { matched: true, command, phrase };
      }
    }
    return { matched: false, command: '', phrase: '' };
  }

  function isStopCommand(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) return false;
    return STOP_PHRASES.some(phrase => normalized === phrase || normalized.startsWith(`${phrase} `));
  }

  // Web Audio AnalyserNode returns unsigned 8-bit samples centered at 128.
  function rmsFromTimeDomain(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = (samples[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / samples.length);
  }

  function updateNoiseFloor(current, sample) {
    const floor = Number.isFinite(current) ? current : 0.006;
    const value = Number.isFinite(sample) ? Math.max(0, sample) : 0;
    return Math.min(0.05, Math.max(0.003, floor * 0.98 + value * 0.02));
  }

  function shouldStartSpeech({ speechFrames = 0, requiredFrames = 3, recording = false, transcribing = false } = {}) {
    return !recording && !transcribing && speechFrames >= requiredFrames;
  }

  function shouldEndSpeech({
    recording = false,
    now = 0,
    lastVoiceAt = 0,
    utteranceStart = 0,
    silenceMs = 700,
    maxDurationMs = 12000,
  } = {}) {
    if (!recording) return false;
    return (now - lastVoiceAt) >= silenceMs || (now - utteranceStart) >= maxDurationMs;
  }

  function mixToMono(channels) {
    const list = Array.isArray(channels) ? channels.filter(Boolean) : [];
    if (!list.length) return new Float32Array(0);
    const frames = Math.max(...list.map(channel => channel.length || 0));
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < list.length; c++) {
        if (i < list[c].length) sample += list[c][i];
      }
      mono[i] = sample / list.length;
    }
    return mono;
  }

  function resampleLinear(samples, sourceRate, targetRate) {
    if (!samples || !samples.length) return new Float32Array(0);
    if (!sourceRate || !targetRate || sourceRate === targetRate) {
      return Float32Array.from(samples);
    }
    const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
    const ratio = sourceRate / targetRate;
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const position = i * ratio;
      const left = Math.min(samples.length - 1, Math.floor(position));
      const right = Math.min(samples.length - 1, left + 1);
      const fraction = position - left;
      output[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    return output;
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  // Whisper only needs 16 kHz mono PCM. Producing that WAV in the renderer
  // avoids requiring ffmpeg on the user's machine for local transcription.
  function encodeWav(channels, sampleRate = 16000, targetSampleRate = 16000) {
    const sourceRate = Number(sampleRate) || 16000;
    const targetRate = Number(targetSampleRate) || 16000;
    const mono = mixToMono(channels);
    const pcm = resampleLinear(mono, sourceRate, targetRate);
    const dataSize = pcm.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < pcm.length; i++) {
      const sample = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
  }

  function audioBufferToWav(audioBuffer, targetSampleRate = 16000) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('Invalid AudioBuffer');
    }
    const channels = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }
    return encodeWav(channels, audioBuffer.sampleRate, targetSampleRate);
  }

  return {
    WAKE_PHRASES,
    STOP_PHRASES,
    normalizeTranscript,
    matchWakePhrase,
    isStopCommand,
    rmsFromTimeDomain,
    updateNoiseFloor,
    shouldStartSpeech,
    shouldEndSpeech,
    mixToMono,
    resampleLinear,
    encodeWav,
    audioBufferToWav,
  };
});
