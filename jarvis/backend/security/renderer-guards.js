'use strict';

/**
 * Attach lock-on-boundary guards to the trusted renderer's webContents.
 *
 * A reload, renderer crash, in-app navigation away from the approved entry
 * document, or webContents destruction must never preserve an unlocked main
 * session. These guards are intentionally independent of renderer JS.
 */
function attachRendererSessionGuards(webContents, {
  sessionState,
  approvedRendererUrl,
  audit = () => {},
  onLock = () => {},
  onBoundary = () => {},
  isQuitting = () => false,
} = {}) {
  if (!webContents || typeof webContents.on !== 'function') {
    throw new TypeError('webContents is required');
  }
  if (!sessionState || typeof sessionState.lock !== 'function') {
    throw new TypeError('sessionState is required');
  }
  if (typeof approvedRendererUrl !== 'string' || !approvedRendererUrl) {
    throw new TypeError('approvedRendererUrl is required');
  }

  let attached = false;

  function lock(reason) {
    // Capability revocation happens even for an explicit no-lock install,
    // whose session state intentionally does not change on reload/hide.
    try { onBoundary(reason); } catch (_) {}
    const before = sessionState.state;
    sessionState.lock(reason);
    if (before !== sessionState.state) onLock(reason);
  }

  function isApproved(url) {
    return typeof url === 'string' && url === approvedRendererUrl;
  }

  function auditBlock(action, value, reason) {
    audit(action, String(value == null ? '' : value).slice(0, 300), `BLOCKED - ${reason}`);
  }

  function install() {
    if (attached) return;
    attached = true;

    // A renderer-initiated reload/navigation is a new, untrusted document until
    // the same approved entry document is authenticated again.
    webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) lock('renderer navigation/reload');
    });

    // Only the exact entry document is a legal main-frame destination. Anything
    // else - file, http, data, custom protocol, or a lookalike URL - is stopped
    // before the committed navigation can inherit this window's preload.
    for (const eventName of ['will-navigate', 'will-redirect']) {
      webContents.on(eventName, (event, url) => {
        if (!isApproved(url)) {
          try { event.preventDefault(); } catch (_) {}
          auditBlock('NAVIGATION_BLOCK', url, 'unapproved destination');
          lock(`blocked navigation (${String(url).slice(0, 120)})`);
        }
      });
    }

    // New renderer windows are never part of the JARVIS UI. External links go
    // through the explicit, validated open-external action instead.
    if (typeof webContents.setWindowOpenHandler === 'function') {
      webContents.setWindowOpenHandler(details => {
        const url = details && details.url;
        auditBlock('WINDOW_OPEN_BLOCK', url, 'new windows are denied');
        lock('blocked window.open');
        return { action: 'deny' };
      });
    }

    // webviewTag is disabled on the main BrowserWindow. These handlers are a
    // second, independent barrier in case a future preference or dependency
    // attempts to attach guest content.
    webContents.on('will-attach-webview', (event, _webPreferences, params = {}) => {
      try { event.preventDefault(); } catch (_) {}
      auditBlock('WEBVIEW_BLOCK', params.src, 'webview attachment is denied');
      lock('blocked webview attachment');
    });

    webContents.on('did-attach-webview', (_event, guest) => {
      auditBlock('WEBVIEW_BLOCK', 'guest content attached', 'destroying guest');
      try {
        if (guest && typeof guest.close === 'function') guest.close();
        else if (guest && typeof guest.destroy === 'function') guest.destroy();
      } catch (_) { /* best effort */ }
      lock('blocked attached webview');
    });

    webContents.on('render-process-gone', (_event, details = {}) => {
      audit('RENDERER_GONE', details.reason || 'unknown', 'LOCK');
      lock(`renderer gone (${details.reason || 'unknown'})`);
    });

    webContents.on('destroyed', () => {
      if (isQuitting()) return;
      audit('RENDERER_DESTROYED', 'webContents destroyed', 'LOCK');
      lock('renderer destroyed');
    });
  }

  return Object.freeze({ install, isApproved, lock });
}

module.exports = { attachRendererSessionGuards };
