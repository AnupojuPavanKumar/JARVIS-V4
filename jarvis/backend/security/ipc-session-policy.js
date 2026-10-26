'use strict';

const { SESSION_STATES: S } = require('./session-state');

const ALL_EXCEPT_BOOTING = Object.freeze([
  S.SETUP, S.LOCKED, S.UNLOCKED, S.NO_LOCK, S.ERROR,
]);
const PRIVILEGED = Object.freeze([S.UNLOCKED, S.NO_LOCK]);
const LOCK_SCREEN = Object.freeze([S.SETUP, S.LOCKED, S.ERROR]);
const LOCKED_ONLY = Object.freeze([S.LOCKED]);
const SETUP_ONLY = Object.freeze([S.SETUP]);
const UNLOCKED_ONLY = Object.freeze([S.UNLOCKED]);
const ERROR_ONLY = Object.freeze([S.ERROR]);

function entry(states, options = {}) {
  return Object.freeze({ states: Object.freeze([...states]), ...options });
}

/**
 * Complete allowlist for renderer -> main IPC.
 *
 * Every registered channel must have an entry; the guard denies anything that
 * is missing. Do not add wildcard prefixes or a generic "trusted" channel.
 */
const IPC_POLICY = Object.freeze({
  // Window chrome and focus are safe on every screen, including setup/error.
  'win-minimize': entry(ALL_EXCEPT_BOOTING, { kind: 'send' }),
  'win-maximize': entry(ALL_EXCEPT_BOOTING, { kind: 'send' }),
  'win-close': entry(ALL_EXCEPT_BOOTING, { kind: 'send' }),
  'focus-window': entry(ALL_EXCEPT_BOOTING, { kind: 'invoke' }),

  // Authentication/session boundary.
  'auth-load': entry(ALL_EXCEPT_BOOTING, { kind: 'invoke', readOnly: true }),
  'auth-setup-pin': entry(SETUP_ONLY, { kind: 'invoke', credential: true }),
  'auth-skip': entry(SETUP_ONLY, { kind: 'invoke', credential: true }),
  'auth-verify': entry(LOCKED_ONLY, { kind: 'invoke', credential: true }),
  'auth-change-pin': entry(UNLOCKED_ONLY, { kind: 'invoke', credential: true }),
  'auth-recover-reset': entry(ERROR_ONLY, { kind: 'invoke', credential: true }),

  // Face unlock is deliberately allowed on the lock screen. Enrollment and
  // profile mutation are not.
  'face-status': entry(ALL_EXCEPT_BOOTING, { kind: 'invoke', readOnly: true }),
  'face-verify': entry(LOCKED_ONLY, { kind: 'invoke', credential: true }),
  'face-arm-camera': entry([S.LOCKED, S.UNLOCKED, S.NO_LOCK], { kind: 'invoke', capability: 'camera' }),
  'face-disarm-camera': entry(ALL_EXCEPT_BOOTING, { kind: 'invoke' }),
  'face-cancel-enrollment': entry(ALL_EXCEPT_BOOTING, { kind: 'invoke' }),
  'face-begin-enrollment': entry(PRIVILEGED, { kind: 'invoke' }),
  'face-enroll': entry(PRIVILEGED, { kind: 'invoke', credential: true }),
  'face-delete': entry(PRIVILEGED, { kind: 'invoke', credential: true }),
  'face-set-enabled': entry(PRIVILEGED, { kind: 'invoke' }),

  // Lock-screen wake-word capture is allowed; the handler enforces its own
  // wake-only mode. One-shot microphone use requires an unlocked session.
  'voice-arm-microphone': entry([S.LOCKED, S.UNLOCKED, S.NO_LOCK], { kind: 'invoke', capability: 'microphone' }),
  'voice-disarm-microphone': entry(ALL_EXCEPT_BOOTING, { kind: 'invoke' }),

  // Settings/security and audit data are privileged. The renderer can read
  // effective capability state and request/revoke grants, but it cannot write
  // a security configuration object.
  'security-get': entry(PRIVILEGED, { kind: 'invoke', readOnly: true }),
  'security-request': entry(PRIVILEGED, { kind: 'invoke', capability: 'broker' }),
  'security-revoke': entry(PRIVILEGED, { kind: 'invoke', capability: 'broker' }),
  'sec-classify-command': entry(PRIVILEGED, { kind: 'invoke' }),
  'sec-audit-read': entry(PRIVILEGED, { kind: 'invoke' }),

  // File system and project access.
  'fs-read': entry(PRIVILEGED, { kind: 'invoke' }),
  'fs-write': entry(PRIVILEGED, { kind: 'invoke' }),
  'fs-list': entry(PRIVILEGED, { kind: 'invoke' }),
  'fs-dialog-save': entry(PRIVILEGED, { kind: 'invoke' }),
  'fs-dialog-open-doc': entry(PRIVILEGED, { kind: 'invoke' }),
  'fs-read-binary': entry(PRIVILEGED, { kind: 'invoke' }),
  'read-pdf': entry(PRIVILEGED, { kind: 'invoke' }),
  'read-text-doc': entry(PRIVILEGED, { kind: 'invoke' }),
  'read-project': entry(PRIVILEGED, { kind: 'invoke' }),
  'open-image-dialog': entry(PRIVILEGED, { kind: 'invoke' }),
  'open-folder-dialog': entry(PRIVILEGED, { kind: 'invoke' }),
  'run-command': entry(PRIVILEGED, { kind: 'invoke', capability: 'terminal' }),
  'capture-screen': entry(PRIVILEGED, { kind: 'invoke', capability: 'screen-capture' }),

  // System and external navigation.
  'get-user-data-path': entry(PRIVILEGED, { kind: 'invoke' }),
  'get-runtime-stats': entry(PRIVILEGED, { kind: 'invoke' }),
  'get-system-info': entry(PRIVILEGED, { kind: 'invoke' }),
  'system-command': entry(PRIVILEGED, { kind: 'invoke' }),
  'open-external': entry(PRIVILEGED, { kind: 'send' }),
  'quit-app': entry(PRIVILEGED, { kind: 'send' }),

  // Chat/history/memory.
  'history-save': entry(PRIVILEGED, { kind: 'invoke' }),
  'history-load': entry(PRIVILEGED, { kind: 'invoke' }),
  'history-list': entry(PRIVILEGED, { kind: 'invoke' }),
  'history-delete': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-load': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-save': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-add': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-update': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-delete': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-disable': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-clear': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-export': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-retrieve': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-record-conversation': entry(PRIVILEGED, { kind: 'invoke' }),
  'memory-stats': entry(PRIVILEGED, { kind: 'invoke' }),
  'embed-text': entry(PRIVILEGED, { kind: 'invoke' }),

  // AI/model/voice services.
  'web-search': entry(PRIVILEGED, { kind: 'invoke' }),
  'ollama-fetch': entry(PRIVILEGED, { kind: 'invoke' }),
  'ollama-stream-start': entry(PRIVILEGED, { kind: 'send' }),
  'ollama-stream-abort': entry(PRIVILEGED, { kind: 'send' }),
  'piper-tts': entry(PRIVILEGED, { kind: 'invoke' }),
  'transcribe-audio': entry(PRIVILEGED, { kind: 'invoke' }),

  // Notes, prompts, snippets, skills.
  'snippets-load': entry(PRIVILEGED, { kind: 'invoke' }),
  'snippets-save': entry(PRIVILEGED, { kind: 'invoke' }),
  'prompts-load': entry(PRIVILEGED, { kind: 'invoke' }),
  'prompts-save': entry(PRIVILEGED, { kind: 'invoke' }),
  'notes-load': entry(PRIVILEGED, { kind: 'invoke' }),
  'notes-save': entry(PRIVILEGED, { kind: 'invoke' }),
  'skills-list': entry(PRIVILEGED, { kind: 'invoke' }),
  'skills-run': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-start': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-abort': entry(PRIVILEGED, { kind: 'invoke' }),

  // Durable agent.
  'agent-task-start': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-task-list': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-task-get': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-task-events': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-task-cancel': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-task-approve': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-task-resume': entry(PRIVILEGED, { kind: 'invoke' }),
  'agent-approval-notify': entry(PRIVILEGED, { kind: 'send' }),

  // Browser and integrations.
  'browser-status': entry(PRIVILEGED, { kind: 'invoke' }),
  'browser-emergency-stop': entry(PRIVILEGED, { kind: 'invoke' }),
  'integrations-list': entry(PRIVILEGED, { kind: 'invoke' }),
  'integrations-update-scopes': entry(PRIVILEGED, { kind: 'invoke' }),
  'integrations-revoke': entry(PRIVILEGED, { kind: 'invoke' }),
  'integrations-delete-data': entry(PRIVILEGED, { kind: 'invoke' }),
  'integrations-activity': entry(PRIVILEGED, { kind: 'invoke' }),

  // Document index.
  'documents-status': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-pick-folder': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-add-folder': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-remove-folder': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-reindex': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-set-retention': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-apply-retention': entry(PRIVILEGED, { kind: 'invoke' }),
  'documents-delete-all': entry(PRIVILEGED, { kind: 'invoke' }),

  // Scheduler.
  'scheduler-add': entry(PRIVILEGED, { kind: 'invoke' }),
  'scheduler-remove': entry(PRIVILEGED, { kind: 'invoke' }),
  'scheduler-list': entry(PRIVILEGED, { kind: 'invoke' }),
  'scheduler-runs': entry(PRIVILEGED, { kind: 'invoke' }),
  'scheduler-settings-update': entry(PRIVILEGED, { kind: 'invoke' }),
  'scheduler-event': entry(PRIVILEGED, { kind: 'invoke' }),
  'ambient-status': entry(PRIVILEGED, { kind: 'invoke' }),
  'ambient-set-auto-start': entry(PRIVILEGED, { kind: 'invoke' }),
});

const POLICY_CHANNELS = Object.freeze(Object.keys(IPC_POLICY));
const LOCKED_ALLOWED_CHANNELS = Object.freeze(
  POLICY_CHANNELS.filter(channel => IPC_POLICY[channel].states.includes(S.LOCKED))
);

function getIpcPolicy(channel) {
  if (typeof channel !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(IPC_POLICY, channel)
    ? IPC_POLICY[channel]
    : null;
}

function isChannelAllowed(channel, state) {
  const policy = getIpcPolicy(channel);
  return !!policy && policy.states.includes(state);
}

module.exports = {
  ALL_EXCEPT_BOOTING,
  PRIVILEGED,
  LOCK_SCREEN,
  LOCKED_ONLY,
  SETUP_ONLY,
  ERROR_ONLY,
  IPC_POLICY,
  POLICY_CHANNELS,
  LOCKED_ALLOWED_CHANNELS,
  getIpcPolicy,
  isChannelAllowed,
};
