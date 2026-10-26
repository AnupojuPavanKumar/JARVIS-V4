'use strict';

// Main-process control surface for the isolated browser. The regular browser
// tools live behind the durable runtime's policy/approval boundary; this
// controller exists so the user can inspect or stop the browser directly when
// the agent is busy or unresponsive.
module.exports = function registerBrowserController({
  ipcMain,
  browserDriver = null,
  secAudit = () => {},
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerBrowserController requires ipcMain');
  }

  function audit(action, detail, verdict) {
    try { secAudit(action, detail, verdict); } catch { /* audit must not break IPC */ }
  }

  ipcMain.handle('browser-status', async () => {
    if (!browserDriver) {
      return { ok: false, enabled: false, error: 'Browser automation is disabled' };
    }
    try {
      return { ok: true, enabled: true, status: browserDriver.status() };
    } catch (error) {
      return { ok: false, enabled: true, error: error.message };
    }
  });

  ipcMain.handle('browser-emergency-stop', async () => {
    if (!browserDriver) {
      return { ok: false, enabled: false, error: 'Browser automation is disabled' };
    }
    try {
      const result = await browserDriver.stop();
      audit('BROWSER_EMERGENCY_STOP', 'user requested browser stop', 'STOPPED');
      return {
        ok: true,
        enabled: true,
        ...result,
        status: browserDriver.status(),
      };
    } catch (error) {
      audit('BROWSER_EMERGENCY_STOP', error.message, 'ERROR');
      return { ok: false, enabled: true, error: error.message };
    }
  });
};
