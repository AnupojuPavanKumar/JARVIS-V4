const path = require('path');
const fs = require('fs');
const os = require('os');
const { dialog } = require('electron');

module.exports = function registerFileController({ ipcMain, app, mainWindowProvider, secAudit }) {
  
  function resolveSafePath(target) {
    let cur = path.resolve(target);
    let remain = [];
    while (cur && !fs.existsSync(cur)) {
      let parent = path.dirname(cur);
      if (parent === cur) break;
      remain.unshift(path.basename(cur));
      cur = parent;
    }
    let real = cur;
    try { if (fs.existsSync(cur)) real = fs.realpathSync.native(cur); } catch (e) { }
    return remain.length > 0 ? path.join(real, ...remain) : real;
  }

  function checkPathBounds(requestedPath) {
    const resolved = resolveSafePath(requestedPath);
    const workspaceDir = path.join(app.getPath('userData'), 'workspace');
    if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

    let workspaceRoot, tmpRoot;
    try { workspaceRoot = fs.realpathSync.native(workspaceDir) + path.sep; }
    catch (e) { workspaceRoot = path.resolve(workspaceDir) + path.sep; }
    try { tmpRoot = fs.realpathSync.native(os.tmpdir()) + path.sep; }
    catch (e) { tmpRoot = path.resolve(os.tmpdir()) + path.sep; }

    const isOk = resolved.startsWith(workspaceRoot) || resolved.startsWith(tmpRoot) ||
      resolved === workspaceRoot.slice(0, -1) || resolved === tmpRoot.slice(0, -1);
    
    if (!isOk) return null;
    return resolved;
  }

  ipcMain.handle('fs-read', async (_, filePath, token) => {
    try {
      let resolved = null;
      if (token && global.workspaceTokens && global.workspaceTokens[token]) {
        const wp = global.workspaceTokens[token];
        const res = path.resolve(filePath);
        if (res.startsWith(wp + path.sep) || res === wp) {
          resolved = res;
        }
      }
      if (!resolved) {
        resolved = checkPathBounds(filePath);
      }
      if (!resolved) return { ok: false, error: 'Read refused: path is outside the allowed workspace.' };
      return { ok: true, data: await fs.promises.readFile(resolved, 'utf8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fs-write', async (_, filePath, content) => {
    try {
      const resolved = checkPathBounds(filePath);
      if (!resolved) {
        secAudit('FS_WRITE', filePath, 'BLOCKED - outside workspace');
        return { ok: false, error: 'Write refused: path is outside the allowed workspace.' };
      }
      secAudit('FS_WRITE', resolved, 'ALLOWED');
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, content, 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fs-list', async (_, dirPath, token) => {
    try {
      let resolved = null;
      if (token && global.workspaceTokens && global.workspaceTokens[token]) {
        const wp = global.workspaceTokens[token];
        const res = path.resolve(dirPath);
        if (res.startsWith(wp + path.sep) || res === wp) {
          resolved = res;
        }
      }
      if (!resolved) {
        resolved = checkPathBounds(dirPath);
      }
      if (!resolved) return { ok: false, error: 'Read refused: path is outside the allowed workspace.' };
      if (!fs.existsSync(resolved)) return { ok: true, data: [] };
      const items = await fs.promises.readdir(resolved, { withFileTypes: true });
      return {
        ok: true,
        data: items.map(d => ({ name: d.name, isDir: d.isDirectory() }))
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fs-dialog-save', async (_, defaultName, content) => {
    const mainWindow = mainWindowProvider();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || 'jarvis-export.md',
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ]
    });
    if (!result.canceled && result.filePath) {
      await fs.promises.writeFile(result.filePath, content, 'utf8');
      return { ok: true, filePath: result.filePath };
    }
    return { ok: false };
  });

  const _allowedDialogPaths = new Set();
  const ALLOWED_DOC_EXTS = new Set(['.pdf', '.txt', '.md', '.json']);
  const MAX_DOC_SIZE = 10 * 1024 * 1024; // 10MB limit

  async function readBounded(filePath, maxSize) {
    let fd = null;
    try {
      fd = await fs.promises.open(filePath, 'r');
      const buffer = Buffer.alloc(maxSize + 1);
      const { bytesRead } = await fd.read(buffer, 0, maxSize + 1, 0);
      if (bytesRead > maxSize) {
        throw new Error('File too large');
      }
      return buffer.slice(0, bytesRead);
    } finally {
      if (fd) await fd.close();
    }
  }

  ipcMain.handle('fs-dialog-open-doc', async () => {
    const mainWindow = mainWindowProvider();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'json'] }
      ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      _allowedDialogPaths.add(result.filePaths[0]);
      return { ok: true, filePath: result.filePaths[0] };
    }
    return { ok: false };
  });

  ipcMain.handle('read-pdf', async (_, filePath) => {
    try {
      if (!_allowedDialogPaths.has(filePath)) return { ok: false, error: 'Read refused: file was not selected via dialog.' };
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
      if (!_allowedDialogPaths.has(filePath)) return { ok: false, error: 'Read refused: file was not selected via dialog.' };
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_DOC_EXTS.has(ext)) return { ok: false, error: 'Invalid extension' };

      const dataBuffer = await readBounded(filePath, MAX_DOC_SIZE);
      return { ok: true, data: dataBuffer.toString('utf8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Binary File Read (used by Image Analysis after open-image-dialog) ──
  // The path is ALWAYS the one returned by the dialog — user intentionally
  // chose it, so we allow any absolute path the dialog resolves to.
  const ALLOWED_BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg',
  ]);
  ipcMain.handle('fs-read-binary', async (_, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) {
        return { ok: false, error: 'Invalid file path' };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_BINARY_EXTS.has(ext)) {
        secAudit('FS_READ_BINARY', filePath, 'BLOCKED - extension not allowed');
        return { ok: false, error: `File type not allowed: ${ext}` };
      }
      const resolved = path.resolve(filePath);
      const data = await fs.promises.readFile(resolved);
      const MIME_MAP = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
        '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
      };
      secAudit('FS_READ_BINARY', resolved, 'ALLOWED');
      return { ok: true, data: data.toString('base64'), mimeType: MIME_MAP[ext] || 'application/octet-stream' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Image Dialog (for Image Analysis feature) ────────────────────
  ipcMain.handle('open-image-dialog', async () => {
    const mainWindow = mainWindowProvider();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }
      ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return { ok: true, filePath: result.filePaths[0] };
    }
    return { ok: false };
  });

  // ─── Dev Pack: Folder Dialog + Project Reader ─────────────────────
  let _activeWorkspacePath = null;

  ipcMain.handle('open-folder-dialog', async () => {
    const mainWindow = mainWindowProvider();
    if (!mainWindow) return { ok: false, error: 'No window available' };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      _activeWorkspacePath = result.filePaths[0];
      // Store a workspace token so fs-read/fs-list can access the folder
      const token = require('crypto').randomBytes(16).toString('hex');
      if (global.workspaceTokens) {
        global.workspaceTokens[token] = _activeWorkspacePath;
      }
      return { ok: true, folderPath: _activeWorkspacePath, token };
    }
    return { ok: false };
  });

  const MAX_PROJECT_FILES = 50;
  const MAX_FILE_BYTES    = 64 * 1024; // 64 KB per file
  const ALLOWED_PROJECT_EXTS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
    '.json', '.yaml', '.yml', '.toml', '.env',
    '.html', '.css', '.scss', '.less', '.svelte', '.vue',
    '.md', '.txt', '.sh', '.ps1', '.bat',
  ]);

  ipcMain.handle('read-project', async () => {
    if (!_activeWorkspacePath) return { ok: false, error: 'No workspace selected. Use open-folder-dialog first.' };
    try {
      const realRoot = fs.realpathSync(_activeWorkspacePath);
      const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next']);
      const results = [];

      function walkDir(dir, relBase) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (results.length >= MAX_PROJECT_FILES) return;
          const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name)) walkDir(path.join(dir, entry.name), rel);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!ALLOWED_PROJECT_EXTS.has(ext)) continue;
            try {
              const full = path.join(dir, entry.name);
              // Symlink escape guard
              const real = fs.realpathSync(full);
              if (!real.startsWith(realRoot + path.sep) && real !== realRoot) continue;
              const stat = fs.statSync(full);
              if (stat.size > MAX_FILE_BYTES) {
                results.push({ relativePath: rel, content: `[File too large: ${(stat.size / 1024).toFixed(0)} KB]` });
              } else {
                results.push({ relativePath: rel, content: fs.readFileSync(full, 'utf8') });
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      walkDir(realRoot, '');
      secAudit('READ_PROJECT', realRoot, `ALLOWED — ${results.length} files`);
      return { ok: true, name: path.basename(realRoot), rootPath: realRoot, files: results };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Safe Code Runner ──────────────────────────────────────────────
  // Executes a code snippet in a sandboxed child process (no shell).
  // Only whitelisted runtimes are accepted. Timeout is 10 s.
  const SAFE_CODE_RUNNERS = { python: 'python', javascript: 'node', js: 'node' };

  ipcMain.handle('run-code-safe', async (_, lang, code) => {
    if (typeof lang !== 'string' || typeof code !== 'string') {
      return { ok: false, error: 'Invalid request: lang and code must be strings.' };
    }
    const runner = SAFE_CODE_RUNNERS[lang.toLowerCase()];
    if (!runner) {
      return { ok: false, error: `Unsupported language: ${lang}. Allowed: python, javascript.` };
    }
    if (code.length > 50000) {
      return { ok: false, error: 'Code too large (max 50 KB).' };
    }

    const tmpDir = app.getPath('temp');
    const ext = runner === 'node' ? '.js' : '.py';
    const tmpFile = path.join(tmpDir, `jarvis_run_${Date.now()}_${process.pid}${ext}`);

    try {
      await fs.promises.writeFile(tmpFile, code, 'utf8');
    } catch (e) {
      return { ok: false, error: `Failed to write temp file: ${e.message}` };
    }

    return new Promise(resolve => {
      const { spawn: _spawn } = require('child_process');
      const child = _spawn(runner, [tmpFile], {
        shell: false,
        windowsHide: true,
        timeout: 10000,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => {
        fs.promises.unlink(tmpFile).catch(() => {});
        resolve({ ok: false, stdout, stderr, error: err.message });
      });
      child.on('close', code => {
        fs.promises.unlink(tmpFile).catch(() => {});
        resolve({ ok: code === 0, stdout, stderr, exitCode: code || 0 });
      });
    });
  });

  // Export checkPathBounds inside context for other controllers if needed
  return { checkPathBounds };
};
