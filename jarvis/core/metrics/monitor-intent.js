'use strict';

const { resolveTarget } = require('./system-metrics');

const MAX_DURATION_SEC = 120;
const MIN_DURATION_SEC = 1;

function parseDurationSeconds(text) {
  const value = String(text || '');
  const match = value.match(
    /\b(?:for|over|during|next)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m)\b/i
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = /^(?:m|min|mins|minute|minutes)$/.test(unit)
    ? 60
    : /^(?:ms|msec|msecs|millisecond|milliseconds)$/.test(unit)
      ? 0.001
      : 1;
  const seconds = amount * multiplier;
  if (!Number.isFinite(seconds) || seconds < MIN_DURATION_SEC || seconds > MAX_DURATION_SEC) {
    return null;
  }
  return Math.round(seconds * 1000) / 1000;
}

// Build a deterministic first tool call for a live telemetry goal. The target
// remains the user's wording; the metric registry decides which provider it
// means. This avoids a phrase-to-metric table in the chat layer.
function planMonitoringTask(goal) {
  const text = typeof goal === 'string' ? goal.trim() : '';
  if (!text) return null;

  const durationSec = parseDurationSeconds(text);
  if (!durationSec) return null;

  const action = /\b(monitor|observe|watch|track|measure|sample|record)\b/i.test(text);
  const telemetry = /\b(usage|load|utilization|utilisation|temperature|vram|dedicated\s+memory|gpu|cpu|ram|memory|disk|network)\b/i.test(text);
  if (!action && !telemetry) return null;

  const resolved = resolveTarget(text);
  if (!resolved.ok) return null;

  // Keep the tool target compact and provider-neutral. The original goal stays
  // on the task; only the selected provider/index is needed by the sampler.
  const target = resolved.provider === 'gpu'
    ? `gpu${resolved.gpuIndex === null || resolved.gpuIndex === undefined ? '' : ` ${resolved.gpuIndex}`}`
    : resolved.provider;

  const analytical = /\b(alert|notify|if|when|compare|why|explain|analy[sz]e|recommend|should|threshold|above|below|while|until|trend|peak)\b/i.test(text);
  return {
    toolCall: {
      tool: 'system_metrics',
      args: {
        target,
        duration_sec: durationSec,
      },
      native: false,
    },
    completeWithToolResult: !analytical,
  };
}

module.exports = {
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
  parseDurationSeconds,
  planMonitoringTask,
};
