'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMediaTypes, decideMediaPermission } = require('../backend/voice/media-permission');

function decide(overrides = {}) {
  return decideMediaPermission({
    permission: 'media',
    isMainRenderer: true,
    isVerifier: false,
    mediaTypes: [],
    cameraArmed: false,
    microphoneArmed: false,
    ...overrides,
  });
}

test('media permission: normalizes request and check-handler media type fields', () => {
  assert.deepEqual(normalizeMediaTypes({ mediaTypes: ['Audio', ' audio ', 'video'] }), ['audio', 'video']);
  assert.deepEqual(normalizeMediaTypes({ mediaType: 'audio' }), ['audio']);
  assert.deepEqual(normalizeMediaTypes({}), []);
});

test('media permission: only the verifier can receive camera access, and only while leased', () => {
  assert.equal(decide({ isMainRenderer: false, isVerifier: true, mediaTypes: ['video'], cameraArmed: true }), true);
  assert.equal(decide({ isMainRenderer: false, isVerifier: true, mediaTypes: ['video'], cameraArmed: false }), false);
  assert.equal(decide({ isMainRenderer: false, isVerifier: true, mediaTypes: ['audio'], microphoneArmed: true }), false);
});

test('media permission: the main renderer never receives camera access', () => {
  assert.equal(decide({ mediaTypes: ['video'], cameraArmed: true }), false);
  assert.equal(decide({ mediaTypes: ['video'], cameraArmed: false }), false);
  assert.equal(decide({ mediaTypes: ['video'], cameraArmed: true, microphoneArmed: true }), false);
});

test('media permission: microphone remains independent on the main renderer', () => {
  assert.equal(decide({ mediaTypes: ['audio'], microphoneArmed: true }), true);
  assert.equal(decide({ mediaTypes: ['audio'], microphoneArmed: false }), false);
  assert.equal(decide({ mediaTypes: ['audio'], cameraArmed: true }), false);
});

test('media permission: combined, empty, non-media, and untrusted requests fail closed', () => {
  assert.equal(decide({ mediaTypes: ['audio', 'video'], cameraArmed: true, microphoneArmed: true }), false);
  assert.equal(decide({ mediaTypes: [], microphoneArmed: true }), false);
  assert.equal(decide({ mediaTypes: [], cameraArmed: true }), false);
  assert.equal(decide({ permission: 'geolocation' }), false);
  assert.equal(decide({ isMainRenderer: false, isVerifier: false, mediaTypes: ['audio'], microphoneArmed: true }), false);
  assert.equal(decide({ isMainRenderer: true, isVerifier: true, mediaTypes: ['video'], cameraArmed: true }), false);
});
