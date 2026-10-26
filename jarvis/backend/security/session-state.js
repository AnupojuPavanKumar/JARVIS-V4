'use strict';

/**
 * Main-owned authentication/session state.
 *
 * The renderer never changes this state directly. IPC handlers may only call
 * the explicit transition methods below after verifying credentials. Privileged
 * IPC is allowed only while the state is `unlocked` or `no-lock`.
 */

const SESSION_STATES = Object.freeze({
  BOOTING: 'booting',
  SETUP: 'setup',
  LOCKED: 'locked',
  UNLOCKED: 'unlocked',
  NO_LOCK: 'no-lock',
  ERROR: 'error',
});

const VALID_STATES = new Set(Object.values(SESSION_STATES));
const PRIVILEGED_STATES = new Set([
  SESSION_STATES.UNLOCKED,
  SESSION_STATES.NO_LOCK,
]);
const LOCK_SCREEN_STATES = new Set([
  SESSION_STATES.SETUP,
  SESSION_STATES.LOCKED,
  SESSION_STATES.ERROR,
]);

function createSessionState({
  initial = SESSION_STATES.BOOTING,
  audit = () => {},
} = {}) {
  let current = initial;
  if (!VALID_STATES.has(current)) {
    throw new Error(`Unknown session state: ${current}`);
  }

  const listeners = new Set();

  function lockRequired() {
    return current !== SESSION_STATES.BOOTING && current !== SESSION_STATES.NO_LOCK;
  }

  function snapshot() {
    return Object.freeze({
      state: current,
      locked: LOCK_SCREEN_STATES.has(current),
      lockRequired: lockRequired(),
      canUsePrivileges: PRIVILEGED_STATES.has(current),
    });
  }

  function notify(previous) {
    const view = snapshot();
    for (const listener of listeners) {
      try {
        listener(view, previous);
      } catch (error) {
        audit('SESSION_STATE_LISTENER', error.message, 'ERROR');
      }
    }
    return view;
  }

  function transition(next, reason) {
    if (!VALID_STATES.has(next)) throw new Error(`Unknown session state: ${next}`);
    if (next === current) return snapshot();
    const previous = current;
    current = next;
    audit('SESSION_STATE', `${previous}->${next}${reason ? `: ${reason}` : ''}`, 'OK');
    return notify(previous);
  }

  /**
   * Classify the persisted auth records once, at startup, using fail-closed
   * rules. Corrupt or contradictory records enter `error`, never `no-lock`.
   */
  function initialize({ auth, faceEnrolled = false, readError = null } = {}) {
    if (readError) return transition(SESSION_STATES.ERROR, 'auth read failed');
    if (!auth || auth.ok !== true) return transition(SESSION_STATES.ERROR, 'auth unavailable');

    const face = faceEnrolled === true;
    if (!auth.exists) {
      return face
        ? transition(SESSION_STATES.ERROR, 'face profile without PIN')
        : transition(SESSION_STATES.SETUP, 'no auth record');
    }

    if (auth.skipPin === true) {
      return face
        ? transition(SESSION_STATES.ERROR, 'skip PIN with enrolled face')
        : transition(SESSION_STATES.NO_LOCK, 'explicit skip PIN');
    }

    if (auth.hasPin === true) {
      return transition(SESSION_STATES.LOCKED, face ? 'PIN and face configured' : 'PIN configured');
    }

    return transition(SESSION_STATES.ERROR, 'auth record has no usable credential');
  }

  function unlock(reason = 'credential verified') {
    if (current !== SESSION_STATES.LOCKED) return false;
    transition(SESSION_STATES.UNLOCKED, reason);
    return true;
  }

  /**
   * First-run setup has no pre-existing credential to verify. This transition
   * may only be called by the main-owned setup handler after the PIN record was
   * durably written.
   */
  function completeSetup(reason = 'setup credential stored') {
    if (current !== SESSION_STATES.SETUP) return false;
    transition(SESSION_STATES.UNLOCKED, reason);
    return true;
  }

  /** A user configured a lock from an explicitly skipped install. */
  function enableLock(reason = 'lock configured') {
    if (current !== SESSION_STATES.NO_LOCK) return false;
    transition(SESSION_STATES.UNLOCKED, reason);
    return true;
  }

  /** Lock-on-hide/reload/crash. Never changes an explicit no-lock install. */
  function lock(reason = 'renderer or window boundary') {
    if (current !== SESSION_STATES.UNLOCKED) return snapshot();
    return transition(SESSION_STATES.LOCKED, reason);
  }

  function markSetup(reason = 'setup requested') {
    return transition(SESSION_STATES.SETUP, reason);
  }

  function markNoLock(reason = 'explicit skip PIN') {
    return transition(SESSION_STATES.NO_LOCK, reason);
  }

  function markLocked(reason = 'lock configured') {
    return transition(SESSION_STATES.LOCKED, reason);
  }

  function enterError(reason = 'authentication error') {
    return transition(SESSION_STATES.ERROR, reason);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    get state() { return current; },
    get locked() { return LOCK_SCREEN_STATES.has(current); },
    get lockRequired() { return lockRequired(); },
    get canUsePrivileges() { return PRIVILEGED_STATES.has(current); },
    snapshot,
    initialize,
    unlock,
    completeSetup,
    enableLock,
    lock,
    markSetup,
    markNoLock,
    markLocked,
    enterError,
    subscribe,
    isPrivileged: () => PRIVILEGED_STATES.has(current),
    isLockScreen: () => LOCK_SCREEN_STATES.has(current),
  });
}

module.exports = {
  SESSION_STATES,
  VALID_STATES,
  PRIVILEGED_STATES,
  LOCK_SCREEN_STATES,
  createSessionState,
};
