'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerSecurityController = require('../backend/controllers/SecurityController');
const { createSessionState } = require('../backend/security/session-state');
const {
  AUTH_STATUS,
  PIN_WINDOW_MS,
  authFilePath,
  authRatePath,
  createPinRateLimiter,
  readAuth,
  writePin,
} = require('../backend/auth/auth-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-security-controller-test-'));
}

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    has(channel) { return handlers.has(channel); },
    invoke(channel, ...args) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`No handler for ${channel}`);
      return listener({}, ...args);
    },
  };
}

function fakeFaceStore({ enrolled = false } = {}) {
  return {
    enrolled,
    removed: 0,
    async getStatus() { return { ok: true, enrolled: this.enrolled }; },
    async remove() {
      this.removed += 1;
      this.enrolled = false;
      return { ok: true };
    },
  };
}

function fakeDialog(initialResponse = 1) {
  const calls = [];
  let response = initialResponse;
  return {
    calls,
    setResponse(value) { response = value; },
    async showMessageBox(_win, options) {
      calls.push(options);
      return { response };
    },
  };
}

function makeHarness(dir, {
  state = 'setup',
  sessionState = null,
  faceEnrolled = false,
  dialogResponse = 1,
  pinRateLimiter = null,
} = {}) {
  const ipcMain = fakeIpc();
  const session = sessionState || createSessionState({ initial: state });
  const faceStore = fakeFaceStore({ enrolled: faceEnrolled });
  const dialog = fakeDialog(dialogResponse);
  const audits = [];
  registerSecurityController({
    ipcMain,
    app: { getPath: () => dir },
    dialog,
    mainWindowProvider: () => ({ isDestroyed: () => false }),
    secAudit: (action, detail, verdict) => audits.push({ action, detail, verdict }),
    sessionState: session,
    faceStore,
    pinRateLimiter,
  });
  return { ipcMain, session, faceStore, dialog, audits };
}

test('P0-2 auth-save is gone and only command-specific auth channels are registered', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = makeHarness(dir);

  assert.equal(h.ipcMain.has('auth-save'), false);
  for (const channel of [
    'auth-load',
    'auth-setup-pin',
    'auth-skip',
    'auth-verify',
    'auth-change-pin',
    'auth-recover-reset',
  ]) {
    assert.equal(h.ipcMain.has(channel), true, channel);
  }
  assert.throws(
    () => h.ipcMain.invoke('auth-save', { pin: '4821' }),
    /No handler/
  );
});

test('P0-2 setup PIN is atomic, moves to locked, and requires one PIN entry', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = makeHarness(dir, { state: 'setup' });

  assert.equal((await readAuth(dir)).status, AUTH_STATUS.MISSING);
  const setup = await h.ipcMain.invoke('auth-setup-pin', { pin: '4821' });
  assert.equal(setup.ok, true);
  assert.equal(setup.requiresUnlock, true);
  assert.equal(h.session.state, 'locked');
  assert.equal(h.session.lockRequired, true);
  assert.equal(h.session.canUsePrivileges, false);

  const load = await h.ipcMain.invoke('auth-load');
  assert.equal(load.ok, true);
  assert.equal(load.state, 'locked');
  assert.equal(load.status, AUTH_STATUS.USABLE_PIN);
  assert.equal(load.data.hasPin, true);
  assert.equal(load.data.skipPin, false);

  const unlocked = await h.ipcMain.invoke('auth-verify', '4821');
  assert.equal(unlocked.ok, true);
  assert.equal(h.session.state, 'unlocked');

  const secondSetup = await h.ipcMain.invoke('auth-setup-pin', { pin: '1111' });
  assert.equal(secondSetup.ok, false);
});

test('P0-2 setup rejects malformed PINs and pre-existing credentials', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = makeHarness(dir, { state: 'setup' });

  assert.equal((await h.ipcMain.invoke('auth-setup-pin', { pin: '123' })).ok, false);
  assert.equal((await h.ipcMain.invoke('auth-setup-pin', { pin: 'abcd' })).ok, false);
  assert.equal((await readAuth(dir)).status, AUTH_STATUS.MISSING);

  assert.equal((await writePin(dir, '4821')).ok, true);
  const existing = makeHarness(dir, { state: 'setup', dialogResponse: 0 });
  const setup = await existing.ipcMain.invoke('auth-setup-pin', { pin: '1111' });
  assert.equal(setup.ok, false);
  assert.match(setup.error, /already exists|credential/i);
  const skip = await existing.ipcMain.invoke('auth-skip');
  assert.equal(skip.ok, false);
  assert.equal(existing.dialog.calls.length, 0);
});

test('P0-2 skip requires setup, no face, no PIN, and native approval', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = makeHarness(dir, { state: 'setup', faceEnrolled: true, dialogResponse: 0 });

  const faceBlocked = await h.ipcMain.invoke('auth-skip');
  assert.equal(faceBlocked.ok, false);
  assert.match(faceBlocked.error, /face/i);
  assert.equal(h.dialog.calls.length, 0);

  h.faceStore.enrolled = false;
  h.dialog.setResponse(1);
  const cancelled = await h.ipcMain.invoke('auth-skip');
  assert.equal(cancelled.ok, false);
  assert.equal(h.session.state, 'setup');
  assert.equal(h.dialog.calls.length, 1);
  assert.match(h.dialog.calls[0].detail, /Anyone who can use this Windows account/i);
  assert.equal((await readAuth(dir)).status, AUTH_STATUS.MISSING);

  h.dialog.setResponse(0);
  const skipped = await h.ipcMain.invoke('auth-skip');
  assert.equal(skipped.ok, true);
  assert.equal(h.session.state, 'no-lock');
  assert.equal((await readAuth(dir)).status, AUTH_STATUS.EXPLICIT_SKIP);
  assert.equal((await h.ipcMain.invoke('auth-verify', '0000')).ok, false);
  assert.equal((await h.ipcMain.invoke('auth-skip')).ok, false);
});

test('P0-2 change PIN is unlocked-only and verifies the current PIN in main', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = makeHarness(dir, { state: 'setup' });

  assert.equal((await h.ipcMain.invoke('auth-setup-pin', { pin: '4821' })).ok, true);
  const lockedChange = await h.ipcMain.invoke('auth-change-pin', {
    currentPin: '4821',
    newPin: '1111',
  });
  assert.equal(lockedChange.ok, false);

  assert.equal((await h.ipcMain.invoke('auth-verify', '4821')).ok, true);
  const wrongCurrent = await h.ipcMain.invoke('auth-change-pin', {
    currentPin: '0000',
    newPin: '1111',
  });
  assert.equal(wrongCurrent.ok, false);
  assert.match(wrongCurrent.error, /current PIN/i);

  const changed = await h.ipcMain.invoke('auth-change-pin', {
    currentPin: '4821',
    newPin: '1111',
  });
  assert.equal(changed.ok, true);
  assert.equal(h.session.state, 'unlocked');

  h.session.markLocked('test lock');
  assert.equal((await h.ipcMain.invoke('auth-verify', '4821')).ok, false);
  assert.equal((await h.ipcMain.invoke('auth-verify', '1111')).ok, true);
});

test('P0-2 five PIN failures persist across controller restarts', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await writePin(dir, '4821')).ok, true);

  let clock = Date.now();
  const limiter = createPinRateLimiter({ userDataPath: dir, now: () => clock });
  const first = makeHarness(dir, { state: 'locked', pinRateLimiter: limiter });

  for (let i = 0; i < 5; i += 1) {
    const failed = await first.ipcMain.invoke('auth-verify', '0000');
    assert.equal(failed.ok, false);
    assert.equal(failed.rateLimited, undefined);
    assert.equal(first.session.state, 'locked');
  }
  const limited = await first.ipcMain.invoke('auth-verify', '4821');
  assert.equal(limited.ok, false);
  assert.equal(limited.rateLimited, true);
  assert.equal(first.session.state, 'locked');

  const restartedLimiter = createPinRateLimiter({ userDataPath: dir, now: () => clock });
  const restarted = makeHarness(dir, { state: 'locked', pinRateLimiter: restartedLimiter });
  const stillLimited = await restarted.ipcMain.invoke('auth-verify', '4821');
  assert.equal(stillLimited.ok, false);
  assert.equal(stillLimited.rateLimited, true);
  assert.equal(restarted.session.state, 'locked');

  clock += PIN_WINDOW_MS + 1;
  const afterWindow = await restarted.ipcMain.invoke('auth-verify', '4821');
  assert.equal(afterWindow.ok, true);
  assert.equal(restarted.session.state, 'unlocked');
});

test('P0-2 corrupt limiter metadata fails closed and allows native recovery', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await writePin(dir, '4821')).ok, true);
  fs.writeFileSync(authRatePath(dir), '{bad', { mode: 0o600 });

  const h = makeHarness(dir, { state: 'locked', dialogResponse: 1 });
  const result = await h.ipcMain.invoke('auth-verify', '4821');
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(h.session.state, 'error');

  h.dialog.setResponse(0);
  const recovered = await h.ipcMain.invoke('auth-recover-reset');
  assert.equal(recovered.ok, true);
  assert.equal(h.session.state, 'setup');
});

test('P0-2 corrupt auth file enters error and recovers only with native approval', async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(authFilePath(dir), '{"broken":', { mode: 0o600 });

  const session = createSessionState({ initial: 'booting' });
  const auth = await readAuth(dir);
  session.initialize({ auth, faceEnrolled: true });
  assert.equal(session.state, 'error');

  const h = makeHarness(dir, { sessionState: session, faceEnrolled: true, dialogResponse: 1 });
  const load = await h.ipcMain.invoke('auth-load');
  assert.equal(load.ok, false);
  assert.equal(load.status, AUTH_STATUS.CORRUPT);
  assert.equal(load.state, 'error');
  assert.equal(load.data, null);
  assert.equal(load.recoveryRequired, true);

  const cancelled = await h.ipcMain.invoke('auth-recover-reset');
  assert.equal(cancelled.ok, false);
  assert.equal(session.state, 'error');
  assert.equal(fs.existsSync(authFilePath(dir)), true);
  assert.equal(h.faceStore.removed, 0);

  h.dialog.setResponse(0);
  const reset = await h.ipcMain.invoke('auth-recover-reset');
  assert.equal(reset.ok, true);
  assert.equal(session.state, 'setup');
  assert.equal(session.lockRequired, true);
  assert.equal(session.canUsePrivileges, false);
  assert.equal(fs.existsSync(authFilePath(dir)), false);
  assert.equal(h.faceStore.removed, 1);
  assert.match(h.dialog.calls[1].detail, /PIN/i);
  assert.match(h.dialog.calls[1].detail, /face/i);

  const setup = await h.ipcMain.invoke('auth-setup-pin', { pin: '4821' });
  assert.equal(setup.ok, true);
  assert.equal(session.state, 'locked');

  const outsideError = await h.ipcMain.invoke('auth-recover-reset');
  assert.equal(outsideError.ok, false);
});

test('P0-2 auth initialization exceptions never create a no-lock session', () => {
  const session = createSessionState({ initial: 'booting' });
  session.initialize({ auth: null, readError: 'simulated auth read failure' });
  assert.equal(session.state, 'error');
  assert.equal(session.lockRequired, true);
  assert.equal(session.canUsePrivileges, false);
});
