'use strict';

// Write-only clipboard bridge. The renderer runs in a sandboxed preload where
// Electron's clipboard module is not exposed, so the write happens in main.
// There is deliberately no read API: copying chat output must never grant a
// renderer access to unrelated clipboard contents.
const MAX_CLIPBOARD_TEXT_LENGTH = 1024 * 1024;

function normalizeClipboardText(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Clipboard text must be a string' };
  if (text.length === 0) return { ok: false, error: 'Clipboard text is empty' };
  if (text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    return { ok: false, error: 'Clipboard text is too large' };
  }
  return { ok: true, text };
}

function createClipboardWriter(clipboard) {
  return function writeClipboardText(text) {
    const normalized = normalizeClipboardText(text);
    if (!normalized.ok) return normalized;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return { ok: false, error: 'Clipboard is unavailable' };
    }
    try {
      clipboard.writeText(normalized.text);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Clipboard write failed' };
    }
  };
}

module.exports = function registerClipboardController({ ipcMain, clipboard }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerClipboardController requires ipcMain.handle');
  }
  const writeClipboardText = createClipboardWriter(clipboard);
  ipcMain.handle('clipboard-write-text', async (_event, text) => writeClipboardText(text));
};

module.exports.createClipboardWriter = createClipboardWriter;
module.exports.normalizeClipboardText = normalizeClipboardText;
module.exports.MAX_CLIPBOARD_TEXT_LENGTH = MAX_CLIPBOARD_TEXT_LENGTH;
