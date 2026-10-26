'use strict';

const PLAN_STEP_STATUSES = new Set([
  'pending',
  'active',
  'completed',
  'failed',
  'skipped',
  'revised',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDependencies(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function validatePlan(raw, { toolNames = null, maxSteps = 20 } = {}) {
  const candidate = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' ? raw.steps : null);
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return { ok: false, error: 'Plan must contain at least one step' };
  }
  if (candidate.length > maxSteps) {
    return { ok: false, error: `Plan has ${candidate.length} steps; limit is ${maxSteps}` };
  }

  const knownTools = Array.isArray(toolNames) ? new Set(toolNames) : null;
  const plan = [];
  const ids = new Set();

  for (let index = 0; index < candidate.length; index += 1) {
    const step = candidate[index];
    if (!isPlainObject(step)) {
      return { ok: false, error: `Plan step ${index + 1} must be an object` };
    }
    const id = typeof step.id === 'string' ? step.id.trim() : '';
    if (!id || id.length > 64) {
      return { ok: false, error: `Plan step ${index + 1} has an invalid id` };
    }
    if (ids.has(id)) return { ok: false, error: `Duplicate plan step id: ${id}` };
    ids.add(id);

    const description = typeof step.description === 'string' ? step.description.trim() : '';
    if (!description || description.length > 600) {
      return { ok: false, error: `Plan step ${id} has an invalid description` };
    }

    const dependsOn = normalizeDependencies(step.dependsOn);
    if (dependsOn === null) {
      return { ok: false, error: `Plan step ${id} has invalid dependsOn` };
    }

    const status = step.status === undefined ? 'pending' : step.status;
    if (!PLAN_STEP_STATUSES.has(status)) {
      return { ok: false, error: `Plan step ${id} has an invalid status` };
    }

    const tool = typeof step.tool === 'string' && step.tool.trim() ? step.tool.trim() : null;
    if (tool && knownTools && !knownTools.has(tool)) {
      return { ok: false, error: `Plan step ${id} references unknown tool: ${tool}` };
    }
    if (step.args !== undefined && !isPlainObject(step.args)) {
      return { ok: false, error: `Plan step ${id} args must be an object` };
    }

    plan.push({
      id,
      description,
      status,
      dependsOn,
      ...(tool ? { tool } : {}),
      ...(step.args ? { args: step.args } : {}),
      ...(Number.isInteger(step.revision) && step.revision >= 0 ? { revision: step.revision } : {}),
    });
  }

  for (const step of plan) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        return { ok: false, error: `Plan step ${step.id} depends on missing step ${dependency}` };
      }
      if (dependency === step.id) {
        return { ok: false, error: `Plan step ${step.id} depends on itself` };
      }
    }
  }

  // Detect dependency cycles with a three-color traversal.
  const byId = new Map(plan.map(step => [step.id, step]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  for (const step of plan) {
    if (!visit(step.id)) return { ok: false, error: `Plan contains a dependency cycle at step ${step.id}` };
  }

  return { ok: true, plan };
}

function firstPendingStep(plan) {
  if (!Array.isArray(plan)) return null;
  return plan.find(step => step.status === 'pending' || step.status === 'active' || step.status === 'failed')
    || null;
}

module.exports = {
  PLAN_STEP_STATUSES,
  validatePlan,
  firstPendingStep,
};
