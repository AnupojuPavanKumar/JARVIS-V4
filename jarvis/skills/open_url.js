// open_url.js — JARVIS skill: open a URL in the default browser
// args: { url: string }
const args = JSON.parse(process.argv[2] || '{}');
let url = (args.url || '').trim();
if (!url) { console.log(JSON.stringify({ ok: false, error: 'No URL provided.' })); process.exit(0); }
if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
const { exec } = require('child_process');
exec(`start "" "${url}"`, { shell: true }, (err) => {
  if (err) console.log(JSON.stringify({ ok: false, error: err.message }));
  else console.log(JSON.stringify({ ok: true, result: `Opened ${url} in browser.` }));
});
