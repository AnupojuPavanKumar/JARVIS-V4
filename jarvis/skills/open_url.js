// open_url.js — JARVIS skill: open a URL in the default browser
// args: { url: string }
const args = JSON.parse(process.argv[2] || '{}');
let urlStr = (args.url || '').trim();
if (!urlStr) { console.log(JSON.stringify({ ok: false, error: 'No URL provided.' })); process.exit(0); }
const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(urlStr);
if (!hasScheme) {
    if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?([/?#].*)?$/.test(urlStr)) {
        urlStr = 'https://' + urlStr;
    } else {
        console.log(JSON.stringify({ ok: false, error: 'Invalid URL.' })); process.exit(0);
    }
}

let parsed;
try {
  parsed = new URL(urlStr);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Invalid URL.' })); process.exit(0);
}

if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
  console.log(JSON.stringify({ ok: false, error: 'Unsupported URL scheme.' })); process.exit(0);
}

if (parsed.username || parsed.password) {
  console.log(JSON.stringify({ ok: false, error: 'Credentials in URL are not allowed.' })); process.exit(0);
}

const { spawn } = require('child_process');
const child = spawn('rundll32', ['url.dll,FileProtocolHandler', parsed.href], {
  shell: false,
  windowsHide: true,
  detached: true,
  stdio: 'ignore'
});
child.unref();
console.log(JSON.stringify({ ok: true, result: `Opened ${parsed.href} in browser.` }));
