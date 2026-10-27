// ═══════════════════════════════════════════════════════════════
// JARVIS — LOCAL VOICE LOOP (Phase 5A)
//
// This module replaces the old Chromium Web Speech wake word with an
// explicitly opt-in, fully local loop:
//   microphone -> Web Audio energy VAD -> PCM capture -> local Whisper
//
// Audio never leaves the machine. Segments are sent over the existing
// `transcribe-audio` IPC to skills/transcribe_server.py, which keeps the
// Whisper model resident in memory. There is no cloud speech fallback.
//
// The loop is intentionally independent of the chat window so it can keep
// listening while JARVIS is minimized or resident in the tray. If the session
// is locked, only the wake phrase is recognized: it focuses the lock screen,
// but never executes a command until PIN or face unlock succeeds.
// ═══════════════════════════════════════════════════════════════

window.WakeWord = (() => {
  const utils = window.JarvisVoiceUtils || {};
  const WAKE_PHRASE = 'hey jarvis';
  const {
    matchWakePhrase = () => ({ matched: false, command: '', phrase: '' }),
    isStopCommand = () => false,
    rmsFromTimeDomain = () => 0,
    updateNoiseFloor = () => 0.006,
    shouldStartSpeech = () => false,
    shouldEndSpeech = () => false,
  } = utils;

  const VAD = {
    fftSize: 1024,
    intervalMs: 50,
    requiredFrames: 3,
    silenceMs: 700,
    maxUtteranceMs: 12000,
    minThreshold: 0.018,
    noiseMultiplier: 2.8,
    ttsThresholdMultiplier: 1.8,
    ttsSuppressMs: 500,
    preRollMs: 700,
    captureBufferSize: 4096,
  };

  let initialized = false;
  let active = false;
  let oneShot = false;
  let recording = false;
  let transcribing = false;
  let awaitingCommand = false;
  let locked = false;
  let speechPlaying = false;
  let suppressUntil = 0;
  let bargeIn = false;
  let bargeInAt = 0;

  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  let captureNode = null;
  let captureSink = null;
  let vadTimer = null;
  let rearmTimer = null;
  let oneShotTimer = null;
  let autoStartTimer = null;
  let revokeRearmTimer = null;

  let preRollFrames = [];
  let preRollSamples = 0;
  let utteranceChunks = [];
  let utteranceSamples = 0;
  let utteranceStart = 0;
  let lastVoiceAt = 0;
  let speechFrames = 0;
  let noiseFloor = 0.006;
  let calibrateUntil = 0;

  let lastErrorToastAt = 0;
  let authObserver = null;
  let captureToken = 0;
  let gateArmed = false;
  let captureId = null;
  let currentPurpose = null;
  let captureExpiresAt = 0;
  let visible = true;
  let startInFlight = false;
  let armSequence = 0;

  function toast(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind || 'info');
  }

  function errorToast(message) {
    const now = Date.now();
    if (now - lastErrorToastAt < 15000) return;
    lastErrorToastAt = now;
    toast(message, 'error');
  }

  function voiceButton() {
    return document.getElementById('voice-btn');
  }

  function setIndicator(on, label) {
    const indicator = document.getElementById('wake-indicator');
    if (indicator) {
      indicator.classList.toggle('active', !!on);
      const text = indicator.querySelector('span:last-child');
      if (text && label) text.textContent = label;
    }
    const badge = document.getElementById('ham-wake-badge');
    if (badge) badge.textContent = active ? 'ON' : 'OFF';
  }

  function updateIndicator() {
    if (!active && !oneShot) {
      setIndicator(false);
      return;
    }
    if (locked) {
      setIndicator(true, 'LOCKED');
      return;
    }
    if (recording) {
      setIndicator(true, 'LISTENING');
      return;
    }
    if (transcribing) {
      setIndicator(true, 'PROCESSING');
      return;
    }
    if (awaitingCommand) {
      setIndicator(true, 'SPEAK');
      return;
    }
    setIndicator(true, 'LISTENING');
  }

  function isAuthLocked() {
    const screen = document.getElementById('auth-screen');
    return !!(screen && !screen.classList.contains('hidden'));
  }

  function refreshLockState() {
    const next = isAuthLocked();
    if (next === locked) return;
    locked = next;
    if (locked) {
      awaitingCommand = false;
      bargeIn = false;
      speechFrames = 0;
      if (typeof window.stopSpeaking === 'function') window.stopSpeaking();
      // Main revokes the old capture when the session locks. Wake-word-only
      // capture is re-armed against the persisted opt-in; a one-shot capture is
      // never allowed across the lock boundary.
      if (active) {
        armMicrophone('wake-word').catch(() => { /* revocation handler retries */ });
      } else if (oneShot) {
        cancelOneShot(false);
      } else if (stream || audioCtx || captureNode || vadTimer) {
        teardown();
      }
    } else if (active) {
      armMicrophone('wake-word').catch(() => { /* retried by the refresh timer */ });
    } else {
      scheduleAutoStart();
    }
    updateIndicator();
  }

  function observeAuthScreen() {
    if (authObserver) return;
    const screen = document.getElementById('auth-screen');
    if (!screen || typeof MutationObserver !== 'function') return;
    authObserver = new MutationObserver(refreshLockState);
    authObserver.observe(screen, { attributes: true, attributeFilter: ['class'] });
    locked = isAuthLocked();
  }

  function scheduleAutoStart() {
    if (active || oneShot || startInFlight || !visible) return;
    if (autoStartTimer) return;
    autoStartTimer = setTimeout(async () => {
      autoStartTimer = null;
      if (active || oneShot || startInFlight || !visible) return;
      let status = null;
      try {
        if (!window.jarvis || typeof window.jarvis.voiceStatus !== 'function') return;
        status = await window.jarvis.voiceStatus();
      } catch { /* main unavailable during reload */ }
      if (!status || status.ok !== true) return;
      if (status.wakeWordEnabled !== true || status.windowVisible === false) return;
      // The persisted opt-in lives in main. Main will still reject the capture
      // unless the window is visible and the session state permits it.
      start({ silent: true, fromSetting: true });
    }, 900);
  }

  function clearRearmTimer() {
    if (rearmTimer) {
      clearTimeout(rearmTimer);
      rearmTimer = null;
    }
  }

  function scheduleCaptureRearm() {
    clearRearmTimer();
    if (currentPurpose !== 'wake-word' || !active || !visible) return;
    const remaining = captureExpiresAt > Date.now()
      ? captureExpiresAt - Date.now()
      : 5 * 60 * 1000;
    const delay = Math.max(15000, remaining - 30000);
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      if (!active || oneShot || !visible || currentPurpose !== 'wake-word') return;
      armMicrophone('wake-word').catch(error => {
        console.warn('[Voice] Wake-word lease refresh failed:', error.message);
        if (active && visible && currentPurpose === 'wake-word') {
          rearmTimer = setTimeout(() => {
            rearmTimer = null;
            if (active && visible) armMicrophone('wake-word').catch(() => { /* policy still denies */ });
          }, 15000);
        }
      });
    }, delay);
  }

  async function armMicrophone(purpose = active ? 'wake-word' : 'one-shot') {
    if (!window.jarvis || typeof window.jarvis.voiceArmMicrophone !== 'function') {
      throw new Error('Microphone permission gate is unavailable');
    }
    if (purpose !== 'wake-word' && purpose !== 'one-shot') {
      throw new Error('Unsupported local voice capture purpose');
    }
    const sequence = ++armSequence;
    const result = await window.jarvis.voiceArmMicrophone(purpose);
    if (sequence !== armSequence) return;
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || 'Microphone permission was denied');
    }
    gateArmed = true;
    captureId = typeof result.captureId === 'string' ? result.captureId : null;
    currentPurpose = result.purpose === 'wake-word' || result.purpose === 'one-shot'
      ? result.purpose
      : purpose;
    captureExpiresAt = Number(result.expiresAt) > 0 ? Number(result.expiresAt) : 0;
    scheduleCaptureRearm();
  }

  function resetCaptureState() {
    preRollFrames = [];
    preRollSamples = 0;
    utteranceChunks = [];
    utteranceSamples = 0;
    recording = false;
    utteranceStart = 0;
  }

  function appendPreRoll(frame) {
    preRollFrames.push(frame);
    preRollSamples += frame.length;
    const rate = audioCtx ? audioCtx.sampleRate : 48000;
    const maxSamples = Math.max(1, Math.round(rate * VAD.preRollMs / 1000));
    while (preRollFrames.length > 1 && preRollSamples > maxSamples) {
      const removed = preRollFrames.shift();
      preRollSamples -= removed.length;
    }
  }

  function onAudioFrame(frame) {
    if (!frame || !frame.length) return;
    if (recording) {
      utteranceChunks.push(frame);
      utteranceSamples += frame.length;
    } else {
      appendPreRoll(frame);
    }
  }

  async function ensureCapture(options = {}) {
    const purpose = options.purpose === 'one-shot' ? 'one-shot' : 'wake-word';
    if (stream && audioCtx && captureNode) {
      // A live stream already has a main-owned grant. Re-assert the wake-word
      // purpose when entering continuous mode; one-shot reuses the existing
      // grant so it cannot shorten an active wake-word lease.
      if (purpose === 'wake-word') await armMicrophone('wake-word');
      return true;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('Microphone capture is not available in this build');
    }

    await armMicrophone(purpose);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio is not available in this build');
    audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch { /* still usable after a user gesture */ }
    }

    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = VAD.fftSize;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    dataArray = new Uint8Array(analyser.fftSize);

    // Capture raw PCM rather than encoding WebM. The renderer can then hand
    // Whisper a 16 kHz WAV without decoding through ffmpeg.
    if (typeof audioCtx.createScriptProcessor !== 'function') {
      throw new Error('PCM capture is not available in this build');
    }
    captureNode = audioCtx.createScriptProcessor(VAD.captureBufferSize, 1, 1);
    captureNode.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0);
      if (!input || !input.length) return;
      const frame = new Float32Array(input.length);
      frame.set(input);
      onAudioFrame(frame);
    };
    captureSink = audioCtx.createGain();
    captureSink.gain.value = 0;
    source.connect(captureNode);
    captureNode.connect(captureSink);
    captureSink.connect(audioCtx.destination);

    resetCaptureState();
    noiseFloor = 0.006;
    speechFrames = 0;
    calibrateUntil = performance.now() + 700;
    vadTimer = setInterval(analysisTick, VAD.intervalMs);
    return true;
  }

  function analysisTick() {
    if (!analyser || !dataArray) return;
    analyser.getByteTimeDomainData(dataArray);
    const rms = rmsFromTimeDomain(dataArray);
    const now = performance.now();

    if (now < calibrateUntil) {
      noiseFloor = updateNoiseFloor(noiseFloor, rms);
      return;
    }

    if (now < suppressUntil) return;

    const threshold = Math.max(
      VAD.minThreshold,
      noiseFloor * VAD.noiseMultiplier
    ) * (speechPlaying ? VAD.ttsThresholdMultiplier : 1);
    const voiceNow = rms > threshold;

    if (voiceNow) {
      lastVoiceAt = now;
      speechFrames += 1;

      if (speechPlaying && !bargeIn && now - bargeInAt > 1200) {
        triggerBargeIn(now);
      }

      if (shouldStartSpeech({
        speechFrames,
        requiredFrames: VAD.requiredFrames,
        recording,
        transcribing,
      }) && captureNode) {
        beginUtterance(now);
      }
    } else {
      speechFrames = Math.max(0, speechFrames - 1);
      if (!recording && !transcribing && !speechPlaying) {
        noiseFloor = updateNoiseFloor(noiseFloor, rms);
      }
    }

    if (shouldEndSpeech({
      recording,
      now,
      lastVoiceAt,
      utteranceStart,
      silenceMs: VAD.silenceMs,
      maxDurationMs: VAD.maxUtteranceMs,
    })) {
      endUtterance();
    }
  }

  function beginUtterance(now) {
    if (!recording) {
      // Keep the preceding pre-roll so the first syllable of "Hey JARVIS"
      // is not clipped by the energy threshold.
      utteranceChunks = preRollFrames.slice();
      utteranceSamples = preRollSamples;
    }
    recording = true;
    utteranceStart = now;
    lastVoiceAt = now;
    updateIndicator();
  }

  function endUtterance() {
    if (!recording) return;
    recording = false;
    utteranceStart = 0;
    const chunks = utteranceChunks;
    const totalSamples = utteranceSamples;
    utteranceChunks = [];
    utteranceSamples = 0;
    updateIndicator();

    const voiceUtils = window.JarvisVoiceUtils;
    if (!audioCtx || !voiceUtils || typeof voiceUtils.encodeWav !== 'function') {
      console.warn('[Voice] PCM encoder is unavailable');
      return;
    }
    if (totalSamples < Math.round(audioCtx.sampleRate * 0.2)) return;

    const pcm = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    const payload = voiceUtils.encodeWav([pcm], audioCtx.sampleRate, 16000);
    transcribePcm(payload);
  }

  async function transcribePcm(audioPayload) {
    if (transcribing || !window.jarvis || typeof window.jarvis.transcribeAudio !== 'function') return;
    if (typeof window.jarvis.voiceCreateTranscriptionLease !== 'function') {
      console.warn('[Voice] Main-owned transcription leases are unavailable');
      return;
    }
    const token = captureToken;
    transcribing = true;
    updateIndicator();
    try {
      // The lease is issued by main immediately before the payload is sent and
      // is consumed before any bytes are inspected. It is valid for one use.
      const lease = await window.jarvis.voiceCreateTranscriptionLease();
      if (token !== captureToken) return;
      if (!lease || lease.ok !== true || !lease.leaseId) {
        throw new Error((lease && lease.error) || 'Local voice lease was denied');
      }
      const result = await Promise.race([
        window.jarvis.transcribeAudio({ leaseId: lease.leaseId, audio: audioPayload }),
        new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Local transcription timed out' }), 45000)),
      ]);
      if (token !== captureToken) return;
      if (!result || result.success === false) {
        throw new Error((result && result.error) || 'Local transcription failed');
      }
      handleTranscript(result.text || '');
    } catch (error) {
      console.warn('[Voice] Transcription failed:', error.message);
      errorToast('Local transcription failed. Check that Whisper is installed.');
    } finally {
      transcribing = false;
      if (!active && !oneShot) {
        teardown();
      } else {
        updateIndicator();
      }
    }
  }

  function enqueueCommand(command) {
    const text = String(command || '').trim();
    if (!text) return;
    if (window.TaskQueue && typeof window.TaskQueue.enqueue === 'function') {
      window.TaskQueue.enqueue(text);
    } else if (typeof window.dashSend === 'function') {
      window.dashSend(text);
    } else if (typeof window.sendMessageWithSearch === 'function') {
      window.sendMessageWithSearch(text);
    }
  }

  function handleTranscript(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;

    if (locked) {
      const wake = matchWakePhrase(text);
      if (wake.matched) {
        if (window.jarvis && typeof window.jarvis.focusWindow === 'function') {
          window.jarvis.focusWindow().catch(() => { /* window may be closing */ });
        }
        toast('Unlock JARVIS with your PIN or face to continue, sir.', 'info');
      }
      return;
    }

    const wake = matchWakePhrase(text);
    if (wake.matched) {
      if (wake.command) {
        enqueueCommand(wake.command);
        awaitingCommand = false;
        finishOneShot();
        playTone(880, 70, 0.035);
        return;
      }
      awaitingCommand = true;
      updateIndicator();
      playTone(880, 70, 0.035);
      toast('Listening for your command, sir.', 'info');
      return;
    }

    if (oneShot) {
      enqueueCommand(text);
      awaitingCommand = false;
      finishOneShot();
      return;
    }

    if (bargeIn || awaitingCommand) {
      if (isStopCommand(text)) {
        if (typeof window.stopSpeaking === 'function') window.stopSpeaking();
        awaitingCommand = false;
        bargeIn = false;
        updateIndicator();
        toast('Voice output stopped, sir.', 'info');
        return;
      }
      enqueueCommand(text);
      awaitingCommand = false;
      bargeIn = false;
      updateIndicator();
    }
  }

  function playTone(frequency, durationMs, volume) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    try {
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.value = volume;
      oscillator.connect(gain);
      gain.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
      oscillator.start(now);
      oscillator.stop(now + durationMs / 1000);
    } catch { /* non-critical cue */ }
  }

  function triggerBargeIn(now) {
    if (!active && !oneShot) return;
    bargeIn = true;
    bargeInAt = now;
    awaitingCommand = true;
    suppressUntil = now + 80;
    if (typeof window.stopSpeaking === 'function') window.stopSpeaking();
    playTone(520, 60, 0.03);
    updateIndicator();
  }

  function clearOneShotTimer() {
    if (oneShotTimer) {
      clearTimeout(oneShotTimer);
      oneShotTimer = null;
    }
  }

  function finishOneShot() {
    if (!oneShot) return;
    oneShot = false;
    awaitingCommand = false;
    bargeIn = false;
    clearOneShotTimer();
    const button = voiceButton();
    if (button) button.classList.remove('recording');
    if (!active) {
      teardown();
    } else {
      updateIndicator();
    }
  }

  function cancelOneShot(showToast = true) {
    if (!oneShot) return;
    oneShot = false;
    awaitingCommand = false;
    bargeIn = false;
    clearOneShotTimer();
    const button = voiceButton();
    if (button) button.classList.remove('recording');
    if (!active) teardown();
    else updateIndicator();
    if (showToast) toast('Voice input cancelled.', 'info');
  }

  function teardown() {
    captureToken += 1;
    armSequence += 1;
    clearOneShotTimer();
    clearRearmTimer();
    if (revokeRearmTimer) { clearTimeout(revokeRearmTimer); revokeRearmTimer = null; }
    if (autoStartTimer) { clearTimeout(autoStartTimer); autoStartTimer = null; }
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    resetCaptureState();
    transcribing = false;
    speechPlaying = false;
    bargeIn = false;
    lastVoiceAt = 0;
    speechFrames = 0;

    if (captureNode) {
      try {
        captureNode.onaudioprocess = null;
        captureNode.disconnect();
      } catch { /* already disconnected */ }
      captureNode = null;
    }
    if (captureSink) {
      try { captureSink.disconnect(); } catch { /* already disconnected */ }
      captureSink = null;
    }
    if (stream) {
      try { stream.getTracks().forEach(track => track.stop()); } catch { /* already stopped */ }
      stream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch { /* already closed */ }
      audioCtx = null;
    }
    analyser = null;
    dataArray = null;

    if (gateArmed && window.jarvis && typeof window.jarvis.voiceDisarmMicrophone === 'function') {
      const staleCaptureId = captureId;
      gateArmed = false;
      captureId = null;
      currentPurpose = null;
      captureExpiresAt = 0;
      window.jarvis.voiceDisarmMicrophone(staleCaptureId).catch(() => { /* best effort */ });
    } else {
      captureId = null;
      currentPurpose = null;
      captureExpiresAt = 0;
    }

    const button = voiceButton();
    if (button) button.classList.remove('recording');
    setIndicator(false);
  }

  // Stop capture without changing the persisted wake-word opt-in. Used when
  // main revokes the lease on hide, quit, or a renderer boundary.
  function suspendCapture() {
    const wasRunning = active || oneShot;
    active = false;
    oneShot = false;
    awaitingCommand = false;
    bargeIn = false;
    teardown();
    if (wasRunning) updateIndicator();
  }

  function handleVisibility(payload) {
    const next = !(payload && payload.visible === false);
    if (next === visible) return;
    visible = next;
    if (!visible) {
      suspendCapture();
      return;
    }
    scheduleAutoStart();
  }

  function handleCaptureRevoked(payload = {}) {
    const reason = String(payload.reason || '');
    if (reason === 'window-hidden') {
      visible = false;
      suspendCapture();
      return;
    }
    if (reason === 'app-quit' || reason === 'renderer-boundary' || reason === 'wake-word-disabled') {
      suspendCapture();
      return;
    }
    // Locking revokes the previous lease. Continuous wake-word capture may
    // re-arm only against the main-owned opt-in; one-shot capture never
    // survives the lock boundary.
    if (oneShot) {
      cancelOneShot(false);
      return;
    }
    if (!active || !visible) return;
    if (revokeRearmTimer) return;
    revokeRearmTimer = setTimeout(() => {
      revokeRearmTimer = null;
      if (!active || oneShot || !visible) return;
      armMicrophone('wake-word').catch(error => {
        console.warn('[Voice] Wake-word re-arm after revocation failed:', error.message);
      });
    }, 300);
  }

  async function start(options = {}) {
    if (active) return true;
    if (startInFlight) return false;
    startInFlight = true;
    let enabledByUser = false;
    try {
      if (options.fromSetting !== true) {
        // The opt-in is persisted by main. Re-asserting an already-enabled
        // setting is allowed on the lock screen; enabling a new one is not.
        const enabled = await window.jarvis.voiceSetWakeWord(true);
        if (!enabled || enabled.ok !== true) {
          throw new Error((enabled && enabled.error) || 'Could not enable the local wake word');
        }
        enabledByUser = true;
      }
      await ensureCapture({ purpose: 'wake-word' });
      active = true;
      oneShot = false;
      awaitingCommand = false;
      bargeIn = false;
      scheduleCaptureRearm();
      updateIndicator();
      if (!options.silent) {
        toast('Local wake word active. Say "Hey JARVIS" anytime.', 'success');
      }
      return true;
    } catch (error) {
      teardown();
      active = false;
      if (enabledByUser && window.jarvis && typeof window.jarvis.voiceSetWakeWord === 'function') {
        window.jarvis.voiceSetWakeWord(false).catch(() => { /* best effort */ });
      }
      if (!options.silent) {
        errorToast(`Could not start local voice: ${error.message}`);
      } else {
        console.warn('[Voice] Auto-start failed:', error.message);
      }
      return false;
    } finally {
      startInFlight = false;
    }
  }

  function stop() {
    if (!active && !oneShot) return;
    const wasActive = active;
    active = false;
    oneShot = false;
    awaitingCommand = false;
    bargeIn = false;
    teardown();
    if (wasActive && window.jarvis && typeof window.jarvis.voiceSetWakeWord === 'function') {
      // Disabling is always allowed and revokes wake-word capture in main.
      window.jarvis.voiceSetWakeWord(false).catch(() => { /* best effort */ });
    }
    toast('Local wake word disabled.', 'info');
  }

  async function listenOnce() {
    if (oneShot) {
      cancelOneShot();
      return false;
    }
    if (locked) {
      toast('Unlock JARVIS before using voice input.', 'error');
      return false;
    }
    try {
      await ensureCapture({ purpose: active ? 'wake-word' : 'one-shot' });
      oneShot = true;
      awaitingCommand = false;
      bargeIn = false;
      updateIndicator();
      const button = voiceButton();
      if (button) button.classList.add('recording');
      clearOneShotTimer();
      oneShotTimer = setTimeout(() => {
        if (oneShot && !recording && !transcribing) {
          toast('No speech detected, sir.', 'info');
          finishOneShot();
        }
      }, 10000);
      playTone(880, 70, 0.035);
      toast('Listening locally…', 'info');
      return true;
    } catch (error) {
      teardown();
      errorToast(`Microphone unavailable: ${error.message}`);
      return false;
    }
  }

  function bindVoiceButton() {
    const button = voiceButton();
    if (!button || button.dataset.localVoiceBound === '1') return;
    button.dataset.localVoiceBound = '1';
    button.title = 'Local voice input (Whisper)';
    button.addEventListener('click', event => {
      event.preventDefault();
      listenOnce();
    });
  }

  function init() {
    if (initialized) return true;
    if (!window.jarvis) return false;
    initialized = true;

    if (typeof window.jarvis.onToggleVoice === 'function') {
      window.jarvis.onToggleVoice(() => { listenOnce(); });
    }
    if (typeof window.jarvis.onVoiceCaptureRevoked === 'function') {
      window.jarvis.onVoiceCaptureRevoked(handleCaptureRevoked);
    }
    if (typeof window.jarvis.onAppVisibility === 'function') {
      window.jarvis.onAppVisibility(handleVisibility);
    }

    window.addEventListener('jarvis:speech-start', () => {
      speechPlaying = true;
      suppressUntil = performance.now() + VAD.ttsSuppressMs;
    });
    window.addEventListener('jarvis:speech-stop', () => {
      speechPlaying = false;
      bargeIn = false;
      if (!locked) updateIndicator();
    });

    const ready = () => {
      bindVoiceButton();
      observeAuthScreen();
      scheduleAutoStart();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ready, { once: true });
    } else {
      ready();
    }
    return true;
  }

  function isActive() {
    return active;
  }

  function isLocked() {
    return locked;
  }

  return {
    init,
    start,
    stop,
    toggle: () => { if (active) stop(); else start(); },
    listenOnce,
    isActive,
    isLocked,
    phrase: WAKE_PHRASE,
    local: true,
  };
})();
