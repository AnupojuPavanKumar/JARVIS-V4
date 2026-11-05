'use strict';

/**
 * Durable security audit log.
 *
 * Records are encrypted one-by-one with Electron safeStorage, written as
 * base64 JSONL, and chained with SHA-256. An encrypted head checkpoint makes a
 * truncated tail detectable. This is tamper-evident, not tamper-proof: a user
 * who controls this Windows account can delete the whole directory.
 *
 * The store never writes plaintext. If safeStorage is unavailable, rejected, or
 * fails during a write, it reports a memory-only failure so the caller can
 * disable the scoped capabilities that depend on audit evidence.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUDIT_DIR_NAME = 'security-audit';
const HEAD_FILE_NAME = 'audit-head.bin';
const AUDIT_FILE_RE = /^audit-(\d{8})(?:-(\d{2}))?\.jsonl$/;
const ZERO_HASH = '0'.repeat(64);
const DEFAULT_READ_LIMIT = 500;

const DEFAULTS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 7,
  maxTotalBytes: 35 * 1024 * 1024,
  readLimit: DEFAULT_READ_LIMIT,
  maxQueued: 1000,
  batchSize: 50,
});

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function formatDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    valid.getUTCFullYear(),
    String(valid.getUTCMonth() + 1).padStart(2, '0'),
    String(valid.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function recordHash(record) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      record.v,
      record.seq,
      record.ts,
      record.action,
      record.detail,
      record.verdict,
      record.prev,
    ]))
    .digest('hex');
}

function isValidRecord(record) {
  return !!record
    && record.v === 1
    && Number.isInteger(record.seq)
    && record.seq > 0
    && typeof record.ts === 'string'
    && typeof record.action === 'string'
    && typeof record.detail === 'string'
    && typeof record.verdict === 'string'
    && isHex64(record.prev)
    && isHex64(record.hash);
}

function createAuditLogStore({
  userDataPath,
  safeStorage,
  now = () => new Date(),
  logger = console,
  onFailure = null,
  maxFileBytes = DEFAULTS.maxFileBytes,
  maxFiles = DEFAULTS.maxFiles,
  maxTotalBytes = DEFAULTS.maxTotalBytes,
  readLimit = DEFAULTS.readLimit,
  maxQueued = DEFAULTS.maxQueued,
  batchSize = DEFAULTS.batchSize,
} = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath.trim()) {
    throw new Error('An audit userData path is required');
  }

  const directory = path.join(userDataPath, AUDIT_DIR_NAME);
  const headPath = path.join(directory, HEAD_FILE_NAME);
  const limits = Object.freeze({
    maxFileBytes: positiveInteger(maxFileBytes, DEFAULTS.maxFileBytes),
    maxFiles: positiveInteger(maxFiles, DEFAULTS.maxFiles),
    maxTotalBytes: positiveInteger(maxTotalBytes, DEFAULTS.maxTotalBytes),
    readLimit: positiveInteger(readLimit, DEFAULTS.readLimit),
    maxQueued: positiveInteger(maxQueued, DEFAULTS.maxQueued),
    batchSize: positiveInteger(batchSize, DEFAULTS.batchSize),
  });

  const queue = [];
  let initialized = false;
  let initializing = null;
  let durable = false;
  let mode = 'starting';
  let reason = null;
  let warning = null;
  let integrity = 'starting';
  let failureReported = false;
  let preInitOverflow = false;
  let scheduled = null;
  let currentFile = null;
  let currentSize = 0;
  let lastSeq = 0;
  let lastHash = ZERO_HASH;
  let lastWrite = null;
  let chainReset = false;

  function currentIso() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString();
  }

  function safeLog(level, message) {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message);
    } catch {
      /* logging must never break auditing */
    }
  }

  function encryptionCheck() {
    try {
      if (!safeStorage
        || typeof safeStorage.isEncryptionAvailable !== 'function'
        || typeof safeStorage.encryptString !== 'function'
        || typeof safeStorage.decryptString !== 'function') {
        return { ok: false, reason: 'OS-backed encryption is unavailable' };
      }
      if (safeStorage.isEncryptionAvailable() !== true) {
        return { ok: false, reason: 'OS-backed encryption is unavailable' };
      }
      if (typeof safeStorage.getSelectedStorageBackend === 'function'
        && safeStorage.getSelectedStorageBackend() === 'basic_text') {
        return { ok: false, reason: 'OS-backed encryption is unavailable (basic_text backend)' };
      }
      return { ok: true, reason: null };
    } catch (error) {
      return { ok: false, reason: error.message || 'OS-backed encryption check failed' };
    }
  }

  function encryptJson(value) {
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  }

  function decryptJson(line) {
    const raw = Buffer.from(line, 'base64').toString('base64');
    if (raw !== line) {
      // Tolerate harmless whitespace, but reject lines that are not base64.
      const normalized = String(line).replace(/\s+/g, '');
      if (Buffer.from(normalized, 'base64').toString('base64').replace(/=+$/, '')
        !== normalized.replace(/=+$/, '')) {
        throw new Error('Audit line is not valid base64');
      }
    }
    return JSON.parse(safeStorage.decryptString(Buffer.from(line, 'base64')));
  }

  function listAuditFiles() {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = AUDIT_FILE_RE.exec(entry.name);
      if (!match) continue;
      const filePath = path.join(directory, entry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      files.push({
        name: entry.name,
        path: filePath,
        day: match[1],
        part: match[2] ? Number(match[2]) : 0,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
    files.sort((left, right) => {
      if (left.day !== right.day) return left.day < right.day ? -1 : 1;
      return left.part - right.part;
    });
    return files;
  }

  function fileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  function readHead() {
    try {
      if (!fs.existsSync(headPath)) return { ok: false, reason: 'missing' };
      const raw = fs.readFileSync(headPath);
      const head = JSON.parse(safeStorage.decryptString(raw));
      if (!head
        || head.v !== 1
        || !Number.isInteger(head.seq)
        || head.seq < 0
        || !isHex64(head.hash)) {
        return { ok: false, reason: 'invalid checkpoint' };
      }
      return { ok: true, head };
    } catch (error) {
      return { ok: false, reason: error.message || 'unreadable checkpoint' };
    }
  }

  function writeHead() {
    if (!currentFile) return;
    const head = {
      v: 1,
      file: path.basename(currentFile),
      seq: lastSeq,
      hash: lastHash,
      updatedAt: currentIso(),
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(head));
    const tempPath = `${headPath}.tmp`;
    fs.writeFileSync(tempPath, encrypted, { mode: 0o600 });
    try {
      fs.renameSync(tempPath, headPath);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
        fs.rmSync(headPath, { force: true });
        fs.renameSync(tempPath, headPath);
      } else {
        throw error;
      }
    }
  }

  function buildRecord(entry) {
    const seq = lastSeq + 1;
    const prev = lastHash || ZERO_HASH;
    const record = {
      v: 1,
      seq,
      ts: typeof entry.ts === 'string' && entry.ts ? entry.ts : currentIso(),
      action: entry.action,
      detail: entry.detail,
      verdict: entry.verdict,
      prev,
    };
    record.hash = recordHash(record);
    lastSeq = seq;
    lastHash = record.hash;
    return record;
  }

  function chooseFilePath(day, { rotate = false } = {}) {
    const basePath = path.join(directory, `audit-${day}.jsonl`);
    const files = listAuditFiles().filter(file => file.day === day);
    if (files.length === 0) return basePath;
    const maxPart = files.reduce((max, file) => Math.max(max, file.part), 0);
    const nextPart = maxPart + 1;
    if (nextPart > 99) {
      throw new Error('Daily audit rotation limit reached');
    }
    return path.join(directory, `audit-${day}-${String(nextPart).padStart(2, '0')}.jsonl`);
  }

  function ensureFileForNextRecord() {
    const day = formatDay(now());
    if (!currentFile) {
      currentFile = chooseFilePath(day);
      currentSize = fileSize(currentFile);
      return { rotated: false, reason: null };
    }

    const match = AUDIT_FILE_RE.exec(path.basename(currentFile));
    const fileDay = match ? match[1] : null;
    if (fileDay !== day) {
      const previous = currentFile;
      currentFile = chooseFilePath(day);
      currentSize = fileSize(currentFile);
      return { rotated: true, reason: `date changed to ${day}; previous file ${path.basename(previous)}` };
    }
    if (currentSize >= limits.maxFileBytes) {
      const previous = currentFile;
      currentFile = chooseFilePath(day);
      currentSize = fileSize(currentFile);
      return { rotated: true, reason: `size limit reached in ${path.basename(previous)}` };
    }
    return { rotated: false, reason: null };
  }

  function appendRecord(record) {
    if (!currentFile) throw new Error('No audit file is selected');
    const line = `${encryptJson(record)}\n`;
    fs.appendFileSync(currentFile, line, { mode: 0o600 });
    currentSize += Buffer.byteLength(line, 'utf8');
    if (record.ts) lastWrite = record.ts;
  }

  function appendSystemRecord(action, detail, verdict, { rotate = true } = {}) {
    if (rotate) {
      const prepared = ensureFileForNextRecord();
      if (prepared.rotated) {
        appendRecord(buildRecord({
          ts: currentIso(),
          action: 'AUDIT_ROTATE',
          detail: prepared.reason,
          verdict: 'ROTATED',
        }));
      }
    }
    appendRecord(buildRecord({
      ts: currentIso(),
      action,
      detail,
      verdict,
    }));
  }

  function decodeRecord(line) {
    let record;
    try {
      record = decryptJson(line);
    } catch {
      return null;
    }
    if (!isValidRecord(record)) return null;
    if (recordHash(record) !== record.hash) return null;
    return record;
  }

  function findLastRecord(file) {
    let content;
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch {
      return null;
    }
    const lines = content.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const record = decodeRecord(line);
      if (record) return { record, filePath: file.path };
    }
    return null;
  }

  function pruneIfNeeded() {
    const files = listAuditFiles();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let deleted = [];

    while (files.length > limits.maxFiles || total > limits.maxTotalBytes) {
      const index = files.findIndex(file => file.path !== currentFile);
      if (index === -1) break;
      const [oldest] = files.splice(index, 1);
      try {
        fs.rmSync(oldest.path, { force: true });
        total -= oldest.size;
        deleted.push(oldest.name);
      } catch (error) {
        safeLog('warn', `[AUDIT] Could not prune ${oldest.name}: ${error.message}`);
        break;
      }
    }

    return deleted;
  }

  function status() {
    let files = [];
    try {
      files = listAuditFiles();
    } catch {
      files = [];
    }
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const memoryMode = initialized && !durable;
    return Object.freeze({
      durable: initialized ? durable : false,
      mode,
      initialized,
      reason,
      warning,
      integrity,
      files: files.length,
      bytes,
      lastWrite,
      directory: AUDIT_DIR_NAME,
      readLimit: limits.readLimit,
      maxFileBytes: limits.maxFileBytes,
      maxFiles: limits.maxFiles,
      maxTotalBytes: limits.maxTotalBytes,
    });
  }

  function fail(error, context) {
    if (failureReported) return;
    failureReported = true;
    durable = false;
    mode = 'memory';
    integrity = 'unavailable';
    const message = error && error.message ? error.message : String(error || 'unknown audit failure');
    reason = context ? `${context}: ${message}` : message;
    warning = `Durable audit logging is unavailable (${reason}). Terminal, screen capture, and export saving are disabled.`;
    queue.length = 0;
    if (scheduled) {
      clearImmediate(scheduled);
      scheduled = null;
    }
    safeLog('error', `[AUDIT] ${warning}`);
    try {
      if (typeof onFailure === 'function') onFailure(new Error(reason), status());
    } catch (callbackError) {
      safeLog('error', `[AUDIT] Failure callback error: ${callbackError.message}`);
    }
  }

  function loadState() {
    const head = readHead();
    const files = listAuditFiles();
    let last = null;

    for (let index = files.length - 1; index >= 0; index -= 1) {
      last = findLastRecord(files[index]);
      if (last) break;
    }

    if (last) {
      lastSeq = last.record.seq;
      lastHash = last.record.hash;
      lastWrite = last.record.ts;
      chainReset = false;
    } else {
      lastSeq = 0;
      lastHash = ZERO_HASH;
      chainReset = files.length > 0;
    }

    if (files.length > 0) {
      const newest = files[files.length - 1];
      currentFile = newest.path;
      currentSize = newest.size;
    } else {
      currentFile = null;
      currentSize = 0;
    }

    integrity = 'ok';
    warning = null;

    if (head.ok) {
      if (!last) {
        if (head.seq > 0) {
          integrity = 'truncated';
          warning = 'The audit head checkpoint is newer than the newest readable record; the log may have been truncated.';
        }
      } else if (head.head.seq === lastSeq && head.head.hash === lastHash) {
        integrity = 'ok';
      } else if (head.head.seq > lastSeq) {
        integrity = 'truncated';
        warning = 'The audit head checkpoint is newer than the newest readable record; the log may have been truncated.';
      } else {
        integrity = 'suspect';
        warning = 'The audit head checkpoint does not match the newest readable record; possible modification or corruption.';
      }
    } else if (files.length > 0) {
      integrity = 'suspect';
      warning = 'The audit head checkpoint is missing or unreadable; integrity was rebuilt from retained records.';
    }

    if (chainReset) {
      integrity = integrity === 'ok' ? 'reset' : integrity;
      warning = warning || 'No readable prior chain was found; a new audit chain will be started.';
    }
  }

  function flushSync() {
    if (!initialized || !durable) {
      if (initialized && !durable) queue.length = 0;
      return status();
    }
    if (queue.length === 0) return status();

    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

      if (chainReset) {
        const prepared = ensureFileForNextRecord();
        if (prepared.rotated) {
          appendRecord(buildRecord({
            ts: currentIso(),
            action: 'AUDIT_ROTATE',
            detail: prepared.reason,
            verdict: 'ROTATED',
          }));
        }
        appendRecord(buildRecord({
          ts: currentIso(),
          action: 'AUDIT_CHAIN_RESET',
          detail: 'no readable prior chain was available; a new audit chain was started',
          verdict: 'WARN',
        }));
        chainReset = false;
      }

      let processed = 0;
      while (queue.length > 0 && durable) {
        const entry = queue.shift();
        const prepared = ensureFileForNextRecord();
        if (prepared.rotated) {
          appendRecord(buildRecord({
            ts: currentIso(),
            action: 'AUDIT_ROTATE',
            detail: prepared.reason,
            verdict: 'ROTATED',
          }));
        }
        appendRecord(buildRecord(entry));
        processed += 1;
        if (processed % limits.batchSize === 0) writeHead();
      }

      writeHead();
      const deleted = pruneIfNeeded();
      if (deleted.length > 0) {
        appendSystemRecord(
          'AUDIT_PRUNE',
          `removed ${deleted.length} file(s): ${deleted.join(', ')}`,
          'PRUNED',
          { rotate: false }
        );
        writeHead();
      }
    } catch (error) {
      fail(error, 'write');
    }

    return status();
  }

  function scheduleFlush() {
    if (scheduled || !initialized || !durable) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (initialized && durable && queue.length > 0) flushSync();
    });
    if (scheduled && typeof scheduled.unref === 'function') scheduled.unref();
  }

  function append(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const normalized = {
      ts: typeof entry.ts === 'string' && entry.ts ? entry.ts : currentIso(),
      action: String(entry.action == null ? '' : entry.action),
      detail: String(entry.detail == null ? '' : entry.detail),
      verdict: String(entry.verdict == null ? '' : entry.verdict),
    };

    if (!initialized) {
      if (queue.length >= limits.maxQueued) {
        preInitOverflow = true;
        return false;
      }
      queue.push(normalized);
      return true;
    }
    if (!durable) return false;
    if (queue.length >= limits.maxQueued) {
      fail(new Error('Audit queue overflow'), 'queue');
      return false;
    }

    queue.push(normalized);
    if (queue.length >= limits.batchSize) {
      flushSync();
    } else {
      scheduleFlush();
    }
    return durable;
  }

  async function init() {
    if (initialized) return status();
    if (initializing) return initializing;

    initializing = (async () => {
      const encryption = encryptionCheck();
      if (!encryption.ok) {
        initialized = true;
        fail(new Error(encryption.reason), 'encryption');
        return status();
      }
      if (preInitOverflow) {
        initialized = true;
        fail(new Error('Audit queue overflow before initialization'), 'startup');
        return status();
      }

      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        loadState();
        initialized = true;
        durable = true;
        mode = 'durable';
        if (queue.length > 0) flushSync();
      } catch (error) {
        initialized = true;
        fail(error, 'initialize');
      }
      return status();
    })().finally(() => {
      initializing = null;
    });

    return initializing;
  }

  async function flush() {
    flushSync();
    return status();
  }

  function read(options = {}) {
    flushSync();
    if (!initialized) {
      return {
        ok: false,
        durable: false,
        integrity,
        warning: 'The audit log is still starting',
        entries: [],
        data: '',
        error: 'The audit log is not initialized',
      };
    }
    if (!durable) {
      return {
        ok: false,
        durable: false,
        integrity: 'unavailable',
        warning,
        entries: [],
        data: '',
        error: reason || 'Durable audit logging is unavailable',
      };
    }

    try {
      const requested = options && options.limit != null ? options.limit : limits.readLimit;
      const limit = Math.min(
        Math.max(1, Number.isFinite(Number(requested)) ? Math.floor(Number(requested)) : limits.readLimit),
        5000
      );
      const files = listAuditFiles();
      const collected = [];
      let corruptLines = 0;
      let suspect = false;
      let expectedHash = null;
      let expectedSeq = null;
      let truncated = false;
      let headRebuilt = false;

      outer:
      for (let fileIndex = files.length - 1; fileIndex >= 0; fileIndex -= 1) {
        const file = files[fileIndex];
        let content;
        try {
          content = fs.readFileSync(file.path, 'utf8');
        } catch {
          corruptLines += 1;
          suspect = true;
          continue;
        }
        const lines = content.split('\n');
        for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
          const line = lines[lineIndex].trim();
          if (!line) continue;
          let record;
          try {
            record = decryptJson(line);
          } catch {
            corruptLines += 1;
            suspect = true;
            continue;
          }
          if (!isValidRecord(record) || recordHash(record) !== record.hash) {
            corruptLines += 1;
            suspect = true;
            continue;
          }
          if (expectedHash !== null && record.hash !== expectedHash) suspect = true;
          if (expectedSeq !== null && record.seq !== expectedSeq) suspect = true;
          collected.push(record);
          expectedHash = record.prev;
          expectedSeq = record.seq - 1;
          if (collected.length >= limit + 1) break outer;
        }
      }

      const newest = collected.length > 0 ? collected[0] : null;
      const head = readHead();
      if (head.ok) {
        if (newest) {
          if (head.head.seq > newest.seq) {
            truncated = true;
          } else if (head.head.seq !== newest.seq || head.head.hash !== newest.hash) {
            suspect = true;
          }
        } else if (head.head.seq > 0) {
          truncated = true;
        }
      } else if (files.length > 0) {
        headRebuilt = true;
        suspect = true;
      }

      if (collected.length === 0 && files.length > 0) suspect = true;

      const entries = collected.slice(0, limit).reverse();
      const hasReset = entries.some(entry => entry.action === 'AUDIT_CHAIN_RESET');
      let readIntegrity = 'ok';
      if (truncated) readIntegrity = 'truncated';
      else if (suspect) readIntegrity = 'suspect';
      else if (hasReset) readIntegrity = 'reset';

      const warnings = [];
      if (truncated) {
        warnings.push('The audit head checkpoint is newer than the newest readable record; the log may have been truncated.');
      }
      if (suspect) {
        warnings.push('Possible modification or corruption was detected in the audit log.');
      }
      if (headRebuilt) {
        warnings.push('The audit head checkpoint is missing or unreadable; integrity was rebuilt from retained records.');
      }
      if (corruptLines > 0) {
        warnings.push(`${corruptLines} corrupt audit line(s) were skipped.`);
      }
      if (hasReset) {
        warnings.push('A new audit chain was started after no readable prior chain was available.');
      }
      const readWarning = warnings.length > 0 ? warnings.join(' ') : null;

      integrity = readIntegrity;
      warning = readWarning;
      if (newest && newest.ts) lastWrite = newest.ts;
      const bytes = files.reduce((sum, file) => sum + file.size, 0);

      return {
        ok: true,
        durable: true,
        mode,
        integrity: readIntegrity,
        warning: readWarning,
        corruptLines,
        entries,
        data: entries
          .map(entry => `[${entry.ts}] [${entry.verdict}] ${entry.action}: ${entry.detail}`)
          .join('\n'),
        files: files.length,
        bytes,
        lastWrite,
        readLimit: limit,
      };
    } catch (error) {
      return {
        ok: false,
        durable,
        integrity: 'unavailable',
        warning: `The audit log could not be read: ${error.message}`,
        entries: [],
        data: '',
        error: error.message,
      };
    }
  }

  function dispose() {
    if (scheduled) {
      clearImmediate(scheduled);
      scheduled = null;
    }
  }

  return Object.freeze({
    init,
    append,
    flush,
    flushSync,
    read,
    status,
    dispose,
  });
}

module.exports = {
  AUDIT_DIR_NAME,
  DEFAULT_READ_LIMIT,
  DEFAULTS,
  createAuditLogStore,
};
