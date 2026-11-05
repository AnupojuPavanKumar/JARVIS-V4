'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerSecurityController = require('../backend/controllers/SecurityController');
const { createCapabilityStore } = require('../backend/security/capability-store');
const { createSessionState } = require('../backend/security/session-state');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-controller-test-'));
}

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    has(channel) { return handlers.has(channel); },
    invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, payload);
    },
  };
}

function fakeDialog({ response = 0, onShow = null } = {}) {
  const calls = [];
  return {
    calls,
    async showMessageBox(_window, options) {
      calls.push(options);
      if (typeof onShow === 'function') onShow();
      return { response };
    },
  };
}

function makeHarness({
  state = 'unlocked',
  audit = { durable: true, mode: 'durable', integrity: 'ok', warning: null },
  response = 0,
  onShow = null,
} = {}) {
  const dir = tempDir();
  const ipcMain = fakeIpc();
  const sessionState = createSessionState({ initial: state });
  const audits = [];
  const store = createCapabilityStore({
    audit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
  });
  const dialog = fakeDialog({ response, onShow });
  registerSecurityController({
    ipcMain,
    app: { getPath: () => dir },
    dialog,
    mainWindowProvider: () => ({ isDestroyed: () => false }),
    secAudit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    sessionState,
    capabilityStore: store,
    auditStatus: () => audit,
  });
  return { dir, ipcMain, sessionState, store, dialog, audits, audit };
}

test('P2-2 security-get exposes durable audit status', async t => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const result = await h.ipcMain.invoke('security-get');
  assert.equal(result.ok, true);
  assert.equal(result.audit.durable, true);
  assert.equal(result.audit.mode, 'durable');
  assert.equal(result.audit.integrity, 'ok');
});

test('P2-2 audit-unavailable denies only terminal, screen capture, and export-save', async t => {
  const h = makeHarness({
    audit: {
      durable: false,
      mode: 'memory',
      integrity: 'unavailable',
      reason: 'OS-backed encryption is unavailable',
      warning: 'Memory-only audit',
    },
  });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  for (const capability of ['terminal', 'screen-capture', 'export-save']) {
    const denied = await h.ipcMain.invoke('security-request', { capability });
    assert.equal(denied.ok, false, capability);
    assert.match(denied.error, /audit/i, capability);
    assert.equal(denied.audit.durable, false, capability);
    assert.equal(h.store.isGranted(capability), false, capability);
  }
  assert.equal(h.dialog.calls.length, 0);

  // Microphone is intentionally outside the narrowed fail-closed scope. It is
  // not directly requestable, so it must reach the normal policy denial rather
  // than the audit-unavailable denial.
  const microphone = await h.ipcMain.invoke('security-request', { capability: 'microphone' });
  assert.equal(microphone.ok, false);
  assert.match(microphone.error, /not directly requestable/i);
  assert.doesNotMatch(microphone.error, /audit/i);

  const revoked = await h.ipcMain.invoke('security-revoke', { all: true });
  assert.equal(revoked.ok, true);
});

test('P2-2 durable audit permits a normal native capability grant', async t => {
  const h = makeHarness({ response: 0 });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const result = await h.ipcMain.invoke('security-request', { capability: 'terminal' });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.terminal.granted, true);
  assert.equal(result.audit.durable, true);
  assert.equal(h.dialog.calls.length, 1);
});

test('P2-2 audit failure after consent refuses the grant', async t => {
  const h = makeHarness({
    response: 0,
    onShow: () => {
      h.audit.durable = false;
      h.audit.mode = 'memory';
      h.audit.reason = 'write failed';
    },
  });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));

  const result = await h.ipcMain.invoke('security-request', { capability: 'terminal' });
  assert.equal(result.ok, false);
  assert.match(result.error, /became unavailable/i);
  assert.equal(result.audit.durable, false);
  assert.equal(h.store.isGranted('terminal'), false);
  assert.equal(h.dialog.calls.length, 1);
});
