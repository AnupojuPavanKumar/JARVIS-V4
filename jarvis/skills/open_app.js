// open_app.js — JARVIS skill: open a local application
// args: { app: string }
const args = JSON.parse(process.argv[3] || '{}');
const app = (args.app || '').trim();
if (!app) { console.log(JSON.stringify({ ok: false, error: 'No app name provided.' })); process.exit(0); }

const aliases = {
  chrome: 'chrome', google: 'chrome', 'google chrome': 'chrome',
  firefox: 'firefox', edge: 'msedge', msedge: 'msedge',
  spotify: 'spotify', notepad: 'notepad', calculator: 'calc', calc: 'calc',
  code: 'code', vscode: 'code', 'vs code': 'code',
  explorer: 'explorer', terminal: 'wt', wt: 'wt',
  powershell: 'powershell', cmd: 'cmd', paint: 'mspaint',
};
const exe = aliases[app.toLowerCase()] || app;
const { exec } = require('child_process');
exec(`start "" "${exe}"`, { shell: true }, (err) => {
  if (err) console.log(JSON.stringify({ ok: false, error: err.message }));
  else console.log(JSON.stringify({ ok: true, result: `Launched ${app}.` }));
});
