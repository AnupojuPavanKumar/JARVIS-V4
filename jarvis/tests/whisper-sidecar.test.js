'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  transcriptFromStdout,
  sidecarEnvironment,
  createWhisperSidecar,
} = require('../backend/voice/whisper-sidecar');

const MANIFEST = Object.freeze({ root: 'bin/whisper', files: [] });

function makeWav(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-whisper-sidecar-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
  const file = path.join(dir, 'utterance.wav');
  fs.writeFileSync(file, Buffer.from('RIFF....WAVE'));
  return file;
}

function fakeSpawn({ emitSpawn = true } = {}) {
  const calls = [];
  const children = [];
  function spawnImpl(executable, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4000 + children.length;
    child.killed = false;
    child.killCalls = [];
    child.kill = signal => {
      child.killed = true;
      child.killCalls.push(signal || 'SIGTERM');
      return true;
    };
    children.push(child);
    calls.push({ executable, args, options, child });
    if (emitSpawn) queueMicrotask(() => child.emit('spawn'));
    return child;
  }
  return { spawnImpl, calls, children };
}

function verifiedAssets(executable = path.join(os.tmpdir(), 'whisper-cli.exe')) {
  const model = path.join(os.tmpdir(), 'ggml-base.en-q5_1.bin');
  return async () => ({ ok: true, paths: { root: path.dirname(executable), executable, model } });
}

function create(t, options = {}) {
  const spawn = fakeSpawn(options.spawn);
  const logs = [];
  const sidecar = createWhisperSidecar({
    appPath: os.tmpdir(),
    manifest: MANIFEST,
    verifyAssets: options.verifyAssets || verifiedAssets(),
    spawnImpl: spawn.spawnImpl,
    logger: {
      log: message => logs.push(['log', message]),
      error: message => logs.push(['error', message]),
    },
    platform: 'win32',
    envSource: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', SECRET_TOKEN: 'do-not-pass' },
    startupTimeoutMs: options.startupTimeoutMs || 1000,
    requestTimeoutMs: options.requestTimeoutMs || 1000,
    maxOutputBytes: options.maxOutputBytes || 1024,
  });
  t.after(() => sidecar.dispose('test-cleanup'));
  return { sidecar, spawn, logs };
}

function closeWith(child, { code = 0, signal = null, stdout = '', stderr = '' } = {}) {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code, signal);
}

async function waitForSpawn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('whisper sidecar: runs one bounded CLI request with an explicit environment', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t);

  const resultPromise = sidecar.transcribe(audio);
  await waitForSpawn();
  assert.equal(spawn.calls.length, 1);

  const { executable, args, options } = spawn.calls[0];
  assert.match(executable, /whisper-cli\.exe$/);
  assert.deepEqual(args.slice(0, 4), ['--model', path.join(os.tmpdir(), 'ggml-base.en-q5_1.bin'), '--file', audio]);
  assert.deepEqual(args.slice(4), [
    '--language', 'en',
    '--threads', '4',
    '--no-timestamps',
    '--no-prints',
    '--suppress-nst',
    '--no-gpu',
  ]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.cwd, path.dirname(executable));
  assert.equal(options.env.SystemRoot, 'C:\\Windows');
  assert.equal(options.env.TEMP, 'C:\\Temp');
  assert.equal(options.env.SECRET_TOKEN, undefined, 'unrelated environment variables are not inherited');
  assert.match(options.env.PATH, /System32/);

  closeWith(spawn.children[0], { stdout: '  hello world  \n\n second line \n' });
  assert.deepEqual(await resultPromise, { success: true, text: 'hello world second line' });
  assert.deepEqual(sidecar.status(), {
    available: true,
    verified: true,
    pending: false,
    error: null,
    busy: false,
  });
});

test('whisper sidecar: a missing asset disables only transcription', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t, {
    verifyAssets: async () => ({
      ok: false,
      error: 'Local transcription is unavailable: bin/whisper/whisper-cli.exe is missing',
    }),
  });

  const result = await sidecar.transcribe(audio);
  assert.deepEqual(result, {
    success: false,
    error: 'Local transcription is unavailable: bin/whisper/whisper-cli.exe is missing',
  });
  assert.equal(spawn.calls.length, 0);
  assert.equal(sidecar.status().available, false);
  assert.match(sidecar.status().error, /is missing/);
});

test('whisper sidecar: a verifier crash is contained as a transcription diagnostic', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t, {
    verifyAssets: async () => { throw new Error('hash read failed'); },
  });

  const result = await sidecar.transcribe(audio);
  assert.equal(result.success, false);
  assert.match(result.error, /Local transcription is unavailable: hash read failed/);
  assert.equal(spawn.calls.length, 0);
});

test('whisper sidecar: nonzero exit and stderr are reported without leaking unlimited output', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t);

  const resultPromise = sidecar.transcribe(audio);
  await waitForSpawn();
  closeWith(spawn.children[0], {
    code: 2,
    stderr: 'failed to load model\nsecond line',
  });
  const result = await resultPromise;
  assert.equal(result.success, false);
  assert.match(result.error, /exit 2/);
  assert.match(result.error, /failed to load model second line/);
});

test('whisper sidecar: spawn errors are handled instead of crashing the main process', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t);

  const resultPromise = sidecar.transcribe(audio);
  await waitForSpawn();
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  spawn.children[0].emit('error', error);

  const result = await resultPromise;
  assert.equal(result.success, false);
  assert.match(result.error, /could not start: ENOENT/);
});

test('whisper sidecar: a startup timeout kills only the child it started', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t, {
    spawn: { emitSpawn: false },
    startupTimeoutMs: 20,
  });

  const result = await sidecar.transcribe(audio);
  assert.equal(result.success, false);
  assert.match(result.error, /did not start in time/);
  assert.equal(spawn.children.length, 1);
  assert.deepEqual(spawn.children[0].killCalls, ['SIGKILL']);
});

test('whisper sidecar: a request timeout kills the child and releases the queue', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t, { requestTimeoutMs: 20 });

  const result = await sidecar.transcribe(audio);
  assert.equal(result.success, false);
  assert.match(result.error, /timed out/);
  assert.deepEqual(spawn.children[0].killCalls, ['SIGKILL']);
  assert.equal(sidecar.status().busy, false);
});

test('whisper sidecar: a killed request settles after close so temp audio can be deleted', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t, { requestTimeoutMs: 20 });

  const pending = sidecar.transcribe(audio);
  await waitForSpawn();
  await new Promise(resolve => setTimeout(resolve, 80));
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'the request waits for the child to release the WAV');

  closeWith(spawn.children[0], { code: null, signal: 'SIGKILL' });
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /timed out/);
});

test('whisper sidecar: oversized stdout is capped and the child is killed', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t, { maxOutputBytes: 16 });

  const resultPromise = sidecar.transcribe(audio);
  await waitForSpawn();
  spawn.children[0].stdout.emit('data', Buffer.alloc(17, 0x61));

  const result = await resultPromise;
  assert.equal(result.success, false);
  assert.match(result.error, /too much output/);
  assert.deepEqual(spawn.children[0].killCalls, ['SIGKILL']);
});

test('whisper sidecar: requests are serialized so only one inference runs at a time', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t);

  const first = sidecar.transcribe(audio);
  const second = sidecar.transcribe(audio);
  await waitForSpawn();
  assert.equal(spawn.calls.length, 1);

  closeWith(spawn.children[0], { stdout: 'first' });
  assert.deepEqual(await first, { success: true, text: 'first' });

  await waitForSpawn();
  assert.equal(spawn.calls.length, 2);
  closeWith(spawn.children[1], { stdout: 'second' });
  assert.deepEqual(await second, { success: true, text: 'second' });
});

test('whisper sidecar: dispose terminates the active JARVIS child and rejects later work', async t => {
  const audio = makeWav(t);
  const { sidecar, spawn } = create(t);

  const pending = sidecar.transcribe(audio);
  await waitForSpawn();
  sidecar.dispose('test-quit');
  assert.deepEqual(spawn.children[0].killCalls, ['SIGKILL']);

  closeWith(spawn.children[0], { code: null, signal: 'SIGKILL' });
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /stopped during app shutdown/);

  const after = await sidecar.transcribe(audio);
  assert.equal(after.success, false);
  assert.match(after.error, /sidecar was stopped/);
  assert.equal(spawn.calls.length, 1);
  assert.equal(sidecar.status().available, false);
});

test('whisper sidecar: a malformed child object fails closed instead of rejecting', async t => {
  const audio = makeWav(t);
  const sidecar = createWhisperSidecar({
    appPath: os.tmpdir(),
    manifest: MANIFEST,
    verifyAssets: verifiedAssets(),
    spawnImpl: () => null,
    logger: { log: () => {}, error: () => {} },
    startupTimeoutMs: 50,
    requestTimeoutMs: 50,
  });
  t.after(() => sidecar.dispose('test-cleanup'));

  const result = await sidecar.transcribe(audio);
  assert.equal(result.success, false);
  assert.match(result.error, /invalid child process|could not start/);
});

test('whisper sidecar: invalid audio paths never reach the executable', async t => {
  const { sidecar, spawn } = create(t);

  for (const value of ['', 'relative.wav', path.join(os.tmpdir(), 'missing.wav'), path.join(os.tmpdir(), 'voice.mp3')]) {
    const result = await sidecar.transcribe(value);
    assert.equal(result.success, false);
  }
  assert.equal(spawn.calls.length, 0);
});

test('whisper sidecar: environment construction is explicit and platform aware', () => {
  const windows = sidecarEnvironment(
    { SystemRoot: 'D:\\Windows', TEMP: 'D:\\Temp', PATH: 'C:\\evil', SECRET_TOKEN: 'x' },
    'win32',
    'D:\\JARVIS\\bin\\whisper\\whisper-cli.exe'
  );
  assert.equal(windows.SystemRoot, 'D:\\Windows');
  assert.equal(windows.PATH, ['D:\\JARVIS\\bin\\whisper', 'D:\\Windows\\System32', 'D:\\Windows'].join(path.delimiter));
  assert.equal(windows.SECRET_TOKEN, undefined);
  assert.equal(windows.PATH.includes('C:\\evil'), false);

  const posix = sidecarEnvironment({ HOME: '/home/jarvis', SECRET_TOKEN: 'x' }, 'linux', '/opt/jarvis/whisper-cli');
  assert.equal(posix.PATH, ['/opt/jarvis', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter));
  assert.equal(posix.HOME, '/home/jarvis');
  assert.equal(posix.SECRET_TOKEN, undefined);
});

test('whisper sidecar: stdout parsing keeps transcript text and drops empty marker lines', () => {
  assert.equal(transcriptFromStdout('\r\n hello \r\n[BLANK_AUDIO]\n world\r\n'), 'hello world');
  assert.equal(transcriptFromStdout(''), '');
  assert.equal(transcriptFromStdout(null), '');
  assert.equal(transcriptFromStdout('a'.repeat(13000)).length, 12000);
});

test('whisper sidecar: non-speech glyphs and markers are never reported as a command', () => {
  assert.equal(transcriptFromStdout('♪♪♪\n'), '');
  assert.equal(transcriptFromStdout('[Music]\n...\n'), '');
  assert.equal(transcriptFromStdout('(silence)'), '');
  assert.equal(transcriptFromStdout('♪♪♪\nhello'), 'hello');
});
