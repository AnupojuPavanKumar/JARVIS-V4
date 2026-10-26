'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_STATES,
  createSessionState,
} = require('../backend/security/session-state');

function auth(overrides = {}) {
  return {
    ok: true,
    exists: true,
    hasPin: false,
    skipPin: false,
    ...overrides,
  };
}

test('session state: missing auth record enters setup, not an unlocked session', () => {
  const state = createSessionState();
  state.initialize({ auth: auth({ exists: false }), faceEnrolled: false });
  assert.equal(state.state, SESSION_STATES.SETUP);
  assert.equal(state.locked, true);
  assert.equal(state.canUsePrivileges, false);
});

test('session state: explicit skip is the only no-lock path', () => {
  const state = createSessionState();
  state.initialize({ auth: auth({ skipPin: true }), faceEnrolled: false });
  assert.equal(state.state, SESSION_STATES.NO_LOCK);
  assert.equal(state.locked, false);
  assert.equal(state.lockRequired, false);
  assert.equal(state.canUsePrivileges, true);
});

test('session state: a PIN or enrolled face starts locked', () => {
  const pin = createSessionState();
  pin.initialize({ auth: auth({ hasPin: true }), faceEnrolled: false });
  assert.equal(pin.state, SESSION_STATES.LOCKED);

  const face = createSessionState();
  face.initialize({ auth: auth({ hasPin: true }), faceEnrolled: true });
  assert.equal(face.state, SESSION_STATES.LOCKED);
});

test('session state: inconsistent or unreadable auth fails closed to error', () => {
  const cases = [
    { auth: null, faceEnrolled: false, error: null },
    { auth: { ok: false, exists: true }, faceEnrolled: false, error: null },
    { auth: auth({ exists: false }), faceEnrolled: true, error: null },
    { auth: auth({ skipPin: true }), faceEnrolled: true, error: null },
    { auth: auth({ hasPin: false, skipPin: false }), faceEnrolled: false, error: null },
    { auth: auth({ hasPin: true }), faceEnrolled: false, error: 'disk read failed' },
  ];
  for (const input of cases) {
    const state = createSessionState();
    if (input.error) {
      state.initialize({ auth: null, readError: input.error });
    } else {
      state.initialize({ auth: input.auth, faceEnrolled: input.faceEnrolled });
    }
    assert.equal(state.state, SESSION_STATES.ERROR, JSON.stringify(input));
    assert.equal(state.canUsePrivileges, false);
  }
});

test('session state: unlock requires a locked state and a main-side transition', () => {
  const state = createSessionState();
  state.initialize({ auth: auth({ hasPin: true }), faceEnrolled: false });
  assert.equal(state.unlock('PIN verified'), true);
  assert.equal(state.state, SESSION_STATES.UNLOCKED);
  assert.equal(state.canUsePrivileges, true);

  assert.equal(state.unlock('replayed credential'), false);
  assert.equal(state.state, SESSION_STATES.UNLOCKED);
});

test('session state: lock-on-boundary never disables an explicit no-lock install', () => {
  const noLock = createSessionState();
  noLock.initialize({ auth: auth({ skipPin: true }), faceEnrolled: false });
  noLock.lock('window hidden');
  assert.equal(noLock.state, SESSION_STATES.NO_LOCK);

  const locked = createSessionState();
  locked.initialize({ auth: auth({ hasPin: true }), faceEnrolled: false });
  locked.unlock('PIN verified');
  locked.lock('window hidden');
  assert.equal(locked.state, SESSION_STATES.LOCKED);
  assert.equal(locked.canUsePrivileges, false);
});

test('session state: setup completion and enabling a lock are explicit transitions', () => {
  const setup = createSessionState();
  setup.initialize({ auth: auth({ exists: false }), faceEnrolled: false });
  assert.equal(setup.completeSetup('first-run PIN stored'), true);
  assert.equal(setup.state, SESSION_STATES.UNLOCKED);

  const skipped = createSessionState();
  skipped.initialize({ auth: auth({ skipPin: true }), faceEnrolled: false });
  assert.equal(skipped.enableLock('PIN added'), true);
  assert.equal(skipped.state, SESSION_STATES.UNLOCKED);
  assert.equal(skipped.lockRequired, true);
});

test('session state: transitions notify observers with immutable snapshots', () => {
  const seen = [];
  const state = createSessionState();
  state.subscribe((snapshot, previous) => seen.push([previous, snapshot]));
  state.initialize({ auth: auth({ exists: false }), faceEnrolled: false });
  state.completeSetup('test');
  assert.equal(seen.length, 2);
  assert.equal(Object.isFrozen(seen[0][1]), true);
  assert.equal(seen[1][1].state, SESSION_STATES.UNLOCKED);
});
