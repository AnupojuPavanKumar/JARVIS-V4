const path = require('path');
const fs = require('fs');

module.exports = function registerMemoryController({ ipcMain, app, JarvisMemory }) {
  
  // ─── History ─────────────────────────────────────────────────────
  
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

  // ─── Persistent Memory ────────────────────────────────────────────
  const memoryFile = () => path.join(app.getPath('userData'), 'memory.json');
  const memoryFileTmp = () => memoryFile() + '.tmp';
  const memoryFileBak = () => memoryFile() + '.bak';
  
  ipcMain.handle('memory-load', async () => {
    const fp = memoryFile();
    const bak = memoryFileBak();
    // Try primary file, fall back to .bak on corruption
    for (const candidate of [fp, bak]) {
      try {
        const raw = await fs.promises.readFile(candidate, 'utf8');
        const facts = JSON.parse(raw);
        if (Array.isArray(facts)) return { ok: true, facts };
      } catch { /* try next */ }
    }
    return { ok: true, facts: [] };
  });
  
  ipcMain.handle('embed-text', async (_, text) => {
    return await JarvisMemory.embedText(text);
  });
  
  ipcMain.handle('memory-save', async (_, facts) => {
    // ponytail: atomic write — tmp → bak → rename; prevents corruption on crash
    const fp = memoryFile();
    const tmp = memoryFileTmp();
    const bak = memoryFileBak();
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(facts, null, 2));
      // rotate: current → .bak
      try { await fs.promises.rename(fp, bak); } catch { /* first save, no existing file */ }
      await fs.promises.rename(tmp, fp);
      return { ok: true };
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch { }
      return { ok: false, error: e.message };
    }
  });

};
