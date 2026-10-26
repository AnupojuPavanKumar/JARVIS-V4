'use strict';

module.exports = function registerSchedulerController({ ipcMain, Scheduler, scheduler = null }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerSchedulerController requires ipcMain');
  }
  const service = Scheduler || scheduler;
  if (!service || typeof service.addJob !== 'function') {
    throw new Error('registerSchedulerController requires an initialized Scheduler');
  }

  function fail(error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  ipcMain.handle('scheduler-add', async (_, jobData) => {
    try {
      const job = await service.addJob(jobData);
      return { ok: true, job };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('scheduler-remove', async (_, jobId) => {
    try {
      const success = await service.removeJob(jobId);
      return { ok: true, success };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('scheduler-list', async () => {
    try {
      return {
        ok: true,
        jobs: service.listJobs(),
        runs: service.listRuns({ limit: 50 }),
        settings: typeof service.getSettings === 'function' ? service.getSettings() : null,
      };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('scheduler-runs', async (_, options = {}) => {
    try {
      return {
        ok: true,
        runs: service.listRuns({
          jobId: typeof options?.jobId === 'string' ? options.jobId : null,
          limit: Number.isInteger(options?.limit) ? options.limit : 50,
        }),
      };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('scheduler-settings-update', async (_, settings = {}) => {
    try {
      const updated = await service.updateSettings(settings);
      return { ok: true, settings: updated };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('scheduler-event', async (_, eventName, payload = {}) => {
    try {
      if (typeof eventName !== 'string' || !eventName.trim()) {
        return { ok: false, error: 'Event name is required' };
      }
      const matched = await service.emitEvent(eventName.trim(), payload);
      return { ok: true, matched };
    } catch (error) {
      return fail(error);
    }
  });

  return { service };
};
