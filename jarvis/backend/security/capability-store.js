'use strict';

/**
 * Main-owned capability policy and in-memory grants.
 *
 * The renderer may ask for a capability, but only the main process can create
 * a grant after native consent. Grants are never loaded from renderer data and
 * high-risk grants are revoked on session boundaries.
 */

const MINUTE = 60 * 1000;

const RAW_CAPABILITIES = {
  terminal: {
    id: 'terminal',
    label: 'terminal command execution',
    risk: 'high',
    scope: 'current unlocked session',
    ttlMs: 30 * MINUTE,
    oneShot: false,
    requestable: true,
    dataAccess: 'Runs commands as your Windows user in the app workspace. Command output can contain local files and system information. Dangerous commands still require a separate confirmation.',
    durationLabel: 'up to 30 minutes; ends on lock, hide, reload, crash, or quit',
  },
  'screen-capture': {
    id: 'screen-capture',
    label: 'one screen capture',
    risk: 'high',
    scope: 'one screenshot',
    ttlMs: 2 * MINUTE,
    oneShot: true,
    requestable: true,
    dataAccess: 'Captures one still image of the primary screen and sends it only to the local image-analysis flow. It does not start background recording.',
    durationLabel: 'one use, expiring after 2 minutes at most',
  },
  microphone: {
    id: 'microphone',
    label: 'local microphone capture',
    risk: 'high',
    scope: 'short local voice lease',
    ttlMs: MINUTE,
    oneShot: true,
    requestable: false,
    dataAccess: 'Records a short local audio segment for wake-word or voice input. Audio stays on this device and is deleted after transcription.',
    durationLabel: 'short lease managed by the main voice gate',
  },
  'project-files': {
    id: 'project-files',
    label: 'project file access',
    risk: 'high',
    scope: 'one directory selected in a native picker',
    ttlMs: 60 * MINUTE,
    oneShot: false,
    requestable: false,
    dataAccess: 'Reads or writes files only within the project directory selected through a native dialog.',
    durationLabel: 'current project selection, ending when the project is closed',
  },
  'export-save': {
    id: 'export-save',
    label: 'export or save',
    risk: 'medium',
    scope: 'one file selected in a native save dialog',
    ttlMs: 5 * MINUTE,
    oneShot: true,
    requestable: false,
    dataAccess: 'Writes one export to the exact path chosen in a native save dialog.',
    durationLabel: 'one save destination chosen in the native dialog',
  },
};

const CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(RAW_CAPABILITIES).map(([id, capability]) => [
    id,
    Object.freeze({ ...capability }),
  ])
));

const CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITIES));

function isCapabilityId(value) {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'no time';
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const minutes = Math.round(ms / MINUTE);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Build the exact native-dialog content. Renderer-provided strings are never
 * used here, so injected UI text cannot rewrite the consent decision.
 */
function buildConsentRequest(capabilityId) {
  if (!isCapabilityId(capabilityId)) {
    throw new Error('Unknown capability');
  }
  const capability = CAPABILITIES[capabilityId];
  if (!capability.requestable) {
    throw new Error(`${capabilityId} is not directly requestable`);
  }
  return Object.freeze({
    type: 'warning',
    buttons: Object.freeze(['Allow', 'Deny']),
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'JARVIS — Capability Permission',
    message: `Allow ${capability.label}?`,
    detail: [
      `Capability: ${capability.label}`,
      `Scope: ${capability.scope}`,
      `Risk: ${capability.risk.toUpperCase()}`,
      `Duration: ${capability.durationLabel}`,
      `Data access: ${capability.dataAccess}`,
      '',
      'This approval is created by the JARVIS main process. The page cannot save or change it.',
    ].join('\n'),
    capabilityId,
    risk: capability.risk,
    scope: capability.scope,
    ttlMs: capability.ttlMs,
    durationLabel: capability.durationLabel,
  });
}

function createCapabilityStore({
  audit = () => {},
  now = () => Date.now(),
  maxTtlMs = 60 * MINUTE,
} = {}) {
  if (typeof audit !== 'function') throw new TypeError('audit must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const grants = new Map();

  function capabilityOrThrow(capabilityId) {
    if (!isCapabilityId(capabilityId)) throw new Error('Unknown capability');
    return CAPABILITIES[capabilityId];
  }

  function expireIfNeeded(capabilityId) {
    const grant = grants.get(capabilityId);
    if (!grant) return null;
    if (now() < grant.expiresAt) return grant;
    grants.delete(capabilityId);
    audit('CAPABILITY_EXPIRE', `${capabilityId} (${grant.scope})`, 'EXPIRED');
    return null;
  }

  function grant(capabilityId, { ttlMs } = {}) {
    const capability = capabilityOrThrow(capabilityId);
    const requestedTtl = Number(ttlMs) || capability.ttlMs;
    const boundedTtl = Math.min(Math.max(1, requestedTtl), maxTtlMs);
    const record = Object.freeze({
      capabilityId,
      scope: capability.scope,
      oneShot: capability.oneShot,
      grantedAt: now(),
      expiresAt: now() + boundedTtl,
    });
    grants.set(capabilityId, record);
    audit('CAPABILITY_GRANT', `${capabilityId} (${record.scope}, ${formatDuration(boundedTtl)})`, 'GRANTED');
    return status(capabilityId);
  }

  function status(capabilityId) {
    const capability = capabilityOrThrow(capabilityId);
    const grant = expireIfNeeded(capabilityId);
    return Object.freeze({
      id: capability.id,
      label: capability.label,
      risk: capability.risk,
      scope: capability.scope,
      ttlMs: capability.ttlMs,
      oneShot: capability.oneShot,
      requestable: capability.requestable,
      dataAccess: capability.dataAccess,
      durationLabel: capability.durationLabel,
      granted: !!grant,
      expiresAt: grant ? grant.expiresAt : null,
      remainingMs: grant ? Math.max(0, grant.expiresAt - now()) : 0,
    });
  }

  function snapshot() {
    return Object.freeze(Object.fromEntries(
      CAPABILITY_IDS.map(id => [id, status(id)])
    ));
  }

  function isGranted(capabilityId) {
    return status(capabilityId).granted;
  }

  /**
   * Consume a one-shot grant. Session grants (terminal) are checked with
   * isGranted and remain valid until a boundary revokes them.
   */
  function consume(capabilityId) {
    const capability = capabilityOrThrow(capabilityId);
    if (!capability.oneShot) return isGranted(capabilityId);
    const grant = expireIfNeeded(capabilityId);
    if (!grant) return false;
    grants.delete(capabilityId);
    audit('CAPABILITY_USE', `${capabilityId} (${grant.scope})`, 'USED');
    return true;
  }

  function revoke(capabilityId, reason = 'revoked') {
    const capability = capabilityOrThrow(capabilityId);
    const existed = grants.delete(capabilityId);
    if (existed) {
      audit('CAPABILITY_REVOKE', `${capabilityId}: ${reason}`, 'REVOKED');
    }
    return status(capability.id);
  }

  function revokeAll(reason = 'session boundary') {
    for (const capabilityId of [...grants.keys()]) {
      grants.delete(capabilityId);
      audit('CAPABILITY_REVOKE', `${capabilityId}: ${reason}`, 'REVOKED');
    }
    return snapshot();
  }

  return Object.freeze({
    snapshot,
    status,
    grant,
    isGranted,
    consume,
    revoke,
    revokeAll,
  });
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_IDS,
  createCapabilityStore,
  buildConsentRequest,
  formatDuration,
  isCapabilityId,
};
