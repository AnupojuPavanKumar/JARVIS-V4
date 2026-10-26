// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// JARVIS â€” Preload Script
// Safely exposes IPC APIs to renderer via contextBridge
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const { contextBridge, ipcRenderer } = require('electron');

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
  readFile:    (filePath, token)          => ipcRenderer.invoke('fs-read', filePath, token),
  writeFile:   (filePath, content) => ipcRenderer.invoke('fs-write', filePath, content),
  listDir:     (dirPath, token)           => ipcRenderer.invoke('fs-list', dirPath, token),
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
  runCommand: (cmd, cwd, timeout) => ipcRenderer.invoke('run-command', cmd, cwd, timeout),

  // â”€â”€â”€ System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  getSystemInfo:   ()          => ipcRenderer.invoke('get-system-info'),
  getUserDataPath: ()          => ipcRenderer.invoke('get-user-data-path'),
  openExternal:    (url)       => ipcRenderer.send('open-external', url),
  systemCommand:   (action, target) => ipcRenderer.invoke('system-command', action, target),
  quitApp:         ()          => ipcRenderer.send('quit-app'),

  // â”€â”€â”€ Dev Pack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  openFolderDialog: ()         => ipcRenderer.invoke('open-folder-dialog'),
  readProject:      () => ipcRenderer.invoke('read-project'),
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
  // The renderer runs local inference and sends only numeric embeddings. Raw
  // camera frames are never sent over IPC or persisted.
  faceStatus:             ()       => ipcRenderer.invoke('face-status'),
  faceBeginEnrollment:    ()       => ipcRenderer.invoke('face-begin-enrollment'),
  faceCancelEnrollment:   ()       => ipcRenderer.invoke('face-cancel-enrollment'),
  faceEnroll:             (payload)=> ipcRenderer.invoke('face-enroll', payload),
  faceVerify:             (payload)=> ipcRenderer.invoke('face-verify', payload),
  faceDelete:             (payload)=> ipcRenderer.invoke('face-delete', payload),
  faceSetEnabled:         (payload)=> ipcRenderer.invoke('face-set-enabled', payload),
  faceArmCamera:          (payload)=> ipcRenderer.invoke('face-arm-camera', payload),
  faceDisarmCamera:       ()       => ipcRenderer.invoke('face-disarm-camera'),
  onAuthLock: (cb) => {
    ipcRenderer.removeAllListeners('auth-lock');
    ipcRenderer.on('auth-lock', () => cb());
  },
  onAppVisibility: (cb) => {
    ipcRenderer.removeAllListeners('app-visibility');
    ipcRenderer.on('app-visibility', (_, payload) => cb(payload || {}));
  },
  onFaceCameraStop: (cb) => {
    ipcRenderer.removeAllListeners('face-camera-stop');
    ipcRenderer.on('face-camera-stop', () => cb());
  },

  // â”€ Security Boundary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  securityGet:     ()       => ipcRenderer.invoke('security-get'),
  securityRequest: (payload) => ipcRenderer.invoke('security-request', payload),
  securityRevoke:  (payload) => ipcRenderer.invoke('security-revoke', payload),
  secAuditRead:    ()       => ipcRenderer.invoke('sec-audit-read'),
  secClassifyCmd:  (cmd)    => ipcRenderer.invoke('sec-classify-command', cmd),

  // â”€â”€â”€ Local Voice (Phase 5A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The renderer runs the VAD and records a short local segment. The main
  // process only grants microphone permission while this explicit gate is
  // armed, and transcription stays on the local Whisper server.
  voiceArmMicrophone: (payload = {}) => ipcRenderer.invoke('voice-arm-microphone', payload),
  voiceDisarmMicrophone: () => ipcRenderer.invoke('voice-disarm-microphone'),
  focusWindow: () => ipcRenderer.invoke('focus-window'),

  // â”€ Screen Capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  captureScreen:   ()       => ipcRenderer.invoke('capture-screen'),
  transcribeAudio: (buffer) => ipcRenderer.invoke('transcribe-audio', buffer),

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
