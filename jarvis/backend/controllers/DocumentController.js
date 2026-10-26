'use strict';

const path = require('path');

function errorResult(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

module.exports = function registerDocumentController({
  ipcMain,
  documentIndex = null,
  dialog = null,
  mainWindowProvider = null,
  secAudit = () => {},
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerDocumentController requires ipcMain');
  }

  function audit(action, detail, verdict) {
    try { secAudit(`DOCUMENT_${action}`, String(detail ?? '').slice(0, 400), verdict); } catch { /* audit must not break IPC */ }
  }

  async function statusPayload() {
    if (!documentIndex) {
      return { ok: false, enabled: false, error: 'Local document search is disabled' };
    }
    return { ok: true, enabled: true, ...(await documentIndex.stats()) };
  }

  // A folder may only be added after the user picked it in the native dialog.
  // This prevents a compromised renderer from indexing an arbitrary local path.
  const pickedPaths = new Set();

  ipcMain.handle('documents-status', async () => {
    try {
      return await statusPayload();
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-pick-folder', async event => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      return { ok: false, error: 'Folder picker is unavailable' };
    }
    try {
      const parent = typeof mainWindowProvider === 'function' ? mainWindowProvider() : null;
      const result = parent
        ? await dialog.showOpenDialog(parent, {
          title: 'Approve a folder for local document search',
          properties: ['openDirectory'],
        })
        : await dialog.showOpenDialog({
          title: 'Approve a folder for local document search',
          properties: ['openDirectory'],
        });
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        audit('PICK_FOLDER', 'canceled', 'CANCELED');
        return { ok: true, canceled: true };
      }
      const folderPath = result.filePaths[0];
      pickedPaths.add(folderPath);
      audit('PICK_FOLDER', `folder=${path.basename(folderPath)}`, 'ALLOWED');
      return { ok: true, canceled: false, path: folderPath };
    } catch (error) {
      audit('PICK_FOLDER', 'picker-error', 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-add-folder', async (_, payload = {}) => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    const folderPath = typeof payload.path === 'string' ? payload.path : '';
    const scope = typeof payload.scope === 'string' ? payload.scope : 'general';
    if (!folderPath) return { ok: false, error: 'path is required' };
    if (!pickedPaths.has(folderPath)) {
      return { ok: false, error: 'Choose the folder with the system picker before adding it' };
    }
    try {
      const result = await documentIndex.addFolder(folderPath, scope);
      pickedPaths.delete(folderPath);
      audit('ADD_FOLDER', `scope=${scope} files=${result.documentCount}`, 'ALLOWED');
      return { ok: true, ...result };
    } catch (error) {
      audit('ADD_FOLDER', 'add-error', 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-remove-folder', async (_, payload = {}) => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    const folderId = typeof payload.folderId === 'string' ? payload.folderId : '';
    if (!folderId) return { ok: false, error: 'folderId is required' };
    try {
      await documentIndex.removeFolder(folderId);
      audit('REMOVE_FOLDER', `folderId=${folderId}`, 'ALLOWED');
      return { ok: true, ...(await documentIndex.stats()) };
    } catch (error) {
      audit('REMOVE_FOLDER', 'remove-error', 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-reindex', async () => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    try {
      const result = await documentIndex.reindex();
      audit('REINDEX', `documents=${result.documentCount}`, 'ALLOWED');
      return { ok: true, ...result };
    } catch (error) {
      audit('REINDEX', 'reindex-error', 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-set-retention', async (_, payload = {}) => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    try {
      const result = await documentIndex.setRetention(payload.days ?? null);
      audit('SET_RETENTION', `days=${result.retentionDays ?? 'none'}`, 'ALLOWED');
      return { ok: true, ...result };
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-apply-retention', async () => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    try {
      const result = await documentIndex.applyRetention();
      audit('APPLY_RETENTION', `removed=${result.removed}`, 'ALLOWED');
      return { ok: true, ...result };
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle('documents-delete-all', async () => {
    if (!documentIndex) return { ok: false, error: 'Local document search is disabled' };
    try {
      const result = await documentIndex.deleteAll();
      pickedPaths.clear();
      audit('DELETE_ALL', `removed=${result.removedDocuments}`, 'ALLOWED');
      return { ok: true, ...result };
    } catch (error) {
      audit('DELETE_ALL', 'delete-error', 'ERROR');
      return errorResult(error);
    }
  });
};
