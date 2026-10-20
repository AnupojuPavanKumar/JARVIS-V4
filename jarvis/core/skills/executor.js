'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_STDOUT_CAP_BYTES = 64 * 1024;
const DEFAULT_STDERR_CAP_BYTES = 64 * 1024;
const MAX_ARGS_BYTES = 64 * 1024;

function resolveSkillScript(skill, skillsDir) {
  if (!skill || typeof skill !== 'object' || typeof skill.script !== 'string' || !skill.script) {
    return { ok: false, error: 'Skill has no script' };
  }

  let scriptPath;
  let realSkillsRoot;
  try {
    scriptPath = fs.realpathSync(path.resolve(skillsDir, skill.script));
    realSkillsRoot = fs.realpathSync(path.resolve(skillsDir)) + path.sep;
  } catch {
    return { ok: false, error: 'Skill script path could not be resolved.' };
  }

  if (!scriptPath.startsWith(realSkillsRoot)) {
    return { ok: false, error: 'Skill script path escapes skills directory.' };
  }
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `Script not found: ${skill.script}` };
  }

  return { ok: true, scriptPath };
}

function resolveRunner(skill) {
  if (skill.type === 'js') return 'node';
  if (skill.type === 'python') return 'python';
  return null;
}

// Execute one verified skill in a child process. This module is deliberately
// free of Electron and policy decisions; callers must authorize the call first.
function executeSkill({
  skill,
  args = {},
  skillsDir,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stdoutCapBytes = DEFAULT_STDOUT_CAP_BYTES,
  stderrCapBytes = DEFAULT_STDERR_CAP_BYTES,
  signal = null,
  now = Date.now,
} = {}) {
  const startedAt = now();

  if (!skill || typeof skill !== 'object') {
    return Promise.resolve({ ok: false, error: 'Skill not found', elapsed: now() - startedAt });
  }
  if (typeof skillsDir !== 'string' || !skillsDir.trim()) {
    return Promise.resolve({ ok: false, error: 'skillsDir is required', elapsed: now() - startedAt });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.resolve({ ok: false, error: 'timeoutMs must be a positive integer', elapsed: now() - startedAt });
  }

  const runner = resolveRunner(skill);
  if (!runner) {
    return Promise.resolve({
      ok: false,
      skill: skill.id,
      error: `Unsupported skill type: ${String(skill.type)}`,
      elapsed: now() - startedAt,
    });
  }

  const resolved = resolveSkillScript(skill, skillsDir);
  if (!resolved.ok) {
    return Promise.resolve({
      ok: false,
      skill: skill.id,
      error: resolved.error,
      elapsed: now() - startedAt,
    });
  }

  let argsStr;
  try {
    argsStr = JSON.stringify(args || {});
  } catch (error) {
    return Promise.resolve({
      ok: false,
      skill: skill.id,
      error: `Skill arguments are not JSON-serializable: ${error.message}`,
      elapsed: now() - startedAt,
    });
  }
  if (Buffer.byteLength(argsStr, 'utf8') > MAX_ARGS_BYTES) {
    return Promise.resolve({
      ok: false,
      skill: skill.id,
      error: `Skill arguments exceed ${MAX_ARGS_BYTES} bytes`,
      elapsed: now() - startedAt,
    });
  }

  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      skill: skill.id,
      error: 'Skill execution aborted',
      elapsed: now() - startedAt,
    });
  }

  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(runner, [resolved.scriptPath, argsStr], {
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        skill: skill.id,
        error: error.message,
        elapsed: now() - startedAt,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ skill: skill.id, elapsed: now() - startedAt, ...result });
    };

    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', chunk => {
      if (stdoutTruncated) return;
      stdoutBuf += chunk;
      if (stdoutBuf.length >= stdoutCapBytes) {
        stdoutBuf = stdoutBuf.slice(0, stdoutCapBytes);
        stdoutTruncated = true;
        kill();
      }
    });

    child.stderr.on('data', chunk => {
      if (stderrTruncated) return;
      stderrBuf += chunk;
      if (stderrBuf.length >= stderrCapBytes) {
        stderrBuf = stderrBuf.slice(0, stderrCapBytes);
        stderrTruncated = true;
      }
    });

    child.on('error', error => {
      finish({
        ok: false,
        data: { stdout: stdoutBuf, stderr: stderrBuf },
        error: error.message,
        _stdoutTruncated: stdoutTruncated || undefined,
        _stderrTruncated: stderrTruncated || undefined,
      });
    });

    child.on('close', code => {
      if (aborted) {
        finish({
          ok: false,
          data: { stdout: stdoutBuf, stderr: stderrBuf },
          error: 'Skill execution aborted',
          _stdoutTruncated: stdoutTruncated || undefined,
          _stderrTruncated: stderrTruncated || undefined,
        });
        return;
      }

      if (timedOut) {
        finish({
          ok: false,
          data: { stdout: stdoutBuf, stderr: stderrBuf },
          error: `Skill timed out after ${timeoutMs}ms`,
          _stdoutTruncated: stdoutTruncated || undefined,
          _stderrTruncated: stderrTruncated || undefined,
        });
        return;
      }

      if (stdoutTruncated) {
        finish({
          ok: false,
          data: { stdout: stdoutBuf, stderr: stderrBuf },
          error: `Skill stdout exceeded ${stdoutCapBytes} bytes`,
          _stdoutTruncated: true,
          _stderrTruncated: stderrTruncated || undefined,
        });
        return;
      }

      const parsed = (() => {
        try {
          const value = JSON.parse(stdoutBuf.trim());
          return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch {
          return null;
        }
      })();

      if (parsed) {
        finish({
          ok: code === 0 && parsed.ok !== false,
          ...parsed,
          data: parsed.data ?? { stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() },
          ...(code !== 0 ? { error: parsed.error || `exit ${code}` } : {}),
          _stdoutTruncated: stdoutTruncated || undefined,
          _stderrTruncated: stderrTruncated || undefined,
        });
        return;
      }

      finish({
        ok: code === 0,
        data: { stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() },
        error: code === 0 ? null : `exit ${code}`,
        _stdoutTruncated: stdoutTruncated || undefined,
        _stderrTruncated: stderrTruncated || undefined,
      });
    });
  });
}

module.exports = {
  executeSkill,
  resolveSkillScript,
  resolveRunner,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STDOUT_CAP_BYTES,
  DEFAULT_STDERR_CAP_BYTES,
  MAX_ARGS_BYTES,
};
