'use strict';

// Central decision for renderer media permission requests.
//
// Electron reports media types differently between the request handler
// (details.mediaTypes) and the check handler (details.mediaType). Normalize
// both and make the decision in one place so audio and video can never be
// granted by accident.
function normalizeMediaTypes(details = {}) {
  const raw = Array.isArray(details.mediaTypes)
    ? details.mediaTypes
    : (details.mediaType ? [details.mediaType] : []);
  const types = raw
    .map(value => String(value || '').toLowerCase().trim())
    .filter(Boolean);
  return Array.from(new Set(types));
}

function decideMediaPermission({
  permission,
  isMainRenderer,
  mediaTypes = [],
  faceCameraArmed = false,
  microphoneArmed = false,
} = {}) {
  if (permission !== 'media' || !isMainRenderer) return false;

  const types = Array.isArray(mediaTypes)
    ? mediaTypes.map(value => String(value || '').toLowerCase().trim()).filter(Boolean)
    : [];
  const wantsAudio = types.includes('audio');
  const wantsVideo = types.includes('video');

  // A combined request would need both gates and is never used by JARVIS.
  if (wantsAudio && wantsVideo) return false;
  if (wantsVideo) return Boolean(faceCameraArmed);
  if (wantsAudio) return Boolean(microphoneArmed);

  // Legacy Electron requests can omit media types. Preserve the old
  // camera-only behavior; never infer microphone access from an empty list.
  return Boolean(faceCameraArmed);
}

module.exports = { normalizeMediaTypes, decideMediaPermission };
