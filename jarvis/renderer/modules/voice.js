/**
 * JARVIS — Voice Module
 * Handles: Web Speech API (STT/TTS), Whisper local transcription, Wake Word detection.
 * Dependencies: state, showToast, sendMessage (from renderer.js globals)
 */

'use strict';

// ─── Web Speech API — Recognition (Basic Voice Input) ──────────

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { if ($voiceBtn) { $voiceBtn.title = 'Voice not supported'; $voiceBtn.style.opacity = '0.4'; } return; }
  state.recognition = new SR();
  state.recognition.continuous = false;
  state.recognition.interimResults = true;
  state.recognition.lang = 'en-US';
  state.recognition.onresult = (event) => {
    let interim = '', final = '';
    for (const r of event.results) { if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; }
    $input.value = final || interim; autoResizeInput();
  };
  state.recognition.onend = () => { state.isRecording = false; $voiceBtn.classList.remove('recording'); if ($input.value.trim()) sendMessage(); };
  state.recognition.onerror = (e) => { state.isRecording = false; $voiceBtn.classList.remove('recording'); if (e.error !== 'no-speech') showToast(`Voice error: ${e.error}`, 'error'); };
}

function toggleVoice() {
  if (!state.recognition) { showToast('Voice input not available.', 'error'); return; }
  if (state.isRecording) { state.recognition.stop(); state.isRecording = false; $voiceBtn.classList.remove('recording'); }
  else { state.recognition.start(); state.isRecording = true; $voiceBtn.classList.add('recording'); showToast('Listening…', 'info'); }
}

// ─── Text-To-Speech ─────────────────────────────────────────────

function speakText(text, interrupt = true) {
  if (!state.synth || !state.ttsEnabled || !text.trim()) return;
  if (interrupt) state.synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = state.speechRate * 1.25; 
  u.pitch = state.speechPitch * 0.9; 
  u.volume = 1.0;
  
  const voices = state.synth.getVoices();
  const preferred = voices.find(v => /google uk english male|microsoft george|daniel/i.test(v.name))
    || voices.find(v => /google uk|microsoft hazel/i.test(v.name))
    || voices.find(v => v.lang === 'en-GB' && /male/i.test(v.name))
    || voices.find(v => v.lang === 'en-GB')
    || voices.find(v => /microsoft david/i.test(v.name))
    || voices.find(v => v.lang.startsWith('en'));
    
  if (preferred) u.voice = preferred;
  state.synth.speak(u);
}

function extractPlainText(md) {
  return md
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`[^`]+`/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s/gm, '')
    .replace(/^\s*\d+\.\s/gm, '')
    .replace(/\|[^|\n]+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/[:;]/g, ',')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function toggleTTS() {
  state.ttsEnabled = !state.ttsEnabled;
  if ($ttsBtn) { $ttsBtn.classList.toggle('active', state.ttsEnabled); $ttsBtn.setAttribute('aria-pressed', state.ttsEnabled); }
  if (!state.ttsEnabled && state.synth) state.synth.cancel();
  showToast(`Voice output ${state.ttsEnabled ? 'enabled' : 'disabled'}.`, 'info');
}

// ─── Whisper Local Transcription (MediaRecorder → IPC) ─────────

let mediaRecorder;
let audioChunks = [];
let isRecording = false;

function initVoiceInput() {
  const voiceBtn = document.getElementById('voice-btn');
  const userInput = document.getElementById('user-input');

  if (!voiceBtn || !userInput) return;

  voiceBtn.addEventListener('click', async () => {
    if (isRecording) {
      stopWhisperRecording();
    } else {
      await startWhisperRecording();
    }
  });

  async function startWhisperRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const arrayBuffer = await audioBlob.arrayBuffer();

        userInput.placeholder = 'Transcribing locally (Whisper)...';
        voiceBtn.classList.add('recording');
        voiceBtn.style.color = '#00d4ff';

        try {
          const res = await window.jarvis.transcribeAudio(new Uint8Array(arrayBuffer));
          if (res.success) {
            const currentVal = userInput.value;
            userInput.value = currentVal ? currentVal + ' ' + res.text : res.text;
            userInput.style.height = 'auto';
            userInput.style.height = (userInput.scrollHeight) + 'px';
            showToast('Voice transcribed', 'success');
          } else {
            showToast('Whisper error: ' + res.error, 'error');
          }
        } catch (e) {
          showToast('Transcription failed: ' + e.message, 'error');
        }

        // Reset UI
        isRecording = false;
        voiceBtn.classList.remove('recording');
        voiceBtn.style.color = '';
        userInput.placeholder = 'Awaiting your command, sir...';

        // Release microphone
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      voiceBtn.classList.add('recording');
      userInput.placeholder = 'Listening...';

    } catch (e) {
      console.error('Mic access denied or error:', e);
      showToast('Microphone access denied or not found.', 'error');
    }
  }

  function stopWhisperRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }
}

// ─── Wake Word Detection — "Hey JARVIS" ────────────────────────

const WakeWord = {
  _recognition: null,
  _active: false,
  _wakePhrase: 'hey jarvis',
  _listening: false,
  _restarting: false,   // ponytail: guard against overlapping restart loops

  init: function() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    WakeWord._recognition = new SR();
    WakeWord._recognition.continuous = true;
    WakeWord._recognition.interimResults = true;
    WakeWord._recognition.lang = 'en-US';
    WakeWord._recognition.onresult = function(event) {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase().trim();
        if (transcript.includes(WakeWord._wakePhrase)) {
          WakeWord._listening = true;
          const ind = document.getElementById('wake-indicator');
          if (ind) ind.classList.add('active');
          showToast('JARVIS activated — speak your command, sir.', 'info');
          speakText('Yes, sir?', true);
          return;
        }
        if (WakeWord._listening && event.results[i].isFinal) {
          const cmd = event.results[i][0].transcript.trim();
          if (cmd && !cmd.toLowerCase().includes(WakeWord._wakePhrase)) {
            WakeWord._listening = false;
            const ind = document.getElementById('wake-indicator');
            if (ind) ind.classList.remove('active');
            TaskQueue.enqueue(cmd);
          }
        }
      }
    };
    WakeWord._recognition.onend = function() {
      WakeWord._listening = false;
      if (WakeWord._active && !WakeWord._restarting) {
        WakeWord._restarting = true;
        setTimeout(function() {
          WakeWord._restarting = false;
          if (WakeWord._active) { try { WakeWord._recognition.start(); } catch(e) {} }
        }, 300);
      }
    };
    WakeWord._recognition.onerror = function(e) {
      if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('[WakeWord] Error:', e.error);
    };
  },


  start: function() {
    if (WakeWord._active || !WakeWord._recognition) return;
    try {
      WakeWord._recognition.start(); WakeWord._active = true;
      const badge = document.getElementById('ham-wake-badge');
      if (badge) badge.textContent = 'ON';
      showToast('Wake word active. Say "Hey JARVIS" anytime.', 'success');
    } catch(e) { showToast('Could not start wake word detection.', 'error'); }
  },

  stop: function() {
    if (!WakeWord._active) return;
    WakeWord._active = false; WakeWord._listening = false;
    try { WakeWord._recognition.stop(); } catch(e) {}
    const ind = document.getElementById('wake-indicator');
    if (ind) ind.classList.remove('active');
    const badge = document.getElementById('ham-wake-badge');
    if (badge) badge.textContent = 'OFF';
    showToast('Wake word detection disabled.', 'info');
  },

  toggle: function() { if (WakeWord._active) WakeWord.stop(); else WakeWord.start(); }
};

window.WakeWord = WakeWord;
window.toggleWakeWord = function() { WakeWord.toggle(); };

// ─── Inline wake word (legacy functions kept for compatibility) ─

function startWakeWord() { WakeWord.start(); }
function stopWakeWord()  { WakeWord.stop(); }
function handleWakeWord(transcript) {
  const input = document.getElementById('user-input');
  if (input) {
    input.focus();
    input.style.boxShadow = '0 0 0 2px var(--cyan)';
    setTimeout(() => { input.style.boxShadow = ''; }, 1500);
  }
  const afterJarvis = transcript.replace(/hey jarvis|jarvis/gi, '').trim();
  if (afterJarvis.length > 3) {
    if (input) input.value = afterJarvis;
    sendMessage(afterJarvis);
  } else {
    showToast('🎤 Yes, sir? Awaiting your command.', 'info');
  }
}

function updateWakeUI(active) {
  const indicator = document.getElementById('wake-indicator');
  const badge     = document.getElementById('ham-wake-badge');
  if (indicator) indicator.classList.toggle('active', active);
  if (badge) {
    badge.textContent = active ? 'ON' : 'OFF';
    badge.className   = `ham-badge ${active ? 'on' : 'off'}`;
  }
}

// ─── Init hook ──────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  WakeWord.init();
  setTimeout(initVoiceInput, 500);
});
