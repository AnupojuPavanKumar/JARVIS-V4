// JARVIS Skill: System Status
const os = require('os');

const totalMem = os.totalmem();
const freeMem = os.freemem();
const usedMem = totalMem - freeMem;

const result = {
  ok: true,
  skill: 'system_status',
  data: {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime_seconds: os.uptime(),
    uptime_human: formatUptime(os.uptime()),
    cpu_model: os.cpus()[0]?.model?.trim() || 'Unknown',
    cpu_cores: os.cpus().length,
    memory: {
      total_gb: (totalMem / 1024 / 1024 / 1024).toFixed(2),
      used_gb: (usedMem / 1024 / 1024 / 1024).toFixed(2),
      free_gb: (freeMem / 1024 / 1024 / 1024).toFixed(2),
      usage_percent: ((usedMem / totalMem) * 100).toFixed(1)
    }
  }
};

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

console.log(JSON.stringify(result));
