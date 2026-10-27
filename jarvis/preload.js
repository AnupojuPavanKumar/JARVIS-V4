// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// JARVIS â€” Preload Script
// Safely exposes IPC APIs to renderer via contextBridge
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const { contextBridge, ipcRenderer } = require('electron');

// Visibility is observed by more than one renderer module (lock screen and the
// local voice loop). Use a single IPC subscription and fan out to each caller
// instead of letting the last registration remove the other listeners.
const appVisibilityListeners = new Set();
let appVisibilityBound = false;
function subscribeAppVisibility(callback) {
  if (typeof callback !== 'function') return () => {};
  appVisibilityListeners.add(callback);
  if (!appVisibilityBound) {
    appVisibilityBound = true;
    ipcRenderer.on('app-visibility', (_event, payload) => {
      for (const listener of [...appVisibilityListeners]) {
        try { listener(payload || {}); } catch (_) { /* renderer owns its errors */ }
      }
    });
  }
  return () => appVisibilityListeners.delete(callback);
}

contextBridge.exposeInMainWorld('jarvis', {

  // â”€â”€â”€ Window Controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  minimize: ()    => ipcRenderer.send('win-minimize'),
  maximize: ()    => ipcRenderer.send('win-maximize'),
  close:    ()    => ipcRenderer.send('win-close'),
  // Issue 8 fix: calling ipcRenderer.on() multiple times stacks listenersâ€”
  // each push event fires every accumulated callback. removeAllListeners first
  // ensures at most one listener is ever active for this channel.
  onWindowState: (cb) => { ipcRenderer.removeAllListeners('window-state'); ipcRenderer.on('window-state', (_, state) => cb(state)); },

  // â”€â”€â”€ File System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // There is deliberately no arbitrary read/write/list bridge. File content
  // enters the renderer only from a project token, a document dialog, or an
  // image dialog.
  writeRendererLog: (content)      => ipcRenderer.invoke('renderer-log-write', content),
  saveDialog:  (name, content)     => ipcRenderer.invoke('fs-dialog-save', name, content),
  openDocDialog: ()                => ipcRenderer.invoke('fs-dialog-open-doc'),
  readPdf:     (filePath)          => ipcRenderer.invoke('read-pdf', filePath),
  readTextDoc: (filePath)          => ipcRenderer.invoke('read-text-doc', filePath),

  // â”€â”€â”€ History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  saveHistory:   (id, data) => ipcRenderer.invoke('history-save', id, data),
  loadHistory:   (id)       => ipcRenderer.invoke('history-load', id),
  listHistory:   ()         => ipcRenderer.invoke('history-list'),
  deleteHistory: (id)       => ipcRenderer.invoke('history-delete', id),

  // â”€â”€â”€ Terminal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Commands run only in main-owned context: the open project token or the app
  // workspace. There is no raw cwd argument and no unlimited timeout.
  runCommand: (cmd, options = {}) => ipcRenderer.invoke('run-command', cmd, options),

  // â”€â”€â”€ System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  getSystemInfo:   ()          => ipcRenderer.invoke('get-system-info'),
  getUserDataPath: ()          => ipcRenderer.invoke('get-user-data-path'),
  openExternal:    (url)       => ipcRenderer.send('open-external', url),
  systemCommand:   (action, target) => ipcRenderer.invoke('system-command', action, target),
  quitApp:         ()          => ipcRenderer.send('quit-app'),

  // â”€â”€â”€ Main-owned Project Context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  projectOpen:     ()       => ipcRenderer.invoke('project-open'),
  projectList:     (payload) => ipcRenderer.invoke('project-list', payload),
  projectReadFile: (payload) => ipcRenderer.invoke('project-read-file', payload),
  projectClose:    (payload) => ipcRenderer.invoke('project-close', payload),
  memoryLoad:       ()         => ipcRenderer.invoke('memory-load'),
  memorySave:       (facts)    => ipcRenderer.invoke('memory-save', facts),
  memoryAdd:        (input, options) => ipcRenderer.invoke('memory-add', input, options),
  memoryUpdate:     (id, patch) => ipcRenderer.invoke('memory-update', id, patch),
  memoryDelete:     (id)       => ipcRenderer.invoke('memory-delete', id),
  memoryDisable:    (id, disabled) => ipcRenderer.invoke('memory-disable', id, disabled),
  memoryClear:      (options)  => ipcRenderer.invoke('memory-clear', options),
  memoryExport:     ()         => ipcRenderer.invoke('memory-export'),
  memoryRetrieve:   (query, options) => ipcRenderer.invoke('memory-retrieve', query, options),
  memoryRecordConversation: (payload) => ipcRenderer.invoke('memory-record-conversation', payload),
  memoryStats:      ()         => ipcRenderer.invoke('memory-stats'),
  embedText:        (text)     => ipcRenderer.invoke('embed-text', text),
  // HIGH-05 fix: chat-memory-read/save channels have no main-process handler
  // and are never called in the renderer. Removed to eliminate dangling invoke() calls.
  webSearch:        (q, type)  => ipcRenderer.invoke('web-search', q, type),


  // â”€â”€â”€ Ollama Proxy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ollamaFetch:      (opts)       => ipcRenderer.invoke('ollama-fetch', opts),
  ollamaStreamStart:(opts)       => ipcRenderer.send('ollama-stream-start', opts),
  ollamaStreamAbort:(reqId)      => ipcRenderer.send('ollama-stream-abort', { reqId }),
  onOllamaStreamChunk:(cb)       => { ipcRenderer.removeAllListeners('ollama-stream-chunk'); ipcRenderer.on('ollama-stream-chunk', (_, data) => cb(data)); },
  onOllamaStreamEnd:  (cb)       => { ipcRenderer.removeAllListeners('ollama-stream-end'); ipcRenderer.on('ollama-stream-end', (_, data) => cb(data)); },
  onOllamaStreamError:(cb)       => { ipcRenderer.removeAllListeners('ollama-stream-error'); ipcRenderer.on('ollama-stream-error', (_, data) => cb(data)); },

  // â”€â”€â”€ Image & Binary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  openImageDialog:  ()           => ipcRenderer.invoke('open-image-dialog'),
  readFileBinary:   (fp)         => ipcRenderer.invoke('fs-read-binary', fp),

  // Write-only clipboard bridge. File-origin renderers cannot rely on the
  // browser clipboard permission, and reading the clipboard exposes unrelated
  // user data. The main process performs the write and returns an explicit
  // success/failure result.
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', text),

  // â”€â”€â”€ Snippets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  snippetsLoad: ()       => ipcRenderer.invoke('snippets-load'),
  snippetsSave: (data)   => ipcRenderer.invoke('snippets-save', data),

  // â”€â”€â”€ Scheduler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  schedulerAdd:       (jobData) => ipcRenderer.invoke('scheduler-add', jobData),
  schedulerRemove:    (jobId)   => ipcRenderer.invoke('scheduler-remove', jobId),
  schedulerList:      ()        => ipcRenderer.invoke('scheduler-list'),
  schedulerRuns:      (options) => ipcRenderer.invoke('scheduler-runs', options),
  schedulerSettingsUpdate: (settings) => ipcRenderer.invoke('scheduler-settings-update', settings),
  schedulerEvent:     (eventName, payload) => ipcRenderer.invoke('scheduler-event', eventName, payload),

  // â”€â”€â”€ Background Presence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ambientStatus:      ()        => ipcRenderer.invoke('ambient-status'),
  ambientSetAutoStart:(payload) => ipcRenderer.invoke('ambient-set-auto-start', payload),
  onAmbientResume:    (cb)      => {
    ipcRenderer.removeAllListeners('ambient-resumed');
    ipcRenderer.on('ambient-resumed', (_, payload) => cb(payload));
  },

  // â”€â”€â”€ Prompts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  promptsLoad:  ()       => ipcRenderer.invoke('prompts-load'),
  promptsSave:  (data)   => ipcRenderer.invoke('prompts-save', data),

  // â”€â”€â”€ Notes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  notesLoad:    ()       => ipcRenderer.invoke('notes-load'),
  notesSave:    (c)      => ipcRenderer.invoke('notes-save', c),

  // â”€â”€â”€ Skills System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  skillsList:   ()                         => ipcRenderer.invoke('skills-list'),

  // â”€â”€â”€ Durable Agent Runtime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Enabled by default. Set JARVIS_DURABLE_AGENT=0 to disable durable
  // tools; DEEP WORK then reports that the agent is unavailable instead of
  // falling back to a renderer-side tool loop.
  durableAgentEnabled: process.env.JARVIS_DURABLE_AGENT !== '0',
  // Shared idle-residency window for startup preload, chat, and durable tasks.
  modelKeepAlive: process.env.JARVIS_MODEL_KEEP_ALIVE || '10m',
  agentTaskStart:   (request)               => ipcRenderer.invoke('agent-task-start', request),
  agentTaskList:    (options)               => ipcRenderer.invoke('agent-task-list', options),
  agentTaskGet:     (taskId)                => ipcRenderer.invoke('agent-task-get', taskId),
  agentTaskEvents:  (taskId, options)       => ipcRenderer.invoke('agent-task-events', taskId, options),
  agentTaskCancel:  (taskId, reason)        => ipcRenderer.invoke('agent-task-cancel', taskId, reason),
  agentTaskApprove: (taskId, options)       => ipcRenderer.invoke('agent-task-approve', taskId, options),
  agentTaskResume:  (taskId, options)       => ipcRenderer.invoke('agent-task-resume', taskId, options),
  // Renderer-discovered approvals (e.g. after restart) ask the main process to
  // surface the native notification when the window is hidden/unfocused.
  notifyApproval:   (payload)               => ipcRenderer.send('agent-approval-notify', payload),
  onAgentTaskEvent: (cb) => {
    ipcRenderer.removeAllListeners('agent-task-event');
    ipcRenderer.on('agent-task-event', (_, event) => cb(event));
  },

  // â”€â”€â”€ Isolated Browser Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  browserStatus:        () => ipcRenderer.invoke('browser-status'),
  browserEmergencyStop: () => ipcRenderer.invoke('browser-emergency-stop'),

  // â”€â”€â”€ Personal Integrations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  integrationsList:         () => ipcRenderer.invoke('integrations-list'),
  integrationsUpdateScopes: (payload) => ipcRenderer.invoke('integrations-update-scopes', payload),
  integrationsRevoke:       (payload) => ipcRenderer.invoke('integrations-revoke', payload),
  integrationsDeleteData:   (payload) => ipcRenderer.invoke('integrations-delete-data', payload),
  integrationsActivity:     (payload) => ipcRenderer.invoke('integrations-activity', payload),

  // â”€â”€â”€ Local Document Index â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  documentsStatus:       () => ipcRenderer.invoke('documents-status'),
  documentsPickFolder:   () => ipcRenderer.invoke('documents-pick-folder'),
  documentsAddFolder:    (payload) => ipcRenderer.invoke('documents-add-folder', payload),
  documentsRemoveFolder: (payload) => ipcRenderer.invoke('documents-remove-folder', payload),
  documentsReindex:      () => ipcRenderer.invoke('documents-reindex'),
  documentsSetRetention: (payload) => ipcRenderer.invoke('documents-set-retention', payload),
  documentsApplyRetention: () => ipcRenderer.invoke('documents-apply-retention'),
  documentsDeleteAll:    () => ipcRenderer.invoke('documents-delete-all'),

  // â”€â”€â”€ Runtime Diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  getRuntimeStats: ()               => ipcRenderer.invoke('get-runtime-stats'),

  // â”€â”€â”€ Auth / PIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  authLoad:          ()       => ipcRenderer.invoke('auth-load'),
  authSetupPin:      (pin)    => ipcRenderer.invoke('auth-setup-pin', { pin }),
  authSkip:          ()       => ipcRenderer.invoke('auth-skip'),
  authVerify:        (pin)    => ipcRenderer.invoke('auth-verify', pin),
  authChangePin:     (payload)=> ipcRenderer.invoke('auth-change-pin', payload),
  authRecoverReset:  ()       => ipcRenderer.invoke('auth-recover-reset'),

  // â”€â”€â”€ Local Face Unlock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Capture, liveness, and embedding generation run in a separate sandboxed
  // verifier webContents. This bridge can only start/cancel that verifier and
  // receive display-only status. It never supplies embeddings or asserts
  // liveness.
  faceStatus:             ()       => ipcRenderer.invoke('face-status'),
  faceBeginEnrollment:    ()       => ipcRenderer.invoke('face-begin-enrollment'),
  faceCancelEnrollment:   ()       => ipcRenderer.invoke('face-cancel-enrollment'),
  faceDelete:             (payload)=> ipcRenderer.invoke('face-delete', payload),
  faceSetEnabled:         (payload)=> ipcRenderer.invoke('face-set-enabled', payload),
  faceStartVerifier:      (payload)=> ipcRenderer.invoke('face-start-verifier', payload),
  faceCancelVerifier:     ()       => ipcRenderer.invoke('face-cancel-verifier'),
  onAuthLock: (cb) => {
    ipcRenderer.removeAllListeners('auth-lock');
    ipcRenderer.on('auth-lock', () => cb());
  },
  onAppVisibility: (cb) => subscribeAppVisibility(cb),
  onFaceVerifierStatus: (cb) => {
    ipcRenderer.removeAllListeners('face-verifier-status');
    ipcRenderer.on('face-verifier-status', (_, payload) => cb(payload || {}));
  },
  onFaceVerifierOutcome: (cb) => {
    ipcRenderer.removeAllListeners('face-verifier-outcome');
    ipcRenderer.on('face-verifier-outcome', (_, payload) => cb(payload || {}));
  },
  onFaceVerifierStop: (cb) => {
    ipcRenderer.removeAllListeners('face-verifier-stop');
    ipcRenderer.on('face-verifier-stop', (_, payload) => cb(payload || {}));
  },

  // â”€ Security Boundary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  securityGet:     ()       => ipcRenderer.invoke('security-get'),
  securityRequest: (payload) => ipcRenderer.invoke('security-request', payload),
  securityRevoke:  (payload) => ipcRenderer.invoke('security-revoke', payload),
  secAuditRead:    ()       => ipcRenderer.invoke('sec-audit-read'),
  secClassifyCmd:  (cmd)    => ipcRenderer.invoke('sec-classify-command', cmd),

  // â”€â”€â”€ Local Voice (Phase 5A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The renderer runs the VAD and records a short local segment. Main owns the
  // persisted opt-in, capture purpose, lease duration, and transcription
  // leases. A renderer-supplied lockScreen flag or duration is never accepted.
  voiceStatus: () => ipcRenderer.invoke('voice-status'),
  voiceSetWakeWord: (enabled) => ipcRenderer.invoke('voice-set-wake-word', { enabled: enabled === true }),
  voiceArmMicrophone: (purpose) => ipcRenderer.invoke('voice-arm-microphone', { purpose }),
  voiceDisarmMicrophone: (captureId) => ipcRenderer.invoke(
    'voice-disarm-microphone',
    typeof captureId === 'string' && captureId ? { captureId } : {}
  ),
  voiceCreateTranscriptionLease: () => ipcRenderer.invoke('voice-create-transcription-lease'),
  onVoiceCaptureRevoked: (cb) => {
    ipcRenderer.removeAllListeners('voice-capture-revoked');
    ipcRenderer.on('voice-capture-revoked', (_, payload) => cb(payload || {}));
  },
  focusWindow: () => ipcRenderer.invoke('focus-window'),

  // â”€ Screen Capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  captureScreen:   ()       => ipcRenderer.invoke('capture-screen'),
  transcribeAudio: (payload) => ipcRenderer.invoke('transcribe-audio', payload),

  // â”€â”€â”€ Piper TTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  piperTTS:        (text)   => ipcRenderer.invoke('piper-tts', text),

  // â”€â”€â”€ Ollama push notification (main â†’ renderer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Issue 8 fix: same listener accumulation guard as onWindowState above.
  onOllamaOnline: (cb) => { ipcRenderer.removeAllListeners('ollama-online'); ipcRenderer.on('ollama-online', () => cb()); },
  // â”€â”€â”€ Telemetry (main â†’ renderer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  onTelemetry: (cb) => { ipcRenderer.removeAllListeners('telemetry-update'); ipcRenderer.on('telemetry-update', (_, data) => cb(data)); },
  // â”€â”€â”€ Toast Notification (main â†’ renderer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  onShowToast: (cb) => { ipcRenderer.removeAllListeners('show-toast'); ipcRenderer.on('show-toast', (_, data) => cb(data)); },
  // â”€â”€â”€ Voice Toggle (main â†’ renderer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  onToggleVoice: (cb) => { ipcRenderer.removeAllListeners('toggle-voice'); ipcRenderer.on('toggle-voice', () => cb()); },
});
