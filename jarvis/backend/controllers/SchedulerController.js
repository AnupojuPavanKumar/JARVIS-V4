module.exports = function registerSchedulerController({ ipcMain, JarvisScheduler }) {
  
  // ─── Scheduler ───────────────────────────────────────────────────
  
  ipcMain.handle('scheduler-add', async (_, jobData) => {
    try {
      const job = JarvisScheduler.addJob(jobData);
      return { ok: true, job };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  
  ipcMain.handle('scheduler-remove', async (_, jobId) => {
    try {
      const success = JarvisScheduler.removeJob(jobId);
      return { ok: true, success };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  
  ipcMain.handle('scheduler-list', async () => {
    try {
      return { ok: true, jobs: JarvisScheduler.listJobs() };
    } catch (e) { return { ok: false, error: e.message }; }
  });

};
