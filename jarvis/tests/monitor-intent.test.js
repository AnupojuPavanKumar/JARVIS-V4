'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDurationSeconds, planMonitoringTask } = require('../core/metrics/monitor-intent');

test('parses monitoring durations in seconds and minutes', () => {
  assert.equal(parseDurationSeconds('observe the gpu for 30 sec'), 30);
  assert.equal(parseDurationSeconds('watch memory usage over 1.5 minutes'), 90);
  assert.equal(parseDurationSeconds('sample cpu for 500 ms'), null);
  assert.equal(parseDurationSeconds('sample cpu for 3 hours'), null);
  assert.equal(parseDurationSeconds('what is the gpu usage?'), null);
});

test('plans one generic system_metrics call for the exact GPU request', () => {
  const goal = 'observe the gpu 1 usage, dedicated memory for 30 sec';
  const plan = planMonitoringTask(goal);
  assert.equal(plan.toolCall.tool, 'system_metrics');
  assert.equal(plan.toolCall.args.target, 'gpu 1');
  assert.equal(plan.toolCall.args.duration_sec, 30);
  assert.equal(plan.toolCall.native, false);
  assert.equal(plan.completeWithToolResult, true);
});

test('plans CPU and memory requests without a metric-specific table', () => {
  assert.equal(planMonitoringTask('monitor cpu usage for 2 minutes').toolCall.args.duration_sec, 120);
  assert.equal(planMonitoringTask('observe ram usage for 5 seconds').toolCall.args.duration_sec, 5);
});

test('does not seed unsupported or ambiguous targets', () => {
  assert.equal(planMonitoringTask('observe network throughput for 30 sec'), null);
  assert.equal(planMonitoringTask('monitor cpu and memory for 30 sec'), null);
  assert.equal(planMonitoringTask('wait for 30 seconds'), null);
});

test('leaves analytical monitoring goals to the model after measurement', () => {
  const plan = planMonitoringTask('monitor gpu usage for 30 sec and explain any spike');
  assert.equal(plan.completeWithToolResult, false);
  assert.equal(plan.toolCall.args.duration_sec, 30);
});
