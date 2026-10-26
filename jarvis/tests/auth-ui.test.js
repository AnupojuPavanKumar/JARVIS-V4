'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('auth UI: the boot overlay starts hidden until an unlock completes', () => {
  const html = read('renderer/index.html');
  assert.match(html, /<div id="boot-screen" class="hidden"[^>]*>/);
});

test('auth UI: face unlock does not mark a fresh PIN lock as already booted', () => {
  const source = read('renderer/modules/faceUnlock.js');
  assert.match(
    source,
    /state\.booted = window\.__jarvisBooted === true \|\| \(!authScreenVisible\(\) && !document\.getElementById\('boot-screen'\)\)/
  );
  assert.match(
    source,
    /state\.booted = state\.booted \|\| window\.__jarvisBooted === true/
  );
});

test('auth UI: face scanning reuses the emblem instead of adding a column', () => {
  const html = read('renderer/index.html');
  const css = read('renderer/style.css');
  const source = read('renderer/modules/faceUnlock.js');
  assert.match(html, /<div id="auth-logo">[\s\S]*?<div id="auth-face-live" class="hidden"/);
  assert.doesNotMatch(html, /<div id="auth-face-panel"[\s\S]*?<div id="auth-face-live"/);
  assert.doesNotMatch(html, /auth-section-label/);
  assert.match(
    html,
    /<div id="auth-face-panel"[\s\S]*?id="auth-face-btn"[\s\S]*?id="auth-face-status"/
  );
  assert.match(html, /id="auth-face-status" class="auth-face-status-sr"/);
  assert.match(html, /id="face-setup-status" class="auth-face-status"/);
  assert.match(css, /\.auth-body\s*\{\s*display: flex;\s*flex-direction: column;/);
  assert.doesNotMatch(css, /grid-template-columns: 260px 260px/);
  assert.match(css, /#auth-face-live\s*\{\s*position: absolute;\s*inset: 4px;[\s\S]*?border-radius: 50%;/);
  assert.match(css, /#auth-logo:has\(#auth-face-live:not\(\.hidden\)\) \.auth-core/);
  assert.match(css, /@media \(max-height: 760px\)/);
  assert.match(source, /setText\('auth-subtitle', message\)/);
  assert.match(source, /setText\('auth-subtitle', 'IDENTITY VERIFICATION REQUIRED'\)/);
});

test('P0-2 auth UI: first-run setup stores the PIN and then requires one unlock entry', () => {
  const source = read('renderer/renderer.js');
  assert.match(source, /window\.jarvis\.authSetupPin\(pin\)/);
  assert.match(source, /PIN saved\. Enter it once to unlock JARVIS\./);
  assert.doesNotMatch(source, /authSave/);
  const setupStart = source.indexOf('window.jarvis.authSetupPin(pin)');
  const setupBlock = source.slice(
    setupStart,
    source.indexOf('if (!window.jarvis || !window.jarvis.authVerify)', setupStart)
  );
  assert.doesNotMatch(setupBlock, /Auth\._unlock\(\)/);
  assert.match(setupBlock, /Auth\._showLockedPrompt\(false\)/);
});

test('P0-2 auth UI: skip, change PIN, and recovery use command-specific main APIs', () => {
  const source = read('renderer/renderer.js');
  const preload = read('preload.js');
  const face = read('renderer/modules/faceUnlock.js');
  const html = read('renderer/index.html');

  assert.match(source, /window\.jarvis\.authSkip\(\)/);
  assert.match(source, /window\.jarvis\.authRecoverReset\(\)/);
  assert.match(source, /window\.jarvis\.authChangePin\(\{ currentPin, newPin \}\)/);
  assert.match(html, /id="auth-recovery"/);
  assert.match(html, /id="auth-recovery-btn"/);
  assert.match(html, /id="auth-recovery" class="hidden"/);

  assert.match(preload, /authSetupPin:\s+\(pin\)\s+=> ipcRenderer\.invoke\('auth-setup-pin'/);
  assert.match(preload, /authSkip:\s+\(\)\s+=> ipcRenderer\.invoke\('auth-skip'\)/);
  assert.match(preload, /authChangePin:\s+\(payload\)\s*=> ipcRenderer\.invoke\('auth-change-pin'/);
  assert.match(preload, /authRecoverReset:\s+\(\)\s+=> ipcRenderer\.invoke\('auth-recover-reset'\)/);
  assert.doesNotMatch(preload, /authSave|auth-save/);
  assert.doesNotMatch(face, /authSave/);

  const changeBlock = source.slice(
    source.indexOf('async function submitChangePin'),
    source.indexOf('window.submitChangePin')
  );
  assert.doesNotMatch(changeBlock, /authVerify/);
  assert.match(changeBlock, /authChangePin/);
});

test('P0-2 auth policy: setup and skip are setup-only and PIN change is unlocked-only', () => {
  const policy = read('backend/security/ipc-session-policy.js');
  assert.match(policy, /'auth-setup-pin': entry\(SETUP_ONLY/);
  assert.match(policy, /'auth-skip': entry\(SETUP_ONLY/);
  assert.match(policy, /'auth-change-pin': entry\(UNLOCKED_ONLY/);
  assert.match(policy, /'auth-verify': entry\(LOCKED_ONLY/);
  assert.match(policy, /'auth-recover-reset': entry\(ERROR_ONLY/);
  assert.doesNotMatch(policy, /auth-save|SETUP_OR_UNLOCKED/);
});

test('P0-2 auth UI: corrupt auth state is visible and recovery stays native-confirmed', () => {
  const source = read('renderer/renderer.js');
  const controller = read('backend/controllers/SecurityController.js');
  assert.match(source, /_showRecoveryState/);
  assert.match(source, /AUTHENTICATION STORE ERROR/);
  assert.match(source, /document\.querySelectorAll\("\.keypad-btn"\)\.forEach\(b\s*=>\s*\{\s*b\.disabled\s*=\s*!0;?\s*\}\)/);
  assert.match(controller, /'auth-recover-reset'/);
  assert.match(controller, /showAuthConfirmation/);
  assert.match(controller, /resetAuth\(app\.getPath\('userData'\)\)/);
  assert.match(controller, /faceStore\.remove/);
  assert.match(controller, /markSetup\('local lock recovery completed'\)/);
  assert.doesNotMatch(controller, /auth-save|_pinAttempts/);
});

test('auth UI: boot completion cannot leave a permanent black overlay', () => {
  const source = read('renderer/renderer.js');
  assert.match(source, /if \(!bt\) \{ window\.__jarvisBooted = true; bs\.classList\.add\("hidden"\)/);
  assert.match(source, /Never let the boot overlay strand the app/);
  assert.match(source, /failsafe = setTimeout\(finish, 20000\)/);
});

test('auth UI: the boot intro is calm, reduced-motion aware, and silent', () => {
  const html = read('renderer/index.html');
  const css = read('renderer/style.css');
  const source = read('renderer/renderer.js');
  assert.match(html, /class="boot-emblem"/);
  assert.match(html, /id="boot-progress-fill"/);
  assert.match(css, /\.boot-line\.visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /bootExplode|bootHexIgnite|bootFlickerGrid/);
  assert.match(source, /"All systems nominal"/);
  assert.doesNotMatch(source, /createOscillator|sawtooth/);
});
