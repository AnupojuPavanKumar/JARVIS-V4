'use strict';

/**
 * Main-owned local voice IPC.
 *
 * The renderer may ask for one of two capture purposes, but it cannot pass a
 * lock-screen flag, a duration, or an audio lease assertion. Main decides from
 * the persisted opt-in, session state, window visibility, and bounded leases.
 */
module.exports = function registerVoiceController({
  ipcMain,
  voicePolicy,
  mainWindowProvider,
  secAudit = () => {},
  sendRenderer = () => {},
  transcriptionStatus = null,
}) {
  if (!voicePolicy) {
    throw new Error('voice controller requires the main-owned voice policy');
  }

  function trustedSender(event) {
    const win = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    return !!event && event.sender === win.webContents;
  }

  function senderId(event) {
    return event && event.sender ? event.sender.id : 0;
  }

  function hasLegacyRendererFields(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(payload, 'lockScreen')
      || Object.prototype.hasOwnProperty.call(payload, 'durationMs');
  }

  function auditBlocked(action, detail) {
    secAudit(action, String(detail).slice(0, 180), 'BLOCKED');
  }

  ipcMain.handle('voice-status', async () => {
    const status = voicePolicy.status();
    let transcription = null;
    if (typeof transcriptionStatus === 'function') {
      try {
        const value = transcriptionStatus();
        transcription = value && typeof value === 'object' ? value : null;
      } catch (_) {
        transcription = {
          available: false,
          verified: false,
          pending: false,
          busy: false,
          error: 'Local transcription status is unavailable',
        };
      }
    }
    return { ...status, transcription };
  });

  ipcMain.handle('voice-set-wake-word', async (event, payload = {}) => {
    if (!trustedSender(event)) {
      auditBlocked('VOICE_SETTING', 'untrusted sender');
      return { ok: false, error: 'A trusted JARVIS window is required' };
    }
    const enabled = payload && payload.enabled;
    const result = voicePolicy.setWakeWordEnabled(enabled);
    if (!result.ok) {
      auditBlocked('VOICE_WAKE_WORD_SETTING', result.error);
      return result;
    }
    if (result.revokedWakeWord) {
      sendRenderer('voice-capture-revoked', { reason: 'wake-word-disabled' });
    }
    return result;
  });

  ipcMain.handle('voice-arm-microphone', async (event, payload = {}) => {
    if (!trustedSender(event)) {
      auditBlocked('VOICE_MIC_ARM', 'untrusted sender');
      return { ok: false, error: 'A trusted JARVIS window is required for microphone access' };
    }
    if (hasLegacyRendererFields(payload)) {
      // A renderer-provided lockScreen or duration was the old authority. It is
      // now rejected outright so a stale renderer cannot bypass main policy.
      auditBlocked('VOICE_MIC_ARM', 'renderer-supplied lockScreen/duration');
      return { ok: false, error: 'Microphone policy is owned by the main process' };
    }

    const result = voicePolicy.armCapture({
      purpose: payload && payload.purpose,
      webContentsId: senderId(event),
    });
    if (!result.ok) {
      auditBlocked('VOICE_MIC_ARM', result.error);
      return result;
    }

    secAudit(
      'VOICE_MIC_ARM',
      `${result.purpose} capture ${result.durationMs}ms`,
      'ALLOW'
    );
    return result;
  });

  ipcMain.handle('voice-disarm-microphone', async (event, payload = {}) => {
    if (!trustedSender(event)) {
      auditBlocked('VOICE_MIC_DISARM', 'untrusted sender');
      return { ok: false, error: 'A trusted JARVIS window is required' };
    }
    const result = voicePolicy.disarmCapture({
      webContentsId: senderId(event),
      captureId: payload && payload.captureId,
    });
    secAudit('VOICE_MIC_DISARM', result.ok ? 'local capture stopped' : result.error, result.ok ? 'OK' : 'BLOCKED');
    return result;
  });

  ipcMain.handle('voice-create-transcription-lease', async (event) => {
    if (!trustedSender(event)) {
      auditBlocked('VOICE_TRANSCRIBE_LEASE', 'untrusted sender');
      return { ok: false, error: 'A trusted JARVIS window is required for transcription' };
    }
    const result = voicePolicy.issueTranscriptionLease({ webContentsId: senderId(event) });
    if (!result.ok) {
      auditBlocked('VOICE_TRANSCRIBE_LEASE', result.error);
      return result;
    }
    secAudit('VOICE_TRANSCRIBE_LEASE', `issued ${result.expiresAt}`, 'ALLOW');
    return result;
  });
};
