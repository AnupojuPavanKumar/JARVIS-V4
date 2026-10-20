'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeSkill, resolveSkillScript } = require('../core/skills/executor');

function makeSkillsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-executor-test-'));
}

function writeScript(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

test('executes a JS skill and parses JSON output', async () => {
  const dir = makeSkillsDir();
  try {
    writeScript(dir, 'echo.js', `
      const args = JSON.parse(process.argv[2] || '{}');
      console.log(JSON.stringify({ ok: true, result: 'echo:' + args.text }));
    `);

    const result = await executeSkill({
      skill: { id: 'echo', type: 'js', script: 'echo.js' },
      args: { text: 'hello' },
      skillsDir: dir,
    });

    assert.equal(result.ok, true);
    assert.equal(result.result, 'echo:hello');
    assert.equal(result.skill, 'echo');
    assert.equal(typeof result.elapsed, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects script paths that escape the skills directory', async () => {
  const dir = makeSkillsDir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-executor-outside-'));
  try {
    const outsideScript = writeScript(outside, 'outside.js', 'console.log("{}")');
    const result = await executeSkill({
      skill: { id: 'outside', type: 'js', script: outsideScript },
      skillsDir: dir,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /escapes skills directory/);

    const resolved = resolveSkillScript(
      { id: 'outside', script: outsideScript },
      dir
    );
    assert.equal(resolved.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('reports nonzero exits, timeouts, and aborts', async () => {
  const dir = makeSkillsDir();
  try {
    writeScript(dir, 'fail.js', 'process.exit(2);');
    const failed = await executeSkill({
      skill: { id: 'fail', type: 'js', script: 'fail.js' },
      skillsDir: dir,
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /exit 2/);

    writeScript(dir, 'slow.js', 'setTimeout(() => console.log("{}"), 5000);');
    const timedOut = await executeSkill({
      skill: { id: 'slow', type: 'js', script: 'slow.js' },
      skillsDir: dir,
      timeoutMs: 50,
    });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error, /timed out/);

    const controller = new AbortController();
    const promise = executeSkill({
      skill: { id: 'slow', type: 'js', script: 'slow.js' },
      skillsDir: dir,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 20);
    const aborted = await promise;
    assert.equal(aborted.ok, false);
    assert.match(aborted.error, /aborted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('caps stdout and rejects unusable output', async () => {
  const dir = makeSkillsDir();
  try {
    writeScript(dir, 'noisy.js', 'console.log("x".repeat(2000));');
    const truncated = await executeSkill({
      skill: { id: 'noisy', type: 'js', script: 'noisy.js' },
      skillsDir: dir,
      stdoutCapBytes: 100,
    });
    assert.equal(truncated.ok, false);
    assert.match(truncated.error, /stdout exceeded/);
    assert.equal(truncated._stdoutTruncated, true);

    writeScript(dir, 'plain.js', 'console.log("not json");');
    const plain = await executeSkill({
      skill: { id: 'plain', type: 'js', script: 'plain.js' },
      skillsDir: dir,
    });
    assert.equal(plain.ok, true);
    assert.equal(plain.data.stdout, 'not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsupported skill types and oversized arguments', async () => {
  const dir = makeSkillsDir();
  try {
    const unsupported = await executeSkill({
      skill: { id: 'bad', type: 'ruby', script: 'bad.rb' },
      skillsDir: dir,
    });
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error, /Unsupported skill type/);

    writeScript(dir, 'echo.js', 'console.log("{}")');
    const oversized = await executeSkill({
      skill: { id: 'echo', type: 'js', script: 'echo.js' },
      args: { text: 'x'.repeat(70000) },
      skillsDir: dir,
    });
    assert.equal(oversized.ok, false);
    assert.match(oversized.error, /exceed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
