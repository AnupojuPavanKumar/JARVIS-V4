'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('P0-3: the main process exposes no arbitrary code-runner channel', () => {
  const controller = read('backend/controllers/FileController.js');
  assert.doesNotMatch(controller, /run-code-safe/);
  assert.doesNotMatch(controller, /SAFE_CODE_RUNNERS/);
  assert.doesNotMatch(controller, /child_process/);
  assert.doesNotMatch(controller, /_spawn\(/);
});

test('P0-3: preload exposes no runCodeSafe bridge', () => {
  const preload = read('preload.js');
  assert.doesNotMatch(preload, /runCodeSafe/);
  assert.doesNotMatch(preload, /run-code-safe/);
});

test('P0-3: code and automation cards contain no execution path or fabricated output', () => {
  const renderer = read('renderer/renderer.js');
  assert.doesNotMatch(renderer, /runDashCode/);
  assert.doesNotMatch(renderer, /runAutoScript/);
  assert.doesNotMatch(renderer, /runCodeSafe/);
  assert.doesNotMatch(renderer, /dash-code-output/);
  assert.doesNotMatch(renderer, /id="auto-output"/);
  assert.doesNotMatch(renderer, /Executing\\u2026/);
  assert.doesNotMatch(renderer, /Running automation/);
});

test('P0-3: safe review/copy/review actions remain available without execution', () => {
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /window\.reviewWithJarvis = function/);
  assert.match(renderer, /window\.explainWithJarvis = function/);
  assert.match(renderer, /window\.optimizeWithJarvis = function/);
  assert.match(renderer, /window\.loadCodeTemplate = function/);
  assert.match(renderer, /window\.scheduleScript = function/);
  assert.match(renderer, /data-action="scheduleScript"/);
  assert.doesNotMatch(renderer, /data-action="runDashCode"/);
  assert.doesNotMatch(renderer, /data-action="runAutoScript"/);
});

test('P0-3: the automation editor explicitly tells the user JARVIS does not execute it', () => {
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /JARVIS never executes this script/);
});
