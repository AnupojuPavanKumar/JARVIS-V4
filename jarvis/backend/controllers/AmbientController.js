'use strict';

function errorResult(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

module.exports = function registerAmbientController({
  ipcMain,
  ambientService = null,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerAmbientController requires ipcMain');
  }

  ipcMain.handle('ambient-status', async () => {
    if (!ambientService) {
      return {
        ok: false,
        supported: false,
        error: 'Background presence is unavailable.',
      };
    }
    try {
      return ambientService.getStatus();
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle('ambient-set-auto-start', async (_, payload = {}) => {
    if (!ambientService) {
      return { ok: false, error: 'Background presence is unavailable.' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: 'A settings object is required.' };
    }
    try {
      return await ambientService.setAutoStart(payload);
    } catch (error) {
      return errorResult(error);
    }
  });
};
