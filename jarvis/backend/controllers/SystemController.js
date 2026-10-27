const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { shell, dialog } = require('electron');
const path = require('path');
const { validateExternalUrl } = require('../security/external-url');

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}h ${m}m ${s}s`;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_COMMAND_TIMEOUT_MS = 120000;
const MAX_COMMAND_LENGTH = 4096;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;

function parseCommand(command) {
  const args = [];
  let currentArg = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && !inSingleQuote) {
      const next = command[index + 1];
      if (next === '"' || next === "'" || next === '\\') {
        currentArg += next;
        index += 1;
      } else {
        currentArg += '\\';
      }
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
      if (currentArg.length > 0) {
        args.push(currentArg);
        currentArg = '';
      }
      continue;
    }
    currentArg += char;
  }

  if (inSingleQuote || inDoubleQuote) return { ok: false, error: 'Command has an unterminated quote' };
  if (currentArg.length > 0) args.push(currentArg);
  if (args.length === 0) return { ok: false, error: 'Command is empty' };
  return { ok: true, executable: args[0], args: args.slice(1) };
}

function normalizeTimeout(value) {
  if (value === undefined || value === null) return { ok: true, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS };
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { ok: false, error: 'Timeout must be a positive integer in milliseconds' };
  }
  return { ok: true, timeoutMs: Math.min(numeric, MAX_COMMAND_TIMEOUT_MS) };
}

function normalizeCommand(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Command must be a string' };
  if (value.length > MAX_COMMAND_LENGTH) return { ok: false, error: 'Command is too long' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return { ok: false, error: 'Command contains control characters' };
  }
  if (value.includes('\n') || value.includes('\r')) {
    return { ok: false, error: 'Only a single command line is allowed' };
  }
  const command = value.trim();
  if (!command) return { ok: false, error: 'Command is empty' };
  return { ok: true, command };
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch (_) {}
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try { child.kill(); } catch (_) {}
      });
      if (typeof killer.unref === 'function') killer.unref();
    } catch (_) {
      try { child.kill(); } catch (_) {}
    }
    return;
  }

  // On POSIX the child is spawned detached, so a negative PID targets its
  // process group. Falling back to the direct child keeps cleanup best-effort.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

function checkOllamaRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 800 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

module.exports = function registerSystemController({
  ipcMain,
  app,
  mainWindowProvider,
  secAudit,
  secCheckRate,
  capabilityStore = null,
  sessionState = null,
  nativeDialog = dialog,
  externalShell = shell,
  projectRegistry = null,
}) {
  const sessionIsPrivileged = () => !!sessionState && sessionState.canUsePrivileges === true;
  const terminalGranted = () => sessionIsPrivileged()
    && !!capabilityStore
    && capabilityStore.isGranted('terminal');

  async function confirmNativeAction({ title, message, detail, auditAction, auditTarget }) {
    if (!nativeDialog || typeof nativeDialog.showMessageBox !== 'function') {
      secAudit(auditAction, auditTarget, 'BLOCKED - native confirmation unavailable');
      return false;
    }
    const win = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      secAudit(auditAction, auditTarget, 'BLOCKED - confirmation window unavailable');
      return false;
    }
    try {
      const result = await nativeDialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Allow', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title,
        message,
        detail,
      });
      return !!result && result.response === 0;
    } catch (error) {
      secAudit(auditAction, `${auditTarget}: ${error.message}`, 'BLOCKED - confirmation failed');
      return false;
    }
  }

  ipcMain.handle('get-user-data-path', () => app.getPath('userData'));
  
  ipcMain.handle('get-runtime-stats', async () => {
    const procMem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    const sysUptime = os.uptime();
    const procUptime = process.uptime();

    let session_count = 0;
    try {
      const histDir = path.join(app.getPath('userData'), 'history');
      if (fs.existsSync(histDir)) {
        session_count = fs.readdirSync(histDir).filter(f => f.endsWith('.json')).length;
      }
    } catch (_) {}

    let skill_count = 0;
    try {
      const manifestPath = path.join(__dirname, '../../skills/manifest.json');
      if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        skill_count = m.skills?.length || 0;
      }
    } catch (_) {}

    const ollama_running = await checkOllamaRunning();

    return {
      ok: true,
      cpus,
      totalmem: totalMem,
      freemem: freeMem,
      uptime: sysUptime,
      process: {
        uptime_human: formatUptime(procUptime),
        heap_used_mb: (procMem.heapUsed / 1024 / 1024).toFixed(1),
        heap_total_mb: (procMem.heapTotal / 1024 / 1024).toFixed(1),
        rss_mb: (procMem.rss / 1024 / 1024).toFixed(1)
      },
      system: {
        uptime_human: formatUptime(sysUptime),
        free_mem_gb: (freeMem / 1024 / 1024 / 1024).toFixed(2),
        total_mem_gb: (totalMem / 1024 / 1024 / 1024).toFixed(2),
        cpu_cores: cpus.length
      },
      jarvis: {
        ollama_running,
        skill_count,
        session_count,
        electron_ver: process.versions.electron || app.getVersion(),
        node_ver: process.versions.node
      }
    };
  });

  function commandFailure(error, extra = {}) {
    return { ok: false, stdout: '', stderr: '', exitCode: 1, error, ...extra };
  }

  function workspaceDirectory() {
    const workspace = path.join(app.getPath('userData'), 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const real = fs.realpathSync.native(workspace);
    if (!fs.statSync(real).isDirectory()) throw new Error('App workspace is not a directory');
    return real;
  }

  function activeProject() {
    if (!projectRegistry || typeof projectRegistry.active !== 'function') return null;
    return projectRegistry.active();
  }

  function resolveCommandCwd(options) {
    const record = options && typeof options === 'object' && !Array.isArray(options)
      ? options
      : {};
    if (Object.prototype.hasOwnProperty.call(record, 'cwd') && record.cwd != null) {
      return { ok: false, error: 'Raw working directories are not allowed; use the open project context' };
    }

    const hasProjectContext = record.projectId !== undefined
      || record.token !== undefined
      || record.relativePath !== undefined;

    if (hasProjectContext) {
      if (!projectRegistry || typeof projectRegistry.resolve !== 'function') {
        return { ok: false, error: 'Project execution context is not available' };
      }
      if (typeof record.projectId !== 'string' || typeof record.token !== 'string') {
        return { ok: false, error: 'projectId and token are required for project execution' };
      }
      const active = activeProject();
      if (!active || active.projectId !== record.projectId) {
        return { ok: false, error: 'The project is no longer active' };
      }
      const resolved = projectRegistry.resolve(
        record.projectId,
        record.token,
        record.relativePath === undefined ? '' : record.relativePath,
        { allowEmpty: true }
      );
      if (!resolved.ok) return { ok: false, error: resolved.error };
      let stat;
      try {
        stat = fs.statSync(resolved.targetPath);
      } catch (_) {
        return { ok: false, error: 'Working directory no longer exists' };
      }
      if (!stat.isDirectory()) return { ok: false, error: 'Working directory must be a directory' };
      return { ok: true, cwd: resolved.targetPath, project: resolved.record, relativePath: resolved.relativePath };
    }

    const active = activeProject();
    if (active) {
      try {
        const real = fs.realpathSync.native(active.rootPath);
        if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
        return { ok: true, cwd: real, project: active, relativePath: '' };
      } catch (_) {
        return { ok: false, error: 'The active project working directory is no longer available' };
      }
    }

    try {
      return { ok: true, cwd: workspaceDirectory(), project: null, relativePath: '' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function executeCommand({ executable, args, cwd, timeoutMs }) {
    return new Promise((resolve) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let collectedBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      let child = null;
      let timeoutTimer = null;
      let forceResolveTimer = null;

      const buildResult = (code) => {
        const ok = !timedOut && !outputLimitExceeded && code === 0;
        let error = null;
        if (timedOut) error = `Command timed out after ${timeoutMs} ms`;
        else if (outputLimitExceeded) error = `Command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes and was terminated`;
        else if (code !== 0) error = `Process exited with code ${code}`;
        return {
          ok,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: Number.isInteger(code) ? code : 1,
          timedOut,
          outputLimitExceeded,
          error,
        };
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceResolveTimer) clearTimeout(forceResolveTimer);
        resolve(result);
      };

      const terminate = () => {
        killProcessTree(child);
        if (forceResolveTimer) return;
        forceResolveTimer = setTimeout(() => finish(buildResult(1)), 3000);
        if (typeof forceResolveTimer.unref === 'function') forceResolveTimer.unref();
      };

      const appendOutput = (chunks, chunk) => {
        if (settled || outputLimitExceeded) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const remaining = MAX_COMMAND_OUTPUT_BYTES - collectedBytes;
        if (remaining <= 0) {
          outputLimitExceeded = true;
          terminate();
          return;
        }
        if (buffer.length > remaining) {
          chunks.push(buffer.subarray(0, remaining));
          collectedBytes = MAX_COMMAND_OUTPUT_BYTES;
          outputLimitExceeded = true;
          terminate();
          return;
        }
        chunks.push(buffer);
        collectedBytes += buffer.length;
      };

      try {
        child = spawn(executable, args, {
          cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        finish(commandFailure(error.message));
        return;
      }

      child.stdout.on('data', data => appendOutput(stdoutChunks, data));
      child.stderr.on('data', data => appendOutput(stderrChunks, data));

      child.on('error', error => {
        finish({ ...buildResult(1), ok: false, error: error.message });
      });

      child.on('close', code => {
        finish(buildResult(Number.isInteger(code) ? code : 1));
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    });
  }

  ipcMain.handle('run-command', async (_, command, options, legacyTimeout) => {
    const auditCommand = typeof command === 'string' ? command.trim().slice(0, 200) : '';
    if (!sessionIsPrivileged()) {
      secAudit('RUN_COMMAND', auditCommand, 'BLOCKED - session locked');
      return commandFailure('Unlock JARVIS before running commands');
    }
    if (!terminalGranted()) {
      secAudit('RUN_COMMAND', auditCommand, 'BLOCKED - terminal capability not granted');
      return commandFailure('Terminal execution requires main-process consent');
    }
    if (typeof secCheckRate === 'function' && !secCheckRate('runCommand', 15)) {
      return commandFailure('⛔ Rate limit: max 15 commands/minute.');
    }

    const normalized = normalizeCommand(command);
    if (!normalized.ok) {
      secAudit('RUN_COMMAND', auditCommand, `BLOCKED - ${normalized.error}`);
      return commandFailure(normalized.error);
    }
    const cmdStr = normalized.command;

    const parsed = parseCommand(cmdStr);
    if (!parsed.ok) {
      secAudit('RUN_COMMAND', cmdStr.slice(0, 200), `BLOCKED - ${parsed.error}`);
      return commandFailure(parsed.error);
    }

    if (options != null && (typeof options !== 'object' || Array.isArray(options))) {
      const error = typeof options === 'string'
        ? 'Raw working directories are not allowed; use the open project context'
        : 'Command options must be an object';
      secAudit('RUN_COMMAND', `${parsed.executable} @ unresolved`, `BLOCKED - ${error}`);
      return commandFailure(error);
    }
    const commandOptions = options || {};

    const timeoutResult = normalizeTimeout(
      commandOptions.timeout !== undefined ? commandOptions.timeout : legacyTimeout
    );
    if (!timeoutResult.ok) {
      secAudit('RUN_COMMAND', `${parsed.executable} @ unresolved`, `BLOCKED - ${timeoutResult.error}`);
      return commandFailure(timeoutResult.error);
    }

    const cwdResult = resolveCommandCwd(commandOptions);
    if (!cwdResult.ok) {
      secAudit(
        'RUN_COMMAND',
        `${parsed.executable} @ ${String(commandOptions.cwd || commandOptions.relativePath || 'unresolved').slice(0, 200)}`,
        `BLOCKED - ${cwdResult.error}`
      );
      return commandFailure(cwdResult.error);
    }
    const cwd = cwdResult.cwd;
    const auditTarget = `${parsed.executable} @ ${cwd}`.slice(0, 300);

    // Assuming ipc-policy is at root of jarvis/
    const { classifyCommand, INTERNAL_ALLOWLIST } = require('../../ipc-policy');

    let isAllowedGit = false;
    if (/^git\s+(status|log|branch|diff|show|rev-parse|remote)(\s|$)/i.test(cmdStr)) {
      if (/^[A-Za-z0-9._\/=:@~^ -]+$/.test(cmdStr)) {
        if (!/(?:^|\s)(-c|--output|--exec-path|--upload-pack|--receive-pack|--ext-diff|--textconv|--open-files-in-pager)\b/.test(cmdStr) &&
            !/(?:^|\s)--(?:git-dir|work-tree)(?:=|\b)/i.test(cmdStr)) {
          isAllowedGit = true;
        }
      }
    }

    if (!INTERNAL_ALLOWLIST.has(cmdStr) && !isAllowedGit) {
      const verdict = classifyCommand(cmdStr);
      if (verdict === 'blocked') {
        secAudit('RUN_COMMAND', auditTarget, 'BLOCKED - policy');
        return commandFailure('Command blocked by security policy');
      }
      // Every command outside the fixed internal/git read-only allowlist gets
      // its own main-process confirmation, including commands the classifier
      // considers low risk. The renderer cannot skip this step.
      const approved = await confirmNativeAction({
        title: 'JARVIS — Command Confirmation Required',
        message: verdict === 'confirm'
          ? 'This command requires your approval before running.'
          : 'Allow this non-allowlisted command?',
        detail: [
          `Command:\n${cmdStr.slice(0, 500)}`,
          `Executable: ${parsed.executable}`,
          `Working directory: ${cwd}`,
          `Classifier result: ${verdict.toUpperCase()}`,
          `Timeout: ${timeoutResult.timeoutMs} ms`,
          '',
          'Only allow commands you understand. The terminal capability alone does not approve this individual command.',
        ].join('\n'),
        auditAction: 'RUN_COMMAND',
        auditTarget,
      });
      if (!approved) {
        return commandFailure('Command cancelled by user');
      }
      secAudit('RUN_COMMAND', auditTarget, 'ALLOWED - user confirmed');
    }

    secAudit('RUN_COMMAND', auditTarget, 'ALLOWED');
    const result = await executeCommand({
      executable: parsed.executable,
      args: parsed.args,
      cwd,
      timeoutMs: timeoutResult.timeoutMs,
    });

    if (result.timedOut) {
      secAudit('RUN_COMMAND', auditTarget, `TERMINATED - timeout after ${timeoutResult.timeoutMs} ms`);
    } else if (result.outputLimitExceeded) {
      secAudit('RUN_COMMAND', auditTarget, 'TERMINATED - output limit');
    } else {
      secAudit('RUN_COMMAND', auditTarget, result.exitCode === 0 ? 'EXIT_0' : `EXIT_${result.exitCode}`);
    }
    return result;
  });

  ipcMain.handle('get-system-info', async () => ({
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || 'Unknown CPU',
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    appVersion: app.getVersion(),
    userDataPath: app.getPath('userData'),
    electronVer: process.versions.electron,
    nodejsVer: process.versions.node,
  }));

  const SYSTEM_CMD_APP_ALLOWLIST = new Set([
    'chrome', 'msedge', 'firefox', 'spotify', 'notepad', 'calc', 'calculator',
    'code', 'vscode', 'explorer', 'powershell', 'cmd', 'wt', 'terminal',
  ]);

  // Origins the user has already approved in this process. The first link to a
  // domain requires a native confirmation; subsequent links to that same origin
  // remain inside the reviewed allowlist without another modal.
  const approvedExternalOrigins = new Set();

  async function openExternalLink(url, { source = 'renderer', alwaysConfirm = false } = {}) {
    if (!sessionIsPrivileged()) {
      secAudit('OPEN_EXTERNAL', String(url).slice(0, 300), 'BLOCKED - session locked');
      return { ok: false, error: 'Unlock JARVIS before opening external links' };
    }
    if (typeof secCheckRate === 'function' && !secCheckRate('openExternal', 10)) {
      secAudit('OPEN_EXTERNAL', String(url).slice(0, 300), 'BLOCKED - rate limit');
      return { ok: false, error: 'Too many external links. Try again in a moment.' };
    }

    const verdict = validateExternalUrl(url);
    if (!verdict.ok) {
      secAudit('OPEN_EXTERNAL', String(url).slice(0, 300), `BLOCKED - ${verdict.error}`);
      return { ok: false, error: 'Refused to open unsafe URL' };
    }

    if (alwaysConfirm || !approvedExternalOrigins.has(verdict.origin)) {
      const approved = await confirmNativeAction({
        title: 'JARVIS — Open External Link?',
        message: `Open ${verdict.hostname} in your default browser?`,
        detail: [
          verdict.url,
          '',
          'JARVIS only opens http and https links. Review the domain before continuing.',
        ].join('\n'),
        auditAction: 'OPEN_EXTERNAL',
        auditTarget: verdict.url,
      });
      if (!approved) {
        secAudit('OPEN_EXTERNAL', verdict.url, 'CANCELLED');
        return { ok: false, error: 'External link cancelled by user' };
      }
      approvedExternalOrigins.add(verdict.origin);
    }

    try {
      await externalShell.openExternal(verdict.url);
      secAudit('OPEN_EXTERNAL', `${source}: ${verdict.url}`, 'ALLOWED');
      return { ok: true, url: verdict.url };
    } catch (error) {
      secAudit('OPEN_EXTERNAL', `${source}: ${error.message}`, 'ERROR');
      return { ok: false, error: 'Could not open the external link' };
    }
  }

  ipcMain.on('open-external', (_, url) => {
    openExternalLink(url).catch(error => {
      secAudit('OPEN_EXTERNAL', error.message, 'ERROR');
    });
  });

  ipcMain.handle('system-command', async (_, action, target) => {
    if (typeof action !== 'string' || typeof target !== 'string') {
      return { ok: false, error: 'Invalid request' };
    }
    const t = target.trim();
    if (!t) return { ok: false, error: 'Empty target' };
    if (t.length > 200) return { ok: false, error: 'Target too long' };

    const a = action.toLowerCase();

    if (a === 'close' || a === 'kill') {
      if (!terminalGranted()) {
        secAudit('SYSTEM_CMD_KILL', t, 'BLOCKED - terminal capability not granted');
        return { ok: false, error: 'Process termination requires main-process terminal consent' };
      }
      const approved = await confirmNativeAction({
        title: 'JARVIS — Confirm Process Termination',
        message: `Terminate ${t}?`,
        detail: [
          `Process: ${t}`,
          'This ends the process immediately. Unsaved work in that application may be lost.',
        ].join('\n'),
        auditAction: 'SYSTEM_CMD_KILL',
        auditTarget: t,
      });
      if (!approved) return { ok: false, error: 'Process termination cancelled by user' };
    }

    if (a === 'open-app' || a === 'start-app') {
      const key = t.toLowerCase().split(/\s+/)[0];
      if (!SYSTEM_CMD_APP_ALLOWLIST.has(key)) {
        return { ok: false, error: `App not in allowlist: ${key}` };
      }
      const candidates = {
        chrome: 'chrome', msedge: 'msedge', firefox: 'firefox', spotify: 'spotify',
        notepad: 'notepad', calc: 'calc', calculator: 'calc',
        code: 'code', vscode: 'code', explorer: 'explorer',
        powershell: 'powershell', cmd: 'cmd', wt: 'wt', terminal: 'wt',
      };
      const appName = candidates[key] || key;
      try {
        const errString = await shell.openPath(appName);
        if (errString !== '') return { ok: false, error: errString };
        return { ok: true, action: 'open-app', target: t };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    if (a === 'open-url' || a === 'search' || a === 'open') {
      let url = t;
      if (a === 'search' || !/^https?:\/\//i.test(url)) {
        if (!/^https?:\/\//i.test(url)) {
          url = 'https://www.google.com/search?q=' + encodeURIComponent(t);
        }
      }
      const yt = t.match(/^(.+)\s+(?:on|in|from|at)\s+youtube$/i);
      if (yt) url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(yt[1].trim());
      else if (/^youtube$/i.test(t)) url = 'https://www.youtube.com/';
      else if (/youtube/i.test(t) && !/^https?:\/\//i.test(t)) {
        const q = t.replace(/(open|search|in|on|from|youtube)/ig, '').trim();
        url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
      }
      url = url.replace(/^https?:\/\//, 'https://');
      if (!/^https:\/\//.test(url)) url = 'https://' + url.replace(/^\/+/, '');

      // Reuse the reviewed external-open path so system commands get the same
      // URL validation, rate limit, native confirmation, and audit trail.
      const opened = await openExternalLink(url, {
        source: 'system-command',
        alwaysConfirm: true,
      });
      if (!opened.ok) return { ok: false, error: opened.error };
      secAudit('SYSTEM_CMD_OPEN_URL', opened.url, 'ALLOWED');
      return { ok: true, action: 'open-url', target: opened.url };
    }

    if (a === 'close' || a === 'kill') {
      if (t.length > 64) return { ok: false, error: 'Name too long' };
      if (!/^[A-Za-z0-9_.\- ]+$/.test(t)) return { ok: false, error: 'Invalid process name' };
      const PROTECTED = /^(csrss|winlogon|lsass|smss|wininit|services|svchost|system|registry|dwm|explorer|audiodg|winrt\.exe|ntoskrnl|spoolsv|taskhost|taskhostw|sihost|fontdrvhost)$/i;
      if (PROTECTED.test(t.replace(/\.exe$/i, ''))) {
        secAudit('SYSTEM_CMD_KILL', t, 'BLOCKED - protected process');
        return { ok: false, error: `Refusing to terminate protected process: ${t}` };
      }
      return await new Promise(resolve => {
        const child = spawn('taskkill', ['/IM', t.endsWith('.exe') ? t : t + '.exe', '/F'], {
          shell: false,
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill();
          resolve({ ok: false, action: 'kill', target: t, error: 'Timed out' });
        }, 5000);
        child.on('close', code => {
          clearTimeout(timer);
          secAudit('SYSTEM_CMD_KILL', t, code === 0 ? 'KILLED' : `EXIT_${code}`);
          resolve({ ok: code === 0 || code === 128, action: 'kill', target: t });
        });
        child.on('error', err => {
          clearTimeout(timer);
          resolve({ ok: false, action: 'kill', target: t, error: err.message });
        });
      });
    }

    return { ok: false, error: `Unknown action: ${action}` };
  });

};

module.exports.parseCommand = parseCommand;
module.exports.normalizeCommand = normalizeCommand;
module.exports.normalizeTimeout = normalizeTimeout;
module.exports.MAX_COMMAND_OUTPUT_BYTES = MAX_COMMAND_OUTPUT_BYTES;
