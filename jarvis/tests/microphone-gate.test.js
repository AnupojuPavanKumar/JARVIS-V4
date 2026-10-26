'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMicrophoneGate } = require('../backend/voice/microphone-gate');

function clock(start = 100000) {
  let value = start;
  return {
    now: () => value,
    advance: ms => { value += ms; },
  };
}

test('microphone gate: arms for a bounded duration and expires', () => {
  const time = clock();
  const gate = createMicrophoneGate({ now: time.now, maxDurationMs: 5000 });
  assert.equal(gate.isArmed(), false);
  const result = gate.arm(2000);
  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 2000);
  assert.equal(gate.isArmed(), true);
  time.advance(1999);
  assert.equal(gate.isArmed(), true);
  time.advance(1);
  assert.equal(gate.isArmed(), false);
});

test('microphone gate: duration is clamped and invalid input gets a safe default', () => {
  const time = clock();
  const gate = createMicrophoneGate({ now: time.now, defaultDurationMs: 3000, maxDurationMs: 10000 });
  assert.equal(gate.arm(1).durationMs, 1000);
  assert.equal(gate.arm(999999).durationMs, 10000);
  assert.equal(gate.arm('not-a-number').durationMs, 3000);
});

test('microphone gate: disarm immediately closes the gate', () => {
  const time = clock();
  const gate = createMicrophoneGate({ now: time.now });
  gate.arm(60000);
  assert.equal(gate.isArmed(), true);
  gate.disarm();
  assert.equal(gate.isArmed(), false);
  assert.equal(gate.remainingMs(), 0);
});
