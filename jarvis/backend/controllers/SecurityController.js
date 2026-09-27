const path = require('path');
const fs = require('fs');
const { pbkdf2, randomBytes } = require('crypto');

module.exports = function registerSecurityController({ ipcMain, app, secAudit, liveSecConfig }) {
  
  // ─── Security Settings ───────────────────────────────────────────
  const secConfigFile = () => path.join(app.getPath('userData'), 'sec-config.json');
  
  ipcMain.handle('sec-config-load', async () => {
    try {
      const fp = secConfigFile();
      if (!fs.existsSync(fp)) return { ok: true, data: { terminalEnabled: false, screenCaptureEnabled: false } };
      const data = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
      // Keep live config in sync
      liveSecConfig.terminalEnabled = !!data.terminalEnabled;
      liveSecConfig.screenCaptureEnabled = !!data.screenCaptureEnabled;
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  
  ipcMain.handle('sec-config-save', async (_, cfg) => {
    try {
      liveSecConfig.terminalEnabled = !!cfg.terminalEnabled;
      liveSecConfig.screenCaptureEnabled = !!cfg.screenCaptureEnabled;
      await fs.promises.writeFile(secConfigFile(), JSON.stringify(cfg, null, 2));
      secAudit('CONFIG_UPDATE', `Terminal: ${liveSecConfig.terminalEnabled}`, 'SUCCESS');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // secAudit log retrieval is handled externally or we pass a getter.
  // Wait, secAudit is just a function. We need the log array.
  // Instead of passing the array, we can let main.js register `sec-audit-read`.
  // Actually, I'll pass a `getSecAuditLog` function in context.
  
  ipcMain.handle('sec-classify-command', async (_, cmd) => {
    const { classifyCommand } = require('../../ipc-policy');
    const v = classifyCommand(cmd);
    return { verdict: v };
  });

  // ─── Authentication ──────────────────────────────────────────────
  const _authFilePath = () => path.join(app.getPath('userData'), 'jarvis_auth.json');
  const PIN_MAX_ATTEMPTS = 5;
  const PIN_WINDOW_MS = 15 * 60 * 1000;
  const _pinAttempts = [];

  function _pinRateLimitOk() {
    const now = Date.now();
    const recent = _pinAttempts.filter(t => now - t < PIN_WINDOW_MS);
    _pinAttempts.length = 0;
    _pinAttempts.push(...recent);
    return _pinAttempts.length < PIN_MAX_ATTEMPTS;
  }

  function _pbkdf2Hash(pin, salt) {
    return new Promise((resolve, reject) => {
      pbkdf2(pin, salt, 100000, 32, 'sha256', (err, key) => {
        if (err) reject(err); else resolve(key.toString('hex'));
      });
    });
  }

  ipcMain.handle('auth-load', async () => {
    try {
      const fp = _authFilePath();
      if (!fs.existsSync(fp)) return { ok: true, data: null };
      const data = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
      return { ok: true, data: { hasPin: !!(data.hash && data.salt), skipPin: data.skipPin } };
    } catch (e) { return { ok: false, data: null }; }
  });

  ipcMain.handle('auth-save', async (_, data) => {
    try {
      const fp = _authFilePath();
      let currentData = null;
      if (fs.existsSync(fp)) {
        currentData = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
      }
      
      if (currentData && !currentData.skipPin && currentData.hash) {
        if (!data.currentPin || typeof data.currentPin !== 'string') {
          return { ok: false, error: 'Current PIN required' };
        }
        if (!_pinRateLimitOk()) return { ok: false, error: 'Too many attempts.' };
        const oldHash = await _pbkdf2Hash(data.currentPin, currentData.salt);
        if (oldHash !== currentData.hash) {
          _pinAttempts.push(Date.now());
          return { ok: false, error: 'Current PIN incorrect' };
        }
      }

      if (data && data.skipPin) {
        await fs.promises.writeFile(fp, JSON.stringify({ skipPin: true }, null, 2));
        return { ok: true };
      }
      if (typeof data.pin !== 'string' || !/^\d{4}$/.test(data.pin)) {
        return { ok: false, error: 'PIN must be exactly 4 digits' };
      }
      const salt = randomBytes(32).toString('hex');
      const hash = await _pbkdf2Hash(data.pin, salt);
      await fs.promises.writeFile(fp, JSON.stringify({ hash, salt, skipPin: false }, null, 2));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('auth-verify', async (_, pin) => {
    if (!_pinRateLimitOk()) {
      secAudit('AUTH_VERIFY', '***', 'RATE_LIMITED');
      return { ok: false, error: 'Too many attempts. Try again in 15 minutes.', rateLimited: true };
    }
    try {
      const fp = _authFilePath();
      if (!fs.existsSync(fp)) return { ok: false, error: 'No auth file' };
      const data = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
      if (data.skipPin) return { ok: true };
      if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
        return { ok: false, error: 'Invalid PIN format' };
      }
      const hash = await _pbkdf2Hash(pin, data.salt);
      const valid = hash === data.hash;
      _pinAttempts.push(Date.now());
      secAudit('AUTH_VERIFY', '***', valid ? 'SUCCESS' : 'FAIL');
      if (!valid) return { ok: false, error: 'Incorrect PIN' };
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

};
