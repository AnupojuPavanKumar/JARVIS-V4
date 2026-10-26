'use strict';

// Phase 4A browser smoke test.
//
// Runs the real ElectronBrowserDriver against a local fixture site and verifies
// the screenshot/grounding loop: navigate, read, type, click, select, scroll,
// verify, navigate again, block an external origin, and emergency stop.
//
//   npx electron tests/electron-phase4-smoke.js

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { ElectronBrowserDriver } = require('../backend/browser/electron-browser-driver');

app.disableHardwareAcceleration();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase4-smoke-'));
app.setPath('userData', userDataDir);
app.on('window-all-closed', () => {});

const fixtureDir = path.join(__dirname, 'fixtures', 'browser-site');
let server = null;
let driver = null;

function finish(code) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.destroy(); } catch { /* best effort */ }
  }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      try {
        const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
        if (requestPath === '/favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }
        const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
        const filePath = path.resolve(fixtureDir, relative);
        if (!filePath.startsWith(path.resolve(fixtureDir) + path.sep)) {
          response.writeHead(403);
          response.end('Forbidden');
          return;
        }
        const body = fs.readFileSync(filePath);
        response.writeHead(200, { 'Content-Type': contentType(filePath) });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end('Not found');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function findElement(snapshot, predicate) {
  return (snapshot.elements || []).find(predicate) || null;
}

async function main() {
  const port = await startFixtureServer();
  const origin = `http://127.0.0.1:${port}`;
  const audit = [];
  driver = new ElectronBrowserDriver({
    BrowserWindow,
    session,
    app,
    partition: `jarvis-browser-smoke-${process.pid}-${Date.now()}`,
    artifactsDir: path.join(userDataDir, 'browser-artifacts'),
    allowedOrigins: [origin],
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
  });

  const opened = await driver.navigate(`${origin}/index.html`);
  check('local fixture navigates', opened.title === 'Phase 4 Browser Fixture', JSON.stringify(opened));

  const first = await driver.read({ includeScreenshot: true });
  check('read captures the fixture title', first.title === 'Phase 4 Browser Fixture');
  check('read identifies actionable elements', Array.isArray(first.elements) && first.elements.length >= 4);
  check('read returns visible page text', /JARVIS Browser Fixture/.test(first.text));
  check('read returns a screenshot reference', Boolean(first.screenshotPath), JSON.stringify(first));
  check(
    'screenshot is a non-empty PNG',
    first.screenshotPath && fs.statSync(first.screenshotPath).size > 8
  );

  const input = findElement(first, element => element.tag === 'input' && element.nameAttribute === 'name-input');
  check('name input is grounded', Boolean(input), JSON.stringify(first.elements));

  const nameResult = await driver.type(input.id, 'Ada');
  check('typing reports the target value length', nameResult.target.valueLength === 3);

  const afterType = await driver.read({ includeScreenshot: false });
  const button = findElement(afterType, element => element.tag === 'button' && element.name === 'Greet');
  check('greeting button is grounded after typing', Boolean(button), JSON.stringify(afterType.elements));

  const clicked = await driver.click(button.id);
  check(
    'click verifies the resulting page state',
    /Hello, Ada!/.test(clicked.snapshot.text),
    clicked.snapshot.text
  );

  const select = findElement(clicked.snapshot, element => element.tag === 'select');
  check('select element is grounded', Boolean(select), JSON.stringify(clicked.snapshot.elements));
  const selected = await driver.select(select.id, 'blue');
  check(
    'select verifies the resulting page state',
    /Choice: blue/.test(selected.snapshot.text),
    selected.snapshot.text
  );

  const scrolled = await driver.scroll('bottom', 600);
  check('scroll changes the page position', scrolled.scrollY > 0, JSON.stringify(scrolled));

  const beforeLink = await driver.read({ includeScreenshot: false });
  const link = findElement(beforeLink, element => element.tag === 'a' && element.name === 'Second page');
  check('navigation link is grounded', Boolean(link), JSON.stringify(beforeLink.elements));
  const navigated = await driver.click(link.id);
  check(
    'clicking a link navigates within the allowlist',
    /Second Page/.test(navigated.snapshot.title),
    JSON.stringify(navigated.snapshot)
  );
  check('status reports the new page', /\/second\.html$/.test(driver.status().url || ''), JSON.stringify(driver.status()));

  let blocked = null;
  try {
    await driver.navigate('https://example.com/');
  } catch (error) {
    blocked = error;
  }
  check('external navigation is rejected by default', Boolean(blocked), 'navigation unexpectedly succeeded');
  check(
    'blocked navigation is audited',
    audit.some(entry => entry.action === 'BROWSER_NAVIGATE_BLOCKED' && entry.verdict === 'DENY'),
    JSON.stringify(audit)
  );
  check('browser still shows the allowlisted page after rejection', /\/second\.html$/.test(driver.status().url || ''));

  await driver.stop();
  check('emergency stop closes the browser', driver.status().open === false);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    console.log('Phase 4 browser smoke');
    await main();
    console.log('Phase 4 browser smoke passed');
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    code = 1;
  } finally {
    try { await driver?.stop(); } catch { /* best effort */ }
    try { server?.close(); } catch { /* best effort */ }
    finish(code);
  }
});
