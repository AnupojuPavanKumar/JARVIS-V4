// search_web.js — JARVIS skill: search the web via the default browser
// args: { query: string }
const args = JSON.parse(process.argv[3] || '{}');
const query = (args.query || '').trim();
if (!query) { console.log(JSON.stringify({ ok: false, error: 'No search query provided.' })); process.exit(0); }
const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
const { exec } = require('child_process');
exec(`start "" "${url}"`, { shell: true }, (err) => {
  if (err) console.log(JSON.stringify({ ok: false, error: err.message }));
  else console.log(JSON.stringify({ ok: true, result: `Searching for "${query}"...` }));
});
