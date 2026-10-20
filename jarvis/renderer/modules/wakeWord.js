// ═══════════════════════════════════════════════════════════════
// JARVIS — WAKE WORD DETECTION ("Hey JARVIS")
// The WakeWord object was lost when modules/voice.js was deleted, but
// renderer.js still calls WakeWord.init() at startup and the hamburger
// menu calls window.toggleWakeWord(). This module restores it on top
// of the Web Speech API and degrades gracefully when unsupported.
// ═══════════════════════════════════════════════════════════════

window.WakeWord = (() => {
  const WAKE_PHRASE = 'hey jarvis';
  const SPEECH = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let active = false;
  let listening = false;
  let restarting = false;

  function toast(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind || 'info');
  }

  function setIndicator(on) {
    const ind = document.getElementById('wake-indicator');
    if (ind) ind.classList.toggle('active', on);
    const badge = document.getElementById('ham-wake-badge');
    if (badge) badge.textContent = active ? 'ON' : 'OFF';
  }

  function enqueue(command) {
    if (window.TaskQueue && typeof window.TaskQueue.enqueue === 'function') {
      window.TaskQueue.enqueue(command);
    } else if (typeof window.dashSend === 'function') {
      window.dashSend(command);
    }
  }

  function init() {
    if (!SPEECH) return false;
    if (recognition) return true;

    recognition = new SPEECH();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase().trim();
        if (transcript.includes(WAKE_PHRASE)) {
          listening = true;
          setIndicator(true);
          toast('JARVIS activated — speak your command, sir.', 'info');
          if (typeof window.speakText === 'function') window.speakText('Yes, sir?', true);
          continue;
        }
        if (listening && event.results[i].isFinal) {
          const command = event.results[i][0].transcript.trim();
          if (command) {
            listening = false;
            setIndicator(false);
            enqueue(command);
          }
        }
      }
    };

    recognition.onend = () => {
      listening = false;
      setIndicator(false);
      if (active && !restarting) {
        restarting = true;
        setTimeout(() => {
          restarting = false;
          if (active && recognition) {
            try { recognition.start(); } catch { /* already running */ }
          }
        }, 300);
      }
    };

    recognition.onerror = event => {
      if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('[WakeWord] Error:', event.error);
      }
    };

    return true;
  }

  function start() {
    if (active) return;
    if (!recognition && !init()) {
      toast('Wake word is not supported in this build.', 'error');
      return;
    }
    try {
      recognition.start();
      active = true;
      setIndicator(false);
      toast('Wake word active. Say "Hey JARVIS" anytime.', 'success');
    } catch {
      toast('Could not start wake word detection.', 'error');
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    listening = false;
    if (recognition) {
      try { recognition.stop(); } catch { /* not running */ }
    }
    setIndicator(false);
    toast('Wake word detection disabled.', 'info');
  }

  function toggle() {
    if (active) stop();
    else start();
  }

  function isActive() {
    return active;
  }

  return { init, start, stop, toggle, isActive, phrase: WAKE_PHRASE };
})();
