'use strict';

const { runMetricsQuery } = require('../metrics/system-metrics');

const SYSTEM_METRICS_TOOL_ID = 'system_metrics';

// This is a trusted built-in tool, not a signed skill. It stays behind the same
// policy and argument-validation boundary as skills, but it can run a longer
// real sampling window in the main process.
function createSystemMetricsTool() {
  return {
    id: SYSTEM_METRICS_TOOL_ID,
    name: 'System Metrics',
    description:
      'Samples real local system telemetry over a duration. One generic tool for CPU, RAM, and NVIDIA GPU utilization, dedicated GPU memory, and temperature. '
      + 'Use this for any request to monitor, observe, watch, measure, or sample system usage over time. Use it instead of system_status for time-series or GPU/VRAM/dedicated-memory requests. '
      + 'It returns only measured values. Never invent or substitute measurements.',
    risk: 'read',
    params: {
      target: {
        type: 'string',
        required: true,
        description: 'What to measure, for example "gpu 1", "gpu 1 dedicated memory", "cpu", or "memory".',
      },
      duration_sec: {
        type: 'number',
        required: false,
        description: 'Sampling duration in seconds, 1-120. Default 5.',
      },
      interval_ms: {
        type: 'number',
        required: false,
        description: 'Sampling interval in milliseconds, 250-5000. GPU sampling is limited to at least 1000 ms. Default 1000.',
      },
      gpu_index: {
        type: 'number',
        required: false,
        description: 'Optional NVIDIA GPU index when the target does not include one, for example 1 for "GPU 1".',
      },
    },
    async execute(args, context = {}) {
      return runMetricsQuery(args, { signal: context.signal || null });
    },
  };
}

module.exports = {
  SYSTEM_METRICS_TOOL_ID,
  createSystemMetricsTool,
};
