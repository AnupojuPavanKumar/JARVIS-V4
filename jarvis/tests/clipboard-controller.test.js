'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerClipboardController = require('../backend/controllers/ClipboardController');
const {
  MAX_CLIPBOARD_TEXT_LENGTH,
  normalizeClipboardText,
} = require('../backend/controllers/ClipboardController');

function fakeIpc() {
  const handlers = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    invoke(channel, ...args) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, ...args);
    },
  };
}

function fakeClipboard({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    reads: 0,
    writeText(text) {
      if (fail) throw new Error('clipboard offline');
      calls.push(text);
    },
    readText() {
      this.reads += 1;
      return 'secret unrelated clipboard content';
    },
  };
}

test('P1-4 clipboard bridge writes only the provided string', async () => {
  const ipcMain = fakeIpc();
  const clipboard = fakeClipboard();
  registerClipboardController({ ipcMain, clipboard });

  const result = await ipcMain.invoke('clipboard-write-text', 'copy me');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(clipboard.calls, ['copy me']);
  assert.equal(clipboard.reads, 0, 'the bridge must never read the clipboard');
});

test('P1-4 clipboard bridge rejects non-strings, empty text, and oversized payloads', async () => {
  const ipcMain = fakeIpc();
  const clipboard = fakeClipboard();
  registerClipboardController({ ipcMain, clipboard });

  for (const value of [undefined, null, 42, {}, ['text'], Buffer.from('text')]) {
    const result = await ipcMain.invoke('clipboard-write-text', value);
    assert.equal(result.ok, false, String(value));
    assert.match(result.error, /must be a string/i);
  }

  const empty = await ipcMain.invoke('clipboard-write-text', '');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/i);

  const oversized = await ipcMain.invoke(
    'clipboard-write-text',
    'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1)
  );
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /too large/i);

  assert.deepEqual(clipboard.calls, []);
  assert.equal(clipboard.reads, 0);
});

test('P1-4 clipboard bridge accepts the documented size boundary', () => {
  const atLimit = normalizeClipboardText('x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH));
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.text.length, MAX_CLIPBOARD_TEXT_LENGTH);

  const overLimit = normalizeClipboardText('x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1));
  assert.equal(overLimit.ok, false);
});

test('P1-4 clipboard bridge reports unavailable and failing clipboards', async () => {
  const unavailableIpc = fakeIpc();
  registerClipboardController({ ipcMain: unavailableIpc, clipboard: null });
  const unavailable = await unavailableIpc.invoke('clipboard-write-text', 'text');
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error, /unavailable/i);

  const failingIpc = fakeIpc();
  const clipboard = fakeClipboard({ fail: true });
  registerClipboardController({ ipcMain: failingIpc, clipboard });
  const failed = await failingIpc.invoke('clipboard-write-text', 'text');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /offline/i);
  assert.equal(clipboard.reads, 0);
});
