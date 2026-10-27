'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Main-owned project capability registry.
//
// A project token is generated in main, never derived from a renderer path. All
// project reads and command cwd resolution go through resolve(), which verifies
// the project ID and token, rejects path syntax that cannot be represented
// inside a project, rejects symlinks at every component, and confirms the
// canonical target remains below the canonical project root.

const MAX_RELATIVE_PATH_LENGTH = 4096;

function pathError(message) {
  return { ok: false, error: message };
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isUncOrDevicePath(value) {
  return /^[\\/]{2}/.test(value) || /^[\\/]\?[\\/]/.test(value) || /^[\\/]\.([\\/]|$)/.test(value);
}

function normalizeRelativePath(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return pathError('Relative path must be a string');
  const raw = value.trim();
  if (!raw && !allowEmpty) return pathError('Relative path is required');
  if (raw.length > MAX_RELATIVE_PATH_LENGTH) return pathError('Relative path is too long');
  if (hasControlCharacters(raw)) return pathError('Relative path contains unsafe characters');

  const normalized = raw.replace(/\\/g, '/');
  if (isUncOrDevicePath(normalized)) return pathError('UNC and device paths are not allowed');
  if (normalized.includes(':')) return pathError('Alternate data streams and drive paths are not allowed');
  if (normalized.startsWith('/')) return pathError('Absolute paths are not allowed');

  const segments = normalized.split('/').filter(segment => segment.length > 0);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return pathError('Path traversal is not allowed');
  }
  return { ok: true, relativePath: segments.join('/'), segments };
}

function canonicalDirectory(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new Error('Project root is required');
  }
  if (hasControlCharacters(rootPath) || isUncOrDevicePath(rootPath)) {
    throw new Error('UNC and device project roots are not allowed');
  }
  if (!path.isAbsolute(rootPath)) throw new Error('Project root must be absolute');
  const real = fs.realpathSync.native(rootPath);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) throw new Error('Project root is not a directory');
  return real;
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function rejectSymlinks(rootPath, segments) {
  let current = rootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return pathError(error.code === 'ENOENT' ? 'Path does not exist' : 'Path could not be inspected');
    }
    if (stat.isSymbolicLink()) return pathError('Symbolic links are not allowed');
  }
  return { ok: true, targetPath: current };
}

function createProjectRegistry({
  audit = () => {},
  maxProjects = 1,
  tokenBytes = 32,
  now = () => Date.now(),
} = {}) {
  const projects = new Map();

  function close(projectId, token, reason = 'project closed') {
    const record = get(projectId, token);
    if (!record) return false;
    projects.delete(record.projectId);
    audit('PROJECT_CLOSE', `${record.name} (${reason})`, 'OK');
    return true;
  }

  function closeAll(reason = 'project boundary') {
    let count = 0;
    for (const record of projects.values()) {
      projects.delete(record.projectId);
      audit('PROJECT_CLOSE', `${record.name} (${reason})`, 'OK');
      count += 1;
    }
    return count;
  }

  function open(rootPath, { name = '', readOnly = true } = {}) {
    const root = canonicalDirectory(rootPath);
    while (projects.size >= Math.max(1, maxProjects)) {
      const oldest = projects.values().next().value;
      if (!oldest) break;
      projects.delete(oldest.projectId);
      audit('PROJECT_CLOSE', `${oldest.name} (replaced)`, 'OK');
    }

    const projectId = `prj_${crypto.randomBytes(12).toString('hex')}`;
    const token = crypto.randomBytes(tokenBytes).toString('hex');
    const record = Object.freeze({
      projectId,
      token,
      name: typeof name === 'string' && name.trim() ? name.trim() : path.basename(root),
      rootPath: root,
      readOnly: readOnly !== false,
      openedAt: new Date(now()).toISOString(),
    });
    projects.set(projectId, record);
    audit('PROJECT_OPEN', `${record.name} (${root})`, 'ALLOWED');
    return record;
  }

  function get(projectId, token) {
    if (typeof projectId !== 'string' || typeof token !== 'string') return null;
    const record = projects.get(projectId);
    if (!record) return null;
    const expected = Buffer.from(record.token, 'utf8');
    const supplied = Buffer.from(token, 'utf8');
    if (expected.length !== supplied.length) return null;
    if (!crypto.timingSafeEqual(expected, supplied)) return null;
    return record;
  }

  function resolve(projectId, token, relativePath, { allowEmpty = true } = {}) {
    const record = get(projectId, token);
    if (!record) return pathError('Project is not open or the token is invalid');
    const normalized = normalizeRelativePath(relativePath, { allowEmpty });
    if (!normalized.ok) return normalized;

    let candidate = record.rootPath;
    if (normalized.segments.length) {
      const checked = rejectSymlinks(record.rootPath, normalized.segments);
      if (!checked.ok) return checked;
      candidate = checked.targetPath;
    }

    let realTarget;
    try {
      realTarget = fs.realpathSync.native(candidate);
    } catch (_) {
      return pathError('Path could not be resolved');
    }
    if (!isInside(record.rootPath, realTarget)) {
      return pathError('Path is outside the approved project');
    }
    return { ok: true, record, targetPath: realTarget, relativePath: normalized.relativePath };
  }

  function active() {
    let last = null;
    for (const record of projects.values()) last = record;
    return last;
  }

  function size() {
    return projects.size;
  }

  return Object.freeze({
    open,
    get,
    resolve,
    close,
    closeAll,
    active,
    size,
  });
}

module.exports = {
  createProjectRegistry,
  normalizeRelativePath,
  isInside,
  isUncOrDevicePath,
  MAX_RELATIVE_PATH_LENGTH,
};
