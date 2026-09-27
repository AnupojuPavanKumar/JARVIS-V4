module.exports = function registerWindowController({ ipcMain, app, mainWindowProvider, liveSecConfig }) {

  // ─── Window Controls ─────────────────────────────────────────────
  ipcMain.on('win-minimize', () => {
    const mainWindow = mainWindowProvider();
    if (mainWindow) mainWindow.minimize();
  });
  
  ipcMain.on('win-maximize', () => {
    const mainWindow = mainWindowProvider();
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });
  
  ipcMain.on('win-close', () => {
    const mainWindow = mainWindowProvider();
    if (mainWindow) mainWindow.hide();
  });
  
  // ─── Quit App (Power Off) ─────────────────────────────────────────
  ipcMain.on('quit-app', () => {
    app.isQuitting = true;
    app.quit();
  });

  // ─── Screen Capture IPC ────────────────────────────────────────
  ipcMain.handle('capture-screen', async () => {
    if (!liveSecConfig.screenCaptureEnabled) {
      return { ok: false, error: 'Screen capture disabled' };
    }
    try {
      const { desktopCapturer } = require('electron');
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 },
      });
      if (!sources || sources.length === 0) return { ok: false, error: 'No screen sources found' };
      const thumb = sources[0].thumbnail;
      const b64 = thumb.toJPEG(80).toString('base64');
      return { ok: true, data: b64, mimeType: 'image/jpeg', source: sources[0].name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

};
