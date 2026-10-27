'use strict';

const path = require('path');
const fs = require('fs');
const { dialog } = require('electron');
const { isSecretProjectFile } = require('../security/secret-files');
const { isInside } = require('../security/project-registry');

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_FILES = 50;
const MAX_PROJECT_TOTAL_BYTES = 1024 * 1024;
const MAX_PROJECT_DEPTH = 12;
const MAX_PROJECT_ENTRIES = 20000;
const MAX_DOC_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_RENDERER_LOG_BYTES = 256 * 1024;

const ALLOWED_DOC_EXTS = new Set(['.pdf', '.txt', '.md', '.json']);
const ALLOWED_PROJECT_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.json', '.yaml', '.yml', '.toml',
  '.html', '.css', '.scss', '.less', '.svelte', '.vue',
  '.md', '.txt', '.sh', '.ps1', '.bat',
]);
const IGNORE_PROJECT_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next',
  'coverage', '.cache', '.idea', '.vscode',
]);
const ALLOWED_BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg',
]);
const MIME_MAP = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch (_) {
    return path.resolve(filePath);
  }
}

function isProbablyText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  if (!sample) return true;
  const replacementCount = (sample.match(/\uFFFD/g) || []).length;
  return replacementCount / sample.length < 0.02;
}

module.exports = function registerFileController({
  ipcMain,
  app,
  mainWindowProvider,
  secAudit,
  projectRegistry,
  nativeDialog = dialog,
}) {
  if (!projectRegistry || typeof projectRegistry.resolve !== 'function') {
    throw new TypeError('projectRegistry is required');
  }

  const dialogHost = () => {
    const win = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
    return win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) ? win : null;
  };

  async function readBounded(filePath, maxSize) {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) throw new Error('Not a regular file');
      if (stat.size > maxSize) throw new Error('File too large');

      const buffer = Buffer.alloc(maxSize + 1);
      const { bytesRead } = await fd.read(buffer, 0, maxSize + 1, 0);
      if (bytesRead > maxSize) throw new Error('File too large');
      return buffer.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  }

  // Renderer diagnostics are written to one fixed main-owned path. There is no
  // renderer-selected path and no general fs-write bridge.
  ipcMain.handle('renderer-log-write', async (_, content) => {
    try {
      if (typeof content !== 'string') return { ok: false, error: 'Log content must be a string' };
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > MAX_RENDERER_LOG_BYTES) return { ok: false, error: 'Log content is too large' };
      const logPath = path.join(app.getPath('userData'), 'renderer_errors.log');
      await fs.promises.appendFile(logPath, bytes);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('fs-dialog-save', async (_, defaultName, content) => {
    const mainWindow = dialogHost();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await nativeDialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || 'jarvis-export.md',
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'JSON', extensions: ['json'] },
      ]
    });
    if (!result.canceled && result.filePath) {
      await fs.promises.writeFile(result.filePath, content, 'utf8');
      return { ok: true, filePath: result.filePath };
    }
    return { ok: false };
  });

  const allowedDocumentPaths = new Set();
  const allowedImagePaths = new Set();

  ipcMain.handle('fs-dialog-open-doc', async () => {
    const mainWindow = dialogHost();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await nativeDialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'json'] }
      ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const selected = canonicalPath(result.filePaths[0]);
      allowedDocumentPaths.add(selected);
      return { ok: true, filePath: selected };
    }
    return { ok: false };
  });

  ipcMain.handle('read-pdf', async (_, filePath) => {
    try {
      if (typeof filePath !== 'string' || !allowedDocumentPaths.has(filePath)) {
        return { ok: false, error: 'Read refused: file was not selected via dialog.' };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_DOC_EXTS.has(ext)) return { ok: false, error: 'Invalid extension' };

      const dataBuffer = await readBounded(filePath, MAX_DOC_SIZE);
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: dataBuffer });
      let data;
      try {
        data = await parser.getText();
      } finally {
        await parser.destroy();
      }
      return { ok: true, text: data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('read-text-doc', async (_, filePath) => {
    try {
      if (typeof filePath !== 'string' || !allowedDocumentPaths.has(filePath)) {
        return { ok: false, error: 'Read refused: file was not selected via dialog.' };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_DOC_EXTS.has(ext)) return { ok: false, error: 'Invalid extension' };

      const dataBuffer = await readBounded(filePath, MAX_DOC_SIZE);
      if (!isProbablyText(dataBuffer)) return { ok: false, error: 'Document does not appear to be text' };
      return { ok: true, data: dataBuffer.toString('utf8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Image data is readable only for the exact canonical path selected through
  // the native image picker. A renderer cannot supply an arbitrary path.
  ipcMain.handle('fs-read-binary', async (_, filePath) => {
    try {
      if (typeof filePath !== 'string' || !allowedImagePaths.has(filePath)) {
        secAudit('FS_READ_BINARY', String(filePath).slice(0, 300), 'BLOCKED - not selected via dialog');
        return { ok: false, error: 'Read refused: image was not selected via dialog.' };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_BINARY_EXTS.has(ext)) {
        secAudit('FS_READ_BINARY', filePath, 'BLOCKED - extension not allowed');
        return { ok: false, error: `File type not allowed: ${ext}` };
      }
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, error: 'Read refused: not a regular file' };
      }
      if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: 'Image is too large' };

      const data = await readBounded(filePath, MAX_IMAGE_BYTES);
      secAudit('FS_READ_BINARY', filePath, 'ALLOWED');
      return { ok: true, data: data.toString('base64'), mimeType: MIME_MAP[ext] || 'application/octet-stream' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('open-image-dialog', async () => {
    const mainWindow = dialogHost();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await nativeDialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }
      ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const selected = canonicalPath(result.filePaths[0]);
      allowedImagePaths.add(selected);
      return { ok: true, filePath: selected };
    }
    return { ok: false };
  });

  // ─── Main-owned project context ───────────────────────────────────
  const projectScans = new Map();

  async function scanProject(record) {
    const root = record.rootPath;
    const files = [];
    let totalBytes = 0;
    let excludedCount = 0;
    let skippedCount = 0;
    let visitedEntries = 0;
    let truncated = false;
    let stopped = false;

    async function walk(directory, relativeBase, depth) {
      if (stopped) return;
      if (depth > MAX_PROJECT_DEPTH) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (_) {
        skippedCount += 1;
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (stopped) return;
        if (files.length >= MAX_PROJECT_FILES || totalBytes >= MAX_PROJECT_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        visitedEntries += 1;
        if (visitedEntries > MAX_PROJECT_ENTRIES) {
          truncated = true;
          stopped = true;
          return;
        }

        const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          skippedCount += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORE_PROJECT_DIRS.has(entry.name)) continue;
          if (isSecretProjectFile(relativePath)) {
            excludedCount += 1;
            continue;
          }
          if (entry.name.startsWith('.')) continue;
          await walk(path.join(directory, entry.name), relativePath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isSecretProjectFile(relativePath)) {
          excludedCount += 1;
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_PROJECT_EXTS.has(ext)) continue;

        const fullPath = path.join(directory, entry.name);
        let stat;
        try {
          stat = await fs.promises.lstat(fullPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            skippedCount += 1;
            continue;
          }
          const real = await fs.promises.realpath(fullPath);
          if (!isInside(root, real)) {
            skippedCount += 1;
            continue;
          }
        } catch (_) {
          skippedCount += 1;
          continue;
        }

        if (stat.size > MAX_FILE_BYTES) {
          skippedCount += 1;
          truncated = true;
          continue;
        }
        if (totalBytes + stat.size > MAX_PROJECT_TOTAL_BYTES) {
          truncated = true;
          stopped = true;
          return;
        }

        let buffer;
        try {
          buffer = await readBounded(fullPath, MAX_FILE_BYTES);
        } catch (_) {
          skippedCount += 1;
          continue;
        }
        if (!isProbablyText(buffer)) {
          skippedCount += 1;
          continue;
        }

        files.push({
          relativePath,
          size: buffer.length,
          content: buffer.toString('utf8'),
        });
        totalBytes += buffer.length;
      }
    }

    await walk(root, '', 0);
    return {
      projectId: record.projectId,
      name: record.name,
      rootPath: record.rootPath,
      files,
      fileCount: files.length,
      totalBytes,
      excludedCount,
      skippedCount,
      truncated,
    };
  }

  function verifyProject(payload = {}) {
    if (!payload || typeof payload !== 'object') return null;
    return projectRegistry.get(payload.projectId, payload.token);
  }

  ipcMain.handle('project-open', async () => {
    const mainWindow = dialogHost();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await nativeDialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Open project folder',
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };

    let record = null;
    try {
      record = projectRegistry.open(result.filePaths[0]);
      const model = await scanProject(record);
      projectScans.clear();
      projectScans.set(record.projectId, model);
      secAudit(
        'PROJECT_OPEN',
        `${model.name}: ${model.fileCount} files, ${model.totalBytes} bytes, ${model.excludedCount} excluded`,
        model.truncated ? 'ALLOWED - truncated' : 'ALLOWED'
      );
      return {
        ok: true,
        ...model,
        token: record.token,
        readOnly: record.readOnly,
      };
    } catch (error) {
      if (record) {
        try { projectRegistry.close(record.projectId, record.token, 'open failed'); } catch (_) {}
      }
      secAudit('PROJECT_OPEN', error.message, 'BLOCKED');
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('project-list', async (_, payload = {}) => {
    const record = verifyProject(payload);
    if (!record) return { ok: false, error: 'Project is not open or the token is invalid' };
    let model = projectScans.get(record.projectId);
    if (!model) {
      try {
        model = await scanProject(record);
        projectScans.set(record.projectId, model);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    return {
      ok: true,
      ...model,
      readOnly: record.readOnly,
    };
  });

  ipcMain.handle('project-read-file', async (_, payload = {}) => {
    const record = verifyProject(payload);
    if (!record) {
      secAudit('PROJECT_READ', 'invalid project token', 'BLOCKED');
      return { ok: false, error: 'Project is not open or the token is invalid' };
    }

    const resolved = projectRegistry.resolve(
      record.projectId,
      record.token,
      payload.relativePath,
      { allowEmpty: false }
    );
    if (!resolved.ok) {
      secAudit('PROJECT_READ', String(payload.relativePath).slice(0, 300), `BLOCKED - ${resolved.error}`);
      return resolved;
    }
    if (isSecretProjectFile(resolved.relativePath)) {
      secAudit('PROJECT_READ', resolved.relativePath, 'BLOCKED - secret file');
      return { ok: false, error: 'Secret-bearing files are excluded from project context' };
    }
    const ext = path.extname(resolved.relativePath).toLowerCase();
    if (!ALLOWED_PROJECT_EXTS.has(ext)) {
      secAudit('PROJECT_READ', resolved.relativePath, 'BLOCKED - extension not allowed');
      return { ok: false, error: 'File type is not available through project context' };
    }

    try {
      const stat = await fs.promises.lstat(resolved.targetPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, error: 'Path is not a regular file' };
      }
      if (stat.size > MAX_FILE_BYTES) return { ok: false, error: 'File is too large for project context' };
      const buffer = await readBounded(resolved.targetPath, MAX_FILE_BYTES);
      if (!isProbablyText(buffer)) return { ok: false, error: 'File does not appear to be text' };
      secAudit('PROJECT_READ', `${record.name}: ${resolved.relativePath}`, 'ALLOWED');
      return {
        ok: true,
        relativePath: resolved.relativePath,
        size: buffer.length,
        data: buffer.toString('utf8'),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('project-close', async (_, payload = {}) => {
    const record = verifyProject(payload);
    if (!record) return { ok: false, error: 'Project is not open or the token is invalid' };
    projectScans.delete(record.projectId);
    const closed = projectRegistry.close(record.projectId, record.token, 'renderer requested');
    return { ok: closed };
  });

  return Object.freeze({ closeProjectForBoundary: reason => projectRegistry.closeAll(reason) });
};
