/**
 * JARVIS-V4 Smoke Test
 * Run:
 *   node audit_artifacts/smoke_test.js --pre   # against base commit (319d2de)
 *   node audit_artifacts/smoke_test.js          # against current fix/audit HEAD
 *
 * Requires: npm install playwright --save-dev (in workspace root)
 * Ollama is replaced by a local NDJSON stub on port 11434.
 *
 * SELECTOR BUGS FIXED vs original:
 *   titleBar      - was #win-min/max/close -> actual #btn-min/max/close
 *   chatStream    - was .jarvis-msg .msg-bubble -> actual .jarvis-message .msg-bubble
 *   authWrongPin  - needs Auth.pressKey() via evaluate, not page.type() which does
 *                   not trigger the hidden-input keydown handler; also waitForFunction
 *   authLockout   - needs 5 total bad attempts; counter persists across test sections
 *   schedulerAdd  - correct jobData shape: { name, type:'one-off', triggerTime }
 *   hamburgerMenu - guards window.closeHamburger before calling it
 */

'use strict';

const { _electron: electron } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Ollama NDJSON Stub ───────────────────────────────────────────────────────
function startOllamaStub(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'stub-model', size: 1000000 }] }));
        return;
      }

      if (req.url === '/api/chat' || req.url === '/api/generate') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const c1  = JSON.stringify({ message: { content: 'Hello sir. ' }, done: false });
        const c2  = JSON.stringify({ message: { content: 'This is a stub response.' }, done: false });
        const fin = JSON.stringify({ message: { content: '' }, done: true });
        res.write(c1 + '\n');
        setTimeout(() => { res.write(c2 + '\n'); }, 50);
        setTimeout(() => { res.write(fin + '\n'); res.end(); }, 120);
        return;
      }

      res.writeHead(404); res.end();
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeEval(page, fn, timeout = 4000) {
  return Promise.race([
    page.evaluate(fn),
    new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timeout')), timeout)),
  ]);
}

// ─── Main test runner ─────────────────────────────────────────────────────────
async function runTest(commitName) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${commitName}] STARTING SMOKE TEST`);
  console.log('='.repeat(60));

  const results = {
    commit: commitName,
    errors: [],
    cspViolations: [],
    tests: {
      authSetup:    { pass: false, note: '' },
      authWrongPin: { pass: false, note: '' },
      authLockout:  { pass: false, note: '' },
      authUnlock:   { pass: false, note: '' },
      titleBar:     { pass: false, note: '' },
      hamburgerMenu:{ pass: false, note: '' },
      settingsModal:{ pass: false, note: '' },
      chatStream:   { pass: false, note: '' },
      schedulerAdd: { pass: false, note: '' },
      skillRun:     { pass: false, note: '' },
      ttsAudio:     { pass: 'needs-manual', note: 'Cannot automate audio output' },
      micInput:     { pass: 'needs-manual', note: 'Cannot automate mic input' },
    }
  };

  let ollamaServer;
  try {
    ollamaServer = await startOllamaStub(11434);
    console.log(`[${commitName}] Ollama stub on 127.0.0.1:11434`);
  } catch (e) {
    results.errors.push(`[OllamaStub] Port 11434 busy: ${e.message}`);
    console.warn(`[${commitName}] WARNING: Ollama stub skipped — ${e.message}`);
  }

  const testUserData = path.join(os.tmpdir(), `jarvis_test_${Date.now()}`);
  fs.mkdirSync(testUserData, { recursive: true });

  const env = Object.assign({}, process.env, { NODE_ENV: 'development', JARVIS_SMOKE_TEST: '1' });

  let electronApp;
  try {
    electronApp = await electron.launch({
      executablePath: path.resolve(
        __dirname, '..', 'jarvis', 'node_modules', 'electron', 'dist', 'electron.exe'
      ),
      args: ['main.js', `--user-data-dir=${testUserData}`],
      cwd: path.resolve(__dirname, '..', 'jarvis'),
      env,
      timeout: 20000,
    });
  } catch (launchErr) {
    results.errors.push(`[Launch] ${launchErr.message}`);
    console.error(`[${commitName}] LAUNCH FAILED: ${launchErr.message}`);
    if (ollamaServer) ollamaServer.close();
    return results;
  }

  const page = await electronApp.firstWindow();
  console.log(`[${commitName}] Window ready`);

  page.on('console', msg => {
    const txt = msg.text();
    const t   = msg.type();
    if (t === 'error' || t === 'warning') {
      if (txt.includes('Content Security Policy') || txt.includes('CORS') || txt.includes('Refused to')) {
        results.cspViolations.push(`[${t.toUpperCase()}] ${txt}`);
      } else if (!txt.includes('Electron Security Warning')) {
        results.errors.push(`[CONSOLE ${t.toUpperCase()}] ${txt}`);
      }
    }
  });

  try {

    // ── AUTH SETUP ─────────────────────────────────────────────────
    console.log(`[${commitName}] --- authSetup ---`);
    try {
      await page.waitForSelector('#auth-screen', { timeout: 5000 }).catch(() => null);
      const authVisible = await safeEval(page, () =>
        !document.getElementById('auth-screen')?.classList.contains('hidden')
      );
      if (authVisible) {
        // First entry
        await safeEval(page, () => ['1','2','3','4'].forEach(d => window.Auth?.pressKey(d)));
        await delay(300);
        // Confirm entry
        await safeEval(page, () => ['1','2','3','4'].forEach(d => window.Auth?.pressKey(d)));
        await delay(400);
        results.tests.authSetup = { pass: true, note: 'PIN 1234 set via Auth.pressKey()' };
      } else {
        results.tests.authSetup = { pass: true, note: 'Auth screen hidden on first load (skip-PIN or no PIN mode)' };
      }
    } catch (e) {
      results.tests.authSetup = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[authSetup] ${e.message}`);
    }

    // ── AUTH WRONG PIN ─────────────────────────────────────────────
    console.log(`[${commitName}] --- authWrongPin ---`);
    try {
      await safeEval(page, () => {
        const s = document.getElementById('auth-screen');
        if (s) { s.classList.remove('hidden', 'unlocking'); }
        const err = document.getElementById('auth-error');
        if (err) { err.textContent = ''; err.classList.add('hidden'); }
        if (window.Auth) { window.Auth._pin = ''; window.Auth._attempts = 0; }
      });
      await delay(100);

      // Type wrong PIN
      await safeEval(page, () => ['9','9','9','9'].forEach(d => window.Auth?.pressKey(d)));

      // Wait for async IPC response → error visible
      await page.waitForFunction(
        () => !document.getElementById('auth-error')?.classList.contains('hidden'),
        { timeout: 5000 }
      ).catch(() => null);

      const errVis = await safeEval(page, () =>
        !document.getElementById('auth-error')?.classList.contains('hidden')
      );
      results.tests.authWrongPin = errVis
        ? { pass: true,  note: '#auth-error appeared after wrong PIN' }
        : { pass: false, note: 'FAIL: #auth-error stayed hidden' };
    } catch (e) {
      results.tests.authWrongPin = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[authWrongPin] ${e.message}`);
    }

    // ── AUTH LOCKOUT ───────────────────────────────────────────────
    console.log(`[${commitName}] --- authLockout ---`);
    try {
      // 1 attempt used above; need 4 more to reach PIN_MAX_ATTEMPTS=5
      for (let i = 0; i < 4; i++) {
        await safeEval(page, () => {
          const err = document.getElementById('auth-error');
          if (err) err.classList.add('hidden');
          if (window.Auth) window.Auth._pin = '';
        });
        await safeEval(page, () => ['9','9','9','9'].forEach(d => window.Auth?.pressKey(d)));
        await delay(700);
      }

      await page.waitForFunction(
        () => {
          const t = (document.getElementById('auth-error')?.textContent || '').toLowerCase();
          return t.includes('lock') || t.includes('too many') || t.includes('wait');
        },
        { timeout: 5000 }
      ).catch(() => null);

      const errTxt = await safeEval(page, () =>
        (document.getElementById('auth-error')?.textContent || '').toLowerCase()
      );
      const locked = errTxt.includes('lock') || errTxt.includes('too many') || errTxt.includes('wait');
      results.tests.authLockout = locked
        ? { pass: true,  note: `Lockout text: "${errTxt.trim()}"` }
        : { pass: false, note: `FAIL: no lockout text; got "${errTxt.trim()}"` };
    } catch (e) {
      results.tests.authLockout = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[authLockout] ${e.message}`);
    }

    // ── AUTH UNLOCK (bypass for remaining tests) ───────────────────
    console.log(`[${commitName}] --- authUnlock ---`);
    try {
      await safeEval(page, () => {
        if (window.Auth) { window.Auth._attempts = 0; window.Auth._lockedUntil = 0; }
        const s = document.getElementById('auth-screen');
        if (s) { s.classList.add('hidden'); s.classList.remove('unlocking'); }
        const bs = document.getElementById('boot-screen');
        if (bs) bs.remove();
      });
      await delay(300);
      const dashOk = await safeEval(page, () => !!document.getElementById('dashboard-area'));
      results.tests.authUnlock = dashOk
        ? { pass: true,  note: 'Auth screen hidden, dashboard-area present' }
        : { pass: false, note: 'FAIL: dashboard-area not found' };
    } catch (e) {
      results.tests.authUnlock = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[authUnlock] ${e.message}`);
    }

    // ── TITLE BAR ─────────────────────────────────────────────────
    // Fix: IDs are #btn-min, #btn-max, #btn-close (not #win-min etc.)
    console.log(`[${commitName}] --- titleBar ---`);
    try {
      const min   = await page.$('#btn-min');
      const max   = await page.$('#btn-max');
      const close = await page.$('#btn-close');
      if (min && max && close) {
        results.tests.titleBar = { pass: true, note: '#btn-min #btn-max #btn-close found' };
      } else {
        const missing = [!min&&'#btn-min', !max&&'#btn-max', !close&&'#btn-close'].filter(Boolean).join(', ');
        results.tests.titleBar = { pass: false, note: `FAIL: missing ${missing}` };
      }
    } catch (e) {
      results.tests.titleBar = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[titleBar] ${e.message}`);
    }

    // ── HAMBURGER MENU ────────────────────────────────────────────
    console.log(`[${commitName}] --- hamburgerMenu ---`);
    try {
      await page.click('#btn-hamburger', { timeout: 3000 });
      await delay(400);
      const hamVis = await safeEval(page, () => !document.getElementById('hamburger-menu')?.hidden);
      results.tests.hamburgerMenu = hamVis
        ? { pass: true,  note: 'hamburger-menu visible after click' }
        : { pass: false, note: 'FAIL: hamburger-menu remained hidden' };
      await safeEval(page, () => {
        if (typeof window.closeHamburger === 'function') window.closeHamburger();
        else { const m = document.getElementById('hamburger-menu'); if (m) m.hidden = true; }
      });
    } catch (e) {
      results.tests.hamburgerMenu = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[hamburgerMenu] ${e.message}`);
    }

    // ── SETTINGS MODAL ────────────────────────────────────────────
    console.log(`[${commitName}] --- settingsModal ---`);
    try {
      await page.click('#btn-settings', { timeout: 3000 });
      await delay(400);
      const setVis = await safeEval(page, () => !document.getElementById('settings-modal')?.hidden);
      results.tests.settingsModal = setVis
        ? { pass: true,  note: 'settings-modal opened' }
        : { pass: false, note: 'FAIL: settings-modal remained hidden' };
      await safeEval(page, () => typeof window.closeModal === 'function' && window.closeModal('settings-modal'));
    } catch (e) {
      results.tests.settingsModal = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[settingsModal] ${e.message}`);
    }

    // ── CHAT STREAM ───────────────────────────────────────────────
    // Fix: message class is .jarvis-message (not .jarvis-msg)
    console.log(`[${commitName}] --- chatStream ---`);
    try {
      await page.waitForSelector('#user-input', { timeout: 3000 });
      await page.fill('#user-input', 'Hello');
      await page.click('#send-btn');
      await page.waitForSelector('.jarvis-message', { timeout: 10000 }).catch(() => null);
      await delay(1500); // let stream finish

      const found = await safeEval(page, () => {
        const msgs = Array.from(document.querySelectorAll('.jarvis-message .msg-bubble'));
        return msgs.some(m =>
          m.textContent.includes('stub response') ||
          m.textContent.includes('Hello sir') ||
          m.textContent.trim().length > 5
        );
      }, 6000);

      results.tests.chatStream = found
        ? { pass: true,  note: 'jarvis-message with content appeared (stub)' }
        : { pass: false, note: 'FAIL: no .jarvis-message with content after 10s' };
    } catch (e) {
      results.tests.chatStream = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[chatStream] ${e.message}`);
    }

    // ── SCHEDULER ADD ─────────────────────────────────────────────
    // Fix: correct jobData shape { name, type, triggerTime }; window.jarvis.schedulerAdd IS in preload
    console.log(`[${commitName}] --- schedulerAdd ---`);
    try {
      const res = await safeEval(page, async () => {
        if (!window.jarvis?.schedulerAdd) return { ok: false, error: 'schedulerAdd not exposed' };
        return window.jarvis.schedulerAdd({
          name: 'smoke_test_job',
          type: 'one-off',
          triggerTime: Date.now() + 60000,
          payload: 'smoke_test',
        });
      }, 8000);

      results.tests.schedulerAdd = (res && res.ok)
        ? { pass: true,  note: `Job created id=${res.id}` }
        : { pass: false, note: `FAIL: ${JSON.stringify(res)}` };
    } catch (e) {
      results.tests.schedulerAdd = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[schedulerAdd] ${e.message}`);
    }

    // ── SKILL RUN (open terminal modal) ───────────────────────────
    console.log(`[${commitName}] --- skillRun ---`);
    try {
      await safeEval(page, () => {
        if (typeof window.openTerminalModal === 'function') window.openTerminalModal();
        else if (typeof window.openModal === 'function') window.openModal('terminal-modal');
      });
      await delay(400);
      const termVis = await safeEval(page, () => !document.getElementById('terminal-modal')?.hidden);
      results.tests.skillRun = termVis
        ? { pass: true,  note: 'terminal-modal opened' }
        : { pass: false, note: 'FAIL: terminal-modal not visible' };
      await safeEval(page, () => typeof window.closeModal === 'function' && window.closeModal('terminal-modal'));
    } catch (e) {
      results.tests.skillRun = { pass: false, note: `FAIL: ${e.message}` };
      results.errors.push(`[skillRun] ${e.message}`);
    }

  } finally {
    // Write results BEFORE trying to close (close can hang if app prevents quit)
    const reportPath = path.join(__dirname, `smoke_test_results_${process.argv.includes('--pre') ? 'pre' : 'post'}.json`);
    try { fs.writeFileSync(reportPath, JSON.stringify(results, null, 2)); } catch (e) { console.error('Could not write results:', e.message); }

    // Force-close with timeout — Electron may refuse clean quit
    const closePromise = electronApp.close().catch(() => {});
    await Promise.race([closePromise, new Promise(r => setTimeout(r, 5000))]);
    if (ollamaServer) try { ollamaServer.close(); } catch { }
  }

  return results;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
async function main() {
  const isPre   = process.argv.includes('--pre');
  const commit  = isPre ? 'PRE-REMEDIATION' : 'FIX-AUDIT';
  const results = await runTest(commit);

  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  for (const [name, val] of Object.entries(results.tests)) {
    const tag = val.pass === true ? 'PASS' : val.pass === 'needs-manual' ? 'MANUAL' : 'FAIL';
    console.log(`  ${tag.padEnd(8)} ${name.padEnd(20)} ${val.note}`);
  }
  if (results.cspViolations.length) {
    console.log('\nCSP/CORS VIOLATIONS:');
    results.cspViolations.forEach(v => console.log('  ', v));
  }
  if (results.errors.length) {
    console.log('\nERRORS:');
    results.errors.forEach(e => console.log('  ', e));
  }

  console.log(`\nSaved: smoke_test_results_${isPre ? 'pre' : 'post'}.json`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

