const os = require('os');
const fs = require('fs');
const http = require('http');
const { exec, spawn } = require('child_process');
const { shell, dialog } = require('electron');
const path = require('path');

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}h ${m}m ${s}s`;
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

module.exports = function registerSystemController({ ipcMain, app, mainWindowProvider, secAudit, liveSecConfig, secCheckRate }) {
  
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

  ipcMain.handle('run-command', async (_, command, cwd, timeout) => {
    if (!secCheckRate('runCommand', 15)) {
      return { ok: false, stdout: '', stderr: '', exitCode: 1, error: '⛔ Rate limit: max 15 commands/minute.' };
    }

    const cmdStr = String(command).trim();
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
      if (!liveSecConfig.terminalEnabled) {
        secAudit('RUN_COMMAND', cmdStr.slice(0, 200), 'BLOCKED - terminal disabled');
        return { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'Terminal execution is disabled' };
      }
      const verdict = classifyCommand(cmdStr);
      if (verdict === 'blocked') {
        secAudit('RUN_COMMAND', cmdStr.slice(0, 200), 'BLOCKED - policy');
        return { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'Command blocked by security policy' };
      }
      if (verdict === 'confirm') {
        const mainWindow = mainWindowProvider();
        if (!mainWindow) {
          secAudit('RUN_COMMAND', cmdStr.slice(0, 200), 'BLOCKED - no window for confirm');
          return { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'Command requires confirmation but no window available' };
        }
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Run Command', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'JARVIS — Command Confirmation Required',
          message: 'This command requires your approval before running.',
          detail: `Command:\n${cmdStr.slice(0, 500)}`,
        });
        if (response !== 0) {
          secAudit('RUN_COMMAND', cmdStr.slice(0, 200), 'BLOCKED - user cancelled confirm');
          return { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'Command cancelled by user' };
        }
        secAudit('RUN_COMMAND', cmdStr.slice(0, 200), 'ALLOWED - user confirmed');
      }
    }

    secAudit('RUN_COMMAND', cmdStr.slice(0, 200), 'ALLOWED');
    return new Promise((resolve) => {
      // Parse command string into executable and arguments
      const args = [];
      let currentArg = '';
      let inSingleQuote = false;
      let inDoubleQuote = false;
      let escapeNext = false;
      for (let i = 0; i < cmdStr.length; i++) {
        const char = cmdStr[i];
        if (escapeNext) {
          currentArg += char;
          escapeNext = false;
          continue;
        }
        if (char === '\\' && !inSingleQuote) {
          escapeNext = true;
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
        if (char.match(/\s/) && !inSingleQuote && !inDoubleQuote) {
          if (currentArg.length > 0) {
            args.push(currentArg);
            currentArg = '';
          }
          continue;
        }
        currentArg += char;
      }
      if (currentArg.length > 0) args.push(currentArg);
      const cmdExe = args[0];
      const cmdArgs = args.slice(1);
      
      if (!cmdExe) return resolve({ ok: true, stdout: '', stderr: '', exitCode: 0, error: null });

      const spawnOptions = { cwd, shell: false };
      if (timeout && timeout > 0) {
        spawnOptions.timeout = timeout;
      }
      const child = spawn(cmdExe, cmdArgs, spawnOptions);
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', data => stdout += data.toString());
      child.stderr.on('data', data => stderr += data.toString());
      
      child.on('error', error => {
        resolve({ ok: false, stdout, stderr, exitCode: 1, error: error.message });
      });
      
      child.on('close', code => {
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          exitCode: code || 0,
          error: code === 0 ? null : `Process exited with code ${code}`
        });
      });
    });
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

  function isSafeExternalUrl(u) {
    try {
      const p = new URL(u);
      if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
      if (!p.hostname || p.hostname.length > 253) return false;
      return true;
    } catch { return false; }
  }

  ipcMain.on('open-external', (_, url) => {
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
      secAudit('OPEN_EXTERNAL', String(url), 'BLOCKED');
      return;
    }
    shell.openExternal(url);
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
      if (!liveSecConfig.terminalEnabled) {
        secAudit('SYSTEM_CMD_KILL', t, 'BLOCKED - terminal disabled');
        return { ok: false, error: 'Process termination is disabled (terminal permission required)' };
      }
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

      if (!isSafeExternalUrl(url)) {
        return { ok: false, error: 'Refused to open unsafe URL' };
      }
      try {
        await shell.openExternal(url);
        return { ok: true, action: 'open-url', target: url };
      } catch (e) {
        return { ok: false, error: e.message };
      }
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
