/**
 * Shared local authentication helpers.
 *
 * PINs are never stored in plaintext. The auth file contains a PBKDF2-SHA256
 * hash and a random salt. `skipPin` is an explicit first-run opt-out, not a
 * credential and never a successful PIN verification.
 */

const fs = require('fs');
const path = require('path');
const { pbkdf2, randomBytes, timingSafeEqual } = require('crypto');

const AUTH_FILE = 'jarvis_auth.json';
const AUTH_BACKUP_FILE = `${AUTH_FILE}.bak`;
const AUTH_RATE_FILE = 'jarvis_auth_rate.json';
const PIN_RE = /^\d{4}$/;
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;

const AUTH_STATUS = Object.freeze({
  MISSING: 'missing',
  USABLE_PIN: 'usable-pin',
  EXPLICIT_SKIP: 'explicit-skip',
  CORRUPT: 'corrupt',
});

function authFilePath(userDataPath) {
  return path.join(userDataPath, AUTH_FILE);
}

function authBackupPath(userDataPath) {
  return path.join(userDataPath, AUTH_BACKUP_FILE);
}

function authRatePath(userDataPath) {
  return path.join(userDataPath, AUTH_RATE_FILE);
}

function isHex(value, length) {
  return typeof value === 'string'
    && value.length === length
    && /^[0-9a-f]+$/i.test(value);
}

function isUsablePinRecord(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.skipPin === true) return false;
  if (!isHex(data.hash, 64) || !isHex(data.salt, 64)) return false;
  // Reject placeholder values used by early development auth files.
  if (data.hash === 'dummy' || data.salt === 'dummy') return false;
  return true;
}

function isExplicitSkipRecord(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.skipPin !== true) return false;
  // A skipped record must not also contain PIN material. Contradictory records
  // are corrupt, not a shortcut into no-lock mode.
  return data.hash === undefined && data.salt === undefined;
}

function classifyAuthRecord(data) {
  if (isUsablePinRecord(data)) return AUTH_STATUS.USABLE_PIN;
  if (isExplicitSkipRecord(data)) return AUTH_STATUS.EXPLICIT_SKIP;
  return AUTH_STATUS.CORRUPT;
}

async function readRecord(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: true, exists: false, data: null };
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, exists: true, data };
  } catch (error) {
    return { ok: false, exists: true, data: null, error: error.message };
  }
}

async function readUsableBackup(userDataPath) {
  const backupPath = authBackupPath(userDataPath);
  const backup = await readRecord(backupPath);
  if (!backup.ok || !backup.exists || classifyAuthRecord(backup.data) !== AUTH_STATUS.USABLE_PIN) {
    return null;
  }
  return backup.data;
}

async function getAuthStatus(userDataPath) {
  return readAuth(userDataPath);
}

async function readAuth(userDataPath) {
  const filePath = authFilePath(userDataPath);
  const main = await readRecord(filePath);

  if (main.ok && main.exists) {
    const status = classifyAuthRecord(main.data);
    if (status === AUTH_STATUS.USABLE_PIN) {
      return {
        ok: true,
        status,
        exists: true,
        data: main.data,
        hasPin: true,
        skipPin: false,
        filePath,
        recoveredFromBackup: false,
      };
    }
    if (status === AUTH_STATUS.EXPLICIT_SKIP) {
      return {
        ok: true,
        status,
        exists: true,
        data: main.data,
        hasPin: false,
        skipPin: true,
        filePath,
        recoveredFromBackup: false,
      };
    }

    const backupData = await readUsableBackup(userDataPath);
    if (backupData) {
      return {
        ok: true,
        status: AUTH_STATUS.USABLE_PIN,
        exists: true,
        data: backupData,
        hasPin: true,
        skipPin: false,
        filePath,
        recoveredFromBackup: true,
      };
    }
    return {
      ok: false,
      status: AUTH_STATUS.CORRUPT,
      exists: true,
      data: null,
      hasPin: false,
      skipPin: false,
      filePath,
      error: main.error || 'Auth record is corrupt',
      recoveredFromBackup: false,
    };
  }

  if (main.ok && !main.exists) {
    // A missing live file plus a usable backup means the last atomic replace
    // was interrupted. Recover the last-known-good PIN rather than treating
    // the missing file as first-run setup. Explicit-skip records are not
    // recovered from backup: skip must be an explicit live choice.
    const backupData = await readUsableBackup(userDataPath);
    if (backupData) {
      return {
        ok: true,
        status: AUTH_STATUS.USABLE_PIN,
        exists: true,
        data: backupData,
        hasPin: true,
        skipPin: false,
        filePath,
        recoveredFromBackup: true,
      };
    }
    return {
      ok: true,
      status: AUTH_STATUS.MISSING,
      exists: false,
      data: null,
      hasPin: false,
      skipPin: false,
      filePath,
      recoveredFromBackup: false,
    };
  }

  const backupData = await readUsableBackup(userDataPath);
  if (backupData) {
    return {
      ok: true,
      status: AUTH_STATUS.USABLE_PIN,
      exists: true,
      data: backupData,
      hasPin: true,
      skipPin: false,
      filePath,
      recoveredFromBackup: true,
    };
  }
  return {
    ok: false,
    status: AUTH_STATUS.CORRUPT,
    exists: true,
    data: null,
    hasPin: false,
    skipPin: false,
    filePath,
    error: main.error || 'Auth file is unreadable',
    recoveredFromBackup: false,
  };
}

function hashPin(pin, salt) {
  return new Promise((resolve, reject) => {
    pbkdf2(String(pin), String(salt), 100000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

function hashesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length || left.length % 2 !== 0) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

async function verifyPin(userDataPath, pin) {
  const auth = await readAuth(userDataPath);
  if (!auth.ok) return { ok: false, status: auth.status, error: 'Auth file is unreadable' };
  if (auth.status === AUTH_STATUS.MISSING) return { ok: false, error: 'No auth file' };
  if (auth.status === AUTH_STATUS.EXPLICIT_SKIP) {
    return { ok: false, status: auth.status, error: 'PIN was explicitly skipped' };
  }
  if (auth.status !== AUTH_STATUS.USABLE_PIN || !isUsablePinRecord(auth.data)) {
    return { ok: false, status: AUTH_STATUS.CORRUPT, error: 'No usable PIN is configured' };
  }
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    return { ok: false, error: 'Invalid PIN format' };
  }
  const hash = await hashPin(pin, auth.data.salt);
  return hashesEqual(hash, auth.data.hash)
    ? { ok: true, recoveredFromBackup: auth.recoveredFromBackup === true }
    : { ok: false, error: 'Incorrect PIN' };
}

function tempPathFor(filePath) {
  return `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
}

async function writeDurableFile(filePath, content) {
  const handle = await fs.promises.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
  }
}

async function replaceFile(tempPath, finalPath) {
  try {
    await fs.promises.rename(tempPath, finalPath);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  }

  // Windows may reject rename-over-existing. The caller has already written a
  // last-known-good backup, so an interruption after removing the live file can
  // still recover through readAuth().
  const rollbackPath = `${finalPath}.rollback-${randomBytes(6).toString('hex')}`;
  let copiedCurrent = false;
  try {
    await fs.promises.copyFile(finalPath, rollbackPath);
    copiedCurrent = true;
  } catch { /* file may not exist yet */ }
  try {
    await fs.promises.rm(finalPath, { force: true });
    await fs.promises.rename(tempPath, finalPath);
    if (copiedCurrent) await fs.promises.rm(rollbackPath, { force: true });
  } catch (error) {
    if (copiedCurrent) {
      try { await fs.promises.copyFile(rollbackPath, finalPath); } catch { /* best effort */ }
    }
    try { await fs.promises.rm(rollbackPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

async function backupCurrent(filePath) {
  if (!fs.existsSync(filePath)) return;
  const current = await readRecord(filePath);
  if (!current.ok || !current.exists) return;
  // Do not overwrite a known-good backup with a corrupt live record.
  if (classifyAuthRecord(current.data) === AUTH_STATUS.CORRUPT) return;
  const backupPath = `${filePath}.bak`;
  const tempPath = tempPathFor(backupPath);
  try {
    await writeDurableFile(tempPath, JSON.stringify(current.data, null, 2));
    await replaceFile(tempPath, backupPath);
    await syncDirectory(path.dirname(backupPath));
  } catch {
    try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
  }
}

async function writeRecordAtomic(filePath, record, {
  validate = null,
  beforeReplace = null,
} = {}) {
  const directory = path.dirname(filePath);
  const tempPath = tempPathFor(filePath);
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await writeDurableFile(tempPath, JSON.stringify(record, null, 2));

    // Read back and validate the exact bytes before the live credential can be
    // replaced. A failure here leaves the previous auth file untouched.
    const writtenRaw = await fs.promises.readFile(tempPath, 'utf8');
    const written = JSON.parse(writtenRaw);
    if (typeof validate === 'function' && validate(written) !== true) {
      throw new Error('Written auth record failed validation');
    }

    await backupCurrent(filePath);
    if (typeof beforeReplace === 'function') {
      await beforeReplace({ tempPath, filePath });
    }
    await replaceFile(tempPath, filePath);
    await syncDirectory(directory);
    return { ok: true };
  } catch (error) {
    try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
    return { ok: false, error: error.message };
  }
}

async function writePin(userDataPath, pin, options = {}) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    return { ok: false, error: 'PIN must be exactly 4 digits' };
  }
  try {
    const salt = randomBytes(32).toString('hex');
    const hash = await hashPin(pin, salt);
    const filePath = authFilePath(userDataPath);
    const record = {
      version: 1,
      hash,
      salt,
      skipPin: false,
      updatedAt: new Date().toISOString(),
    };
    return await writeRecordAtomic(filePath, record, {
      validate: written => isUsablePinRecord(written)
        && written.hash === hash
        && written.salt === salt,
      beforeReplace: options.beforeReplace || null,
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function writeSkipPin(userDataPath, options = {}) {
  const filePath = authFilePath(userDataPath);
  return writeRecordAtomic(filePath, {
    version: 1,
    skipPin: true,
    updatedAt: new Date().toISOString(),
  }, {
    validate: written => isExplicitSkipRecord(written),
    beforeReplace: options.beforeReplace || null,
  });
}

async function resetAuth(userDataPath) {
  const filePath = authFilePath(userDataPath);
  const backupPath = authBackupPath(userDataPath);
  const ratePath = authRatePath(userDataPath);
  try {
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rm(backupPath, { force: true });
    await fs.promises.rm(ratePath, { force: true });
    try {
      const entries = await fs.promises.readdir(userDataPath);
      await Promise.all(entries
        .filter(name => name.startsWith(`${AUTH_FILE}.tmp-`) || name.startsWith(`${AUTH_FILE}.bak.tmp-`))
        .map(name => fs.promises.rm(path.join(userDataPath, name), { force: true })));
    } catch { /* best effort */ }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateRateRecord(data, maxAttempts) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.version !== 1 || !Array.isArray(data.failures)) return false;
  if (data.failures.length > maxAttempts) return false;
  return data.failures.every(value => Number.isFinite(value) && value > 0);
}

async function writeRateRecord(filePath, failures, now, maxAttempts) {
  const record = {
    version: 1,
    failures: failures.slice(-maxAttempts),
    updatedAt: new Date(now()).toISOString(),
  };
  const directory = path.dirname(filePath);
  const tempPath = tempPathFor(filePath);
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await writeDurableFile(tempPath, JSON.stringify(record, null, 2));
    const readBack = JSON.parse(await fs.promises.readFile(tempPath, 'utf8'));
    if (!validateRateRecord(readBack, maxAttempts)) {
      throw new Error('Rate limiter metadata failed validation');
    }
    await replaceFile(tempPath, filePath);
    await syncDirectory(directory);
    return true;
  } catch {
    try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/**
 * Persistent PIN failure limiter. A missing file is empty; a corrupt file is
 * fail-closed. If metadata cannot be written, the in-memory list remains active
 * and the caller is told the limiter is degraded.
 */
function createPinRateLimiter({
  userDataPath,
  now = () => Date.now(),
  maxAttempts = PIN_MAX_ATTEMPTS,
  windowMs = PIN_WINDOW_MS,
} = {}) {
  if (!userDataPath) throw new TypeError('userDataPath is required');
  const filePath = authRatePath(userDataPath);
  let memory = [];
  let degraded = false;

  function prune(values) {
    const cutoff = now() - windowMs;
    return values
      .filter(value => Number.isFinite(value) && value > cutoff && value <= now() + 1000)
      .sort((a, b) => a - b)
      .slice(-maxAttempts);
  }

  async function readState() {
    if (!fs.existsSync(filePath)) return { ok: true, failures: [] };
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!validateRateRecord(data, maxAttempts)) {
        return { ok: false, failures: [], error: 'Rate limiter metadata is invalid' };
      }
      return { ok: true, failures: prune(data.failures) };
    } catch (error) {
      return { ok: false, failures: [], error: 'Rate limiter metadata is unreadable' };
    }
  }

  async function check() {
    const persisted = await readState();
    if (!persisted.ok) {
      degraded = true;
      return Object.freeze({
        allowed: false,
        blocked: true,
        degraded: true,
        error: persisted.error,
        remaining: 0,
      });
    }
    // When persistence is healthy the file is authoritative. If a previous
    // write failed, memory contains the newer fail-closed list and must not be
    // replaced by the stale file.
    if (memory.length === 0 || degraded !== true) memory = prune(persisted.failures);
    else memory = prune(memory);
    const blocked = memory.length >= maxAttempts;
    return Object.freeze({
      allowed: !blocked,
      blocked,
      degraded,
      failures: memory.length,
      remaining: Math.max(0, maxAttempts - memory.length),
      retryAfterMs: blocked ? windowMs : 0,
    });
  }

  async function recordFailure() {
    const persisted = await readState();
    if (!persisted.ok) {
      degraded = true;
      return { ok: false, degraded: true, blocked: true, error: persisted.error };
    }
    if (memory.length === 0 || degraded !== true) memory = prune(persisted.failures);
    memory = prune([...memory, now()]);
    const written = await writeRateRecord(filePath, memory, now, maxAttempts);
    degraded = !written;
    return {
      ok: written,
      degraded,
      blocked: memory.length >= maxAttempts,
      failures: memory.length,
    };
  }

  async function clear() {
    const previous = memory.slice();
    memory = [];
    const written = await writeRateRecord(filePath, [], now, maxAttempts);
    degraded = !written;
    // A failed clear must not silently remove an active in-memory limit.
    if (!written) memory = previous;
    return { ok: written, degraded };
  }

  return Object.freeze({ check, recordFailure, clear, filePath });
}

module.exports = {
  AUTH_FILE,
  AUTH_BACKUP_FILE,
  AUTH_RATE_FILE,
  AUTH_STATUS,
  PIN_RE,
  PIN_MAX_ATTEMPTS,
  PIN_WINDOW_MS,
  authFilePath,
  authBackupPath,
  authRatePath,
  classifyAuthRecord,
  isUsablePinRecord,
  isExplicitSkipRecord,
  getAuthStatus,
  readAuth,
  hashPin,
  hashesEqual,
  verifyPin,
  writePin,
  writeSkipPin,
  resetAuth,
  createPinRateLimiter,
};
