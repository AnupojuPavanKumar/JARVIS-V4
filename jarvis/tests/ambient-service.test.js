'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AmbientService,
  AUTOSTART_ARG,
  DEFAULT_START_HIDDEN,
  HIDDEN_ARG,
  buildLoginItemSettings,
  shouldStartHidden,
} = require('../backend/ambient/ambient-service');
const registerAmbientController = require('../backend/controllers/AmbientController');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ambient-'));
}

function createFakeApp(baseDir, { isPackaged = false, appPath = 'C:\\JARVIS App' } = {}) {
  let openAtLogin = false;
  const calls = [];
  return {
    calls,
    app: {
      isPackaged,
      getAppPath: () => appPath,
      getPath: () => baseDir,
      getLoginItemSettings() {
        return { openAtLogin, executableWillLaunchAtLogin: openAtLogin };
      },
      setLoginItemSettings(settings) {
        calls.push(settings);
        openAtLogin = settings.openAtLogin === true;
      },
    },
  };
}

function createPowerMonitor() {
  const listeners = new Map();
  return {
    on(event, handler) {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter(candidate => candidate !== handler));
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) handler(...args);
    },
    count(event) {
      return (listeners.get(event) || []).length;
    },
  };
}

function createScheduler() {
  const calls = { starts: 0, ticks: 0, saves: 0, shutdowns: 0 };
  return {
    calls,
    timer: null,
    startLoop() {
      calls.starts += 1;
      this.timer = { id: calls.starts };
    },
    shutdown() {
      calls.shutdowns += 1;
      this.timer = null;
    },
    async saveJobs() {
      calls.saves += 1;
    },
    async tick() {
      calls.ticks += 1;
    },
  };
}

test('login item settings launch the same app in development and packaged builds', () => {
  const dev = buildLoginItemSettings({
    app: {
      isPackaged: false,
      getAppPath: () => 'C:\\JARVIS App',
    },
    platform: 'win32',
    enabled: true,
    execPath: 'C:\\electron.exe',
  });
  assert.equal(dev.openAtLogin, true);
  assert.equal(dev.path, 'C:\\electron.exe');
  assert.equal(dev.name, undefined);
  assert.deepEqual(dev.args, ['C:\\JARVIS App', AUTOSTART_ARG]);

  const packaged = buildLoginItemSettings({
    app: {
      isPackaged: true,
      getAppPath: () => 'C:\\JARVIS App',
    },
    platform: 'win32',
    enabled: false,
    execPath: 'C:\\JARVIS.exe',
  });
  assert.equal(packaged.openAtLogin, false);
  assert.equal(packaged.name, undefined);
  assert.deepEqual(packaged.args, [AUTOSTART_ARG]);

  const mac = buildLoginItemSettings({
    app: { isPackaged: true, getAppPath: () => '/Applications/JARVIS.app' },
    platform: 'darwin',
    enabled: true,
  });
  assert.deepEqual(mac, { openAtLogin: true });
});

test('start-hidden requires a login launch and the persisted preference', () => {
  assert.equal(DEFAULT_START_HIDDEN, true);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe', 'C:\\JARVIS App', AUTOSTART_ARG, HIDDEN_ARG],
    platform: 'win32',
    startHidden: true,
  }), true);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe', 'C:\\JARVIS App', AUTOSTART_ARG],
    platform: 'win32',
    startHidden: true,
  }), true);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe', 'C:\\JARVIS App', AUTOSTART_ARG],
    platform: 'win32',
  }), true);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe', 'C:\\JARVIS App'],
    platform: 'win32',
    startHidden: true,
  }), false);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe', 'C:\\JARVIS App'],
    platform: 'win32',
  }), false);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe'],
    platform: 'darwin',
    startHidden: true,
    loginItemSettings: { wasOpenedAtLogin: true },
  }), true);
  assert.equal(shouldStartHidden({
    argv: ['electron.exe'],
    platform: 'darwin',
    startHidden: true,
    loginItemSettings: { wasOpenedAtLogin: false },
  }), false);
});

test('ambient service persists auto-start preferences and reports tray state', async () => {
  const baseDir = tempDir();
  try {
    const { app, calls } = createFakeApp(baseDir);
    const powerMonitor = createPowerMonitor();
    const service = new AmbientService({
      app,
      powerMonitor,
      platform: 'win32',
      argv: ['electron.exe', 'C:\\JARVIS App'],
      execPath: 'C:\\electron.exe',
      configPath: path.join(baseDir, 'ambient-config.json'),
    });

    const initial = await service.init();
    assert.equal(initial.supported, true);
    assert.equal(initial.autoStartEnabled, false);
    assert.equal(initial.startHidden, true);
    assert.equal(powerMonitor.count('suspend'), 1);
    assert.equal(powerMonitor.count('resume'), 1);

    const initialSaved = JSON.parse(fs.readFileSync(path.join(baseDir, 'ambient-config.json'), 'utf8'));
    assert.equal(initialSaved.startHidden, true);
    assert.equal(initialSaved.version, 2);

    const enabled = await service.setAutoStart({ enabled: true, startHidden: true });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.autoStartEnabled, true);
    assert.equal(enabled.startHidden, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['C:\\JARVIS App', AUTOSTART_ARG]);

    const saved = JSON.parse(fs.readFileSync(path.join(baseDir, 'ambient-config.json'), 'utf8'));
    assert.equal(saved.startHidden, true);
    assert.equal(saved.version, 2);

    const restarted = new AmbientService({
      app,
      powerMonitor,
      platform: 'win32',
      argv: ['electron.exe', 'C:\\JARVIS App', AUTOSTART_ARG],
      execPath: 'C:\\electron.exe',
      configPath: path.join(baseDir, 'ambient-config.json'),
    });
    const restartedStatus = await restarted.init();
    assert.equal(restartedStatus.startHidden, true);
    assert.equal(restartedStatus.autoStartEnabled, true);
    assert.equal(restarted.shouldStartHidden(), true);
    restarted.dispose();

    await service.setAutoStart({ enabled: true, startHidden: false });
    assert.equal(service.shouldStartHidden(), false);
    const visibleSaved = JSON.parse(fs.readFileSync(path.join(baseDir, 'ambient-config.json'), 'utf8'));
    assert.equal(visibleSaved.startHidden, false);
    assert.equal(visibleSaved.version, 2);
    service.dispose();
    assert.equal(powerMonitor.count('suspend'), 0);
    assert.equal(powerMonitor.count('resume'), 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('background presence migrates v1 configs to tray-first and preserves v2 opt-outs', async () => {
  const baseDir = tempDir();
  const configPath = path.join(baseDir, 'ambient-config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, startHidden: false }), 'utf8');
    const { app } = createFakeApp(baseDir);
    const service = new AmbientService({
      app,
      platform: 'win32',
      configPath,
    });

    const migratedStatus = await service.init();
    assert.equal(migratedStatus.startHidden, true);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.startHidden, true);
    service.dispose();

    fs.writeFileSync(configPath, JSON.stringify({ version: 2, startHidden: false }), 'utf8');
    const optOut = new AmbientService({
      app,
      platform: 'win32',
      configPath,
    });
    const optOutStatus = await optOut.init();
    assert.equal(optOutStatus.startHidden, false);
    const preserved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(preserved.version, 2);
    assert.equal(preserved.startHidden, false);
    optOut.dispose();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('login item readback accepts legacy hidden args after an upgrade', async () => {
  const baseDir = tempDir();
  try {
    const app = {
      isPackaged: false,
      getAppPath: () => 'C:\\JARVIS App',
      getPath: () => baseDir,
      getLoginItemSettings(options = {}) {
        return { openAtLogin: Array.isArray(options.args) && options.args.includes(HIDDEN_ARG) };
      },
      setLoginItemSettings() {},
    };
    const service = new AmbientService({
      app,
      platform: 'win32',
      argv: ['electron.exe', 'C:\\JARVIS App', AUTOSTART_ARG],
      execPath: 'C:\\electron.exe',
      configPath: path.join(baseDir, 'ambient-config.json'),
    });

    const status = await service.init();
    assert.equal(status.autoStartEnabled, true);
    assert.equal(status.startHidden, true);
    assert.equal(service.shouldStartHidden(), true);
    service.dispose();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('ambient service flushes and restarts the scheduler across sleep and resume', async () => {
  const baseDir = tempDir();
  try {
    const { app } = createFakeApp(baseDir);
    const powerMonitor = createPowerMonitor();
    const scheduler = createScheduler();
    const events = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    };
    const service = new AmbientService({
      app,
      powerMonitor,
      scheduler,
      mainWindowProvider: () => window,
      platform: 'win32',
      argv: ['electron.exe'],
      configPath: path.join(baseDir, 'ambient-config.json'),
      now: () => 1_700_000_000_000,
    });

    await service.init();
    scheduler.startLoop();
    assert.equal(service.getStatus().schedulerRunning, true);

    powerMonitor.emit('suspend');
    assert.equal(scheduler.calls.saves, 1);
    assert.equal(scheduler.calls.shutdowns, 1);
    assert.equal(service.getStatus().schedulerRunning, false);
    assert.equal(service.getStatus().lastSuspendAt, new Date(1_700_000_000_000).toISOString());

    const resumed = await service.handleResume('resume');
    assert.equal(resumed.ok, true);
    assert.equal(scheduler.calls.starts, 2);
    assert.equal(scheduler.calls.ticks, 1);
    assert.equal(service.getStatus().schedulerRunning, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'ambient-resumed');
    assert.equal(events[0].payload.source, 'resume');

    const duplicate = await service.handleResume('unlock-screen');
    assert.equal(duplicate.deduped, true);
    assert.equal(scheduler.calls.ticks, 1);
    service.dispose();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('ambient service fails closed on unsupported platforms', async () => {
  const baseDir = tempDir();
  try {
    const { app, calls } = createFakeApp(baseDir);
    const service = new AmbientService({
      app,
      platform: 'linux',
      configPath: path.join(baseDir, 'ambient-config.json'),
    });
    const status = await service.init();
    assert.equal(status.supported, false);
    assert.equal(status.autoStartEnabled, false);

    const result = await service.setAutoStart({ enabled: true, startHidden: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /not supported/i);
    assert.equal(calls.length, 0);
    service.dispose();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('ambient controller validates status and auto-start payloads', async () => {
  const handlers = new Map();
  const ipc = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const calls = [];
  const service = {
    getStatus: () => ({ ok: true, supported: true, autoStartEnabled: false }),
    setAutoStart: payload => {
      calls.push(payload);
      if (typeof payload.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be a boolean' };
      }
      return { ok: true, supported: true, autoStartEnabled: payload.enabled === true };
    },
  };
  registerAmbientController({ ipcMain: ipc, ambientService: service });

  const status = await handlers.get('ambient-status')();
  assert.equal(status.ok, true);
  assert.equal(status.supported, true);

  const invalid = await handlers.get('ambient-set-auto-start')({}, { enabled: 'yes' });
  assert.equal(invalid.ok, false);
  assert.deepEqual(calls, [{ enabled: 'yes' }]);

  const notObject = await handlers.get('ambient-set-auto-start')({}, null);
  assert.equal(notObject.ok, false);
  assert.equal(calls.length, 1);

  const unavailableHandlers = new Map();
  registerAmbientController({
    ipcMain: { handle: (channel, handler) => unavailableHandlers.set(channel, handler) },
    ambientService: null,
  });
  const unavailable = await unavailableHandlers.get('ambient-status')();
  assert.equal(unavailable.ok, false);
});
