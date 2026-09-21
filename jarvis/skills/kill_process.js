// kill_process.js — JARVIS skill: terminate a process by name
// Security: shell:false spawn + name allowlist + comprehensive protected list.
// args: { name: string }

'use strict';

const args = JSON.parse(process.argv[2] || '{}');
const name = (args.name || '').trim();

if (!name) {
  console.log(JSON.stringify({ ok: false, error: 'No process name provided.' }));
  process.exit(0);
}

// ── Strict allowlist: only safe filename-like characters ──────────────────
// Rejects shell metacharacters before they ever reach taskkill.
const SAFE_NAME_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
if (!SAFE_NAME_RE.test(name)) {
  console.log(JSON.stringify({ ok: false, error: 'Process name contains illegal characters.' }));
  process.exit(0);
}

// ── Comprehensive protected process blocklist ─────────────────────────────
const PROTECTED = new Set([
  // NT kernel / session manager
  'system', 'registry', 'memory compression', 'secure system',
  'smss', 'smss.exe',
  // Security subsystem
  'csrss', 'csrss.exe', 'lsass', 'lsass.exe', 'lsaiso', 'lsaiso.exe',
  'wininit', 'wininit.exe', 'winlogon', 'winlogon.exe',
  // Service control
  'services', 'services.exe', 'svchost', 'svchost.exe',
  // Desktop window manager / shell / audio
  'dwm', 'dwm.exe', 'explorer', 'explorer.exe',
  'audiodg', 'audiodg.exe', 'fontdrvhost', 'fontdrvhost.exe',
  // Network / RPC / boot helpers
  'spoolsv', 'spoolsv.exe', 'taskhostw', 'taskhostw.exe', 'lsm', 'lsm.exe',
  // Anti-malware / EDR (common agents)
  'msmpeng', 'msmpeng.exe', 'smartscreen', 'smartscreen.exe',
  'securityhealthservice', 'securityhealthservice.exe',
  'antimalware service executable',
  'csfalconservice', 'csfalconservice.exe',
  'sentinelagent', 'sentinelagent.exe',
  'cylancesvc', 'cylancesvc.exe',
  'cb', 'cb.exe', 'carbonblack', 'carbonblack.exe',
  'xagt', 'xagt.exe', 'falcon-sensor', 'falcon-sensor.exe',
  'taniumclient', 'taniumclient.exe',
  // JARVIS ecosystem — never self-terminate
  'electron', 'electron.exe', 'jarvis', 'jarvis.exe',
  'ollama', 'ollama.exe', 'ollama app', 'ollama app.exe',
  'node', 'node.exe',
]);

// Normalise: strip .exe suffix and lowercase for lookup
function isProtected(n) {
  const key = n.toLowerCase().replace(/\.exe$/i, '').trim();
  return PROTECTED.has(key) || PROTECTED.has(n.toLowerCase().trim());
}

if (isProtected(name)) {
  console.log(JSON.stringify({
    ok: false,
    error: `⛔ "${name}" is a protected system process and cannot be terminated.`
  }));
  process.exit(0);
}

// ── shell:false spawn — name passed as a literal argv element, never shell-interpolated
const { spawn } = require('child_process');
const child = spawn('taskkill', ['/IM', name, '/F'], {
  shell: false,
  windowsHide: true,
});

let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });
child.on('close', code => {
  if (code === 0 || out.toLowerCase().includes('success')) {
    console.log(JSON.stringify({ ok: true, result: `Terminated "${name}".` }));
  } else {
    console.log(JSON.stringify({ ok: false, error: err.trim() || `taskkill exited with code ${code}` }));
  }
});
child.on('error', e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
});
