'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SESSION_STATES } = require('../backend/security/session-state');
const {
  IPC_POLICY,
  POLICY_CHANNELS,
  LOCKED_ALLOWED_CHANNELS,
  getIpcPolicy,
  isChannelAllowed,
} = require('../backend/security/ipc-session-policy');

test('IPC policy: unknown and prototype-like channels default-deny', () => {
  for (const channel of ['unknown-channel', '', '__proto__', 'constructor', 'fs-read\n', null, 42]) {
    assert.equal(getIpcPolicy(channel), null, String(channel));
    assert.equal(isChannelAllowed(channel, SESSION_STATES.UNLOCKED), false);
  }
});

test('IPC policy: every entry has explicit states and a kind', () => {
  assert.ok(POLICY_CHANNELS.length > 50);
  for (const channel of POLICY_CHANNELS) {
    const policy = getIpcPolicy(channel);
    assert.ok(Array.isArray(policy.states), channel);
    assert.ok(policy.states.length > 0, channel);
    assert.ok(['invoke', 'send'].includes(policy.kind), channel);
    assert.equal(new Set(policy.states).size, policy.states.length, channel);
    assert.ok(policy.states.every(state => Object.values(SESSION_STATES).includes(state)), channel);
  }
});

test('IPC policy: locked state allows only the lock-screen allowlist', () => {
  const expected = [
    'win-minimize',
    'win-maximize',
    'win-close',
    'focus-window',
    'auth-load',
    'auth-verify',
    'face-status',
    'face-verify',
    'face-arm-camera',
    'face-disarm-camera',
    'face-cancel-enrollment',
    'voice-arm-microphone',
    'voice-disarm-microphone',
  ].sort();
  assert.deepEqual([...LOCKED_ALLOWED_CHANNELS].sort(), expected);
});

test('IPC policy: privileged data and action channels are denied in every non-unlocked state', () => {
  const privileged = [
    'fs-read', 'fs-write', 'run-command', 'capture-screen', 'open-external',
    'get-user-data-path', 'sec-audit-read', 'history-load', 'memory-load',
    'agent-task-start', 'agent-task-approve', 'scheduler-add', 'documents-add-folder',
    'browser-emergency-stop', 'integrations-revoke', 'ollama-fetch',
  ];
  for (const channel of privileged) {
    for (const state of [
      SESSION_STATES.BOOTING,
      SESSION_STATES.SETUP,
      SESSION_STATES.LOCKED,
      SESSION_STATES.ERROR,
    ]) {
      assert.equal(isChannelAllowed(channel, state), false, `${channel} in ${state}`);
    }
    assert.equal(isChannelAllowed(channel, SESSION_STATES.UNLOCKED), true, channel);
    assert.equal(isChannelAllowed(channel, SESSION_STATES.NO_LOCK), true, channel);
  }
});

test('IPC policy: there is no generic renderer unlock or state-mutation channel', () => {
  for (const channel of [
    'auth-unlock', 'session-unlock', 'unlock', 'set-session-state',
    'auth-bypass', 'jarvis-api', 'invoke-any',
  ]) {
    assert.equal(getIpcPolicy(channel), null, channel);
  }
});
