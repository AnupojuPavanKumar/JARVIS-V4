'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionState, SESSION_STATES } = require('../backend/security/session-state');
const { attachRendererSessionGuards } = require('../backend/security/renderer-guards');

const APPROVED_URL = 'file:///C:/JARVIS/renderer/index.html';

function fakeWebContents() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) || []) fn(...args);
    },
    listeners,
  };
}

function unlockedHarness() {
  const state = createSessionState();
  state.initialize({ auth: { ok: true, exists: true, hasPin: true, skipPin: false } });
  state.unlock('test');
  assert.equal(state.state, SESSION_STATES.UNLOCKED);
  const webContents = fakeWebContents();
  const locked = [];
  attachRendererSessionGuards(webContents, {
    sessionState: state,
    approvedRendererUrl: APPROVED_URL,
    onLock: reason => locked.push(reason),
  }).install();
  return { state, webContents, locked };
}

test('renderer guards: reload/navigation locks an unlocked session', () => {
  const h = unlockedHarness();
  h.webContents.emit('did-start-navigation', {}, APPROVED_URL, false, true);
  assert.equal(h.state.state, SESSION_STATES.LOCKED);
  assert.equal(h.locked.length, 1);
});

test('renderer guards: unapproved navigation is prevented and locks', () => {
  const h = unlockedHarness();
  let prevented = false;
  h.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://evil.example/');
  assert.equal(prevented, true);
  assert.equal(h.state.state, SESSION_STATES.LOCKED);
});

test('renderer guards: redirect to an unapproved URL is prevented and locks', () => {
  const h = unlockedHarness();
  let prevented = false;
  h.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'file:///C:/Windows/System32/evil.html');
  assert.equal(prevented, true);
  assert.equal(h.state.state, SESSION_STATES.LOCKED);
});

test('renderer guards: renderer crash and webContents destruction lock the session', () => {
  const crash = unlockedHarness();
  crash.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(crash.state.state, SESSION_STATES.LOCKED);

  const destroyed = unlockedHarness();
  destroyed.webContents.emit('destroyed');
  assert.equal(destroyed.state.state, SESSION_STATES.LOCKED);
});

test('renderer guards: destruction during app quit does not attempt a lock', () => {
  const state = createSessionState();
  state.initialize({ auth: { ok: true, exists: true, hasPin: true, skipPin: false } });
  state.unlock('test');
  const webContents = fakeWebContents();
  attachRendererSessionGuards(webContents, {
    sessionState: state,
    approvedRendererUrl: APPROVED_URL,
    isQuitting: () => true,
  }).install();
  webContents.emit('destroyed');
  assert.equal(state.state, SESSION_STATES.UNLOCKED);
});

test('renderer guards: explicit no-lock sessions stay unlocked across reload', () => {
  const state = createSessionState();
  state.initialize({ auth: { ok: true, exists: true, hasPin: false, skipPin: true } });
  const webContents = fakeWebContents();
  attachRendererSessionGuards(webContents, {
    sessionState: state,
    approvedRendererUrl: APPROVED_URL,
  }).install();
  webContents.emit('did-start-navigation', {}, APPROVED_URL, false, true);
  assert.equal(state.state, SESSION_STATES.NO_LOCK);
});
