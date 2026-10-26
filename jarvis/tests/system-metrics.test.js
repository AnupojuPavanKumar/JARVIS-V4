'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DURATION_SEC,
  normalizeArgs,
  resolveTarget,
  parseGpuOutput,
  selectGpu,
  formatMetricValue,
  runMetricsQuery,
} = require('../core/metrics/system-metrics');
const { createSystemMetricsTool } = require('../core/tools/system-metrics-tool');

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

test('normalizes monitoring arguments and rejects out-of-range values', () => {
  const normalized = normalizeArgs({
    target: ' gpu 1 ',
    duration_sec: 30,
    interval_ms: 1000,
    gpu_index: 1,
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.target, 'gpu 1');
  assert.equal(normalized.durationMs, 30000);
  assert.equal(normalized.intervalMs, 1000);
  assert.equal(normalized.gpuIndex, 1);

  assert.equal(normalizeArgs({ target: 'cpu', duration_sec: 0 }).ok, false);
  assert.equal(normalizeArgs({ target: 'cpu', duration_sec: MAX_DURATION_SEC + 1 }).ok, false);
  assert.equal(normalizeArgs({ target: 'cpu', interval_ms: 10 }).ok, false);
  assert.equal(normalizeArgs({ target: '' }).ok, false);
});

test('resolves GPU context before system memory context', () => {
  const gpu = resolveTarget('observe the gpu 1 usage, dedicated memory');
  assert.deepEqual(
    { ok: gpu.ok, provider: gpu.provider, gpuIndex: gpu.gpuIndex },
    { ok: true, provider: 'gpu', gpuIndex: 1 }
  );

  const dedicated = resolveTarget('dedicated memory');
  assert.equal(dedicated.provider, 'gpu');
  assert.equal(dedicated.gpuIndex, null);

  assert.equal(resolveTarget('memory usage').provider, 'memory');
  assert.equal(resolveTarget('ram usage').provider, 'memory');
  assert.equal(resolveTarget('cpu usage').provider, 'cpu');
  assert.equal(resolveTarget('gpu 1', 1).gpuIndex, 1);
  assert.equal(resolveTarget('gpu 1', 2).ok, false);
  assert.match(resolveTarget('cpu and memory').error, /Ambiguous/);
  assert.match(resolveTarget('network throughput').error, /Unsupported/);
});

test('parses nvidia-smi rows from both ends so names may contain commas', () => {
  const rows = parseGpuOutput([
    '0, NVIDIA GeForce RTX 4050 Laptop GPU, 37, 4924, 6141, 61',
    '1, Other, GPU, 12, 100, 200, [N/A]',
  ].join('\n'));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].gpuIndex, 0);
  assert.equal(rows[0].gpuName, 'NVIDIA GeForce RTX 4050 Laptop GPU');
  assert.equal(rows[0].utilizationPercent, 37);
  assert.equal(rows[0].memoryUsedBytes, 4924 * MIB);
  assert.equal(rows[0].memoryTotalBytes, 6141 * MIB);
  assert.ok(Math.abs(rows[0].memoryUsedPercent - (4924 / 6141) * 100) < 0.001);
  assert.equal(rows[0].temperatureC, 61);
  assert.equal(rows[1].gpuName, 'Other, GPU');
  assert.equal(rows[1].temperatureC, null);
});

test('maps the sole NVIDIA adapter to a requested Windows GPU number explicitly', () => {
  const gpus = [{ gpuIndex: 0, gpuName: 'RTX' }];
  const mapped = selectGpu(gpus, 1);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.indexMapped, true);
  assert.equal(mapped.gpu.gpuIndex, 0);

  const exact = selectGpu([{ gpuIndex: 0 }, { gpuIndex: 1 }], 1);
  assert.equal(exact.ok, true);
  assert.equal(exact.indexMapped, false);

  assert.equal(selectGpu([{ gpuIndex: 0 }, { gpuIndex: 1 }], 2).ok, false);
});

test('formats byte and percentage metric values', () => {
  assert.equal(formatMetricValue(8 * GIB, 'bytes'), '8.00 GB');
  assert.equal(formatMetricValue(512 * MIB, 'bytes'), '512 MB');
  assert.equal(formatMetricValue(45.56, '%'), '45.6%');
  assert.equal(formatMetricValue(61.4, '°C'), '61°C');
});

test('samples memory through the generic query shape', async () => {
  let clock = 0;
  const values = [
    { totalBytes: 16 * GIB, usedBytes: 8 * GIB, freeBytes: 8 * GIB, usedPercent: 50 },
    { totalBytes: 16 * GIB, usedBytes: 9 * GIB, freeBytes: 7 * GIB, usedPercent: 56.25 },
    { totalBytes: 16 * GIB, usedBytes: 7 * GIB, freeBytes: 9 * GIB, usedPercent: 43.75 },
  ];
  let index = 0;

  const result = await runMetricsQuery(
    { target: 'memory', duration_sec: 2, interval_ms: 1000 },
    {
      now: () => clock,
      wait: async ms => { clock += ms; },
      readMemory: () => values[index++],
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'memory');
  assert.equal(result.sampleCount, 3);
  const used = result.metrics.find(metric => metric.key === 'memory.used');
  assert.equal(used.avg, 8 * GIB);
  assert.equal(used.min, 7 * GIB);
  assert.equal(used.max, 9 * GIB);
  assert.equal(result.metrics.find(metric => metric.key === 'memory.total').value, 16 * GIB);
  assert.match(result.summaryText, /RAM over 2s \(3 samples\)/);
});

test('samples CPU usage through the generic query shape', async () => {
  let clock = 0;
  const cpu = [
    { idle: 40, total: 100 },
    { idle: 90, total: 200 },
    { idle: 140, total: 300 },
  ];
  let index = 0;

  const result = await runMetricsQuery(
    { target: 'cpu', duration_sec: 2, interval_ms: 1000 },
    {
      now: () => clock,
      wait: async ms => { clock += ms; },
      readCpuTimes: () => cpu[index++],
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'cpu');
  assert.equal(result.sampleCount, 2);
  assert.equal(result.metrics[0].key, 'cpu.utilization');
  assert.equal(result.metrics[0].avg, 50);
  assert.match(result.summaryText, /CPU over 2s/);
});

test('samples GPU utilization and dedicated memory, including the GPU mapping note', async () => {
  let clock = 0;
  let call = 0;
  const gpu = async requestedIndex => {
    call += 1;
    return {
      ok: true,
      gpuIndex: 0,
      gpuName: 'NVIDIA GeForce RTX 4050 Laptop GPU',
      utilizationPercent: 20 + call,
      memoryUsedBytes: (4800 + call) * MIB,
      memoryTotalBytes: 6141 * MIB,
      memoryUsedPercent: ((4800 + call) / 6141) * 100,
      temperatureC: 60 + call,
      requestedIndex,
      indexMapped: requestedIndex === 1,
      availableGpuCount: 1,
    };
  };

  const result = await runMetricsQuery(
    { target: 'gpu 1 usage, dedicated memory', duration_sec: 2, interval_ms: 1000, gpu_index: 1 },
    {
      now: () => clock,
      wait: async ms => { clock += ms; },
      readGpu: gpu,
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'gpu');
  assert.equal(result.sampleCount, 3);
  assert.equal(result.meta.gpuIndex, 0);
  assert.equal(result.meta.requestedGpuIndex, 1);
  assert.equal(result.meta.indexMapped, true);
  assert.match(result.meta.note, /nvidia-smi reports the only NVIDIA adapter as index 0/);
  assert.match(result.summaryText, /GPU 1 \(NVIDIA GeForce RTX 4050 Laptop GPU\)/);
  assert.match(result.summaryText, /dedicated memory/);
  const utilization = result.metrics.find(metric => metric.key === 'GPU 1.utilization');
  assert.equal(utilization.min, 21);
  assert.equal(utilization.max, 23);
  assert.equal(utilization.avg, 22);
  assert.equal(result.metrics.find(metric => metric.key === 'GPU 1.dedicated_memory.total').value, 6141 * MIB);
  assert.match(result.displayMarkdown, /^### GPU 1 \(NVIDIA GeForce RTX 4050 Laptop GPU\) — 2s/);
  assert.match(result.displayMarkdown, /\| GPU 1 dedicated memory usage \|/);
  assert.equal(result.agentText, result.displayMarkdown);
  assert.match(result.displayMarkdown, /3 real samples at approximately 1000 ms intervals/);
});

test('does not substitute RAM when nvidia-smi fails', async () => {
  const result = await runMetricsQuery(
    { target: 'gpu 1', duration_sec: 2, interval_ms: 1000 },
    {
      now: () => 0,
      readGpu: async () => ({ ok: false, error: 'nvidia-smi unavailable' }),
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /nvidia-smi unavailable/);
  assert.equal(result.provider, undefined);
});

test('exposes one generic native tool with shared argument validation', async () => {
  const tool = createSystemMetricsTool();
  assert.equal(tool.id, 'system_metrics');
  assert.equal(tool.risk, 'read');
  assert.equal(tool.params.target.required, true);
  assert.equal(tool.params.duration_sec.type, 'number');

  const missing = await tool.execute({});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /target is required/);
});
