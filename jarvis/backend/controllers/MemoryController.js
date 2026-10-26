'use strict';

const {
  MEMORY_TYPES,
  SENSITIVITY_LEVELS,
  isValidMemoryId,
} = require('../../core/memory/memory-schema');

function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

module.exports = function registerMemoryController({
  ipcMain,
  app,
  JarvisMemory,
  MemoryStore = null,
  MemoryStoreProvider = null,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerMemoryController requires ipcMain');
  }

  function resolveStore() {
    return typeof MemoryStoreProvider === 'function' ? MemoryStoreProvider() : MemoryStore;
  }

  function requireStore() {
    const store = resolveStore();
    if (!store || typeof store.list !== 'function') {
      throw new Error('Unified memory store is unavailable');
    }
    return store;
  }

  // ─── Conversation history (separate from learned memory) ────────────────
  ipcMain.handle('history-save', async (_, sessionId, data) => {
    return JarvisMemory.saveSession(sessionId, data);
  });

  ipcMain.handle('history-load', async (_, sessionId) => {
    return JarvisMemory.loadSession(sessionId);
  });

  ipcMain.handle('history-list', async () => {
    return JarvisMemory.listSessions();
  });

  ipcMain.handle('history-delete', async (_, sessionId) => {
    return JarvisMemory.deleteSession(sessionId);
  });

  // ─── Memory records ─────────────────────────────────────────────────────
  ipcMain.handle('memory-load', async () => {
    try {
      const memory = requireStore();
      const records = await memory.list({ includeDisabled: true });
      return {
        ok: true,
        records,
        // Backwards-compatible field for older renderer builds. The active
        // renderer uses the record API and never writes through this field.
        facts: records.map(record => record.text),
        stats: memory.stats(),
      };
    } catch (error) {
      return { ...failure(error), records: [], facts: [] };
    }
  });

  // Compatibility for pre-Phase-2 renderer builds. This imports into the one
  // store rather than replacing it, so it cannot create a competing writer.
  ipcMain.handle('memory-save', async (_, facts) => {
    try {
      const memory = requireStore();
      if (!Array.isArray(facts)) return { ok: false, error: 'Memory import must be an array' };
      const result = await memory.import(facts.map(fact => (
        typeof fact === 'string'
          ? { text: fact, source: { kind: 'manual', legacy: true } }
          : { ...fact, source: fact.source || { kind: 'manual', legacy: true } }
      )));
      return { ok: true, imported: result.imported, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-add', async (_, input, options = {}) => {
    try {
      const memory = requireStore();
      const text = typeof input === 'string' ? input : input?.text;
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Memory text is required' };
      const type = options.type || input?.type;
      if (type && !MEMORY_TYPES.includes(type)) return { ok: false, error: `Unknown memory type: ${type}` };
      const sensitivity = options.sensitivity || input?.sensitivity;
      if (sensitivity && !SENSITIVITY_LEVELS.includes(sensitivity)) {
        return { ok: false, error: `Unknown sensitivity: ${sensitivity}` };
      }
      const record = await memory.addManual({
        ...(typeof input === 'string' ? { text } : input),
        text,
        ...(type ? { type } : {}),
        ...(sensitivity ? { sensitivity } : {}),
      }, { type, sensitivity });
      return { ok: true, record, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-update', async (_, id, patch = {}) => {
    try {
      const memory = requireStore();
      if (!isValidMemoryId(id)) return { ok: false, error: 'Invalid memory id' };
      const record = await memory.update(id, patch);
      if (!record) return { ok: false, error: 'Memory not found' };
      return { ok: true, record, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-delete', async (_, id) => {
    try {
      const memory = requireStore();
      if (!isValidMemoryId(id)) return { ok: false, error: 'Invalid memory id' };
      const deleted = await memory.delete(id);
      return { ok: true, deleted, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-disable', async (_, id, disabled) => {
    try {
      const memory = requireStore();
      if (!isValidMemoryId(id)) return { ok: false, error: 'Invalid memory id' };
      const record = await memory.setDisabled(id, disabled === true);
      if (!record) return { ok: false, error: 'Memory not found' };
      return { ok: true, record, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-clear', async (_, options = {}) => {
    try {
      const memory = requireStore();
      const result = await memory.clear({ confirm: options?.confirm });
      return { ...result, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-export', async () => {
    try {
      const memory = requireStore();
      const json = await memory.export({ format: 'json' });
      return { ok: true, json, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-retrieve', async (_, query, options = {}) => {
    try {
      const memory = requireStore();
      const result = await memory.retrieve(query, {
        maxRecords: options?.maxRecords,
        maxChars: options?.maxChars,
        allowPersonal: options?.allowPersonal === true,
      });
      return {
        ok: true,
        context: result.context,
        records: result.records,
        chars: result.chars,
        budget: result.budget,
      };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-record-conversation', async (_, payload = {}) => {
    try {
      const memory = requireStore();
      if (!Array.isArray(payload.messages)) {
        return { ok: false, error: 'messages must be an array' };
      }
      const result = await memory.recordConversation({
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId.slice(0, 160) : null,
        messages: payload.messages.slice(-80),
      });
      return { ok: true, ...result, stats: memory.stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('memory-stats', async () => {
    try {
      return { ok: true, ...requireStore().stats() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('embed-text', async (_, text) => {
    return await JarvisMemory.embedText(text);
  });

  return {
    getStore: resolveStore,
  };
};
