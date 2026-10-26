'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMediaTypes, decideMediaPermission } = require('../backend/voice/media-permission');

function decide(overrides = {}) {
  return decideMediaPermission({
    permission: 'media',
    isMainRenderer: true,
    mediaTypes: [],
    faceCameraArmed: false,
    microphoneArmed: false,
    ...overrides,
  });
}

test('media permission: normalizes request and check-handler media type fields', () => {
  assert.deepEqual(normalizeMediaTypes({ mediaTypes: ['Audio', ' audio ', 'video'] }), ['audio', 'video']);
  assert.deepEqual(normalizeMediaTypes({ mediaType: 'audio' }), ['audio']);
  assert.deepEqual(normalizeMediaTypes({}), []);
});

test('media permission: camera and microphone gates are independent', () => {
  assert.equal(decide({ mediaTypes: ['video'], faceCameraArmed: true }), true);
  assert.equal(decide({ mediaTypes: ['video'], microphoneArmed: true }), false);
  assert.equal(decide({ mediaTypes: ['audio'], microphoneArmed: true }), true);
  assert.equal(decide({ mediaTypes: ['audio'], faceCameraArmed: true }), false);
});

test('media permission: combined, empty, non-media, and untrusted requests fail closed', () => {
  assert.equal(decide({ mediaTypes: ['audio', 'video'], faceCameraArmed: true, microphoneArmed: true }), false);
  assert.equal(decide({ mediaTypes: [], faceCameraArmed: false, microphoneArmed: true }), false);
  assert.equal(decide({ mediaTypes: [], faceCameraArmed: true }), true);
  assert.equal(decide({ permission: 'geolocation' }), false);
  assert.equal(decide({ isMainRenderer: false, mediaTypes: ['audio'], microphoneArmed: true }), false);
});
