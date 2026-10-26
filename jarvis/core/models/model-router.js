'use strict';

const DEFAULT_ROUTES = Object.freeze({
  chat: 'default',
  classification: 'small',
  extraction: 'small',
  routine: 'small',
  planning: 'strong',
  verification: 'strong',
  ambiguous: 'strong',
  high_stakes: 'strong',
});

function normalizeModel(model, index) {
  if (typeof model === 'string') {
    return { name: model, tier: index === 0 ? 'default' : 'strong', score: 0 };
  }
  if (!model || typeof model !== 'object' || typeof model.name !== 'string') return null;
  return {
    name: model.name,
    tier: typeof model.tier === 'string' ? model.tier : 'default',
    score: Number.isFinite(model.score) ? model.score : 0,
    capabilities: model.capabilities && typeof model.capabilities === 'object'
      ? model.capabilities
      : null,
  };
}

// Small and inspectable router. It does not call a model itself; it maps a
// workload class to an explicit model tier. If a tier is unavailable, it falls
// back to the configured default rather than inventing a model name.
class ModelRouter {
  constructor({ models = [], defaultModel = null, routes = {} } = {}) {
    this.models = (Array.isArray(models) ? models : [])
      .map(normalizeModel)
      .filter(Boolean);
    this.defaultModel = defaultModel || this.models[0]?.name || null;
    this.routes = { ...DEFAULT_ROUTES, ...(routes || {}) };
  }

  select({ kind = 'chat', highStakes = false, ambiguous = false, requiresVision = false } = {}) {
    const route = highStakes
      ? (this.routes.high_stakes || 'strong')
      : (ambiguous ? (this.routes.ambiguous || 'strong') : (this.routes[kind] || 'default'));

    if (highStakes && this.models.some(model => model.tier === 'cloud')) {
      const cloud = this._best('cloud', requiresVision);
      if (cloud) return cloud.name;
    }

    const selected = this._best(route, requiresVision);
    if (selected) return selected.name;
    const fallback = this._best('default', requiresVision);
    return fallback ? fallback.name : this.defaultModel;
  }

  _best(tier, requiresVision) {
    return this.models
      .filter(model => model.tier === tier)
      .filter(model => !requiresVision || model.capabilities?.vision === true)
      .sort((a, b) => b.score - a.score)[0] || null;
  }
}

function recommendModel(measurements) {
  const list = Array.isArray(measurements) ? measurements.filter(Boolean) : [];
  if (list.length === 0) return null;

  return list.slice().sort((a, b) => {
    const aRate = Number(a.successRate ?? a.completionRate ?? 0);
    const bRate = Number(b.successRate ?? b.completionRate ?? 0);
    const completion = bRate - aRate;
    if (completion !== 0) return completion;
    const validity = Number(b.validToolCallRate || 0) - Number(a.validToolCallRate || 0);
    if (validity !== 0) return validity;
    const unsafe = Number(a.unsafeActionRate || 0) - Number(b.unsafeActionRate || 0);
    if (unsafe !== 0) return unsafe;
    const latency = Number(a.p95LatencyMs || Infinity) - Number(b.p95LatencyMs || Infinity);
    if (Number.isFinite(latency) && latency !== 0) return latency;
    return String(a.model || '').localeCompare(String(b.model || ''));
  })[0];
}

module.exports = {
  DEFAULT_ROUTES,
  ModelRouter,
  recommendModel,
};
