'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelRouter, recommendModel } = require('../core/models/model-router');

test('routes routine work to a small model and planning work to a strong model', () => {
  const router = new ModelRouter({
    models: [
      { name: 'tiny:1b', tier: 'small', score: 10 },
      { name: 'default:8b', tier: 'default', score: 5 },
      { name: 'strong:70b', tier: 'strong', score: 1 },
    ],
    defaultModel: 'default:8b',
  });

  assert.equal(router.select({ kind: 'classification' }), 'tiny:1b');
  assert.equal(router.select({ kind: 'extraction' }), 'tiny:1b');
  assert.equal(router.select({ kind: 'planning' }), 'strong:70b');
  assert.equal(router.select({ kind: 'ambiguous' }), 'strong:70b');
  assert.equal(router.select({ kind: 'chat' }), 'default:8b');
});

test('high-stakes work uses cloud when available and honors vision requirements', () => {
  const router = new ModelRouter({
    models: [
      { name: 'local:8b', tier: 'strong' },
      { name: 'cloud:large', tier: 'cloud' },
      { name: 'vision:latest', tier: 'strong', capabilities: { vision: true } },
    ],
    defaultModel: 'local:8b',
  });

  assert.equal(router.select({ kind: 'planning', highStakes: true }), 'cloud:large');
  assert.equal(router.select({ kind: 'planning', requiresVision: true }), 'vision:latest');
});

test('falls back to the default model when a tier is unavailable', () => {
  const router = new ModelRouter({
    models: [{ name: 'default:8b', tier: 'default' }],
    defaultModel: 'default:8b',
  });
  assert.equal(router.select({ kind: 'planning' }), 'default:8b');
});

test('recommends the model with measured completion and valid tool calls', () => {
  const recommended = recommendModel([
    { model: 'a', completionRate: 0.8, validToolCallRate: 0.99, unsafeActionRate: 0, p95LatencyMs: 1000 },
    { model: 'b', completionRate: 0.9, validToolCallRate: 0.97, unsafeActionRate: 0, p95LatencyMs: 2000 },
    { model: 'c', completionRate: 0.9, validToolCallRate: 0.99, unsafeActionRate: 0, p95LatencyMs: 2500 },
  ]);
  assert.equal(recommended.model, 'c');

  const safe = recommendModel([
    { model: 'unsafe', completionRate: 1, validToolCallRate: 1, unsafeActionRate: 1, p95LatencyMs: 1 },
    { model: 'safe', completionRate: 1, validToolCallRate: 1, unsafeActionRate: 0, p95LatencyMs: 4000 },
  ]);
  assert.equal(safe.model, 'safe');
});
