const fs = require('fs');
const path = require('path');

class JarvisScheduler {
  constructor() {
    this.jobs = [];
    this.timer = null;
    this.schedulerFile = null;
    this.onJobTriggered = null; // Callback for when a job fires
  }

  init(userDataPath, triggerCallback) {
    this.schedulerFile = path.join(userDataPath, 'scheduler.json');
    this.onJobTriggered = triggerCallback;
    this.loadJobs();
    this.startLoop();
    console.log('[MAIN] JARVIS Scheduler initialized successfully.');
  }

  loadJobs() {
    try {
      if (fs.existsSync(this.schedulerFile)) {
        const raw = JSON.parse(fs.readFileSync(this.schedulerFile, 'utf8'));
        // MED-04 fix: sanitize loaded jobs — reject any with invalid intervalMs
        this.jobs = raw.filter(j => {
          if (j.type === 'recurring') {
            return typeof j.intervalMs === 'number' &&
                   isFinite(j.intervalMs) &&
                   j.intervalMs >= 10000 &&
                   j.intervalMs <= 7 * 24 * 60 * 60 * 1000;
          }
          return true; // one-off jobs pass through
        });
      }
    } catch (err) {
      console.error('[MAIN] Error loading jobs:', err);
      this.jobs = [];
    }
  }

  async saveJobs() {
    if (!this.schedulerFile) return;
    try {
      await fs.promises.writeFile(this.schedulerFile, JSON.stringify(this.jobs, null, 2));
    } catch (err) {
      console.error('[MAIN] Error saving jobs:', err);
    }
  }

  startLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000); // Check every second
  }

  tick() {
    const now = Date.now();
    let jobsModified = false;

    for (let i = 0; i < this.jobs.length; i++) {
      const job = this.jobs[i];
      if (!job.active) continue;

      if (job.type === 'one-off' && now >= job.triggerTime) {
        this.executeJob(job);
        job.active = false; // Mark as complete
        jobsModified = true;
      } else if (job.type === 'recurring' && now >= job.nextRun) {
        this.executeJob(job);
        job.nextRun = now + job.intervalMs;
        jobsModified = true;
      }
    }

    // Clean up one-off completed jobs
    if (jobsModified) {
      this.jobs = this.jobs.filter(job => job.type === 'recurring' || job.active);
      this.saveJobs();
    }
  }

  executeJob(job) {
    console.log(`[SCHEDULER] Triggering job: ${job.name} (${job.id})`);
    if (this.onJobTriggered) {
      this.onJobTriggered(job);
    }
  }

  addJob(jobData) {
    const newJob = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name: typeof jobData.name === 'string' ? jobData.name.slice(0, 200) : 'Unnamed Job',
      type: jobData.type, // 'one-off' or 'recurring'
      payload: jobData.payload || {},
      active: true,
      createdAt: Date.now()
    };

    if (newJob.type === 'one-off') {
      newJob.triggerTime = jobData.triggerTime;
    } else if (newJob.type === 'recurring') {
      // MED-04 fix: validate intervalMs — must be finite, >= 10s, <= 7 days
      const MIN_INTERVAL = 10000;            // 10 seconds
      const MAX_INTERVAL = 7 * 24 * 3600000; // 7 days
      const ms = Number(jobData.intervalMs);
      if (!isFinite(ms) || ms < MIN_INTERVAL || ms > MAX_INTERVAL) {
        throw new Error(`intervalMs must be a finite number between ${MIN_INTERVAL} and ${MAX_INTERVAL} ms`);
      }
      newJob.intervalMs = ms;
      newJob.nextRun = Date.now() + ms;
    } else {
      throw new Error(`Unknown job type: ${newJob.type}`);
    }

    this.jobs.push(newJob);
    this.saveJobs();
    return newJob;
  }

  removeJob(jobId) {
    const initialLength = this.jobs.length;
    this.jobs = this.jobs.filter(j => j.id !== jobId);
    if (this.jobs.length < initialLength) {
      this.saveJobs();
      return true;
    }
    return false;
  }

  listJobs() {
    return this.jobs;
  }
}

module.exports = new JarvisScheduler();
