'use strict';

/**
 * Frozen interaction manifest for the trusted renderer UI.
 *
 * Every element carrying a data-action / data-change / data-input / data-blur /
 * data-keydown-enter / data-drag* / data-drop attribute must name an entry here.
 * IDs are simple identifiers; dots and dynamic property traversal are not
 * supported. `args` is a compact argument schema consumed by
 * renderer/action-registry.js. `custom: true` means renderer.js supplies the
 * handler; otherwise the handler is the window function named by `global`
 * (defaults to the action ID).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JarvisActionManifest = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const spec = (args = '', options = {}) => Object.freeze({ args, ...options });
  const manifest = {
    // General controls
    cancelStream: spec(),
    closeCmdPalette: spec(),
    closeHamburger: spec(),
    closeModal: spec('s'),
    closeShortcuts: spec(),
    confirmPowerOff: spec(),
    executePowerOff: spec(),
    newSession: spec(),
    quickAction: spec('s'),
    toggleDeepWork: spec(),
    toggleHamburger: spec(),
    toggleWakeWord: spec(),
    windowMinimize: spec('', { custom: true }),
    windowMaximize: spec('', { custom: true }),
    windowClose: spec('', { custom: true }),
    openExternalLink: spec('S', { custom: true }),

    // Authentication and settings
    openChangePinModal: spec(),
    submitChangePin: spec(),
    openDiagnosticsModal: spec(),
    refreshDiagnostics: spec(),
    openSchedulerModal: spec(),
    renderSchedulerJobs: spec(),
    addSchedulerJob: spec(),
    deleteSchedulerJob: spec('s'),
    saveSchedulerSettings: spec(),
    toggleSchedulerAddForm: spec(),
    toggleSchedulerType: spec('', { custom: true }),
    syncSchedulerRecurringMode: spec(),
    refreshSecAudit: spec(),
    secToggle: spec('es'),

    // Models and chat
    openModels: spec('', { custom: true }),
    quickSwitchModel: spec('s'),
    selectModelAndClose: spec('s', { custom: true }),
    saveSettings: spec(),
    resetSettings: spec(),
    setFontSize: spec('s'),
    applyTheme: spec('s', { custom: true }),
    exportChat: spec(),
    exportChatAndClose: spec('', { custom: true }),
    clearCurrentChat: spec(),
    togglePromptAddForm: spec(),
    injectPrompt: spec('S'),

    // Documents and memory
    openDocUpload: spec('', { custom: true }),
    clearActiveDoc: spec('', { custom: true }),
    openMemoryModal: spec('', { custom: true }),
    memoryAdd: spec(),
    memoryClear: spec(),
    memoryDelete: spec('s'),
    memoryEdit: spec('s'),
    memoryExport: spec(),
    memoryRefresh: spec(),
    memoryToggle: spec('s'),

    // Terminal and project actions
    openTerminalAndClose: spec('', { custom: true }),
    clearTerminal: spec(),
    loadProject: spec(),
    clearProjectAndClose: spec('', { custom: true }),
    executeGitConfirm: spec('s'),
    gitAction: spec('s'),

    // Code, automation, and dashboards (review only; never executes code)
    clearDashCode: spec(),
    reviewWithJarvis: spec(),
    explainWithJarvis: spec(),
    optimizeWithJarvis: spec(),
    loadCodeTemplate: spec('S'),
    onCodeLangChange: spec(),
    clearAutoScript: spec(),
    generateAutoScript: spec(),
    scheduleScript: spec(),
    loadAutoTemplate: spec('sS'),
    copyCodeBlock: spec('e', { custom: true }),
    analyzeError: spec(),
    clearErrorInput: spec(),
    debugPattern: spec('s'),
    analyzeSystem: spec(),
    refreshProcesses: spec(),
    analyzeImage: spec(),
    pickImage: spec(),
    clearImg: spec(),

    // Productivity dashboard
    addGoal: spec(),
    askGoalsJarvis: spec(),
    bizAsk: spec('s'),
    analyzeSwot: spec(),
    saveSwot: spec(),
    deleteGoal: spec('i'),
    toggleGoal: spec('i'),
    fullBizAnalysis: spec(),
    addTask: spec(),
    clearDoneTasks: spec(),
    deleteTask: spec('i'),
    toggleTask: spec('i'),
    prioritizeWithJarvis: spec(),
    planWithJarvis: spec(),
    addTimeBlock: spec(),
    clearTBs: spec(),
    deleteTB: spec('i'),
    toggleTB: spec('i'),
    startPomodoro: spec(),
    resetPomodoro: spec(),
    skipPhase: spec(),
    kanbanAddCard: spec('s'),
    kanbanDeleteCard: spec('si'),
    kanbanDragStart: spec('esi'),
    kanbanDragEnd: spec('e'),
    kanbanDragOver: spec('e'),
    kanbanDragLeave: spec('e'),
    kanbanDrop: spec('es'),
    saveKPI: spec('is'),
    updateKPIProg: spec('is'),

    // Research and notes
    startResearch: spec(),
    generateOutline: spec(),
    findSources: spec(),
    clearResearchNotes: spec(),
    sendNotesToJarvis: spec(),
    addOutlineItem: spec(),
    removeOutlineItem: spec('i'),
    clearOutline: spec(),
    generateQuestions: spec(),
    addQuestion: spec(),
    removeQuestion: spec('i'),
    clearQuestions: spec(),
    notesInsert: spec('s'),
    updateNotesStatus: spec('s'),
    saveNotes: spec(),

    // Prompts, snippets, and formula helper
    usePrompt: spec('s'),
    deletePrompt: spec('s'),
    saveNewPrompt: spec(),
    renderPrompts: spec('s'),
    useSnippet: spec('s'),
    copySnip: spec('s'),
    deleteSnippet: spec('s'),
    saveNewSnippet: spec(),
    renderSnippets: spec('s'),
    toggleSnipAddForm: spec(),
    calcPress: spec('s'),

    // History
    deleteSession: spec('se', { custom: true }),

    // Generic API panel
    sendApiRequest: spec(),
    switchApiTab: spec('s'),

    // Creative dashboard
    generateCreative: spec(),
    improveCreative: spec(),
    sparkIdea: spec(),
    copyCreative: spec(),
    clearCreative: spec(),
    updateWordCount: spec('s'),
    closeChatSearch: spec(),

    // Command palette result selection
    runCmdItem: spec('i'),
  };
  for (const [id, entry] of Object.entries(manifest)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(id)) {
      throw new Error(`Invalid action identifier in manifest: ${id}`);
    }
    if (entry.global && !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(entry.global)) {
      throw new Error(`Invalid global handler name for ${id}`);
    }
  }
  return Object.freeze(manifest);
});
