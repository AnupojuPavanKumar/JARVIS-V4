// ═══════════════════════════════════════════════════════════════
// agent-policy.js — Pure skill-execution policy (no Electron deps)
// Exports: validateArgs, AgentTaskStore, authorize
// ═══════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');

// ─── Constants ──────────────────────────────────────────────────
const TASK_STEP_CAP      = 8;
const TASK_TTL_MS        = 30 * 60 * 1000; // 30 minutes
const UNTRACKED_CALL_LIMIT     = TASK_STEP_CAP;   // throwaway read calls…
const UNTRACKED_CALL_WINDOW_MS = 60 * 1000;       // …allowed per minute

// ─── validateArgs ───────────────────────────────────────────────
// Returns an error string, or null when args are valid.
function validateArgs(skill, args) {
  if (!skill) return 'Skill not found';
  const params = skill.params || {};

  // Reject unknown keys
  for (const key of Object.keys(args)) {
    if (!(key in params)) {
      return `Unknown param "${key}" for skill "${skill.id}"`;
    }
  }

  for (const [key, schema] of Object.entries(params)) {
    const val = args[key];

    if (schema.required && (val === undefined || val === null || val === '')) {
      return `Missing required param "${key}" for skill "${skill.id}"`;
    }

    if (val !== undefined && val !== null) {
      if (schema.type && typeof val !== schema.type) {
        return `Param "${key}" must be type ${schema.type}, got ${typeof val}`;
      }
      if (schema.enum && !schema.enum.includes(val)) {
        return `Param "${key}" must be one of [${schema.enum.join(', ')}]`;
      }
    }
  }

  return null;
}

// ─── AgentTaskStore ─────────────────────────────────────────────
// Holds per-task state: { stepCount, tainted, aborted, mintedAt }
// Task IDs are 128-bit random hex tokens minted by agent-start.
// Unknown IDs passed to skills-run are never auto-registered as
// full tasks — see authorize() for the "throwaway" read path.
// Eviction runs lazily on every mutating call.
class AgentTaskStore {
  constructor({
    stepCap = TASK_STEP_CAP,
    ttlMs = TASK_TTL_MS,
    untrackedCallLimit = UNTRACKED_CALL_LIMIT,
    untrackedWindowMs = UNTRACKED_CALL_WINDOW_MS,
  } = {}) {
    this._map            = new Map(); // taskId → { stepCount, tainted, aborted, mintedAt }
    this._untrackedCalls = [];        // timestamps of read calls without a taskId
    this.stepCap            = stepCap;
    this.ttlMs              = ttlMs;
    this.untrackedCallLimit = untrackedCallLimit;
    this.untrackedWindowMs  = untrackedWindowMs;
  }

  // ── Mint a new task ID (128-bit random, hex-encoded) ─────────
  mintTaskId() {
    this._evict();
    const id = crypto.randomBytes(16).toString('hex');
    this._map.set(id, { stepCount: 0, tainted: false, aborted: false, mintedAt: Date.now() });
    return id;
  }

  // ── Abort a task ─────────────────────────────────────────────
  // Returns { ok, error? }
  abort(taskId) {
    this._evict();
    if (!taskId || typeof taskId !== 'string') {
      return { ok: false, error: 'Invalid taskId' };
    }
    const rec = this._map.get(taskId);
    if (!rec) {
      // Pre-emptively mark so future mints of same ID (impossible with 128-bit
      // random, but guard anyway) are denied. Store a synthetic aborted entry.
      this._map.set(taskId, { stepCount: 0, tainted: false, aborted: true, mintedAt: Date.now() });
    } else {
      rec.aborted = true;
    }
    return { ok: true };
  }

  // ── Check whether a taskId was minted by agent-start ─────────
  has(taskId) {
    return typeof taskId === 'string' && this._map.has(taskId);
  }

  // ── Get mutable record (null if not found) ────────────────────
  get(taskId) {
    return this._map.get(taskId) || null;
  }

  // ── Rate-limit throwaway (unknown taskId) read calls ──────────
  // Throwaway calls never get a task record, so track them in a global
  // sliding window. Returns false once the per-minute cap is reached.
  allowUntrackedCall() {
    const now = Date.now();
    const cutoff = now - this.untrackedWindowMs;
    this._untrackedCalls = this._untrackedCalls.filter(t => t > cutoff);
    if (this._untrackedCalls.length >= this.untrackedCallLimit) return false;
    this._untrackedCalls.push(now);
    return true;
  }

  // ── Evict entries older than TTL ──────────────────────────────
  _evict() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, rec] of this._map) {
      if (rec.mintedAt < cutoff) this._map.delete(id);
    }
  }

  get size() { return this._map.size; }
}

// ─── authorize ──────────────────────────────────────────────────
// Runs the full policy decision for one skills-run attempt.
//
// Parameters:
//   skill     — skill object from manifest (with .risk, .untrusted, .params)
//   args      — caller-supplied arg map (already coerced to {})
//   taskId    — string|undefined supplied by caller
//   store     — AgentTaskStore instance
//   confirmFn — async (skill, args, risk, tainted) => boolean
//                 Must return true (allow) or false (deny).
//                 In main process this wraps dialog.showMessageBox.
//                 In tests it's a stub.
//
// Returns:
//   { ok: true,  taskRec }               — allowed; caller sets tainted after spawn
//   { ok: false, error, deny }           — denied; deny is the audit reason string
async function authorize({ skill, args, taskId, store, confirmFn }) {
  const risk       = skill.risk || 'read';
  const isKnownId  = store.has(taskId);

  // ── Forged / missing taskId handling ──────────────────────────
  // Only IDs minted by agent-start are "known".
  // Unknown IDs for write/destructive are always denied.
  // Unknown IDs for read are allowed via a throwaway 1-step state
  // that is never inserted into the store, but these calls are still
  // counted against a global per-minute limit (see allowUntrackedCall).
  if (!isKnownId) {
    if (risk === 'write' || risk === 'destructive') {
      return { ok: false, error: 'Unknown or missing taskId — write/destructive skills require a valid task token', deny: 'unknown-taskId' };
    }
    // read skill with unknown taskId → throwaway state (not persisted).
    // Count throwaway calls so omitting taskId cannot bypass the step cap.
    if (!store.allowUntrackedCall()) {
      return { ok: false, error: 'Rate limit exceeded for untracked read skill calls', deny: 'untracked-rate-limit' };
    }
    const throwaway = { stepCount: 0, tainted: false, aborted: false, throwaway: true };
    return await _evaluateStep({ skill, args, risk, taskRec: throwaway, store, confirmFn, persist: false });
  }

  const taskRec = store.get(taskId);

  // ── Abort check ───────────────────────────────────────────────
  if (taskRec.aborted) {
    return { ok: false, error: 'Task has been aborted', deny: 'aborted' };
  }

  // ── Step cap ──────────────────────────────────────────────────
  if (taskRec.stepCount >= store.stepCap) {
    return { ok: false, error: `Step cap of ${store.stepCap} reached for task`, deny: 'step-cap' };
  }

  // Increment now (before confirm) so a denied confirm still counts as a step
  // attempt — prevents a prompt-spam bypass.
  taskRec.stepCount++;

  return await _evaluateStep({ skill, args, risk, taskRec, store, confirmFn, persist: true });
}

// ─── Internal: evaluate risk + taint, call confirmFn if needed ──
async function _evaluateStep({ skill, args, risk, taskRec, confirmFn, persist }) {
  const needsConfirm = (risk === 'write' || risk === 'destructive') || taskRec.tainted;

  if (needsConfirm) {
    const allowed = await confirmFn(skill, args, risk, taskRec.tainted);
    if (!allowed) {
      return {
        ok:    false,
        error: 'User denied permission for this skill',
        deny:  `confirm-denied(risk=${risk}${taskRec.tainted ? ',tainted' : ''})`,
      };
    }
  }

  // Mark tainted after an untrusted skill is confirmed/allowed
  if (skill.untrusted && persist) {
    taskRec.tainted = true;
  }

  return { ok: true, taskRec };
}

module.exports = { validateArgs, AgentTaskStore, authorize, TASK_STEP_CAP, TASK_TTL_MS };
