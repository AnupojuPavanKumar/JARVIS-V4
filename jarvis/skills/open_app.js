// open_app.js — JARVIS skill: open a local application
// args: { app: string }
const args = JSON.parse(process.argv[2] || '{}');
const app = (args.app || '').trim();
if (!app) { console.log(JSON.stringify({ ok: false, error: 'No app name provided.' })); process.exit(0); }

const aliases = {
  chrome: 'chrome', google: 'chrome', 'google chrome': 'chrome',
  firefox: 'firefox', edge: 'msedge', msedge: 'msedge',
  spotify: 'spotify', notepad: 'notepad', calculator: 'calc', calc: 'calc',
  code: 'code', vscode: 'code', 'vs code': 'code',
  explorer: 'explorer', terminal: 'wt', wt: 'wt',
  powershell: 'powershell', cmd: 'cmd', paint: 'mspaint',
  youtube: 'https://youtube.com', github: 'https://github.com',
  gamma: 'https://gamma.app',
};
const exe = aliases[app.toLowerCase()];
if (!exe) {
  console.log(JSON.stringify({ ok: false, error: 'App not in allowlist.' }));
  process.exit(0);
}

const { spawn } = require('child_process');
let child;
if (exe.startsWith('http')) {
  child = spawn('rundll32', ['url.dll,FileProtocolHandler', exe], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
} else {
  child = spawn(exe, [], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
}

child.on('error', () => {});
child.unref();
console.log(JSON.stringify({ ok: true, result: `Launched ${app}.` }));
