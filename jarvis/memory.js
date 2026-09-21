const path = require('path');
const os = require('os');
const fs = require('fs');

class JarvisMemory {
  constructor() {
    this.histDir = null;
  }

  init(userDataPath) {
    this.histDir = path.join(userDataPath, 'history');
    if (!fs.existsSync(this.histDir)) {
      fs.mkdirSync(this.histDir, { recursive: true });
    }
    console.log('[MAIN] JARVIS Memory (JSON Fallback Engine) initialized successfully.');
  }

  async saveSession(sessionId, data) {
    if (!this.histDir) return { ok: false, error: "Memory not initialized" };
    try {
      const fp = path.join(this.histDir, `${sessionId}.json`);
      await fs.promises.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async loadSession(sessionId) {
    if (!this.histDir) return { ok: false, error: "Memory not initialized", data: null };
    try {
      const fp = path.join(this.histDir, `${sessionId}.json`);
      try { await fs.promises.access(fp); } catch { return { ok: true, data: null }; }
      const content = await fs.promises.readFile(fp, 'utf8');
      return { ok: true, data: JSON.parse(content) };
    } catch (e) {
      return { ok: false, error: e.message, data: null };
    }
  }

  async listSessions() {
    if (!this.histDir) return { ok: false, error: "Memory not initialized", data: [] };
    try {
      try { await fs.promises.access(this.histDir); } catch { return { ok: true, data: [] }; }
      const files = await fs.promises.readdir(this.histDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      const sessions = (await Promise.all(jsonFiles.map(async f => {
        try {
          const fp = path.join(this.histDir, f);
          const stats = await fs.promises.stat(fp);
          const content = await fs.promises.readFile(fp, 'utf8');
          const data = JSON.parse(content);
          return {
            id:           f.replace('.json', ''),
            title:        data.title || 'Untitled Session',
            mode:         data.mode  || 'general',
            messageCount: data.messages?.length || 0,
            updatedAt:    stats.mtime.toISOString(),
          };
        } catch { return null; }
      }))).filter(Boolean);
      
      sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return { ok: true, data: sessions };
    } catch (e) {
      return { ok: false, error: e.message, data: [] };
    }
  }

  async deleteSession(sessionId) {
    if (!this.histDir) return { ok: false, error: "Memory not initialized" };
    try {
      const fp = path.join(this.histDir, `${sessionId}.json`);
      try { await fs.promises.unlink(fp); } catch {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = new JarvisMemory();
