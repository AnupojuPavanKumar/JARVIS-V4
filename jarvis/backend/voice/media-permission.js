'use strict';

// Central decision for renderer media permission requests.
//
// Electron reports media types differently between the request handler
// (details.mediaTypes) and the check handler (details.mediaType). Normalize
// both and make the decision in one place so audio and video can never be
// granted by accident.
//
// Camera access is verifier-only. The main renderer has no camera path even
// while the face camera lease is armed. The isolated verifier gets video only
// while that main-owned lease is active. Microphone use remains on the main
// renderer and is controlled by the separate microphone gate.
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
  isMainRenderer = false,
  isVerifier = false,
  mediaTypes = [],
  cameraArmed = false,
  microphoneArmed = false,
} = {}) {
  if (permission !== 'media') return false;
  if (!isMainRenderer && !isVerifier) return false;

  // A single webContents can never be both the main renderer and the verifier.
  if (isMainRenderer && isVerifier) return false;

  const types = Array.isArray(mediaTypes)
    ? mediaTypes.map(value => String(value || '').toLowerCase().trim()).filter(Boolean)
    : [];
  const wantsAudio = types.includes('audio');
  const wantsVideo = types.includes('video');

  // A combined request would need both gates and is never used by JARVIS.
  if (wantsAudio && wantsVideo) return false;

  if (isVerifier) {
    return wantsVideo && !wantsAudio && Boolean(cameraArmed);
  }

  // Main renderer: camera is always denied. Microphone keeps its explicit gate.
  if (wantsVideo) return false;
  if (wantsAudio) return Boolean(microphoneArmed);
  return false;
}

module.exports = { normalizeMediaTypes, decideMediaPermission };
