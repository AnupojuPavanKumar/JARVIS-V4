#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// JARVIS Skill — Process Manager
// Lists and optionally kills processes with security guards.
// Usage: node process_manager.js '{"action":"list"}' 
//        node process_manager.js '{"action":"kill","pid":1234,"name":"chrome.exe"}'
// ═══════════════════════════════════════════════════════════════

'use strict';

const { exec } = require('child_process');

// System-critical processes that can NEVER be killed.
// On Windows the kernel and security components must not be terminated.
const PROTECTED_PROCESSES = new Set([
  // Kernel / session / security
  'csrss.exe', 'winlogon.exe', 'lsass.exe', 'smss.exe',
  'wininit.exe', 'services.exe', 'svchost.exe', 'system',
  'registry', 'memory compression', 'secure system',
  'antimalware service executable', 'mssecsvc.exe',
  'securityhealthservice.exe', 'msmpeng.exe', 'smartscreen.exe',
  // Shell / DWM / audio
  'dwm.exe', 'explorer.exe', 'audiodg.exe', 'fontdrvhost.exe',
  'lsaiso.exe', 'lsm.exe',
  // Network / RPC
  'rpcss.exe', 'dns.exe', 'dhcp.exe', 'winnat.exe',
  'tcpip.sys', 'nlasvc.exe', 'ncbind.exe', 'nlacp.exe',
  // Boot / logon
  'autochk.exe', 'autoconv.exe', 'autofmt.exe', 'taskhostw.exe',
  'taskhostex.exe', 'sihclient.exe', 'tiworker.exe',
  // Common anti-virus / EDR
  'csfalconservice.exe', 'cb.exe', 'carbonblack.exe',
  'cylancesvc.exe', 'sentinelagent.exe', 'taniumclient.exe',
  'xagt.exe', 'falcon-sensor.exe',
  // JARVIS + Ollama
  'electron.exe', 'jarvis.exe', 'ollama.exe', 'ollama app.exe',
]);

// Hard character allowlist for process names — anything else is rejected
// before being passed to taskkill. This is the defence-in-depth check on
// top of the protected set.
const PROCESS_NAME_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;

function isProtected(name) {
  if (!name) return true;
  return PROTECTED_PROCESSES.has(name.toLowerCase().trim());
}

function listProcesses() {
  return new Promise((resolve) => {
    // tasklist /fo csv /nh gives: "name","pid","session","num","mem"
    exec('tasklist /fo csv /nh', { timeout: 8000, maxBuffer: 1024 * 512 }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: err.message, data: [] }); return; }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const processes = [];
      for (const line of lines) {
        try {
          // Parse CSV row
          const cols = line.match(/"([^"]*)"/g)?.map(v => v.replace(/"/g, '')) || [];
          if (cols.length >= 5) {
            const name = cols[0];
            const pid  = parseInt(cols[1], 10);
            const mem  = cols[4]; // e.g. "12,345 K"
            if (pid && name) {
              processes.push({
                name,
                pid,
                memKb: parseInt(mem.replace(/[^0-9]/g, ''), 10) || 0,
                protected: isProtected(name),
              });
            }
          }
        } catch (_) {}
      }
      // Sort by memory descending (top resource hogs first)
      processes.sort((a, b) => b.memKb - a.memKb);
      resolve({ ok: true, data: processes.slice(0, 50) }); // top 50
    });
  });
}

function killProcess(pid, name) {
  return new Promise((resolve) => {
    if (!pid || isNaN(parseInt(pid, 10))) {
      resolve({ ok: false, error: 'Invalid PID.' }); return;
    }
    if (isProtected(name)) {
      resolve({ ok: false, error: `⛔ "${name}" is a system-critical process and cannot be terminated.` }); return;
    }
    if (!PROCESS_NAME_RE.test(name || '')) {
      resolve({ ok: false, error: `⛔ Process name contains illegal characters.` }); return;
    }
    exec(`taskkill /PID ${parseInt(pid, 10)} /F`, { timeout: 5000, shell: 'cmd.exe' }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr?.trim() || err.message }); return;
      }
      resolve({ ok: true, data: { pid, name, message: `Process ${name} (PID ${pid}) terminated.` } });
    });
  });
}

async function main() {
  let args = {};
  try {
    const raw = process.argv[2];
    if (raw) args = JSON.parse(raw);
  } catch (_) {}

  let result;
  if (args.action === 'kill') {
    result = await killProcess(args.pid, args.name || '');
  } else {
    // Default: list
    result = await listProcesses();
  }

  process.stdout.write(JSON.stringify({ ...result, skill: 'process_manager' }));
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, skill: 'process_manager' }));
});
