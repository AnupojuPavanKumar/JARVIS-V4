const path = require('path');
const os = require('os');
const fs = require('fs');

// HIGH-02 fix: allowlist for session identifiers.
// Only alphanumeric + dash + underscore, max 64 chars.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: 'Invalid session ID format' };
  }
  const reserved = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;
  if (reserved.test(sessionId)) {
    return { ok: false, error: 'Reserved session ID' };
  }
  return { ok: true };
}

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
    if (!this.histDir) return { ok: false, error: 'Memory not initialized' };
    const v = validateSessionId(sessionId);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      const fp = path.resolve(this.histDir, `${sessionId}.json`);
      // Double-check the resolved path is inside histDir (defence-in-depth)
      const histDirReal = path.resolve(this.histDir);
      if (!fp.startsWith(histDirReal + path.sep) && fp !== histDirReal) {
        return { ok: false, error: 'Write refused: path escapes history directory' };
      }
      await fs.promises.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async loadSession(sessionId) {
    if (!this.histDir) return { ok: false, error: 'Memory not initialized', data: null };
    const v = validateSessionId(sessionId);
    if (!v.ok) return { ok: false, error: v.error, data: null };
    try {
      const fp = path.resolve(this.histDir, `${sessionId}.json`);
      const histDirReal = path.resolve(this.histDir);
      if (!fp.startsWith(histDirReal + path.sep) && fp !== histDirReal) {
        return { ok: false, error: 'Read refused: path escapes history directory', data: null };
      }
      try { await fs.promises.access(fp); } catch { return { ok: true, data: null }; }
      const content = await fs.promises.readFile(fp, 'utf8');
      const data = JSON.parse(content);

      return { ok: true, data };
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
    if (!this.histDir) return { ok: false, error: 'Memory not initialized' };
    const v = validateSessionId(sessionId);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      const fp = path.resolve(this.histDir, `${sessionId}.json`);
      const histDirReal = path.resolve(this.histDir);
      if (!fp.startsWith(histDirReal + path.sep) && fp !== histDirReal) {
        return { ok: false, error: 'Delete refused: path escapes history directory' };
      }
      try { await fs.promises.unlink(fp); } catch {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async embedText(text) {
    try {
      // Use built-in fetch if available (Node 18+ / Electron)
      let embeddingModel = 'all-minilm';
      try {
        const fp = require('path').join(require('electron').app.getPath('userData'), 'app-config.json');
        if (require('fs').existsSync(fp)) {
          const cfg = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
          if (cfg.embeddingModel) embeddingModel = cfg.embeddingModel;
        }
      } catch (e) {}

      const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, prompt: text })
      });
      const data = await res.json();
      if (data && data.embedding) {
        return data.embedding; // plain number array
      } else {
        console.error('[MAIN] embedText: no embedding in response', data);
      }
      return null;
    } catch (e) {
      console.error('[MAIN] embedText error:', e);
      return null;
    }
  }
}

module.exports = new JarvisMemory();
