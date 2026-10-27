'use strict';

// Renderer boot smoke test.
//
// Loads the real renderer/index.html in a hidden Electron window with the real
// preload, then verifies the dashboard renders instead of leaving a blank
// window. Guards against regressions like the dropped `dashProductivity`
// builder and the missing `WakeWord` object.
//
//   npx electron tests/electron-renderer-smoke.js
//
// Exits 0 on success, 1 on the first failed check.

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registerClipboardController = require('../backend/controllers/ClipboardController');

app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-renderer-smoke-'));
app.setPath('userData', userDataDir);

// Keep the developer's real clipboard out of the smoke run. The controller and
// renderer bridge still exercise the real write path, but the write is captured
// here and never reaches the operating system.
const originalClipboardWriteText = clipboard.writeText;
const clipboardWrites = [];
clipboard.writeText = text => { clipboardWrites.push(text); };
registerClipboardController({ ipcMain, clipboard });

function finish(code) {
  clipboard.writeText = originalClipboardWriteText;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
}

const consoleLines = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const integrationFixture = {
  calendar: { enabled: true, scopes: ['calendar.read'], counts: { events: 1 } },
  email: { enabled: true, scopes: ['email.read'], counts: { emails: 1 } },
  contacts: { enabled: true, scopes: ['contacts.read'], counts: { contacts: 1 } },
  tasks: { enabled: true, scopes: ['tasks.read'], counts: { tasks: 1 } },
  notes: { enabled: true, scopes: ['notes.read'], counts: { notes: 1 } },
  messaging: { enabled: false, scopes: [], counts: { messages: 0 } },
};

// The renderer init path calls several IPC handlers; reply benignly so the
// page can settle without a swarm of rejected invokes aborting init.
const benignHandlers = {
  'settings-load': { ok: true, data: null },
  'integrations-list': {
    ok: true,
    enabled: true,
    vaultAvailable: true,
    availableScopes: {
      calendar: ['calendar.read'],
      email: ['email.read'],
      contacts: ['contacts.read'],
      tasks: ['tasks.read'],
      notes: ['notes.read'],
      messaging: ['messaging.draft', 'messaging.send'],
    },
    integrations: integrationFixture,
  },
  'documents-status': {
    ok: true,
    enabled: true,
    folders: [{
      id: 'folder_smoke',
      path: 'C:/approved',
      scope: 'work',
      addedAt: '2026-10-21T12:00:00.000Z',
      documentCount: 2,
      chunkCount: 4,
    }],
    documentCount: 2,
    chunkCount: 4,
    retentionDays: null,
    lastIndexedAt: '2026-10-21T12:00:00.000Z',
  },
  'get-system-info': { ok: true, cpuModel: 'smoke', cpuCores: 8, totalMemGB: 16, osName: 'smoke' },
  'get-user-data-path': userDataDir,
  'ollama-check': { ok: false, online: false },
  'list-history': { ok: true, data: [] },
  'auth-load': { ok: true, state: 'no-lock', status: 'explicit-skip', data: { hasPin: false, skipPin: true, status: 'explicit-skip', recoveredFromBackup: false } },
  'face-status': {
    ok: true,
    available: true,
    enrolled: true,
    enabled: true,
    hasPin: true,
    skipPin: false,
    lockRequired: true,
    samples: 3,
    modelBaseUrl: 'http://127.0.0.1:9/models/',
  },
  'skills-list': { ok: true, skills: [] },
  'security-get': { ok: true, state: 'no-lock', capabilities: {}, legacy: { detected: false } },
  'sec-audit-read': { ok: true, entries: [] },
  'memory-load': { ok: true, records: [], facts: [], stats: { total: 0 } },
  'memory-retrieve': { ok: true, context: '', records: [], chars: 0, budget: { maxChars: 1800, maxRecords: 6 } },
  'memory-record-conversation': { ok: true, episode: null, extractedCount: 0, stats: { total: 0 } },
  'memory-add': { ok: true, record: null, stats: { total: 0 } },
  'run-command': { ok: true, stdout: '', stderr: '' },
  'get-runtime-stats': { ok: false },
  'ollama-fetch': { ok: false, error: 'smoke' },
  'history-list': { ok: true, data: [] },
  'agent-task-list': { ok: true, tasks: [] },
  'agent-task-get': { ok: false, error: 'smoke' },
  'ambient-status': {
    ok: true,
    supported: true,
    autoStartEnabled: false,
    startHidden: true,
    schedulerRunning: true,
    trayResident: true,
    lastResumeAt: null,
  },
  'piper-tts': { ok: true },
  'renderer-log-write': { ok: true },
  'voice-status': {
    ok: true,
    wakeWordEnabled: false,
    settingsError: null,
    sessionLocked: false,
    windowVisible: false,
    capture: null,
  },
};
for (const [channel, response] of Object.entries(benignHandlers)) {
  ipcMain.handle(channel, async () => response);
}

const historySaves = [];
ipcMain.handle('history-save', async (_event, id, data = {}) => {
  historySaves.push({ id, data });
  return { ok: true };
});

const knowledgeCalls = {
  promptsLoads: 0,
  promptsSaves: [],
  snippetsLoads: 0,
  snippetsSaves: [],
  notesLoads: 0,
  notesSaves: [],
  imageDialogs: 0,
  binaryReads: [],
};

ipcMain.handle('prompts-load', async () => {
  knowledgeCalls.promptsLoads += 1;
  return {
    ok: true,
    data: [{
      id: 'smoke-prompt',
      title: 'Smoke Prompt',
      category: 'Smoke',
      body: 'Prompt body loaded through the named bridge.',
    }],
  };
});
ipcMain.handle('prompts-save', async (_event, data = []) => {
  knowledgeCalls.promptsSaves.push(data);
  return { ok: true };
});
ipcMain.handle('snippets-load', async () => {
  knowledgeCalls.snippetsLoads += 1;
  return {
    ok: true,
    data: [{
      id: 'smoke-snippet',
      title: 'Smoke Snippet',
      lang: 'javascript',
      code: 'console.log("smoke snippet");',
    }],
  };
});
ipcMain.handle('snippets-save', async (_event, data = []) => {
  knowledgeCalls.snippetsSaves.push(data);
  return { ok: true };
});
ipcMain.handle('notes-load', async () => {
  knowledgeCalls.notesLoads += 1;
  return { ok: true, data: 'Smoke notes from main' };
});
ipcMain.handle('notes-save', async (_event, content = '') => {
  knowledgeCalls.notesSaves.push(content);
  return { ok: true };
});
ipcMain.handle('open-image-dialog', async () => {
  knowledgeCalls.imageDialogs += 1;
  return { ok: true, filePath: 'C:/smoke/pixel.png' };
});
ipcMain.handle('fs-read-binary', async (_event, filePath) => {
  knowledgeCalls.binaryReads.push(filePath);
  return {
    ok: true,
    data: Buffer.from('smoke-image').toString('base64'),
    mimeType: 'image/png',
  };
});

const ambientAutoStartCalls = [];
ipcMain.handle('ambient-set-auto-start', async (_event, payload = {}) => {
  ambientAutoStartCalls.push(payload);
  return {
    ok: true,
    supported: true,
    autoStartEnabled: payload.enabled === true,
    startHidden: payload.startHidden === true,
    schedulerRunning: true,
    trayResident: true,
  };
});

ipcMain.on('ollama-stream-start', (event, payload = {}) => {
  const reqId = payload.reqId;
  setTimeout(() => {
    if (event.sender.isDestroyed()) return;
    event.sender.send('ollama-stream-chunk', {
      reqId,
      chunk: JSON.stringify({
        message: { content: 'FAST smoke reply' },
        done: false,
      }) + '\n',
    });
    event.sender.send('ollama-stream-end', { reqId });
  }, 250);
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof message === 'string'
      ? message
      : (event && typeof event.message === 'string' ? event.message : '');
    if (text) consoleLines.push(text);
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(1500);
  await win.webContents.executeJavaScript(`document.getElementById('btn-settings')?.click()`);
  await wait(300);

  const boot = await win.webContents.executeJavaScript(`({
    dashboardLength: (document.getElementById('dashboard-area')?.innerHTML || '').length,
    generalRendered: Boolean(document.querySelector('#dashboard-area .mode-dashboard')),
    sidebarButtons: document.querySelectorAll('#sidebar-modes .mode-btn').length,
    wakeWordType: typeof window.WakeWord,
    toggleWakeType: typeof window.toggleWakeWord,
    voiceUtilsType: typeof window.JarvisVoiceUtils,
    voiceLocalMode: window.WakeWord?.local === true,
    voiceListenOnceType: typeof window.WakeWord?.listenOnce,
    voiceArmMicrophoneType: typeof window.jarvis.voiceArmMicrophone,
    voiceDisarmMicrophoneType: typeof window.jarvis.voiceDisarmMicrophone,
    voiceStatusType: typeof window.jarvis.voiceStatus,
    voiceSetWakeWordType: typeof window.jarvis.voiceSetWakeWord,
    voiceTranscriptionLeaseType: typeof window.jarvis.voiceCreateTranscriptionLease,
    voiceRevokedEventType: typeof window.jarvis.onVoiceCaptureRevoked,
    voiceFocusWindowType: typeof window.jarvis.focusWindow,
    voiceButtonBound: document.getElementById('voice-btn')?.dataset.localVoiceBound === '1',
    jarvisSecLoadType: typeof window.JarvisSec?.load,
    jarvisSecRequestType: typeof window.JarvisSec?.request,
    jarvisSecRevokeType: typeof window.JarvisSec?.revoke,
    jarvisMemorySaveType: typeof window.jarvisMemory?.save,
    memoryRetrieveType: typeof window.jarvisMemory?.getRelevantContext,
    memoryRecordType: typeof window.jarvisMemory?.recordConversation,
    jarvisNoticeType: typeof window.appendJarvisMessage,
    browserStopType: typeof window.jarvis.browserEmergencyStop,
    browserStopButton: Boolean(document.getElementById('btn-browser-stop')),
    integrationListType: typeof window.jarvis.integrationsList,
    integrationPanelRows: document.querySelectorAll('#integration-panel .integration-row').length,
    integrationPanelText: (document.getElementById('integration-panel')?.innerText || '').slice(0, 500),
    integrationEnableButton: Boolean(document.querySelector('#integration-panel [data-integration-action="enable"]')),
    ambientStatusType: typeof window.jarvis.ambientStatus,
    ambientSetAutoStartType: typeof window.jarvis.ambientSetAutoStart,
    ambientAutoStartToggle: Boolean(document.getElementById('cfg-start-at-login')),
    ambientStartHiddenToggle: Boolean(document.getElementById('cfg-start-hidden')),
    ambientStartHiddenChecked: document.getElementById('cfg-start-hidden')?.checked === true,
    ambientStatusText: (document.getElementById('ambient-status')?.innerText || '').slice(0, 300),
    faceStatusType: typeof window.jarvis.faceStatus,
    faceStartVerifierType: typeof window.jarvis.faceStartVerifier,
    faceVerifierResultType: typeof window.jarvis.faceVerify,
    faceSettingsStatus: (document.getElementById('face-settings-status')?.innerText || '').slice(0, 300),
    faceEnabledChecked: document.getElementById('cfg-face-enabled')?.checked === true,
    faceEnrollText: (document.getElementById('face-enroll-btn')?.innerText || '').trim(),
    faceDeleteDisabled: document.getElementById('face-delete-btn')?.disabled === true,
    faceDeletePinVisible: document.getElementById('face-delete-pin')?.classList.contains('hidden') === false,
    faceLockPanel: Boolean(document.getElementById('auth-face-panel')),
    faceLockReticle: Boolean(document.querySelector('#auth-face-live .auth-face-reticle')),
    faceSetupModal: Boolean(document.getElementById('face-setup-modal')),
    faceSetupVisual: Boolean(document.querySelector('#face-setup-camera .face-setup-visual')),
    faceSetupVideo: Boolean(document.getElementById('face-setup-video')),
    toggleGeometry: Array.from(document.querySelectorAll('#settings-modal .toggle-row')).map(row => {
      const track = row.querySelector('.toggle-track');
      const thumb = row.querySelector('.toggle-thumb');
      const trackRect = track?.getBoundingClientRect();
      const thumbRect = thumb?.getBoundingClientRect();
      return {
        id: row.querySelector('input')?.id || '',
        trackWidth: trackRect?.width || 0,
        thumbLeft: thumbRect && trackRect ? thumbRect.left - trackRect.left : -1,
        thumbRight: thumbRect && trackRect ? thumbRect.right - trackRect.left : -1,
      };
    }),
    documentsStatusType: typeof window.jarvis.documentsStatus,
    documentPanelRows: document.querySelectorAll('#document-panel .integration-row').length,
    documentPanelText: (document.getElementById('document-panel')?.innerText || '').slice(0, 500),
    legacyTaskController: typeof window.TaskController?.createTask,
    legacyTaskControllerExecute: typeof window.TaskController?.executeTask,
    legacyToolExecutor: typeof window.ToolExecutor,
    legacySkillsRun: typeof window.jarvis.skillsRun,
    legacyAgentStart: typeof window.jarvis.agentStart,
    schedulerModal: (() => {
      const modal = document.getElementById('scheduler-modal');
      const wasHidden = modal.hidden;
      modal.hidden = false;
      const box = modal.querySelector('.modal-box');
      const header = modal.querySelector('.modal-hdr');
      const addButton = modal.querySelector('.scheduler-add-btn');
      const rect = box.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const addRect = addButton.getBoundingClientRect();
      const addStyle = getComputedStyle(addButton);
      modal.hidden = wasHidden;
      return {
        top: rect.top,
        headerTop: headerRect.top,
        headerHeight: headerRect.height,
        addButtonWidth: Math.round(addRect.width),
        addButtonBackground: addStyle.backgroundColor,
        titlebar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')),
      };
    })(),
    schedulerForm: (() => {
      const form = document.getElementById('scheduler-add-form');
      const wasHidden = form.hidden;
      if (wasHidden) window.toggleSchedulerAddForm();
      const dateInput = document.getElementById('sched-datetime');
      const oneOff = document.getElementById('sched-oneoff');
      const recurring = document.getElementById('sched-recurring');
      const triggerTime = new Date(dateInput.value).getTime();
      const info = {
        dateValue: dateInput.value,
        dateFuture: Number.isFinite(triggerTime) && triggerTime > Date.now(),
        recurringHidden: recurring.hidden && getComputedStyle(recurring).display === 'none',
        oneOffVisible: !oneOff.hidden && getComputedStyle(oneOff).display !== 'none',
      };
      if (wasHidden) window.toggleSchedulerAddForm();
      return info;
    })(),
  })`);

  check('sidebar mode buttons are built', boot.sidebarButtons === 8, JSON.stringify(boot));
  check('general dashboard renders content', boot.generalRendered && boot.dashboardLength > 200, JSON.stringify(boot));
  check('WakeWord module is loaded', boot.wakeWordType === 'object', JSON.stringify(boot));
  check('toggleWakeWord is callable', boot.toggleWakeType === 'function', JSON.stringify(boot));
  check(
    'local voice helpers and Whisper bridge are loaded',
    boot.voiceUtilsType === 'object'
      && boot.voiceLocalMode === true
      && boot.voiceListenOnceType === 'function'
      && boot.voiceArmMicrophoneType === 'function'
      && boot.voiceDisarmMicrophoneType === 'function'
      && boot.voiceStatusType === 'function'
      && boot.voiceSetWakeWordType === 'function'
      && boot.voiceTranscriptionLeaseType === 'function'
      && boot.voiceRevokedEventType === 'function'
      && boot.voiceFocusWindowType === 'function',
    JSON.stringify(boot)
  );
  check('voice button is bound to the local voice loop', boot.voiceButtonBound === true, JSON.stringify(boot));
  check(
    'JarvisSec exposes only main-broker capability methods',
    boot.jarvisSecLoadType === 'function'
      && boot.jarvisSecRequestType === 'function'
      && boot.jarvisSecRevokeType === 'function',
    JSON.stringify(boot)
  );
  check(
    'unified memory client is exposed',
    boot.jarvisMemorySaveType === 'function'
      && boot.memoryRetrieveType === 'function'
      && boot.memoryRecordType === 'function',
    JSON.stringify(boot)
  );
  check('JARVIS chat notices are exposed to the agent client', boot.jarvisNoticeType === 'function', JSON.stringify(boot));
  check(
    'browser emergency stop is exposed in the renderer',
    boot.browserStopType === 'function' && boot.browserStopButton === true,
    JSON.stringify(boot)
  );
  check(
    'personal integration controls render in settings',
    boot.integrationListType === 'function'
      && boot.integrationPanelRows === 6
      && boot.integrationEnableButton === true
      && /CALENDAR/.test(boot.integrationPanelText),
    JSON.stringify(boot)
  );
  check(
    'background presence controls render in settings',
    boot.ambientStatusType === 'function'
      && boot.ambientSetAutoStartType === 'function'
      && boot.ambientAutoStartToggle === true
      && boot.ambientStartHiddenToggle === true
      && boot.ambientStartHiddenChecked === true
      && /Auto-start is off/.test(boot.ambientStatusText),
    JSON.stringify(boot)
  );
  check(
    'approved document index controls render in settings',
    boot.documentsStatusType === 'function'
      && boot.documentPanelRows === 1
      && /approved/.test(boot.documentPanelText)
      && /2 file/.test(boot.documentPanelText),
    JSON.stringify(boot)
  );
  check(
    'settings toggle thumbs stay inside their tracks',
    boot.toggleGeometry.length >= 4
      && boot.toggleGeometry.every(toggle => (
        toggle.trackWidth >= 40
        && toggle.thumbLeft >= -0.5
        && toggle.thumbRight <= toggle.trackWidth + 0.5
      )),
    JSON.stringify(boot.toggleGeometry)
  );
  check(
    'local face unlock controls use the isolated verifier and display-only emblem',
    boot.faceStatusType === 'function'
      && boot.faceStartVerifierType === 'function'
      && boot.faceVerifierResultType === 'undefined'
      && boot.faceLockPanel === true
      && boot.faceLockReticle === true
      && boot.faceSetupModal === true
      && boot.faceSetupVisual === true
      && boot.faceSetupVideo === false
      && boot.faceEnabledChecked === true
      && boot.faceDeleteDisabled === false
      && boot.faceDeletePinVisible === true
      && boot.faceEnrollText === 'RE-ENROLL FACE'
      && /3 templates/.test(boot.faceSettingsStatus)
      && /enabled/.test(boot.faceSettingsStatus),
    JSON.stringify(boot)
  );

  // P1-4: prompt, snippet, notes, image, and clipboard flows must use the named
  // preload bridge instead of the removed generic invoke. The handlers above
  // return fixtures so a broken call site becomes a visible failure.
  const knowledgeUi = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const close = id => document.querySelector('#' + id + ' .modal-close-btn')?.click();
    const types = {
      promptsLoad: typeof window.jarvis.promptsLoad,
      promptsSave: typeof window.jarvis.promptsSave,
      snippetsLoad: typeof window.jarvis.snippetsLoad,
      snippetsSave: typeof window.jarvis.snippetsSave,
      notesLoad: typeof window.jarvis.notesLoad,
      notesSave: typeof window.jarvis.notesSave,
      openImageDialog: typeof window.jarvis.openImageDialog,
      readFileBinary: typeof window.jarvis.readFileBinary,
      clipboardWriteText: typeof window.jarvis.clipboardWriteText,
      clipboardReadText: typeof window.jarvis.clipboardReadText,
      invoke: typeof window.jarvis.invoke,
      copyTextToClipboard: typeof window.copyTextToClipboard,
      copySnip: typeof window.copySnip,
      copyCodeBlock: typeof window.copyCodeBlock,
      copyCreative: typeof window.copyCreative,
    };

    await window.openPromptLibrary();
    await wait(120);
    const promptsOpen = document.getElementById('prompts-modal')?.hidden === false;
    const promptsText = document.getElementById('prompts-grid')?.innerText || '';
    document.getElementById('prompt-new-title').value = 'Smoke Added Prompt';
    document.getElementById('prompt-new-cat').value = 'Smoke';
    document.getElementById('prompt-new-body').value = 'Added through saveNewPrompt.';
    await window.saveNewPrompt();
    await wait(120);
    const promptsAfterSave = document.getElementById('prompts-grid')?.innerText || '';
    close('prompts-modal');
    await wait(320);

    await window.openSnippetManager();
    await wait(120);
    const snippetsOpen = document.getElementById('snippets-modal')?.hidden === false;
    const snippetsText = document.getElementById('snippets-list')?.innerText || '';
    document.getElementById('snip-new-title').value = 'Smoke Added Snippet';
    document.getElementById('snip-new-lang').value = 'javascript';
    document.getElementById('snip-new-code').value = 'console.log("added");';
    await window.saveNewSnippet();
    await wait(120);
    const snippetsAfterSave = document.getElementById('snippets-list')?.innerText || '';
    close('snippets-modal');
    await wait(320);

    await window.openNotes();
    await wait(220);
    const notesValue = document.getElementById('notes-editor')?.value || '';
    const notesStatus = document.getElementById('notes-status-bar')?.textContent || '';
    document.getElementById('notes-editor').value = 'Smoke notes updated';
    await window.saveNotes();
    await wait(120);
    close('notes-modal');
    await wait(320);

    window.openImageAnalysis();
    await window.pickImage();
    await wait(180);
    const imageOpen = document.getElementById('img-modal')?.hidden === false;
    const previewSrc = document.getElementById('img-preview')?.getAttribute('src') || '';
    const imageAnalyzeEnabled = document.getElementById('img-analyze-btn')?.disabled === false;
    const imagePreviewVisible = document.getElementById('img-preview-wrap')?.hidden === false;
    close('img-modal');
    await wait(320);

    const emptyCopy = await window.copyTextToClipboard('');
    const clipboardWrite = await window.jarvis.clipboardWriteText('smoke clipboard payload');
    const invalidClipboardWrite = await window.jarvis.clipboardWriteText(42);

    return {
      types,
      promptsOpen,
      promptsText,
      promptsAfterSave,
      snippetsOpen,
      snippetsText,
      snippetsAfterSave,
      notesValue,
      notesStatus,
      imageOpen,
      previewSrc,
      imageAnalyzeEnabled,
      imagePreviewVisible,
      emptyCopy,
      clipboardWrite,
      invalidClipboardWrite,
      promptsClosed: document.getElementById('prompts-modal')?.hidden === true,
      snippetsClosed: document.getElementById('snippets-modal')?.hidden === true,
      notesClosed: document.getElementById('notes-modal')?.hidden === true,
      imageClosed: document.getElementById('img-modal')?.hidden === true,
    };
  })()`);

  check(
    'P1-4 prompt/snippet/notes/image tools expose their named bridge methods',
    knowledgeUi.types.promptsLoad === 'function'
      && knowledgeUi.types.promptsSave === 'function'
      && knowledgeUi.types.snippetsLoad === 'function'
      && knowledgeUi.types.snippetsSave === 'function'
      && knowledgeUi.types.notesLoad === 'function'
      && knowledgeUi.types.notesSave === 'function'
      && knowledgeUi.types.openImageDialog === 'function'
      && knowledgeUi.types.readFileBinary === 'function'
      && knowledgeUi.types.clipboardWriteText === 'function'
      && knowledgeUi.types.clipboardReadText === 'undefined'
      && knowledgeUi.types.invoke === 'undefined',
    JSON.stringify(knowledgeUi.types)
  );
  check(
    'P1-4 prompt, snippet, notes, and image dialogs load, save, and render',
    knowledgeUi.promptsOpen === true
      && /Smoke Prompt/.test(knowledgeUi.promptsText)
      && /Smoke Added Prompt/.test(knowledgeUi.promptsAfterSave)
      && knowledgeUi.snippetsOpen === true
      && /Smoke Snippet/.test(knowledgeUi.snippetsText)
      && /Smoke Added Snippet/.test(knowledgeUi.snippetsAfterSave)
      && knowledgeUi.notesValue === 'Smoke notes from main'
      && /21 chars/.test(knowledgeUi.notesStatus)
      && /4 words/.test(knowledgeUi.notesStatus)
      && knowledgeUi.imageOpen === true
      && knowledgeUi.previewSrc.startsWith('data:image/png;base64,')
      && knowledgeUi.imagePreviewVisible === true
      && knowledgeUi.imageAnalyzeEnabled === true
      && knowledgeUi.promptsClosed === true
      && knowledgeUi.snippetsClosed === true
      && knowledgeUi.notesClosed === true
      && knowledgeUi.imageClosed === true,
    JSON.stringify(knowledgeUi)
  );
  check(
    'P1-4 named bridge handlers received the prompt, snippet, notes, and image payloads',
    knowledgeCalls.promptsLoads === 1
      && knowledgeCalls.promptsSaves.length === 1
      && knowledgeCalls.promptsSaves[0].some(entry => entry.title === 'Smoke Added Prompt')
      && knowledgeCalls.snippetsLoads === 1
      && knowledgeCalls.snippetsSaves.length === 1
      && knowledgeCalls.snippetsSaves[0].some(entry => entry.title === 'Smoke Added Snippet')
      && knowledgeCalls.notesLoads === 1
      && knowledgeCalls.notesSaves.length === 1
      && knowledgeCalls.notesSaves[0] === 'Smoke notes updated'
      && knowledgeCalls.imageDialogs === 1
      && knowledgeCalls.binaryReads.length === 1
      && knowledgeCalls.binaryReads[0] === 'C:/smoke/pixel.png',
    JSON.stringify(knowledgeCalls)
  );
  check(
    'P1-4 copy actions use the write-only bridge and never read the clipboard',
    knowledgeUi.emptyCopy?.ok === false
      && /Nothing to copy/.test(knowledgeUi.emptyCopy?.error || '')
      && knowledgeUi.clipboardWrite?.ok === true
      && knowledgeUi.invalidClipboardWrite?.ok === false
      && clipboardWrites.length === 1
      && clipboardWrites[0] === 'smoke clipboard payload',
    JSON.stringify({ emptyCopy: knowledgeUi.emptyCopy, clipboardWrite: knowledgeUi.clipboardWrite, invalidClipboardWrite: knowledgeUi.invalidClipboardWrite, clipboardWrites })
  );

  // P0-4: the settings UI must only display state returned by main. A denied
  // request must leave the toggle where it was, and screenshot capture must
  // ask for consent before it invokes the capture channel.
  const securityUiCalls = { requests: [], revokes: [], captures: 0 };
  let terminalGranted = false;
  const capabilityState = () => ({
    terminal: {
      id: 'terminal', granted: terminalGranted, requestable: true,
      risk: 'high', oneShot: false, scope: 'current unlocked session',
    },
    'screen-capture': {
      id: 'screen-capture', granted: false, requestable: true,
      risk: 'high', oneShot: true, scope: 'one screenshot',
    },
  });
  let securityGetCalls = 0;
  ipcMain.removeHandler('security-get');
  ipcMain.handle('security-get', async () => {
    securityGetCalls += 1;
    // The modal's first read is denied-state; a later read demonstrates that
    // the UI follows main when main reports an active grant.
    terminalGranted = securityGetCalls > 1;
    return {
      ok: true,
      state: 'no-lock',
      capabilities: capabilityState(),
      legacy: { detected: false },
    };
  });
  ipcMain.removeHandler('security-request');
  ipcMain.handle('security-request', async (_event, payload = {}) => {
    securityUiCalls.requests.push(payload.capability);
    return {
      ok: false,
      denied: true,
      error: 'Permission denied',
      state: 'no-lock',
      capabilities: capabilityState(),
    };
  });
  ipcMain.removeHandler('security-revoke');
  ipcMain.handle('security-revoke', async (_event, payload = {}) => {
    securityUiCalls.revokes.push(payload);
    terminalGranted = false;
    return { ok: true, state: 'no-lock', capabilities: capabilityState() };
  });
  ipcMain.removeHandler('capture-screen');
  ipcMain.handle('capture-screen', async () => {
    securityUiCalls.captures += 1;
    return {
      ok: true,
      data: Buffer.from('smoke-screen').toString('base64'),
      mimeType: 'image/jpeg',
      source: 'smoke',
    };
  });

  const securityUi = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    document.getElementById('btn-security')?.click();
    await wait(250);
    const modal = document.getElementById('security-modal');
    const terminal = document.getElementById('sec-terminal');
    const initialChecked = Boolean(terminal && terminal.checked);

    terminal.checked = true;
    terminal.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
    const deniedChecked = Boolean(terminal.checked);

    await window.JarvisSec.load();
    window.JarvisSec.render();
    const mainChecked = Boolean(terminal.checked);

    terminal.checked = false;
    terminal.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
    const revokedChecked = Boolean(terminal.checked);

    document.getElementById('screen-capture-btn')?.click();
    await wait(250);
    const screenStatus = document.getElementById('sec-screen-state')?.textContent || '';

    modal?.querySelector('[data-action="closeModal"]')?.click();
    await wait(100);
    return {
      modalOpen: Boolean(modal) && modal.hidden === false,
      initialChecked,
      deniedChecked,
      mainChecked,
      revokedChecked,
      screenStatus,
    };
  })()`);

  check(
    'P0-4 settings reflect main capability state and denied requests revert',
    securityUi.modalOpen === true
      && securityUi.initialChecked === false
      && securityUi.deniedChecked === false
      && securityUi.mainChecked === true
      && securityUi.revokedChecked === false
      && /APPROVAL REQUIRED/.test(securityUi.screenStatus),
    JSON.stringify(securityUi)
  );
  check(
    'P0-4 screenshot requests consent before capture and denial blocks capture',
    securityUiCalls.requests.includes('screen-capture')
      && securityUiCalls.captures === 0
      && securityUiCalls.requests[0] === 'terminal'
      && securityUiCalls.revokes.length >= 1,
    JSON.stringify(securityUiCalls)
  );

  const p0Actions = await win.webContents.executeJavaScript(`(async () => {
    const payloads = [
      '<button data-action="clearActiveDoc">CLOSE</button>',
      '<div><span><button data-change="secToggle" data-arg="terminalEnabled">T</button></span></div>',
      '<svg onload="window.jarvis.close()"><circle /></svg>',
      '<details open ontoggle="window.jarvis.close()">x</details>',
      '<a href="javascript:window.jarvis.close()">JS</a>',
      '<a href="data:text/html,<script>alert(1)<\\/script>">DATA</a>',
      '<a href="file:///C:/Windows/System32/calc.exe">FILE</a>',
      '<img src="x" onerror="window.jarvis.close()">',
      '<iframe src="file:///C:/Windows/System32/calc.exe"></iframe>',
      '<form action="https://example.invalid"><input name="x"><button formaction="https://example.invalid">GO</button></form>',
      '<div id="btn-close" name="jarvis">CLOBBER</div>',
      '<button data-action="jarvisApi.runCommand" data-arg="calc">FAKE API</button>',
      '<a href="https://example.com/doc?q=1" target="_blank" rel="opener">SAFE LINK</a>'
    ];
    const sanitized = payloads.map(payload => window.JarvisSafeHtml.sanitize(payload));
    const probe = document.createElement('div');
    probe.innerHTML = sanitized.join('');
    const blockedAttributes = probe.querySelectorAll(
      '[data-action], [data-change], [data-input], [data-blur], [data-keydown-enter], ' +
      '[data-dragstart], [data-dragend], [onclick], [onload], [onerror], [ontoggle], [style], [id], [name]'
    ).length;
    const blockedTags = probe.querySelectorAll('script, iframe, svg, form, object, embed, img, style').length;
    const unsafeLinks = Array.from(probe.querySelectorAll('a[href]')).filter(link =>
      /^(?:javascript|data|file):/i.test(link.getAttribute('href') || ''));
    const rendered = window.renderMarkdown(
      '<button data-action="clearActiveDoc">MODEL BUTTON</button>' +
      '<a href="javascript:window.jarvis.close()">MODEL LINK</a>'
    );
    const renderedProbe = document.createElement('div');
    renderedProbe.innerHTML = rendered;
    const renderedActions = renderedProbe.querySelectorAll('[data-action]').length;
    const renderedUnsafeLinks = Array.from(renderedProbe.querySelectorAll('a[href]')).filter(link =>
      /^(?:javascript|data|file):/i.test(link.getAttribute('href') || '')).length;

    const activeDocIndicator = document.getElementById('active-doc-indicator');
    activeDocIndicator.style.display = 'flex';

    const trusted = document.createElement('button');
    trusted.setAttribute('data-action', 'clearActiveDoc');
    trusted.textContent = 'TRUSTED CLEAR DOC';
    document.body.appendChild(trusted);
    trusted.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const trustedActionCalls = activeDocIndicator.style.display === 'none' ? 1 : 0;

    activeDocIndicator.style.display = 'flex';
    const untrustedHost = document.createElement('div');
    untrustedHost.className = 'msg-content';
    const injected = document.createElement('button');
    injected.setAttribute('data-action', 'clearActiveDoc');
    injected.textContent = 'INJECTED CLEAR DOC';
    untrustedHost.appendChild(injected);
    document.body.appendChild(untrustedHost);
    injected.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const injectedActionCalls = activeDocIndicator.style.display === 'none' ? 1 : 0;

    const unknown = document.createElement('button');
    unknown.setAttribute('data-action', 'runCodeSafe');
    unknown.textContent = 'UNKNOWN';
    document.body.appendChild(unknown);
    unknown.click();
    await new Promise(resolve => setTimeout(resolve, 20));

    activeDocIndicator.style.display = 'none';
    trusted.remove();
    untrustedHost.remove();
    unknown.remove();

    const modelsModal = document.getElementById('models-modal');
    document.querySelector('[data-action="openModels"]').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const modelsOpened = Boolean(modelsModal) && modelsModal.hidden === false;
    modelsModal?.querySelector('[data-action="closeModal"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 350));
    const modelsClosed = Boolean(modelsModal) && modelsModal.hidden === true;

    const registry = window.jarvisActionRegistry;
    return {
      sanitizedCount: sanitized.length,
      blockedAttributes,
      blockedTags,
      unsafeLinkCount: unsafeLinks.length,
      renderedActions,
      renderedUnsafeLinks,
      trustedActionCalls,
      injectedActionCalls,
      unknownKnown: registry ? registry.has('runCodeSafe') : null,
      knownKnown: registry ? registry.has('clearActiveDoc') : null,
      unknownDispatch: registry ? registry.dispatch('runCodeSafe', []) : null,
      manifestCount: Object.keys(window.JarvisActionManifest || {}).length,
      modelsOpened,
      modelsClosed,
    };
  })()`);

  check(
    'P0-5 untrusted HTML loses actions, handlers, embedded objects, and unsafe links',
    p0Actions.sanitizedCount === 13
      && p0Actions.blockedAttributes === 0
      && p0Actions.blockedTags === 0
      && p0Actions.unsafeLinkCount === 0,
    JSON.stringify(p0Actions)
  );
  check(
    'P0-5 model markdown cannot retain action or unsafe-link payloads',
    p0Actions.renderedActions === 0 && p0Actions.renderedUnsafeLinks === 0,
    JSON.stringify(p0Actions)
  );
  check(
    'P0-5 trusted actions run while injected and unknown actions are denied',
    p0Actions.trustedActionCalls === 1
      && p0Actions.injectedActionCalls === 0
      && p0Actions.unknownKnown === false
      && p0Actions.knownKnown === true
      && p0Actions.unknownDispatch === false
      && p0Actions.manifestCount > 100,
    JSON.stringify(p0Actions)
  );
  check(
    'P0-5 existing modal actions still work through the registry',
    p0Actions.modelsOpened && p0Actions.modelsClosed,
    JSON.stringify(p0Actions)
  );

  const ambientToggle = await win.webContents.executeJavaScript(`(async () => {
    const toggle = document.getElementById('cfg-start-at-login');
    const hidden = document.getElementById('cfg-start-hidden');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 200));
    return {
      checked: toggle.checked,
      hiddenChecked: hidden.checked,
      hiddenDisabled: hidden.disabled,
      disabled: toggle.disabled,
      status: (document.getElementById('ambient-status')?.innerText || '').slice(0, 300),
    };
  })()`);
  check(
    'background presence toggle stays on after a successful apply',
    ambientToggle.checked === true
      && ambientToggle.hiddenChecked === true
      && ambientToggle.hiddenDisabled === false
      && ambientToggle.disabled === false
      && /Auto-start is on and starts hidden/.test(ambientToggle.status)
      && ambientAutoStartCalls.length === 1
      && ambientAutoStartCalls[0].enabled === true
      && ambientAutoStartCalls[0].startHidden === true,
    JSON.stringify({ ambientToggle, ambientAutoStartCalls })
  );

  const hiddenOverride = await win.webContents.executeJavaScript(`(async () => {
    const hidden = document.getElementById('cfg-start-hidden');
    hidden.checked = false;
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 200));
    return {
      hiddenChecked: hidden.checked,
      status: (document.getElementById('ambient-status')?.innerText || '').slice(0, 300),
    };
  })()`);
  check(
    'start-hidden override can be disabled for login launches',
    hiddenOverride.hiddenChecked === false
      && /Auto-start is on/.test(hiddenOverride.status)
      && !/starts hidden/.test(hiddenOverride.status)
      && ambientAutoStartCalls.length === 2
      && ambientAutoStartCalls[1].enabled === true
      && ambientAutoStartCalls[1].startHidden === false,
    JSON.stringify({ hiddenOverride, ambientAutoStartCalls })
  );
  check(
    'legacy renderer task loop is not loaded',
    boot.legacyTaskController === 'undefined'
      && boot.legacyTaskControllerExecute === 'undefined'
      && boot.legacyToolExecutor === 'undefined'
      && boot.legacySkillsRun === 'undefined'
      && boot.legacyAgentStart === 'undefined',
    JSON.stringify(boot)
  );
  check('scheduler modal starts below the titlebar', Math.abs(boot.schedulerModal.top - boot.schedulerModal.titlebar) < 1 && boot.schedulerModal.headerHeight > 0, JSON.stringify(boot.schedulerModal));
  check('scheduler add button is visible', boot.schedulerModal.addButtonWidth > 40 && boot.schedulerModal.addButtonBackground !== 'rgba(0, 0, 0, 0)', JSON.stringify(boot.schedulerModal));
  check('scheduler form pre-fills a future trigger', boot.schedulerForm.dateFuture, JSON.stringify(boot.schedulerForm));
  check('scheduler recurring field stays hidden for one-off', boot.schedulerForm.recurringHidden && boot.schedulerForm.oneOffVisible, JSON.stringify(boot.schedulerForm));

  const monitor = await win.webContents.executeJavaScript(`(async () => {
    window.state.deepWorkEnabled = false;
    await window.sendMessage('observe the gpu 1 usage, dedicated memory for 30sec');
    return {
      text: document.getElementById('chat-messages').innerText,
      streaming: window.state.isStreaming,
      sendDisabled: document.getElementById('send-btn').disabled,
    };
  })()`);
  check(
    'FAST hands live monitoring to the durable DEEP WORK agent',
    /DEEP WORK/.test(monitor.text) && /durable agent/i.test(monitor.text),
    JSON.stringify(monitor)
  );
  check(
    'FAST does not fabricate a monitoring table',
    !/RAM usage —|GPU utilization|Dedicated memory:|Average used/.test(monitor.text),
    JSON.stringify(monitor)
  );
  check('chat returns to idle after the monitoring handoff', monitor.streaming === false && monitor.sendDisabled === false, JSON.stringify(monitor));

  const fast = await win.webContents.executeJavaScript(`(async () => {
    window.state.deepWorkEnabled = false;
    window.state.ollamaOnline = true;
    await window.sendMessage('hello in FAST mode');
    await new Promise(resolve => setTimeout(resolve, 250));
    return {
      text: document.getElementById('chat-messages').innerText,
      streaming: window.state.isStreaming,
      sendDisabled: document.getElementById('send-btn').disabled,
    };
  })()`);
  check(
    'FAST direct-chat streaming path still works',
    /FAST smoke reply/.test(fast.text) && fast.streaming === false && fast.sendDisabled === false,
    JSON.stringify(fast)
  );

  const modelSelection = await win.webContents.executeJavaScript(`({
    preferred: window.JarvisModelSelection?.pickChatModel([
      { name: 'all-minilm:latest' },
      { name: 'phi3:mini' },
      { name: 'llama3.1:8b' },
    ]),
    onlyEmbedding: window.JarvisModelSelection?.pickChatModel([
      { name: 'all-minilm:latest' },
      { name: 'nomic-embed-text:latest' },
    ]),
    fallbackChat: window.JarvisModelSelection?.pickChatModel([
      { name: 'nomic-embed-text:latest' },
      { name: 'phi3:mini' },
    ]),
    embeddingFlag: window.JarvisModelSelection?.isEmbeddingModel('nomic-embed-text:latest'),
    chatFlag: window.JarvisModelSelection?.isEmbeddingModel('llama3.1:8b'),
  })`);
  check(
    'model picker prefers llama3.1 and skips embedding-only models',
    modelSelection.preferred === 'llama3.1:8b'
      && modelSelection.onlyEmbedding === null
      && modelSelection.fallbackChat === 'phi3:mini'
      && modelSelection.embeddingFlag === true
      && modelSelection.chatFlag === false,
    JSON.stringify(modelSelection)
  );

  const streamAwait = await win.webContents.executeJavaScript(`(async () => {
    window.state.deepWorkEnabled = false;
    window.state.ollamaOnline = true;
    const pending = window.sendMessage('hello delayed FAST mode');
    await new Promise(resolve => setTimeout(resolve, 100));
    const during = window.state.isStreaming;
    await pending;
    const messages = window.state.conversations[window.state.mode].messages;
    const last = messages[messages.length - 1];
    return {
      during,
      after: window.state.isStreaming,
      assistant: last?.role,
      text: String(last?.content || ''),
    };
  })()`);
  const lastSave = historySaves[historySaves.length - 1];
  check(
    'FAST keeps streaming state and saves the completed assistant reply',
    streamAwait.during === true
      && streamAwait.after === false
      && streamAwait.assistant === 'assistant'
      && /FAST smoke reply/.test(streamAwait.text)
      && lastSave?.data?.messages?.at(-1)?.role === 'assistant'
      && /FAST smoke reply/.test(String(lastSave?.data?.messages?.at(-1)?.content || '')),
    JSON.stringify({ streamAwait, lastSave })
  );

  const referenced = consoleLines.filter(line =>
    /dashProductivity is not defined|WakeWord is not defined/.test(line));
  check('no dangling dashboard/wake references', referenced.length === 0, JSON.stringify(referenced));

  await win.webContents.executeJavaScript(`document.getElementById('mode-btn-productivity').click()`);
  await wait(400);

  const prod = await win.webContents.executeJavaScript(`({
    prodRendered: Boolean(document.querySelector('#dashboard-area .dash-prod')),
    pomoCanvas: Boolean(document.getElementById('pomo-canvas')),
    pomoTime: document.getElementById('pomo-time')?.textContent || '',
    tasksList: Boolean(document.getElementById('tasks-list')),
    tbList: Boolean(document.getElementById('tb-list')),
  })`);

  check('productivity dashboard renders', prod.prodRendered, JSON.stringify(prod));
  check('pomodoro canvas is mounted', prod.pomoCanvas, JSON.stringify(prod));
  check('pomodoro display is initialized', prod.pomoTime === '25:00', JSON.stringify(prod));
  check('task list is mounted', prod.tasksList, JSON.stringify(prod));
  check('time blocks list is mounted', prod.tbList, JSON.stringify(prod));

  console.log('PASS — renderer boot smoke checks');
  finish(0);
}).catch(error => {
  console.error('FAIL', error);
  finish(1);
});
