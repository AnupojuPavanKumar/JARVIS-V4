const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { validateArgs, AgentTaskStore, authorize } = require('../../agent-policy');

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
MCowBQYDK2VwAyEADeCN7rDcMvMG0eMeWcEs6HGhpa24JSSDiycp4ne0YiE=
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
      const ok = verify(null, Buffer.from(manifestRaw), _skillsPubKey, Buffer.from(sigRaw));
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

  // ─── Task store (delegated to agent-policy) ────────────────────
  const taskStore = new AgentTaskStore(); // stepCap=8, ttl=30min
  const STDOUT_CAP_BYTES = 64 * 1024;    // 64 KB

  // ─── confirmFn: wraps Electron dialog for main-process use ─────
  async function confirmFn(skill, args, risk, tainted) {
    const { dialog } = require('electron');
    const taintedNote = tainted
      ? '\n\n⚠️  This task previously ran an untrusted (external-data) skill.'
      : '';
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: 'JARVIS — Skill Permission',
      message: `Allow "${skill.name}"?`,
      detail: `Risk level: ${risk.toUpperCase()}\nSkill ID: ${skill.id}\nArgs: ${JSON.stringify(args)}${taintedNote}\n\nThis action cannot be undone if destructive.`,
    });
    return response === 0; // 0 = Allow
  }

  // ─── agent-start: mint a new 128-bit task token ────────────────
  ipcMain.handle('agent-start', async () => {
    const taskId = taskStore.mintTaskId();
    secAudit('AGENT_START', taskId, 'MINTED');
    return { ok: true, taskId };
  });

  // ─── agent-abort: mark a task as aborted ──────────────────────
  ipcMain.handle('agent-abort', async (_, taskId) => {
    const result = taskStore.abort(taskId);
    if (result.ok) {
      secAudit('AGENT_ABORT', String(taskId), 'ABORTED');
    } else {
      secAudit('AGENT_ABORT', String(taskId), `DENY - ${result.error}`);
    }
    return result;
  });

  // ─── skills-run IPC handler ────────────────────────────────────
  ipcMain.handle('skills-run', async (_, skillId, args, taskId) => {
    const start = Date.now();

    // ── rate limit ──
    if (!secCheckRate('skillRun', 20)) {
      secAudit('SKILL_RUN', `${skillId} task=${taskId}`, 'DENY - rate limit');
      return { ok: false, error: 'Rate limit exceeded', elapsed: Date.now() - start };
    }

    if (!args) args = {};

    try {
      const load = await loadVerifiedSkillsManifest();
      if (!load.ok) return { ok: false, error: load.error, elapsed: Date.now() - start };

      const skill = (load.skills || []).find(s => s.id === skillId);
      if (!skill) return { ok: false, error: 'Skill not found: ' + skillId, elapsed: Date.now() - start };

      // ── arg validation ──
      const argError = validateArgs(skill, args);
      if (argError) {
        secAudit('SKILL_RUN', `${skillId} task=${taskId}`, `DENY - ${argError}`);
        return { ok: false, error: argError, elapsed: Date.now() - start };
      }

      // ── policy decision (task state + risk + taint + confirm) ──
      const decision = await authorize({ skill, args, taskId, store: taskStore, confirmFn });
      if (!decision.ok) {
        secAudit('SKILL_RUN', `${skillId} task=${taskId}`, `DENY - ${decision.deny}`);
        return { ok: false, error: decision.error, elapsed: Date.now() - start };
      }

      // ── path sandboxing ──
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

      if (!fs.existsSync(scriptPath)) {
        return { ok: false, error: 'Script not found: ' + skill.script, elapsed: Date.now() - start };
      }

      // Mark task tainted after an untrusted skill runs
      // (authorize already sets it on known tasks; this is redundant safety for
      //  the throwaway path where skill.untrusted and taskRec is ephemeral)
      const argsStr = JSON.stringify(args);
      const runner = skill.type === 'js' ? 'node' : 'python';
      secAudit('SKILL_RUN', `${skillId} task=${taskId} risk=${skill.risk || 'read'} untrusted=${!!skill.untrusted} (${argsStr.length} bytes)`, 'ALLOWED');

      return await new Promise(function (resolve) {
        const child = spawn(runner, [scriptPath, argsStr], {
          shell: false,
          windowsHide: true,
        });

        let stdoutBuf = '', stderrBuf = '';
        let stdoutTruncated = false;

        child.stdout.on('data', (chunk) => {
          if (stdoutBuf.length < STDOUT_CAP_BYTES) {
            stdoutBuf += chunk;
            if (stdoutBuf.length >= STDOUT_CAP_BYTES) {
              stdoutBuf = stdoutBuf.slice(0, STDOUT_CAP_BYTES);
              stdoutTruncated = true;
              try { child.kill('SIGKILL'); } catch (_) { }
            }
          }
        });
        child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) { }
        }, 10000);

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, skill: skillId, data: { stdout: stdoutBuf, stderr: stderrBuf }, elapsed: Date.now() - start, error: err.message });
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          const elapsed = Date.now() - start;
          if (stdoutTruncated) {
            secAudit('SKILL_RUN', `${skillId} task=${taskId}`, 'WARN - stdout truncated at 64KB');
          }
          try {
            const p = JSON.parse(stdoutBuf.trim());
            resolve(Object.assign({ ok: true }, p, { elapsed, _stdoutTruncated: stdoutTruncated || undefined }));
          } catch (_) {
            resolve({ ok: code === 0, skill: skillId, data: { stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() }, elapsed, error: code !== 0 ? `exit ${code}` : null, _stdoutTruncated: stdoutTruncated || undefined });
          }
        });
      });
    } catch (e) { return { ok: false, error: e.message, elapsed: Date.now() - start }; }
  });

};
