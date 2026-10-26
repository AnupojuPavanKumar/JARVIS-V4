'use strict';

// Phase 5B — background presence.
//
// The ambient service owns the OS login-item registration and the power
// lifecycle hooks. It intentionally has no Electron import: main.js injects
// the app and powerMonitor handles, which keeps the logic testable with fakes.

const fs = require('fs');
const path = require('path');

const AUTOSTART_ARG = '--jarvis-autostart';
const HIDDEN_ARG = '--jarvis-hidden';
const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin']);
const RESUME_DEDUPE_MS = 1500;
const CONFIG_VERSION = 2;
const DEFAULT_START_HIDDEN = true;

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function loginItemArgsFor(app) {
  const args = [];
  // A development launch is `electron.exe <appPath>`. A packaged launch is
  // `JARVIS.exe`; both must be represented correctly in the login item.
  if (app && app.isPackaged !== true && typeof app.getAppPath === 'function') {
    args.push(app.getAppPath());
  }
  args.push(AUTOSTART_ARG);
  // The hidden-start preference is read from ambient-config.json at launch.
  // Keeping it out of the login-item args means changing the preference does
  // not make Electron's getLoginItemSettings() readback report "off".
  return args;
}

function buildLoginItemSettings({
  app,
  platform = process.platform,
  enabled = false,
  execPath = process.execPath,
} = {}) {
  if (!app || typeof app !== 'object') {
    throw new Error('buildLoginItemSettings requires an app handle');
  }

  const openAtLogin = enabled === true;
  if (platform === 'darwin') {
    // macOS does not accept command-line arguments for the main app login item.
    // startHidden is applied from the persisted preference when macOS reports
    // that the app was opened at login.
    return { openAtLogin };
  }

  // Deliberately no `name`: Electron's getLoginItemSettings() checks the
  // Windows Run value named after the app's AppUserModelId. main.js pins that
  // id to JARVIS, so the readback sees the same entry that setLoginItemSettings
  // writes. Passing a separate name here would make the toggle appear to fail.
  return {
    openAtLogin,
    path: execPath,
    args: loginItemArgsFor(app),
    enabled: openAtLogin,
  };
}

function shouldStartHidden({
  argv = [],
  platform = process.platform,
  startHidden = DEFAULT_START_HIDDEN,
  loginItemSettings = {},
} = {}) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes(HIDDEN_ARG)) return true;
  if (startHidden !== true) return false;

  const openedAtLogin = args.includes(AUTOSTART_ARG)
    || (platform === 'darwin' && loginItemSettings && loginItemSettings.wasOpenedAtLogin === true);
  return openedAtLogin;
}

class AmbientService {
  constructor({
    app,
    powerMonitor = null,
    scheduler = null,
    mainWindowProvider = () => null,
    configPath = null,
    audit = () => {},
    logger = console,
    platform = process.platform,
    argv = process.argv,
    now = Date.now,
    execPath = process.execPath,
  } = {}) {
    if (!app) throw new Error('AmbientService requires an app handle');

    this.app = app;
    this.powerMonitor = powerMonitor;
    this.scheduler = scheduler;
    this.mainWindowProvider = typeof mainWindowProvider === 'function'
      ? mainWindowProvider
      : () => null;
    this.configPath = configPath || path.join(app.getPath('userData'), 'ambient-config.json');
    this.audit = typeof audit === 'function' ? audit : () => {};
    this.logger = logger || console;
    this.platform = platform;
    this.argv = Array.isArray(argv) ? [...argv] : [];
    this.now = typeof now === 'function' ? now : Date.now;
    this.execPath = execPath;

    this.startHidden = DEFAULT_START_HIDDEN;
    this._configNeedsSave = false;
    this._initialized = false;
    this._disposed = false;
    this._lastSuspendAt = null;
    this._lastResumeAt = null;
    this._lastResumeHandledAt = 0;
    this._resumeInFlight = null;

    this._onSuspend = () => this.handleSuspend('suspend');
    this._onResume = () => this.handleResume('resume');
    this._onUnlock = () => this.handleResume('unlock-screen');
  }

  isSupported() {
    return SUPPORTED_PLATFORMS.has(this.platform);
  }

  async init() {
    if (this._initialized) return this.getStatus();
    await this._loadConfig();
    if (this._configNeedsSave) {
      try {
        await this._saveConfig();
        this._configNeedsSave = false;
      } catch (error) {
        const message = errorMessage(error);
        this.audit('AMBIENT_CONFIG', `write_error=${message}`, 'WARN');
        (this.logger.warn || this.logger.log || (() => {}))(
          `[AMBIENT] Could not save background presence config: ${message}`
        );
      }
    }
    this._bindPowerMonitor();
    this._initialized = true;
    return this.getStatus();
  }

  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }

  shouldStartHidden() {
    return shouldStartHidden({
      argv: this.argv,
      platform: this.platform,
      startHidden: this.startHidden,
      loginItemSettings: this._loginItemSettings(),
    });
  }

  getStatus() {
    const login = this._loginItemSettings();
    return {
      ok: true,
      supported: this.isSupported(),
      autoStartEnabled: login.openAtLogin === true,
      startHidden: this.startHidden === true,
      executableWillLaunchAtLogin: login.executableWillLaunchAtLogin === true,
      launchItemStatus: typeof login.status === 'string' ? login.status : null,
      schedulerRunning: Boolean(this.scheduler && this.scheduler.timer),
      trayResident: true,
      lastSuspendAt: this._lastSuspendAt,
      lastResumeAt: this._lastResumeAt,
      platform: this.platform,
    };
  }

  async setAutoStart({ enabled, startHidden } = {}) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' };
    }
    if (startHidden !== undefined && typeof startHidden !== 'boolean') {
      return { ok: false, error: 'startHidden must be a boolean' };
    }
    if (!this.isSupported()) {
      return {
        ...this.getStatus(),
        ok: false,
        supported: false,
        error: 'Auto-start is not supported on this platform.',
      };
    }

    const nextHidden = startHidden === undefined ? this.startHidden : startHidden;
    try {
      this.app.setLoginItemSettings(buildLoginItemSettings({
        app: this.app,
        platform: this.platform,
        enabled,
        execPath: this.execPath,
      }));
      this.startHidden = nextHidden;
      await this._saveConfig();
      this.audit(
        'AMBIENT_AUTOSTART',
        `enabled=${enabled} startHidden=${nextHidden}`,
        'SUCCESS'
      );
      return { ok: true, ...this.getStatus() };
    } catch (error) {
      const message = errorMessage(error);
      this.audit('AMBIENT_AUTOSTART', `enabled=${enabled} error=${message}`, 'ERROR');
      (this.logger.error || this.logger.log || (() => {}))(`[AMBIENT] Could not update auto-start: ${message}`);
      return { ...this.getStatus(), ok: false, error: message };
    }
  }

  handleSuspend(source = 'suspend') {
    const now = this.now();
    this._lastSuspendAt = new Date(now).toISOString();
    this.audit('AMBIENT_SUSPEND', String(source).slice(0, 80), 'INFO');

    // Persist any pending scheduler mutation before the OS freezes the process,
    // then stop the timer. The resume hook restarts it and immediately ticks so
    // jobs that came due during sleep are not skipped until the next interval.
    if (this.scheduler) {
      try {
        const pendingSave = typeof this.scheduler.saveJobs === 'function'
          ? this.scheduler.saveJobs()
          : null;
        if (pendingSave && typeof pendingSave.catch === 'function') {
          pendingSave.catch(error => {
            (this.logger.warn || this.logger.log || (() => {}))(
              `[AMBIENT] Could not flush scheduler before suspend: ${errorMessage(error)}`
            );
          });
        }
      } catch (error) {
        (this.logger.warn || this.logger.log || (() => {}))(
          `[AMBIENT] Could not flush scheduler before suspend: ${errorMessage(error)}`
        );
      }
      try {
        if (typeof this.scheduler.shutdown === 'function') this.scheduler.shutdown();
      } catch (error) {
        (this.logger.warn || this.logger.log || (() => {}))(
          `[AMBIENT] Could not stop scheduler on suspend: ${errorMessage(error)}`
        );
      }
    }

    return { ok: true, at: this._lastSuspendAt };
  }

  handleResume(source = 'resume') {
    const now = this.now();
    if (this._lastResumeHandledAt && now - this._lastResumeHandledAt < RESUME_DEDUPE_MS) {
      return this._resumeInFlight || Promise.resolve({ ok: true, deduped: true, at: this._lastResumeAt });
    }

    this._lastResumeHandledAt = now;
    this._lastResumeAt = new Date(now).toISOString();
    this.audit('AMBIENT_RESUME', String(source).slice(0, 80), 'SUCCESS');

    const window = this.mainWindowProvider();
    const windowDestroyed = Boolean(
      window
      && typeof window.isDestroyed === 'function'
      && window.isDestroyed()
    );
    if (window && !windowDestroyed && window.webContents) {
      try {
        window.webContents.send('ambient-resumed', {
          at: this._lastResumeAt,
          source: String(source).slice(0, 80),
        });
      } catch (error) {
        (this.logger.warn || this.logger.log || (() => {}))(
          `[AMBIENT] Could not notify renderer after resume: ${errorMessage(error)}`
        );
      }
    }

    if (!this.scheduler) {
      return Promise.resolve({ ok: true, at: this._lastResumeAt });
    }

    try {
      if (typeof this.scheduler.startLoop === 'function') this.scheduler.startLoop();
    } catch (error) {
      (this.logger.warn || this.logger.log || (() => {}))(
        `[AMBIENT] Could not restart scheduler after resume: ${errorMessage(error)}`
      );
    }

    if (typeof this.scheduler.tick !== 'function') {
      return Promise.resolve({ ok: true, at: this._lastResumeAt });
    }

    this._resumeInFlight = Promise.resolve()
      .then(() => this.scheduler.tick())
      .then(() => ({ ok: true, at: this._lastResumeAt }))
      .catch(error => {
        const message = errorMessage(error);
        this.audit('AMBIENT_RESUME', `tick_error=${message}`, 'ERROR');
        (this.logger.error || this.logger.log || (() => {}))(
          `[AMBIENT] Scheduler tick failed after resume: ${message}`
        );
        return { ok: false, error: message, at: this._lastResumeAt };
      })
      .finally(() => {
        this._resumeInFlight = null;
      });

    return this._resumeInFlight;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.powerMonitor && typeof this.powerMonitor.removeListener === 'function') {
      try { this.powerMonitor.removeListener('suspend', this._onSuspend); } catch { /* best effort */ }
      try { this.powerMonitor.removeListener('resume', this._onResume); } catch { /* best effort */ }
      try { this.powerMonitor.removeListener('unlock-screen', this._onUnlock); } catch { /* best effort */ }
    }
  }

  _bindPowerMonitor() {
    if (!this.powerMonitor || typeof this.powerMonitor.on !== 'function') return;
    this.powerMonitor.on('suspend', this._onSuspend);
    this.powerMonitor.on('resume', this._onResume);
    this.powerMonitor.on('unlock-screen', this._onUnlock);
  }

  _loginItemSettings() {
    if (!this.isSupported() || !this.app || typeof this.app.getLoginItemSettings !== 'function') {
      return {};
    }
    try {
      const baseArgs = loginItemArgsFor(this.app);
      const options = this.platform === 'win32'
        ? {
          path: this.execPath,
          args: baseArgs,
        }
        : undefined;
      const settings = this.app.getLoginItemSettings(options) || {};
      if (this.platform !== 'win32' || settings.openAtLogin === true) {
        return settings;
      }

      // Older builds encoded the hidden preference in the login-item args.
      // Read that variant too so an upgrade does not report auto-start as off.
      const legacy = this.app.getLoginItemSettings({
        path: this.execPath,
        args: [...baseArgs, HIDDEN_ARG],
      }) || {};
      return legacy.openAtLogin === true ? legacy : settings;
    } catch (error) {
      (this.logger.warn || this.logger.log || (() => {}))(
        `[AMBIENT] Could not read login item settings: ${errorMessage(error)}`
      );
      return {};
    }
  }

  async _loadConfig() {
    let parsed;
    try {
      const raw = await fs.promises.readFile(this.configPath, 'utf8');
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._configNeedsSave = true;
        return;
      }
      this.audit('AMBIENT_CONFIG', `read_error=${errorMessage(error)}`, 'WARN');
      (this.logger.warn || this.logger.log || (() => {}))(
        `[AMBIENT] Could not read background presence config: ${errorMessage(error)}`
      );
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.audit('AMBIENT_CONFIG', 'invalid_shape', 'WARN');
      return;
    }

    const version = Number.isInteger(parsed.version) ? parsed.version : 0;
    if (version >= CONFIG_VERSION) {
      if (typeof parsed.startHidden === 'boolean') {
        this.startHidden = parsed.startHidden;
      } else {
        this.startHidden = DEFAULT_START_HIDDEN;
        this._configNeedsSave = true;
      }
      return;
    }

    // Version 1 shipped with visible login launches as the default. Adopt the
    // tray-first default once; the Settings toggle can turn it back off.
    this.startHidden = DEFAULT_START_HIDDEN;
    this._configNeedsSave = true;
  }

  async _saveConfig() {
    const directory = path.dirname(this.configPath);
    await fs.promises.mkdir(directory, { recursive: true });
    const tempPath = `${this.configPath}.${process.pid}.${this.now()}.tmp`;
    const payload = JSON.stringify({
      version: CONFIG_VERSION,
      startHidden: this.startHidden === true,
    }, null, 2);
    await fs.promises.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.promises.rename(tempPath, this.configPath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error && error.code)) throw error;
      await fs.promises.rm(this.configPath, { force: true });
      await fs.promises.rename(tempPath, this.configPath);
    }
  }
}

module.exports = {
  AmbientService,
  AUTOSTART_ARG,
  DEFAULT_START_HIDDEN,
  HIDDEN_ARG,
  buildLoginItemSettings,
  shouldStartHidden,
};
