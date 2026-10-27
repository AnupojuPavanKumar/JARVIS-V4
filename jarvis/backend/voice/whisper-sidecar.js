'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { verifyWhisperAssets, unavailable } = require('./whisper-assets');

const DEFAULT_REQUEST_TIMEOUT_MS = 40000;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CHARS = 12000;
const CHILD_TERMINATION_GRACE_MS = 250;
const NON_SPEECH_MARKER = /^[\[(](?:blank_audio|silence|music|noise|inaudible|applause|laughter)[\])]$/i;
const SPEECH_CONTENT = /[\p{L}\p{N}]/u;

function boundedTail(chunks, limit) {
  // Errors are surfaced to logs and the renderer, so collapse control
  // characters and keep only a short tail of the child's diagnostic.
  const value = chunks.join('').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(-limit) : value;
}

function transcriptFromStdout(stdout) {
  return String(stdout || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !NON_SPEECH_MARKER.test(line))
    // whisper.cpp can emit note glyphs or punctuation for non-speech audio.
    // A line with no letters or digits is never a usable command.
    .filter(line => SPEECH_CONTENT.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

function sidecarEnvironment(source = process.env, platform = process.platform, executablePath = '') {
  const env = {};
  const executableDir = executablePath ? path.dirname(executablePath) : '';
  if (platform === 'win32') {
    const systemRoot = source.SystemRoot || source.WINDIR || 'C:\\Windows';
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.PATH = [
      executableDir,
      path.join(systemRoot, 'System32'),
      systemRoot,
    ].filter(Boolean).join(path.delimiter);
    if (source.TEMP) env.TEMP = source.TEMP;
    if (source.TMP) env.TMP = source.TMP;
    return env;
  }

  env.PATH = [executableDir, '/usr/local/bin', '/usr/bin', '/bin']
    .filter(Boolean)
    .join(path.delimiter);
  if (source.HOME) env.HOME = source.HOME;
  if (source.TMPDIR) env.TMPDIR = source.TMPDIR;
  return env;
}

/**
 * Run the bundled whisper.cpp executable for a single utterance.
 *
 * There is no resident server and no loopback listener. Each request starts a
 * JARVIS-owned child, feeds it one validated WAV path, and waits for a bounded
 * plain-text result. Requests are serialized so only one inference runs at a
 * time. A missing or modified asset disables transcription without affecting
 * the rest of the app.
 */
function createWhisperSidecar({
  appPath,
  manifest,
  verifyAssets = verifyWhisperAssets,
  spawnImpl = spawn,
  logger = console,
  platform = process.platform,
  threads = 4,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  envSource = process.env,
  fsImpl = fs,
} = {}) {
  if (typeof appPath !== 'string' || appPath.length === 0) {
    throw new TypeError('whisper sidecar requires the Electron app path');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('whisper sidecar requires an asset manifest');
  }
  if (typeof verifyAssets !== 'function') {
    throw new TypeError('whisper sidecar requires an asset verifier');
  }

  let initialization = null;
  let assetResult = null;
  let disposed = false;
  let activeChild = null;
  let chain = Promise.resolve();

  function logError(error) {
    if (logger && typeof logger.error === 'function') logger.error(`[WHISPER] ${error}`);
  }

  function initialize() {
    if (initialization) return initialization;
    initialization = Promise.resolve()
      .then(() => verifyAssets({ appPath, manifest }))
      .then(result => {
        assetResult = result && typeof result === 'object'
          ? result
          : { ok: false, error: unavailable('the asset verifier returned no result') };
        if (!assetResult.ok) logError(assetResult.error);
        return assetResult;
      })
      .catch(error => {
        assetResult = {
          ok: false,
          error: unavailable(error && error.message ? error.message : 'asset verification failed'),
        };
        logError(assetResult.error);
        return assetResult;
      });
    return initialization;
  }

  function buildArguments(paths, audioPath) {
    return [
      '--model', paths.model,
      '--file', audioPath,
      '--language', 'en',
      '--threads', String(threads),
      '--no-timestamps',
      '--no-prints',
      '--suppress-nst',
      '--no-gpu',
    ];
  }

  function runOne(audioPath) {
    return new Promise(resolve => {
      let settled = false;
      let spawned = false;
      let startupTimer = null;
      let requestTimer = null;
      let terminationTimer = null;
      let terminationReason = null;
      const stdout = [];
      const stderr = [];
      const stdoutSize = { bytes: 0 };
      const stderrSize = { bytes: 0 };
      let child = null;

      const settle = result => {
        if (settled) return;
        settled = true;
        if (startupTimer) clearTimeout(startupTimer);
        if (requestTimer) clearTimeout(requestTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        if (activeChild === child) activeChild = null;
        resolve(result);
      };

      const stop = () => {
        if (!child || child.killed) return;
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      };

      const killFor = error => {
        if (settled) return;
        terminationReason = error;
        stop();
        if (settled) return;
        // Wait for the child to close so the caller can delete the temporary
        // WAV after Windows releases its file handle. The fallback prevents a
        // missing close event from wedging the serialized queue.
        if (!terminationTimer) {
          terminationTimer = setTimeout(
            () => settle({ success: false, error }),
            CHILD_TERMINATION_GRACE_MS
          );
        }
      };

      if (disposed) {
        resolve({ success: false, error: unavailable('the sidecar was stopped') });
        return;
      }
      const paths = assetResult && assetResult.paths;
      if (
        !paths
        || typeof paths.executable !== 'string'
        || !path.isAbsolute(paths.executable)
        || typeof paths.model !== 'string'
        || !path.isAbsolute(paths.model)
      ) {
        resolve({ success: false, error: unavailable('the native runtime is not verified') });
        return;
      }
      if (
        typeof audioPath !== 'string'
        || !path.isAbsolute(audioPath)
        || path.extname(audioPath).toLowerCase() !== '.wav'
      ) {
        resolve({ success: false, error: 'Local transcription rejected an invalid audio path' });
        return;
      }
      try {
        const stat = fsImpl.statSync(audioPath);
        if (!stat.isFile() || stat.size <= 0) {
          resolve({ success: false, error: 'Local transcription rejected an invalid audio file' });
          return;
        }
      } catch (_) {
        resolve({ success: false, error: 'Local transcription rejected a missing audio file' });
        return;
      }

      try {
        child = spawnImpl(paths.executable, buildArguments(paths, audioPath), {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: path.dirname(paths.executable),
          env: sidecarEnvironment(envSource, platform, paths.executable),
        });
      } catch (error) {
        settle({
          success: false,
          error: `Local transcription could not start: ${error && error.message ? error.message : 'spawn failed'}`,
        });
        return;
      }
      if (
        !child
        || !child.stdout
        || typeof child.stdout.on !== 'function'
        || !child.stderr
        || typeof child.stderr.on !== 'function'
      ) {
        settle({ success: false, error: 'Local transcription could not start: invalid child process' });
        stop();
        return;
      }
      activeChild = child;

      child.once('error', error => {
        settle({
          success: false,
          error: `Local transcription could not start: ${error && (error.code || error.message) ? (error.code || error.message) : 'unknown error'}`,
        });
        stop();
      });

      child.once('spawn', () => {
        spawned = true;
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = null;
      });

      function capture(stream, chunks, size, label) {
        stream.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          size.bytes += buffer.length;
          if (size.bytes > maxOutputBytes) {
            killFor(`Local transcription produced too much ${label}`);
            return;
          }
          chunks.push(buffer.toString('utf8'));
        });
      }

      capture(child.stdout, stdout, stdoutSize, 'output');
      capture(child.stderr, stderr, stderrSize, 'error output');

      child.once('close', (code, signal) => {
        if (settled) return;
        if (disposed) {
          settle({ success: false, error: 'Local transcription stopped during app shutdown' });
          return;
        }
        if (terminationReason) {
          settle({ success: false, error: terminationReason });
          return;
        }
        if (code === 0) {
          settle({ success: true, text: transcriptFromStdout(stdout.join('')) });
          return;
        }
        const detail = boundedTail(stderr, 300);
        settle({
          success: false,
          error: `Local transcription failed${code === null ? '' : ` (exit ${code})`}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`,
        });
      });

      // A synchronous spawn implementation may emit "spawn" before the timer
      // exists, so only arm the startup timer when the child is still pending.
      if (!spawned) {
        startupTimer = setTimeout(() => {
          if (settled || spawned) return;
          killFor('Local transcription did not start in time');
        }, startupTimeoutMs);
      }

      requestTimer = setTimeout(() => {
        if (settled) return;
        killFor(`Local transcription timed out after ${Math.round(requestTimeoutMs / 1000)}s`);
      }, requestTimeoutMs);
    });
  }

  async function runTranscription(audioPath) {
    if (disposed) {
      return { success: false, error: unavailable('the sidecar was stopped') };
    }
    const ready = await initialize();
    if (!ready.ok) return { success: false, error: ready.error };
    if (disposed) {
      return { success: false, error: unavailable('the sidecar was stopped') };
    }
    return runOne(audioPath);
  }

  function transcribe(audioPath) {
    const request = chain.then(
      () => runTranscription(audioPath),
      () => runTranscription(audioPath)
    );
    chain = request.then(() => undefined, () => undefined);
    return request;
  }

  function status() {
    const verified = !!(assetResult && assetResult.ok);
    return Object.freeze({
      available: !disposed && verified,
      verified,
      pending: !assetResult && !disposed,
      error: assetResult && !assetResult.ok ? assetResult.error : null,
      busy: !!activeChild,
    });
  }

  function dispose(reason = 'app-quit') {
    if (disposed) return;
    disposed = true;
    if (activeChild) {
      try { activeChild.kill('SIGKILL'); } catch (_) { /* already gone */ }
    }
    if (logger && typeof logger.log === 'function') {
      logger.log(`[WHISPER] Native sidecar stopped (${reason}).`);
    }
  }

  return Object.freeze({
    initialize,
    transcribe,
    status,
    dispose,
  });
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  transcriptFromStdout,
  sidecarEnvironment,
  createWhisperSidecar,
};
