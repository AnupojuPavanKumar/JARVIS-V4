const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

module.exports = function registerKnowledgeController({ ipcMain, app, secAudit, secCheckRate }) {
  
  // ─── Snippets Persistence ────────────────────────────────────────
  const snippetsFile = () => path.join(app.getPath('userData'), 'snippets.json');
  
  ipcMain.handle('snippets-load', async () => {
    try {
      const fp = snippetsFile();
      if (!fs.existsSync(fp)) return { ok: true, data: [] };
      return { ok: true, data: JSON.parse(await fs.promises.readFile(fp, 'utf8')) };
    } catch (e) { return { ok: false, data: [] }; }
  });
  ipcMain.handle('snippets-save', async (_, data) => {
    try { await fs.promises.writeFile(snippetsFile(), JSON.stringify(data, null, 2)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  
  // ─── Prompts Library Persistence ────────────────────────────────
  const promptsFile = () => path.join(app.getPath('userData'), 'prompts.json');
  ipcMain.handle('prompts-load', async () => {
    try {
      const fp = promptsFile();
      if (!fs.existsSync(fp)) return { ok: true, data: [] };
      return { ok: true, data: JSON.parse(await fs.promises.readFile(fp, 'utf8')) };
    } catch (e) { return { ok: false, data: [] }; }
  });
  ipcMain.handle('prompts-save', async (_, data) => {
    try { await fs.promises.writeFile(promptsFile(), JSON.stringify(data, null, 2)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  
  // ─── Notes Scratchpad Persistence ───────────────────────────────
  const notesFile = () => path.join(app.getPath('userData'), 'notes.md');
  ipcMain.handle('notes-load', async () => {
    try {
      const fp = notesFile();
      if (!fs.existsSync(fp)) return { ok: true, data: '' };
      return { ok: true, data: await fs.promises.readFile(fp, 'utf8') };
    } catch (e) { return { ok: false, data: '' }; }
  });
  ipcMain.handle('notes-save', async (_, content) => {
    try { await fs.promises.writeFile(notesFile(), content, 'utf8'); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  
  // =======================================================================
  // SKILLS SYSTEM IPC
  // =======================================================================
  
  const skillsDir = path.join(__dirname, '../../skills');
  
  const SKILLS_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQi/+EtNe7DXn4P7c/wiL20qmqVK2yWxRYOuOyLs0VAU=
-----END PUBLIC KEY-----`;
  
  let _skillsPubKey = null;
  try {
    const { createPublicKey } = require('crypto');
    _skillsPubKey = createPublicKey(SKILLS_PUBLIC_KEY_PEM);
  } catch (_) { _skillsPubKey = null; }
  
  function verifyManifestSignature(manifestRaw, sigRaw) {
    if (!_skillsPubKey) return { ok: false, reason: 'public-key unavailable' };
    try {
      const { verify } = require('crypto');
      const ok = verify(
        null,
        Buffer.from(manifestRaw),
        _skillsPubKey,
        Buffer.from(sigRaw)
      );
      return { ok };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  
  async function loadVerifiedSkillsManifest() {
    const manifestPath = path.join(skillsDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { ok: true, skills: [], manifestRaw: '' };
    const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
  
    const sigPath = path.join(skillsDir, 'manifest.sig');
    if (!fs.existsSync(sigPath)) {
      return { ok: false, error: 'Skills manifest has no signature file (manifest.sig). Refusing to load skills.' };
    }
    const sigRaw = await fs.promises.readFile(sigPath);
    const v = verifyManifestSignature(manifestRaw, sigRaw);
    if (!v.ok) {
      return { ok: false, error: 'Skills manifest signature invalid. Refusing to load skills.' };
    }
  
    const manifest = JSON.parse(manifestRaw);
    return { ok: true, skills: manifest.skills || [], manifestRaw };
  }
  
  ipcMain.handle('skills-list', async () => {
    try {
      const res = await loadVerifiedSkillsManifest();
      if (!res.ok) return { ok: false, error: res.error, skills: [] };
      return { ok: true, skills: res.skills };
    } catch (e) { return { ok: false, error: e.message, skills: [] }; }
  });
  
  ipcMain.handle('skills-run', async (_, skillId, args) => {
    const start = Date.now();
    if (!secCheckRate('skillRun', 20)) {
      return { ok: false, error: 'Rate limit exceeded', elapsed: Date.now() - start };
    }
    if (!args) args = {};
    try {
      const load = await loadVerifiedSkillsManifest();
      if (!load.ok) return { ok: false, error: load.error, elapsed: Date.now() - start };
      const skill = (load.skills || []).find(function (s) { return s.id === skillId; });
      if (!skill) return { ok: false, error: 'Skill not found: ' + skillId, elapsed: Date.now() - start };
  
      let scriptPath, realSkillsRoot;
      try {
        scriptPath = fs.realpathSync(path.resolve(skillsDir, skill.script));
        realSkillsRoot = fs.realpathSync(path.resolve(skillsDir)) + path.sep;
      } catch {
        return { ok: false, error: 'Skill script path could not be resolved.', elapsed: Date.now() - start };
      }
      if (!scriptPath.startsWith(realSkillsRoot)) {
        return { ok: false, error: 'Skill script path escapes skills directory.', elapsed: Date.now() - start };
      }
  
      if (!fs.existsSync(scriptPath)) return { ok: false, error: 'Script not found: ' + skill.script, elapsed: Date.now() - start };
  
      const argsStr = JSON.stringify(args);
      const runner = skill.type === 'js' ? 'node' : 'python';
      secAudit('SKILL_RUN', `${skillId} (${argsStr.length} bytes)`, 'ALLOWED');
  
      return await new Promise(function (resolve) {
        const child = spawn(runner, [scriptPath, argsStr], {
          shell: false,
          windowsHide: true,
        });
  
        let stdoutBuf = '', stderrBuf = '';
  
        child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });
        child.stderr.on('data', (chunk) => { stderrBuf += chunk; });
  
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) { }
        }, 10000);
  
        child.on('error', (err) => {
          clearTimeout(timer);
          const elapsed = Date.now() - start;
          resolve({ ok: false, skill: skillId, data: { stdout: stdoutBuf, stderr: stderrBuf }, elapsed, error: err.message });
        });
  
        child.on('close', (code) => {
          clearTimeout(timer);
          const elapsed = Date.now() - start;
          try {
            const p = JSON.parse(stdoutBuf.trim());
            resolve(Object.assign({ ok: true }, p, { elapsed }));
          } catch (_) {
            resolve({ ok: code === 0, skill: skillId, data: { stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() }, elapsed, error: code !== 0 ? `exit ${code}` : null });
          }
        });
      });
    } catch (e) { return { ok: false, error: e.message, elapsed: Date.now() - start }; }
  });

};
