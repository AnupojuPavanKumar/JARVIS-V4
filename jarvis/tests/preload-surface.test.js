'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER_ROOT = path.join(ROOT, 'renderer');
const PRELOAD_PATH = path.join(ROOT, 'preload.js');
const INDEX_PATH = path.join(RENDERER_ROOT, 'index.html');
const VERIFIER_PRELOAD_PATH = path.join(RENDERER_ROOT, 'verifier', 'face-verifier-preload.js');

const REQUIRED_NAMED_APIS = [
  'promptsLoad',
  'promptsSave',
  'snippetsLoad',
  'snippetsSave',
  'notesLoad',
  'notesSave',
  'openImageDialog',
  'readFileBinary',
  'clipboardWriteText',
  'faceStatus',
  'faceStartVerifier',
  'faceCancelVerifier',
  'voiceStatus',
  'voiceSetWakeWord',
  'voiceArmMicrophone',
  'voiceDisarmMicrophone',
  'voiceCreateTranscriptionLease',
  'onVoiceCaptureRevoked',
];

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function listRendererSources(dir = RENDERER_ROOT, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // dist/ is an unused development build and vendor/ is third-party code.
    // index.html loads only the hand-maintained renderer files below. The
    // verifier is a separate sandboxed surface with its own preload.
    if (entry.name === 'dist' || entry.name === 'vendor' || entry.name === 'node_modules' || entry.name === 'verifier') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) listRendererSources(fullPath, results);
    else if (entry.name.endsWith('.js')) results.push(fullPath);
  }
  return results;
}

function parsePreloadSurface() {
  const source = read(PRELOAD_PATH);
  const names = [...source.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map(match => match[1]);
  return { source, names, exposed: new Set(names) };
}

test('P1-4 preload exposes a named, write-only surface with no generic invoke', () => {
  const { source, names, exposed } = parsePreloadSurface();

  assert.ok(names.length > 50, `unexpectedly small preload surface: ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'preload API names must be unique');
  assert.equal(exposed.has('invoke'), false, 'generic invoke must never be exposed');
  assert.equal(exposed.has('ipcRenderer'), false, 'ipcRenderer must never be exposed');
  assert.match(source, /contextBridge\.exposeInMainWorld\(\s*['"]jarvis['"]/);
  assert.equal((source.match(/exposeInMainWorld\s*\(/g) || []).length, 1);

  for (const name of REQUIRED_NAMED_APIS) {
    assert.equal(exposed.has(name), true, `missing named preload API: ${name}`);
  }

  assert.match(
    source,
    /clipboardWriteText:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]clipboard-write-text['"]/,
    'clipboard writes must use the named main-process bridge'
  );
  assert.doesNotMatch(source, /clipboard\.(?:read|readText|readHTML|readImage|availableFormats)/i);
  assert.equal(exposed.has('clipboardReadText'), false);
  assert.equal(exposed.has('faceVerify'), false, 'renderer-side face verification must be removed');
  assert.equal(exposed.has('faceEnroll'), false, 'renderer-side enrollment must be removed');
  assert.equal(exposed.has('faceArmCamera'), false, 'the renderer must not arm the camera');
  assert.equal(exposed.has('faceDisarmCamera'), false, 'camera leases are main-owned');
  assert.equal(exposed.has('onFaceCameraStop'), false);
});

test('P1-4 renderer call sites use only named, exposed preload APIs', () => {
  const { exposed } = parsePreloadSurface();
  const violations = [];

  for (const filePath of listRendererSources()) {
    const relative = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const source = read(filePath);

    if (/window\s*\.\s*jarvis\s*\??\.\s*invoke\b/.test(source)) {
      violations.push(`${relative}: generic window.jarvis.invoke`);
    }
    if (/window\s*\.\s*jarvis\s*\[/.test(source)) {
      violations.push(`${relative}: dynamic window.jarvis[...] access`);
    }
    if (/window\s*\[\s*['"]jarvis['"]\s*\]/.test(source)) {
      violations.push(`${relative}: dynamic window['jarvis'] access`);
    }
    if (/\bipcRenderer\b/.test(source)) {
      violations.push(`${relative}: direct ipcRenderer access`);
    }

    for (const match of source.matchAll(/window\s*\.\s*jarvis\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (!exposed.has(match[1])) {
        violations.push(`${relative}: unknown window.jarvis.${match[1]}`);
      }
    }
  }

  assert.deepEqual([...new Set(violations)], []);
});

test('P1-6 preload voice surface cannot supply lock-screen or duration policy', () => {
  const { source } = parsePreloadSurface();
  const voiceBlock = source.slice(
    source.indexOf('voiceStatus:'),
    source.indexOf('focusWindow:')
  );
  assert.match(voiceBlock, /voiceArmMicrophone:\s*\(purpose\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]voice-arm-microphone['"],\s*\{\s*purpose\s*\}\s*\)/);
  assert.doesNotMatch(voiceBlock, /lockScreen/);
  assert.doesNotMatch(voiceBlock, /durationMs|duration/);
  assert.match(voiceBlock, /voiceCreateTranscriptionLease/);
  assert.match(voiceBlock, /onVoiceCaptureRevoked/);
  assert.match(voiceBlock, /voiceSetWakeWord/);
});

test('P1-5 verifier preload is separate, minimal, and cannot reach the JARVIS bridge', () => {
  const source = read(VERIFIER_PRELOAD_PATH);
  assert.match(source, /contextBridge\.exposeInMainWorld\(\s*['"]faceVerifier['"]/);
  assert.equal((source.match(/exposeInMainWorld\s*\(/g) || []).length, 1);
  assert.doesNotMatch(source, /exposeInMainWorld\(\s*['"]jarvis['"]/);
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(requires, ['electron']);
  assert.doesNotMatch(source, /\bclipboard\./);
  for (const channel of [
    'face-verifier-start',
    'face-verifier-stop',
    'face-verifier-progress',
    'face-verifier-result',
  ]) {
    assert.match(source, new RegExp(channel), channel);
  }
  for (const method of ['onStart', 'onStop', 'reportProgress', 'reportResult']) {
    assert.match(source, new RegExp(`${method}\\s*:`), method);
  }
});

test('P1-5 lock screen and enrollment UI contain no live video elements', () => {
  const index = read(INDEX_PATH);
  const faceUnlock = read(path.join(RENDERER_ROOT, 'modules', 'faceUnlock.js'));
  assert.doesNotMatch(index, /<video\b/i);
  assert.doesNotMatch(index, /auth-face-video|face-setup-video/);
  assert.match(index, /id="auth-face-live"[\s\S]*?auth-face-reticle/);
  assert.match(index, /id="face-setup-camera"[\s\S]*?face-setup-visual/);
  assert.doesNotMatch(faceUnlock, /getUserMedia|mediaDevices|new Human|auth-face-video|face-setup-video/);
  assert.match(faceUnlock, /window\.jarvis\.faceStartVerifier/);
});

test('P1-4 renderer index does not load the stale dist build', () => {
  const index = read(INDEX_PATH);
  const scripts = [...index.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
  assert.ok(scripts.some(src => /(?:^|\/)renderer\.js$/.test(src)));
  assert.ok(scripts.some(src => /(?:^|\/)modules\/uiFeatures\.js$/.test(src)));
  assert.deepEqual(scripts.filter(src => /(?:^|\/)dist\//.test(src)), []);
});

test('P1-4 copy actions await the clipboard bridge and surface failures', () => {
  const uiFeatures = read(path.join(RENDERER_ROOT, 'modules', 'uiFeatures.js'));
  const renderer = read(path.join(RENDERER_ROOT, 'renderer.js'));

  assert.match(uiFeatures, /async function copyTextToClipboard\(text\)/);
  assert.match(uiFeatures, /await window\.jarvis\.clipboardWriteText\(text\)/);
  assert.match(uiFeatures, /async function copySnip\(id\)[\s\S]*?await copyTextToClipboard\(s\.code\)/);
  assert.match(renderer, /async function copyCodeBlock\(event\)[\s\S]*?await window\.copyTextToClipboard\(code\.textContent/);
  assert.match(renderer, /window\.copyCreative = async function[\s\S]*?await window\.copyTextToClipboard\(e\)/);

  const liveClipboardCalls = [...uiFeatures.split(/\r?\n/), ...renderer.split(/\r?\n/)]
    .filter(line => !/^\s*\/\//.test(line))
    .filter(line => line.includes('navigator.clipboard'));
  assert.deepEqual(liveClipboardCalls, []);

  assert.match(uiFeatures, /Copy failed:/);
  assert.match(renderer, /Failed to copy/);
  assert.match(renderer, /Copy failed/);
});
