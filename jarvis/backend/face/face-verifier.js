'use strict';

/**
 * Isolated face verifier surface.
 *
 * A fresh, hidden, sandboxed BrowserWindow is created for every unlock or
 * enrollment attempt. It uses its own minimal preload, its own ephemeral
 * session partition, and a local trusted page. Camera permission is granted
 * only to this exact webContents while the main-owned camera lease is active.
 *
 * The surface never awards access. It only returns an embedding or enrollment
 * samples to FaceController, which validates the one-time challenge and owns
 * the lock transition.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FACE_VERIFIER_PARTITION = 'face-verifier';
const DEFAULT_MAX_LIFETIME_MS = 45 * 1000;
const DEFAULT_EXPIRY_GRACE_MS = 750;

function createFaceVerifierSurface({
  BrowserWindow,
  session,
  rootDir,
  logger = console,
  now = () => Date.now(),
  onUnexpectedStop = () => {},
  maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
  expiryGraceMs = DEFAULT_EXPIRY_GRACE_MS,
} = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('BrowserWindow is required');
  }
  if (!rootDir || typeof rootDir !== 'string') {
    throw new TypeError('rootDir is required');
  }

  const pagePath = path.join(rootDir, 'renderer', 'verifier', 'face-verifier.html');
  const preloadPath = path.join(rootDir, 'renderer', 'verifier', 'face-verifier-preload.js');
  const approvedUrl = pathToFileURL(pagePath).href;
  const boundNow = typeof now === 'function' ? now : () => Date.now();

  let win = null;
  let deadlineTimer = null;
  let generation = 0;
  let suppressEvents = false;

  function assetsAvailable() {
    try {
      return fs.existsSync(pagePath) && fs.existsSync(preloadPath);
    } catch {
      return false;
    }
  }

  function isAvailable() {
    return Boolean(session) && assetsAvailable();
  }

  function currentWebContents() {
    if (!win) return null;
    try {
      if (win.isDestroyed()) return null;
      const webContents = win.webContents;
      if (!webContents || webContents.isDestroyed()) return null;
      return webContents;
    } catch {
      return null;
    }
  }

  function getWebContents() {
    return currentWebContents();
  }

  function getSession() {
    return session || null;
  }

  function isSender(webContents) {
    const current = currentWebContents();
    return Boolean(current && webContents && current === webContents);
  }

  function clearDeadline() {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  }

  function destroyWindow(reason) {
    const current = win;
    win = null;
    clearDeadline();
    if (!current) return;
    suppressEvents = true;
    try {
      if (!current.isDestroyed()) {
        try {
          current.webContents.send('face-verifier-stop', { reason });
        } catch (_) { /* the verifier may already be gone */ }
        current.destroy();
      }
    } catch (error) {
      logger?.warn?.('[FACE] Could not destroy the verifier window:', error?.message || error);
    } finally {
      suppressEvents = false;
    }
  }

  function stop(reason = 'stopped') {
    generation += 1;
    destroyWindow(reason);
    return { ok: true };
  }

  function fail(reason) {
    if (!win) return;
    generation += 1;
    destroyWindow(reason);
    try {
      onUnexpectedStop(reason);
    } catch (error) {
      logger?.warn?.('[FACE] Verifier stop handler failed:', error?.message || error);
    }
  }

  function handleWindowEvent(eventGeneration, reason) {
    if (suppressEvents || !win || eventGeneration !== generation) return;
    fail(reason);
  }

  async function start({ purpose, nonce, deadline, modelBaseUrl } = {}) {
    if (!isAvailable()) {
      return { ok: false, error: 'Trusted face verifier is unavailable' };
    }
    if (purpose !== 'unlock' && purpose !== 'enroll') {
      return { ok: false, error: 'Invalid face verifier purpose' };
    }
    if (typeof nonce !== 'string' || nonce.length < 32) {
      return { ok: false, error: 'Invalid face verifier challenge' };
    }

    const startedAt = boundNow();
    const requestedDeadline = Number(deadline);
    const cappedDeadline = startedAt + Math.max(1000, Number(maxLifetimeMs) || DEFAULT_MAX_LIFETIME_MS);
    const expiresAt = Number.isFinite(requestedDeadline)
      ? Math.min(Math.max(requestedDeadline, startedAt + 1000), cappedDeadline)
      : cappedDeadline;

    stop('replaced');
    const eventGeneration = ++generation;
    let created;
    try {
      created = new BrowserWindow({
        show: false,
        width: 480,
        height: 360,
        frame: false,
        focusable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: '#000000',
        title: 'JARVIS Local Face Verifier',
        webPreferences: {
          preload: preloadPath,
          session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          webviewTag: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          experimentalFeatures: false,
          navigateOnDragDrop: false,
          spellcheck: false,
          devTools: false,
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required',
        },
      });
    } catch (error) {
      logger?.warn?.('[FACE] Could not create the verifier window:', error?.message || error);
      return { ok: false, error: 'Trusted face verifier could not start' };
    }

    win = created;
    try {
      created.setMenu?.(null);
      created.setSkipTaskbar?.(true);
      created.setIgnoreMouseEvents?.(true);
      created.setAlwaysOnTop?.(false);
    } catch (_) { /* best effort */ }

    const webContents = created.webContents;
    try {
      webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      webContents.on?.('will-attach-webview', event => {
        event?.preventDefault?.();
        handleWindowEvent(eventGeneration, 'webview-attach');
      });
      const blockNavigation = (event, url) => {
        if (url === approvedUrl) return;
        event?.preventDefault?.();
        try { webContents.stop?.(); } catch (_) { /* best effort */ }
        handleWindowEvent(eventGeneration, 'navigation-blocked');
      };
      webContents.on?.('will-navigate', blockNavigation);
      webContents.on?.('will-redirect', blockNavigation);
      webContents.on?.('render-process-gone', (_event, details) => {
        handleWindowEvent(eventGeneration, `renderer-gone:${details?.reason || 'unknown'}`);
      });
      webContents.on?.('unresponsive', () => handleWindowEvent(eventGeneration, 'unresponsive'));
      webContents.on?.('destroyed', () => handleWindowEvent(eventGeneration, 'destroyed'));
      created.on?.('closed', () => handleWindowEvent(eventGeneration, 'closed'));
    } catch (error) {
      logger?.warn?.('[FACE] Could not attach verifier guards:', error?.message || error);
      stop('guard-failed');
      return { ok: false, error: 'Trusted face verifier could not start' };
    }

    try {
      await created.loadFile(pagePath);
    } catch (error) {
      if (eventGeneration === generation) stop('load-failed');
      logger?.warn?.('[FACE] Verifier page failed to load:', error?.message || error);
      return { ok: false, error: 'Trusted face verifier failed to load' };
    }

    if (eventGeneration !== generation || win !== created) {
      return { ok: false, error: 'Face verifier was cancelled' };
    }

    try {
      webContents.send('face-verifier-start', {
        purpose,
        nonce,
        deadline: expiresAt,
        modelBaseUrl,
      });
    } catch (error) {
      stop('send-failed');
      logger?.warn?.('[FACE] Could not start the verifier page:', error?.message || error);
      return { ok: false, error: 'Trusted face verifier could not be reached' };
    }

    const grace = Math.max(0, Number(expiryGraceMs) || 0);
    const delay = Math.max(0, expiresAt - boundNow()) + grace;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (eventGeneration !== generation) return;
      fail('expired');
    }, delay);
    deadlineTimer.unref?.();

    logger?.log?.(`[FACE] Trusted verifier started for ${purpose}`);
    return { ok: true, expiresAt };
  }

  return Object.freeze({
    start,
    stop,
    isAvailable,
    isSender,
    getWebContents,
    getSession,
    getApprovedUrl: () => approvedUrl,
    getPagePath: () => pagePath,
    getPreloadPath: () => preloadPath,
  });
}

module.exports = {
  FACE_VERIFIER_PARTITION,
  createFaceVerifierSurface,
};
