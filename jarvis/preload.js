// ═══════════════════════════════════════════════════════════════
// JARVIS — Preload Script
// Safely exposes IPC APIs to renderer via contextBridge
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {

  // ─── Window Controls ─────────────────────────────────────────
  minimize: ()    => ipcRenderer.send('win-minimize'),
  maximize: ()    => ipcRenderer.send('win-maximize'),
  close:    ()    => ipcRenderer.send('win-close'),
  // Issue 8 fix: calling ipcRenderer.on() multiple times stacks listeners—
  // each push event fires every accumulated callback. removeAllListeners first
  // ensures at most one listener is ever active for this channel.
  onWindowState: (cb) => { ipcRenderer.removeAllListeners('window-state'); ipcRenderer.on('window-state', (_, state) => cb(state)); },

  // ─── File System ─────────────────────────────────────────────
  readFile:    (filePath)          => ipcRenderer.invoke('fs-read', filePath),
  writeFile:   (filePath, content) => ipcRenderer.invoke('fs-write', filePath, content),
  listDir:     (dirPath)           => ipcRenderer.invoke('fs-list', dirPath),
  saveDialog:  (name, content)     => ipcRenderer.invoke('fs-dialog-save', name, content),

  // ─── History ─────────────────────────────────────────────────
  saveHistory:   (id, data) => ipcRenderer.invoke('history-save', id, data),
  loadHistory:   (id)       => ipcRenderer.invoke('history-load', id),
  listHistory:   ()         => ipcRenderer.invoke('history-list'),
  deleteHistory: (id)       => ipcRenderer.invoke('history-delete', id),

  // ─── Terminal ────────────────────────────────────────────────
  runCommand: (cmd, cwd) => ipcRenderer.invoke('run-command', cmd, cwd),

  // ─── System ──────────────────────────────────────────────────
  getSystemInfo:   ()          => ipcRenderer.invoke('get-system-info'),
  getUserDataPath: ()          => ipcRenderer.invoke('get-user-data-path'),
  openExternal:    (url)       => ipcRenderer.send('open-external', url),
  systemCommand:   (action, target) => ipcRenderer.invoke('system-command', action, target),
  quitApp:         ()          => ipcRenderer.send('quit-app'),

  // ─── Dev Pack ────────────────────────────────────────────────
  openFolderDialog: ()         => ipcRenderer.invoke('open-folder-dialog'),
  readProject:      (rootPath) => ipcRenderer.invoke('read-project', rootPath),
  memoryLoad:       ()         => ipcRenderer.invoke('memory-load'),
  memorySave:       (facts)    => ipcRenderer.invoke('memory-save', facts),
  chatMemoryRead:   (mode, limit) => ipcRenderer.invoke('chat-memory-read', { mode, limit }),
  chatMemorySave:   (mode, role, content) => ipcRenderer.invoke('chat-memory-save', { mode, role, content }),
  webSearch:        (q, type)  => ipcRenderer.invoke('web-search', q, type),

  // ─── Safe Code Runner ────────────────────────────────────────
  runCodeSafe:      (lang, code) => ipcRenderer.invoke('run-code-safe', lang, code),

  // ─── HTTP Proxy ──────────────────────────────────────────────
  httpRequest:      (opts)       => ipcRenderer.invoke('http-request', opts),

  // ─── Image & Binary ──────────────────────────────────────────
  openImageDialog:  ()           => ipcRenderer.invoke('open-image-dialog'),
  readFileBinary:   (fp)         => ipcRenderer.invoke('fs-read-binary', fp),

  // ─── Snippets ────────────────────────────────────────────────
  snippetsLoad: ()       => ipcRenderer.invoke('snippets-load'),
  snippetsSave: (data)   => ipcRenderer.invoke('snippets-save', data),

  // ─── Scheduler ───────────────────────────────────────────────
  schedulerAdd:       (jobData) => ipcRenderer.invoke('scheduler-add', jobData),
  schedulerRemove:    (jobId)   => ipcRenderer.invoke('scheduler-remove', jobId),
  schedulerList:      ()        => ipcRenderer.invoke('scheduler-list'),
  onSchedulerTrigger: (cb)      => ipcRenderer.on('scheduler-trigger', (_, job) => cb(job)),

  // ─── Prompts ─────────────────────────────────────────────────
  promptsLoad:  ()       => ipcRenderer.invoke('prompts-load'),
  promptsSave:  (data)   => ipcRenderer.invoke('prompts-save', data),

  // ─── Notes ───────────────────────────────────────────────────
  notesLoad:    ()       => ipcRenderer.invoke('notes-load'),
  notesSave:    (c)      => ipcRenderer.invoke('notes-save', c),

  // ─── Skills System ───────────────────────────────────────────
  skillsList:   ()                  => ipcRenderer.invoke('skills-list'),
  skillsRun:    (skillId, args)     => ipcRenderer.invoke('skills-run', skillId, args),

  // ─── Runtime Diagnostics ─────────────────────────────────────
  getRuntimeStats: ()               => ipcRenderer.invoke('get-runtime-stats'),

  // ─── Auth / PIN ──────────────────────────────────────────────
  authLoad:     ()       => ipcRenderer.invoke('auth-load'),
  authSave:     (data)   => ipcRenderer.invoke('auth-save', data),

  // ─ Security Boundary ──────────────────────────────────────
  secConfigLoad:   ()       => ipcRenderer.invoke('sec-config-load'),
  secConfigSave:   (cfg)    => ipcRenderer.invoke('sec-config-save', cfg),
  secAuditRead:    ()       => ipcRenderer.invoke('sec-audit-read'),
  secClassifyCmd:  (cmd)    => ipcRenderer.invoke('sec-classify-command', cmd),

  // ─ Screen Capture ────────────────────────────────────────────
  captureScreen:   ()       => ipcRenderer.invoke('capture-screen'),
  transcribeAudio: (buffer) => ipcRenderer.invoke('transcribe-audio', buffer),

  // ─── Piper TTS ───────────────────────────────────────────────
  piperTTS:        (text)   => ipcRenderer.invoke('piper-tts', text),

  // ─── Ollama push notification (main → renderer) ───────────────
  // Issue 8 fix: same listener accumulation guard as onWindowState above.
  onOllamaOnline: (cb) => { ipcRenderer.removeAllListeners('ollama-online'); ipcRenderer.on('ollama-online', () => cb()); },
  // ─── Telemetry (main → renderer) ───────────────
  onTelemetry: (cb) => { ipcRenderer.removeAllListeners('telemetry'); ipcRenderer.on('telemetry', (_, data) => cb(data)); },
});
