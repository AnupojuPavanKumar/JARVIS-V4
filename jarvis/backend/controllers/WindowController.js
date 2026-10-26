module.exports = function registerWindowController({
  ipcMain,
  app,
  mainWindowProvider,
  secAudit = () => {},
  capabilityStore = null,
  sessionState = null,
  screenCaptureProvider = null,
}) {

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

  // Wake-word activation can request focus while JARVIS is resident in the
  // tray. Showing the window also triggers the normal session lock screen.
  ipcMain.handle('focus-window', async () => {
    const mainWindow = mainWindowProvider();
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'Window unavailable' };
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return { ok: true };
  });
  
  // ─── Quit App (Power Off) ─────────────────────────────────────────
  ipcMain.on('quit-app', () => {
    app.isQuitting = true;
    app.quit();
  });

  // ─── Screen Capture IPC ────────────────────────────────────────
  // A screenshot always consumes a main-issued, one-shot grant. There is no
  // persistent renderer toggle that can turn capture on indefinitely.
  ipcMain.handle('capture-screen', async () => {
    if (!sessionState || sessionState.canUsePrivileges !== true) {
      secAudit('SCREEN_CAPTURE', 'session locked', 'BLOCKED');
      return { ok: false, error: 'Unlock JARVIS before capturing the screen' };
    }
    if (!capabilityStore || !capabilityStore.consume('screen-capture')) {
      secAudit('SCREEN_CAPTURE', 'consent grant missing or expired', 'BLOCKED');
      return { ok: false, error: 'Screen capture requires a fresh main-process approval' };
    }
    try {
      const provider = screenCaptureProvider || (async () => {
        const { desktopCapturer } = require('electron');
        return desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1280, height: 720 },
        });
      });
      const sources = await provider();
      if (!sources || sources.length === 0) return { ok: false, error: 'No screen sources found' };
      const thumb = sources[0].thumbnail;
      const b64 = thumb.toJPEG(80).toString('base64');
      return { ok: true, data: b64, mimeType: 'image/jpeg', source: sources[0].name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

};
