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

  // Export checkPathBounds inside context for other controllers if needed
  return { checkPathBounds };
};
