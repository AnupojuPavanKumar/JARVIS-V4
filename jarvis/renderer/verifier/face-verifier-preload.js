'use strict';

/**
 * Minimal preload for the isolated face verifier.
 *
 * This is intentionally not the main application preload. The page can only
 * start/stop one verifier attempt and return progress plus a nonce-bound
 * result. It has no access to the JARVIS bridge, file system, clipboard, or
 * arbitrary IPC.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return;
  ipcRenderer.once(channel, (_event, payload) => {
    try {
      callback(payload || {});
    } catch (_) { /* the verifier page owns its own error handling */ }
  });
}

contextBridge.exposeInMainWorld('faceVerifier', Object.freeze({
  onStart: callback => subscribe('face-verifier-start', callback),
  onStop: callback => subscribe('face-verifier-stop', callback),
  reportProgress: payload => ipcRenderer.send('face-verifier-progress', payload),
  reportResult: payload => ipcRenderer.invoke('face-verifier-result', payload),
}));
