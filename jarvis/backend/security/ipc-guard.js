'use strict';

const { getIpcPolicy } = require('./ipc-session-policy');

const DEFAULT_DENY_ERROR = 'untrusted sender';
const SESSION_DENY_ERROR = 'JARVIS is locked';

function safeCall(fn, fallback = null) {
  try { return fn(); } catch (_) { return fallback; }
}

function frameUrl(frame) {
  return frame && typeof frame.url === 'string' ? frame.url : null;
}

function frameDestroyed(frame) {
  return !frame || safeCall(() => frame.isDestroyed?.() === true, true);
}

function createIpcGuard({
  ipcMain,
  getMainWindow,
  approvedRendererUrl,
  getVerifierWebContents = () => null,
  approvedVerifierUrl = null,
  sessionState,
  audit = () => {},
  strictPolicy = true,
  auditLimitPerMinute = 30,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('ipcMain with handle/on is required');
  }
  if (!sessionState || typeof sessionState.state !== 'string') {
    throw new TypeError('sessionState is required');
  }
  if (typeof approvedRendererUrl !== 'string' || approvedRendererUrl.length === 0) {
    throw new TypeError('approvedRendererUrl is required');
  }

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);
  const auditTimes = new Map();
  let installed = false;

  function auditBlocked(action, detail) {
    const now = Date.now();
    const key = `${action}:${detail}`;
    const recent = (auditTimes.get(key) || []).filter(t => now - t < 60000);
    if (recent.length < auditLimitPerMinute) {
      recent.push(now);
      auditTimes.set(key, recent);
      audit(action, detail, 'BLOCKED');
    } else {
      auditTimes.set(key, recent);
    }
  }

  function validateMainSender(event) {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!win || safeCall(() => win.isDestroyed() === true, true)) {
      return { ok: false, reason: 'no-main-window' };
    }
    const sender = event && event.sender;
    const webContents = win.webContents;
    if (!sender || !webContents || sender !== webContents) {
      return { ok: false, reason: 'wrong-web-contents' };
    }
    if (safeCall(() => sender.isDestroyed() === true, false)) {
      return { ok: false, reason: 'sender-destroyed' };
    }
    const frame = event.senderFrame;
    if (frameDestroyed(frame)) {
      return { ok: false, reason: 'frame-destroyed' };
    }
    const mainFrame = safeCall(() => sender.mainFrame, null);
    if (!mainFrame || frame !== mainFrame) {
      return { ok: false, reason: 'subframe' };
    }
    if (frameUrl(frame) !== approvedRendererUrl) {
      return { ok: false, reason: 'unapproved-url' };
    }
    return { ok: true };
  }

  function validateVerifierSender(event) {
    if (typeof approvedVerifierUrl !== 'string' || approvedVerifierUrl.length === 0) {
      return { ok: false, reason: 'no-verifier-policy' };
    }
    const verifier = typeof getVerifierWebContents === 'function'
      ? safeCall(() => getVerifierWebContents(), null)
      : null;
    if (!verifier) {
      return { ok: false, reason: 'no-verifier' };
    }
    const sender = event && event.sender;
    if (!sender || sender !== verifier) {
      return { ok: false, reason: 'wrong-web-contents' };
    }
    if (safeCall(() => sender.isDestroyed() === true, true)) {
      return { ok: false, reason: 'sender-destroyed' };
    }
    const frame = event.senderFrame;
    if (frameDestroyed(frame)) {
      return { ok: false, reason: 'frame-destroyed' };
    }
    const mainFrame = safeCall(() => sender.mainFrame, null);
    if (!mainFrame || frame !== mainFrame) {
      return { ok: false, reason: 'subframe' };
    }
    if (frameUrl(frame) !== approvedVerifierUrl) {
      return { ok: false, reason: 'unapproved-url' };
    }
    return { ok: true };
  }

  function authorize(channel, event) {
    const policy = getIpcPolicy(channel);
    if (!policy) {
      auditBlocked('IPC_POLICY_MISSING', channel);
      return { ok: false, error: DEFAULT_DENY_ERROR, reason: 'no-policy' };
    }
    const surface = policy.surface === 'verifier' ? 'verifier' : 'renderer';
    const sender = surface === 'verifier'
      ? validateVerifierSender(event)
      : validateMainSender(event);
    if (!sender.ok) {
      auditBlocked('IPC_BLOCK', `${channel} surface=${surface} sender=${sender.reason}`);
      return { ok: false, error: DEFAULT_DENY_ERROR, reason: sender.reason };
    }
    if (!policy.states.includes(sessionState.state)) {
      auditBlocked('IPC_SESSION_BLOCK', `${channel} state=${sessionState.state}`);
      return {
        ok: false,
        error: SESSION_DENY_ERROR,
        reason: 'session-state',
        code: 'SESSION_LOCKED',
        state: sessionState.state,
      };
    }
    return { ok: true, policy, surface };
  }

  function registerChecked(channel) {
    const policy = getIpcPolicy(channel);
    if (!policy) {
      const message = `No IPC policy entry for channel: ${channel}`;
      if (strictPolicy) throw new Error(message);
      audit('IPC_POLICY_MISSING', channel, 'ERROR');
    }
  }

  function install() {
    if (installed) return api;
    installed = true;

    ipcMain.handle = (channel, listener) => {
      registerChecked(channel);
      return originalHandle(channel, async (event, ...args) => {
        const decision = authorize(channel, event);
        if (!decision.ok) return decision;
        return listener(event, ...args);
      });
    };

    ipcMain.on = (channel, listener) => {
      registerChecked(channel);
      return originalOn(channel, (event, ...args) => {
        const decision = authorize(channel, event);
        if (!decision.ok) {
          // `send()` has no result channel; setting returnValue is harmless and
          // keeps the denial observable to tests and future invoke-style use.
          try { event.returnValue = decision; } catch (_) {}
          return;
        }
        listener(event, ...args);
      });
    };

    return api;
  }

  const api = Object.freeze({
    install,
    authorize,
    validateVerifierSender,
  });
  return api;
}

module.exports = { createIpcGuard };
