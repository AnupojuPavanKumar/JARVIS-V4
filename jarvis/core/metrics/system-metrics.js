'use strict';

const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_DURATION_SEC = 5;
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 120;
const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 5000;
const MIN_GPU_INTERVAL_MS = 1000;
const MAX_SAMPLES = 240;
const MIB = 1024 * 1024;
const GPU_QUERY_ARGS = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
];

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stats(values) {
  const finite = (values || []).filter(value => Number.isFinite(value));
  if (finite.length === 0) return { avg: 0, min: 0, max: 0, count: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of finite) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { avg: sum / finite.length, min, max, count: finite.length };
}

function normalizeArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'system_metrics args must be an object' };
  }

  const target = typeof args.target === 'string' ? args.target.trim() : '';
  if (!target) return { ok: false, error: 'target is required (for example "gpu 1", "cpu", or "memory")' };
  if (target.length > 200) return { ok: false, error: 'target must be 200 characters or fewer' };

  const durationValue = args.duration_sec === undefined ? DEFAULT_DURATION_SEC : Number(args.duration_sec);
  if (!Number.isFinite(durationValue) || durationValue < MIN_DURATION_SEC || durationValue > MAX_DURATION_SEC) {
    return {
      ok: false,
      error: `duration_sec must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC}`,
    };
  }
  const durationMs = Math.round(durationValue * 1000);

  const intervalValue = args.interval_ms === undefined ? DEFAULT_INTERVAL_MS : Number(args.interval_ms);
  if (!Number.isFinite(intervalValue) || intervalValue < MIN_INTERVAL_MS || intervalValue > MAX_INTERVAL_MS) {
    return {
      ok: false,
      error: `interval_ms must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    };
  }

  let intervalMs = Math.floor(intervalValue);
  intervalMs = Math.min(intervalMs, Math.max(MIN_INTERVAL_MS, Math.floor(durationMs / 2)));
  intervalMs = Math.max(intervalMs, Math.ceil(durationMs / MAX_SAMPLES));

  let gpuIndex = null;
  if (args.gpu_index !== undefined && args.gpu_index !== null) {
    const parsed = Number(args.gpu_index);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 15) {
      return { ok: false, error: 'gpu_index must be an integer between 0 and 15' };
    }
    gpuIndex = parsed;
  }

  return { ok: true, target, durationMs, intervalMs, gpuIndex };
}

// Resolve a natural target to exactly one provider. GPU phrases are checked
// first because "dedicated memory" and "gpu memory" are GPU terms, not RAM.
function resolveTarget(target, explicitGpuIndex = null) {
  const text = typeof target === 'string' ? target.trim() : '';
  if (!text) return { ok: false, error: 'target is required' };

  const lower = text.toLowerCase();
  const gpuContext = /\bgpu\b|\bvram\b|\bgraphics\b|dedicated\s+memory|\bnvidia\b/.test(lower);
  const cpuContext = /\bcpu\b|\bprocessor\b/.test(lower);
  const memoryText = lower
    .replace(/dedicated\s+memory/g, ' ')
    .replace(/\bgpu\s+memory\b/g, ' ');
  const memoryContext = /\bram\b|\bmemory\b/.test(memoryText);

  const contexts = [
    gpuContext ? 'gpu' : null,
    cpuContext ? 'cpu' : null,
    memoryContext ? 'memory' : null,
  ].filter(Boolean);

  if (contexts.length > 1) {
    return {
      ok: false,
      error: `Ambiguous target "${text}". Ask for one provider at a time: CPU, memory, or GPU.`,
    };
  }
  if (contexts.length === 0) {
    return {
      ok: false,
      error: `Unsupported target "${text}". Supported providers: CPU, memory/RAM, GPU/VRAM/dedicated memory.`,
    };
  }

  const provider = contexts[0];
  let gpuIndex = null;
  if (provider === 'gpu') {
    const match = lower.match(/\bgpu\s*(?:#|number|index)?\s*(\d+)\b/);
    if (match) gpuIndex = Number(match[1]);
    if (explicitGpuIndex !== null && explicitGpuIndex !== undefined) {
      if (gpuIndex !== null && gpuIndex !== explicitGpuIndex) {
        return {
          ok: false,
          error: `GPU index conflict: target says ${gpuIndex}, gpu_index says ${explicitGpuIndex}.`,
        };
      }
      gpuIndex = explicitGpuIndex;
    }
    if (gpuIndex !== null && (!Number.isInteger(gpuIndex) || gpuIndex < 0 || gpuIndex > 15)) {
      return { ok: false, error: 'gpuIndex must be an integer between 0 and 15' };
    }
  }

  return { ok: true, provider, gpuIndex, target: text };
}

function readMemory() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
  };
}

function readCpuTimes() {
  const cpus = os.cpus() || [];
  return cpus.reduce((totals, cpu) => {
    const times = cpu.times || {};
    totals.idle += Number(times.idle) || 0;
    totals.total += (Number(times.user) || 0)
      + (Number(times.nice) || 0)
      + (Number(times.sys) || 0)
      + (Number(times.idle) || 0)
      + (Number(times.irq) || 0);
    return totals;
  }, { idle: 0, total: 0 });
}

function cpuUsagePercent(previous, current) {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  return clamp((1 - idleDelta / totalDelta) * 100, 0, 100);
}

// nvidia-smi uses a comma-separated row. Parse from both ends so an adapter
// name containing a comma does not shift the numeric fields.
function parseGpuOutput(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map(part => part.trim());
    if (parts.length < 6) continue;

    const gpuIndex = Number(parts[0]);
    const gpuName = parts.slice(1, parts.length - 4).join(', ').trim();
    const utilizationPercent = numberOrNull(parts[parts.length - 4]);
    const memoryUsedMiB = numberOrNull(parts[parts.length - 3]);
    const memoryTotalMiB = numberOrNull(parts[parts.length - 2]);
    const temperatureC = numberOrNull(parts[parts.length - 1]);

    if (!Number.isInteger(gpuIndex) || !gpuName) continue;
    if (memoryUsedMiB === null || memoryTotalMiB === null || memoryTotalMiB <= 0) continue;

    rows.push({
      gpuIndex,
      gpuName,
      utilizationPercent: utilizationPercent === null ? null : clamp(utilizationPercent, 0, 100),
      memoryUsedBytes: memoryUsedMiB * MIB,
      memoryTotalBytes: memoryTotalMiB * MIB,
      memoryUsedPercent: clamp((memoryUsedMiB / memoryTotalMiB) * 100, 0, 100),
      temperatureC,
    });
  }
  return rows;
}

function queryGpu() {
  return new Promise(resolve => {
    execFile(
      'nvidia-smi',
      GPU_QUERY_ARGS,
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: `nvidia-smi unavailable: ${error.message}` });
          return;
        }
        const gpus = parseGpuOutput(stdout);
        if (gpus.length === 0) {
          resolve({ ok: false, error: 'nvidia-smi returned no parseable GPU data' });
          return;
        }
        resolve({ ok: true, gpus });
      }
    );
  });
}

function selectGpu(gpus, requestedIndex = null) {
  if (!Array.isArray(gpus) || gpus.length === 0) {
    return { ok: false, error: 'No NVIDIA GPU detected' };
  }
  if (requestedIndex === null || requestedIndex === undefined) {
    return { ok: true, gpu: gpus[0], requestedIndex: null, indexMapped: false };
  }

  const exact = gpus.find(gpu => gpu.gpuIndex === requestedIndex);
  if (exact) {
    return { ok: true, gpu: exact, requestedIndex, indexMapped: false };
  }
  if (gpus.length === 1) {
    return { ok: true, gpu: gpus[0], requestedIndex, indexMapped: true };
  }
  return {
    ok: false,
    error: `GPU ${requestedIndex} was not found. Available NVIDIA GPU indexes: ${gpus.map(gpu => gpu.gpuIndex).join(', ')}`,
  };
}

async function readGpu(requestedIndex = null) {
  const query = await queryGpu();
  if (!query.ok) return query;
  const selected = selectGpu(query.gpus, requestedIndex);
  if (!selected.ok) return selected;
  return {
    ok: true,
    ...selected.gpu,
    requestedIndex: selected.requestedIndex,
    indexMapped: selected.indexMapped,
    availableGpuCount: query.gpus.length,
  };
}

function abortableWait(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Monitor aborted'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error('Monitor aborted'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function formatMetricValue(value, unit) {
  if (unit === 'bytes') {
    const bytes = Number(value) || 0;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (unit === '%') return `${(Number(value) || 0).toFixed(1)}%`;
  if (unit === '°C') return `${Math.round(Number(value) || 0)}°C`;
  return String(value);
}

function metric(key, label, unit, values) {
  const summary = stats(values);
  return {
    key,
    label,
    unit,
    avg: summary.avg,
    min: summary.min,
    max: summary.max,
    samples: summary.count,
    available: summary.count > 0,
  };
}

function buildMetrics(provider, samples, meta) {
  if (provider === 'cpu') {
    return [metric('cpu.utilization', 'CPU utilization', '%', samples.map(sample => sample.percent))];
  }

  if (provider === 'memory') {
    return [
      metric('memory.used', 'RAM used', 'bytes', samples.map(sample => sample.usedBytes)),
      metric('memory.used_percent', 'RAM usage', '%', samples.map(sample => sample.usedPercent)),
      metric('memory.free', 'RAM free', 'bytes', samples.map(sample => sample.freeBytes)),
      {
        key: 'memory.total',
        label: 'Total RAM',
        unit: 'bytes',
        value: samples[samples.length - 1]?.totalBytes || 0,
        samples: samples.length,
        available: true,
      },
    ];
  }

  const gpuLabel = meta.requestedGpuIndex === null || meta.requestedGpuIndex === undefined
    ? `GPU ${meta.gpuIndex === null || meta.gpuIndex === undefined ? '' : meta.gpuIndex}`.trim()
    : `GPU ${meta.requestedGpuIndex}`;

  const metrics = [
    metric(`${gpuLabel}.utilization`, `${gpuLabel} utilization`, '%', samples.map(sample => sample.utilizationPercent)),
    metric(`${gpuLabel}.dedicated_memory.used`, `${gpuLabel} dedicated memory used`, 'bytes', samples.map(sample => sample.memoryUsedBytes)),
    metric(`${gpuLabel}.dedicated_memory.used_percent`, `${gpuLabel} dedicated memory usage`, '%', samples.map(sample => sample.memoryUsedPercent)),
    {
      key: `${gpuLabel}.dedicated_memory.total`,
      label: `${gpuLabel} dedicated memory total`,
      unit: 'bytes',
      value: samples[samples.length - 1]?.memoryTotalBytes || 0,
      samples: samples.length,
      available: true,
    },
  ];

  const temperatures = samples.map(sample => sample.temperatureC);
  if (temperatures.some(value => Number.isFinite(value))) {
    metrics.push(metric(`${gpuLabel}.temperature`, `${gpuLabel} temperature`, '°C', temperatures));
  }
  return metrics;
}

function metricSubject(provider, meta) {
  if (provider === 'gpu') {
    return meta.requestedGpuIndex === null || meta.requestedGpuIndex === undefined
      ? `GPU ${meta.gpuIndex}`
      : `GPU ${meta.requestedGpuIndex}`;
  }
  return provider === 'cpu' ? 'CPU' : 'RAM';
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function buildDisplayMarkdown(provider, metrics, meta, durationMs, sampleCount, intervalMs) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const subject = metricSubject(provider, meta);
  const title = meta.gpuName ? `${subject} (${meta.gpuName})` : subject;
  const effectiveInterval = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : durationMs / Math.max(1, sampleCount);
  const lines = [
    `### ${title} — ${seconds}s`,
    `${sampleCount} real samples at approximately ${Math.max(1, Math.round(effectiveInterval))} ms intervals.`,
  ];
  if (meta.note) lines.push('', `> ${meta.note}`);
  lines.push(
    '',
    '| Metric | Average | Minimum | Maximum |',
    '| --- | ---: | ---: | ---: |'
  );

  for (const entry of metrics) {
    if (entry.available === false) continue;
    const label = escapeMarkdownCell(entry.label);
    if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
      lines.push(`| ${label} | ${formatMetricValue(entry.value, entry.unit)} | — | — |`);
    } else {
      lines.push(
        `| ${label} | ${formatMetricValue(entry.avg, entry.unit)} | ${formatMetricValue(entry.min, entry.unit)} | ${formatMetricValue(entry.max, entry.unit)} |`
      );
    }
  }
  return lines.join('\n');
}

function buildSummaryText(provider, metrics, meta, durationMs, sampleCount) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const parts = metrics
    .filter(entry => entry.available !== false)
    .map(entry => {
      if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
        return `${entry.label}: ${formatMetricValue(entry.value, entry.unit)}`;
      }
      return `${entry.label}: avg ${formatMetricValue(entry.avg, entry.unit)} (min ${formatMetricValue(entry.min, entry.unit)}, max ${formatMetricValue(entry.max, entry.unit)})`;
    });

  let subject;
  if (provider === 'gpu') {
    subject = meta.requestedGpuIndex === null || meta.requestedGpuIndex === undefined
      ? `GPU ${meta.gpuIndex}`
      : `GPU ${meta.requestedGpuIndex}`;
    if (meta.gpuName) subject += ` (${meta.gpuName})`;
  } else if (provider === 'cpu') {
    subject = 'CPU';
  } else {
    subject = 'RAM';
  }

  const note = meta.note ? ` ${meta.note}` : '';
  return `${subject} over ${seconds}s (${sampleCount} samples): ${parts.join('; ')}.${note}`;
}

async function runMetricsQuery(args = {}, dependencies = {}) {
  const normalized = normalizeArgs(args);
  if (!normalized.ok) return normalized;

  const resolved = resolveTarget(normalized.target, normalized.gpuIndex);
  if (!resolved.ok) return resolved;

  const signal = dependencies.signal || null;
  const now = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
  const wait = typeof dependencies.wait === 'function'
    ? dependencies.wait
    : abortableWait;
  const readMemorySample = typeof dependencies.readMemory === 'function'
    ? dependencies.readMemory
    : readMemory;
  const readCpuSample = typeof dependencies.readCpuTimes === 'function'
    ? dependencies.readCpuTimes
    : readCpuTimes;
  const readGpuSample = typeof dependencies.readGpu === 'function'
    ? dependencies.readGpu
    : readGpu;

  const { provider, gpuIndex } = resolved;
  let intervalMs = normalized.intervalMs;
  if (provider === 'gpu') {
    // nvidia-smi is an external process. Keep its sampling rate useful without
    // spawning it four times a second.
    intervalMs = Math.max(intervalMs, Math.min(MIN_GPU_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(normalized.durationMs / 2))));
  }

  const startedAt = now();
  const finishAt = startedAt + normalized.durationMs;
  const samples = [];
  let gpuMeta = null;
  let previousCpu = provider === 'cpu' ? readCpuSample() : null;

  try {
    if (provider === 'memory') {
      samples.push({ at: startedAt, ...readMemorySample() });
    } else if (provider === 'gpu') {
      const first = await readGpuSample(gpuIndex);
      if (!first.ok) return first;
      gpuMeta = first;
      samples.push({ at: startedAt, ...first });
    }

    // Schedule against absolute sample times. A slow provider call (notably
    // nvidia-smi) must not add its own latency to every subsequent interval.
    let nextSampleAt = startedAt + intervalMs;
    while (samples.length < MAX_SAMPLES && nextSampleAt <= finishAt) {
      if (signal?.aborted) return { ok: false, error: 'Monitor aborted' };
      const delay = nextSampleAt - now();
      if (delay > 0) await wait(delay, signal);
      const at = now();

      if (provider === 'memory') {
        samples.push({ at, ...readMemorySample() });
      } else if (provider === 'cpu') {
        const current = readCpuSample();
        samples.push({ at, percent: cpuUsagePercent(previousCpu, current) });
        previousCpu = current;
      } else {
        const current = await readGpuSample(gpuIndex);
        if (!current.ok) return current;
        if (!gpuMeta) gpuMeta = current;
        samples.push({ at, ...current });
      }

      nextSampleAt += intervalMs;
      if (nextSampleAt <= at) nextSampleAt = at + intervalMs;
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const meta = { provider };
  if (provider === 'gpu') {
    meta.gpuIndex = gpuMeta?.gpuIndex ?? null;
    meta.gpuName = gpuMeta?.gpuName || null;
    meta.requestedGpuIndex = gpuIndex;
    meta.indexMapped = Boolean(gpuMeta?.indexMapped);
    meta.availableGpuCount = gpuMeta?.availableGpuCount ?? null;
    if (meta.indexMapped) {
      meta.note = `Requested GPU ${gpuIndex}; nvidia-smi reports the only NVIDIA adapter as index ${meta.gpuIndex}. Windows may label that adapter as GPU ${gpuIndex}.`;
    }
  }

  const metrics = buildMetrics(provider, samples, meta);
  const endedAt = now();
  const observedIntervalMs = samples.length > 1
    ? (samples[samples.length - 1].at - samples[0].at) / (samples.length - 1)
    : intervalMs;
  const displayMarkdown = buildDisplayMarkdown(
    provider,
    metrics,
    meta,
    normalized.durationMs,
    samples.length,
    observedIntervalMs
  );
  return {
    ok: true,
    tool: 'system_metrics',
    provider,
    target: resolved.target,
    durationMs: normalized.durationMs,
    intervalMs,
    observedIntervalMs,
    sampleCount: samples.length,
    startedAt,
    endedAt,
    meta,
    metrics,
    summaryText: buildSummaryText(provider, metrics, meta, normalized.durationMs, samples.length),
    displayMarkdown,
    agentText: displayMarkdown,
  };
}

module.exports = {
  DEFAULT_DURATION_SEC,
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_GPU_INTERVAL_MS,
  MAX_SAMPLES,
  normalizeArgs,
  resolveTarget,
  readMemory,
  readCpuTimes,
  cpuUsagePercent,
  parseGpuOutput,
  selectGpu,
  readGpu,
  formatMetricValue,
  buildDisplayMarkdown,
  runMetricsQuery,
};
