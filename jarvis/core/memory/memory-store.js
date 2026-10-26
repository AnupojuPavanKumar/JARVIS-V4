'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  MEMORY_SCHEMA_VERSION,
  MEMORY_TYPES,
  MEMORY_TYPE_SET,
  SENSITIVITY_SET,
  normalizeText,
  normalizeRecord,
  makeMemoryId,
  isValidMemoryId,
  classifySensitivity,
  isManual,
  isExpired,
} = require('./memory-schema');
const {
  extractConversationCandidates,
  summarizeConversation,
} = require('./memory-extractor');

const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_RETRIEVAL_RECORDS = 6;
const DEFAULT_RETRIEVAL_CHARS = 1800;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sourcePriority(record) {
  if (!record) return 0;
  const kind = record.source && record.source.kind;
  if (kind === 'manual') return 4;
  if (kind === 'task') return 3;
  if (kind === 'conversation') return 2;
  if (kind === 'migration') return 1;
  return 0;
}

function normalizedKey(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(text) {
  return new Set(normalizedKey(text).split(' ').filter(Boolean));
}

function tokenOverlap(a, b) {
  const left = a instanceof Set ? a : tokenSet(a);
  const right = b instanceof Set ? b : tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

function sourceIdentity(record) {
  if (!record || !record.source) return null;
  const kind = record.source.kind;
  if (kind === 'task' && record.source.taskId) return `task:${record.source.taskId}`;
  if (kind === 'conversation' && record.source.sessionId) return `conversation:${record.source.sessionId}`;
  return null;
}

// Facts with the same predicate describe the same slot. This catches manual
// corrections such as "my name is Ada" vs a later extracted "my name is Grace"
// even when the values are too different for a token-similarity match.
function semanticSlot(text) {
  const value = normalizedKey(text);
  const slots = [
    /^user s name is /,
    /^user prefers to be called /,
    /^user lives in /,
    /^user is from /,
    /^user works at /,
    /^user s birthday is /,
    /^user s favorite [a-z0-9 ]+? is /,
  ];
  for (const pattern of slots) {
    if (pattern.test(value)) return pattern.exec(value)[0];
  }
  return null;
}

class MemoryStore {
  constructor({
    baseDir,
    filePath = null,
    now = Date.now,
    maxRecords = DEFAULT_MAX_RECORDS,
    logger = console,
    idFactory = makeMemoryId,
  } = {}) {
    if (!baseDir && !filePath) throw new Error('MemoryStore requires baseDir or filePath');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new Error('MemoryStore maxRecords must be a positive integer');
    }

    this.baseDir = baseDir ? path.resolve(baseDir) : path.dirname(path.resolve(filePath));
    this.filePath = filePath ? path.resolve(filePath) : path.join(this.baseDir, 'memory.json');
    this.backupPath = `${this.filePath}.pre-migration.bak`;
    this.now = now;
    this.maxRecords = maxRecords;
    this.logger = logger;
    this.idFactory = idFactory;
    this.records = [];
    this.migration = null;
    this.schemaVersion = MEMORY_SCHEMA_VERSION;
    this._initialized = false;
    this._queue = Promise.resolve();
  }

  async init() {
    if (this._initialized) return this.stats();
    await fs.promises.mkdir(this.baseDir, { recursive: true });

    let raw = null;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Failed to read memory store: ${error.message}`);
    }

    if (raw !== null) {
      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch (error) {
        throw new Error(`Memory store is corrupt: ${error.message}`);
      }

      if (this._isLegacyFormat(parsed)) {
        await this._migrateLegacy(parsed, raw);
      } else {
        this._loadCurrent(parsed);
      }
    }

    this._initialized = true;
    if (!raw) await this._writeNow();
    return this.stats();
  }

  _isLegacyFormat(parsed) {
    if (Array.isArray(parsed)) return true;
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.schemaVersion === MEMORY_SCHEMA_VERSION && Array.isArray(parsed.records)) return false;
    return Array.isArray(parsed.memories) || Array.isArray(parsed.facts) || Array.isArray(parsed.records);
  }

  _loadCurrent(parsed) {
    if (!parsed || parsed.schemaVersion !== MEMORY_SCHEMA_VERSION || !Array.isArray(parsed.records)) {
      throw new Error(`Unsupported memory store schema version: ${String(parsed && parsed.schemaVersion)}`);
    }

    const loaded = [];
    for (const raw of parsed.records) {
      try {
        loaded.push(normalizeRecord(raw, { now: this.now() }));
      } catch (error) {
        (this.logger.warn || this.logger.log || (() => {}))(`[Memory] Skipping malformed record: ${error.message}`);
      }
    }
    this.records = loaded.slice(-this.maxRecords);
    this.migration = parsed.migration && typeof parsed.migration === 'object' ? clone(parsed.migration) : null;
  }

  _legacyItems(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
    if (Array.isArray(parsed?.memories)) return parsed.memories;
    if (Array.isArray(parsed?.facts)) return parsed.facts;
    return [];
  }

  async _migrateLegacy(parsed, raw) {
    const items = this._legacyItems(parsed);
    const migrated = [];
    let skipped = 0;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      try {
        const base = typeof item === 'string' ? { text: item } : (item || {});
        const text = normalizeText(base.text ?? base.content ?? base.fact ?? base.memory);
        if (!text) {
          skipped += 1;
          continue;
        }
        const createdAt = base.createdAt ?? base.timestamp ?? this.now();
        const record = normalizeRecord({
          ...base,
          text,
          createdAt,
          updatedAt: base.updatedAt ?? createdAt,
          source: { kind: 'manual', migrated: true },
          confidence: typeof base.confidence === 'number' ? base.confidence : 0.8,
          sensitivity: base.sensitivity || classifySensitivity(text),
        }, { now: this.now() });
        migrated.push(record);
      } catch (error) {
        skipped += 1;
        (this.logger.warn || this.logger.log || (() => {}))(`[Memory] Skipping legacy entry ${index}: ${error.message}`);
      }
    }

    // Preserve the original bytes before writing the normalized format. Never
    // overwrite an earlier backup: it is the user's recovery copy.
    let backedUp = false;
    try {
      await fs.promises.writeFile(this.backupPath, raw, { encoding: 'utf8', flag: 'wx' });
      backedUp = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    this.records = migrated.slice(-this.maxRecords);
    this.migration = {
      from: Array.isArray(parsed) ? 'legacy-array' : 'legacy-object',
      migratedAt: this.now(),
      count: migrated.length,
      skipped,
      backedUp,
      backupPath: this.backupPath,
    };
    await this._writeNow();
    (this.logger.log || (() => {}))(
      `[Memory] Migrated ${migrated.length} legacy record(s)${skipped ? `, skipped ${skipped}` : ''}.`
    );
  }

  _serialize() {
    return JSON.stringify({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      updatedAt: this.now(),
      migration: this.migration,
      settings: {
        maxRecords: this.maxRecords,
      },
      records: this.records,
    }, null, 2);
  }

  async _writeNow() {
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const payload = this._serialize();
    let handle = null;
    try {
      handle = await fs.promises.open(tempPath, 'w');
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;

      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.promises.rename(tempPath, this.filePath);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
        }
      }
      if (lastError) throw lastError;
    } finally {
      if (handle) {
        try { await handle.close(); } catch { /* best effort */ }
      }
      try { await fs.promises.unlink(tempPath); } catch { /* renamed or never created */ }
    }
  }

  _withWrite(fn) {
    if (!this._initialized) {
      return Promise.reject(new Error('MemoryStore is not initialized'));
    }
    const run = this._queue.then(async () => {
      const result = await fn();
      await this._writeNow();
      return result;
    });
    this._queue = run.catch(() => {});
    return run;
  }

  _findConflict(record) {
    const key = normalizedKey(record.text);
    for (const existing of this.records) {
      if (existing.type === record.type && normalizedKey(existing.text) === key) return existing;
    }

    const incomingSlot = semanticSlot(record.text);
    if (incomingSlot) {
      const sameSlot = this.records.find(existing => (
        existing.type === record.type && semanticSlot(existing.text) === incomingSlot
      ));
      if (sameSlot) return sameSlot;
    }

    const identity = sourceIdentity(record);
    if (identity) {
      const sameSource = this.records.find(existing => (
        existing.type === record.type && sourceIdentity(existing) === identity
      ));
      if (sameSource) return sameSource;
    }

    // Facts and preferences can be phrased slightly differently between a
    // manual edit and an extracted sentence. A single high-similarity match is
    // treated as the same memory; manual provenance always wins.
    if (['fact', 'preference', 'relationship'].includes(record.type)) {
      const incomingTokens = tokenSet(record.text);
      let best = null;
      let bestScore = 0;
      for (const existing of this.records) {
        if (existing.type !== record.type) continue;
        const score = tokenOverlap(incomingTokens, existing.text);
        if (score > bestScore) {
          best = existing;
          bestScore = score;
        }
      }
      if (best && bestScore >= 0.9) return best;
    }

    return null;
  }

  _insertNormalized(record) {
    const existing = this._findConflict(record);
    if (existing) {
      const incomingPriority = sourcePriority(record);
      const existingPriority = sourcePriority(existing);

      if (incomingPriority < existingPriority) {
        // A semantic extraction must never overwrite a manual correction.
        return { record: existing, merged: true, keptExisting: true };
      }

      const updated = {
        ...existing,
        text: record.text,
        type: record.type,
        embedding: record.embedding || existing.embedding,
        source: record.source,
        confidence: Math.max(existing.confidence || 0, record.confidence || 0),
        sensitivity: record.sensitivity,
        updatedAt: this.now(),
        expiresAt: record.expiresAt ?? existing.expiresAt,
        disabled: existing.disabled,
      };
      const index = this.records.findIndex(candidate => candidate.id === existing.id);
      this.records[index] = updated;
      return { record: updated, merged: true, keptExisting: false };
    }

    this.records.push(record);
    this._enforceCap();
    return { record, merged: false, keptExisting: false };
  }

  _enforceCap() {
    if (this.records.length <= this.maxRecords) return;
    const now = this.now();
    this.records = this.records.filter(record => !isExpired(record, now));
    if (this.records.length <= this.maxRecords) return;
    // Prefer retaining manual records and verified procedures. Evict the oldest
    // low-priority record first.
    while (this.records.length > this.maxRecords) {
      let evictIndex = 0;
      let evictScore = Infinity;
      this.records.forEach((record, index) => {
        const priority = sourcePriority(record) + (record.type === 'procedure' ? 2 : 0) + (record.confidence || 0);
        if (priority < evictScore || (priority === evictScore && record.updatedAt < this.records[evictIndex].updatedAt)) {
          evictScore = priority;
          evictIndex = index;
        }
      });
      this.records.splice(evictIndex, 1);
    }
  }

  async add(input, options = {}) {
    if (!this._initialized) await this.init();
    return this._withWrite(async () => {
      const source = options.source || (input && typeof input === 'object' && input.source) || { kind: 'manual' };
      const record = normalizeRecord(input, {
        now: this.now(),
        source,
        id: options.id || (input && input.id) || null,
      });
      if (!isValidMemoryId(record.id)) record.id = makeMemoryId();
      if (this.records.some(existing => existing.id === record.id)) {
        throw new Error(`Memory record already exists: ${record.id}`);
      }
      const result = this._insertNormalized(record);
      return clone(result.record);
    });
  }

  async addManual(input, {
    type = null,
    sensitivity = null,
    confidence = 1,
    source = { kind: 'manual' },
  } = {}) {
    return this.add({
      ...(typeof input === 'string' ? { text: input } : input),
      ...(type ? { type } : {}),
      ...(sensitivity ? { sensitivity } : {}),
      confidence,
      source,
    });
  }

  async get(id) {
    if (!this._initialized) await this.init();
    if (!isValidMemoryId(id)) return null;
    const record = this.records.find(candidate => candidate.id === id);
    return record ? clone(record) : null;
  }

  async list({ includeDisabled = false, type = null, limit = null } = {}) {
    if (!this._initialized) await this.init();
    let records = this.records.filter(record => {
      if (!includeDisabled && record.disabled) return false;
      if (type && record.type !== type) return false;
      return true;
    });
    records = records.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (Number.isInteger(limit) && limit >= 0) records = records.slice(0, limit);
    return records.map(clone);
  }

  async update(id, patch = {}) {
    if (!this._initialized) await this.init();
    if (!isValidMemoryId(id)) return null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Memory patch must be an object');
    }
    return this._withWrite(async () => {
      const index = this.records.findIndex(record => record.id === id);
      if (index === -1) return null;
      const existing = this.records[index];
      const next = { ...existing };
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
        const text = normalizeText(patch.text);
        if (!text) throw new Error('Memory text must be a non-empty string');
        next.text = text;
        next.embedding = null;
        if (!Object.prototype.hasOwnProperty.call(patch, 'sensitivity')) {
          next.sensitivity = classifySensitivity(text);
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'type')) {
        if (!MEMORY_TYPE_SET.has(patch.type)) throw new Error(`Unknown memory type: ${patch.type}`);
        next.type = patch.type;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'sensitivity')) {
        if (!SENSITIVITY_SET.has(patch.sensitivity)) throw new Error(`Unknown sensitivity: ${patch.sensitivity}`);
        next.sensitivity = patch.sensitivity;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'confidence')) {
        const confidence = Number(patch.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new Error('Memory confidence must be between 0 and 1');
        }
        next.confidence = confidence;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) {
        next.expiresAt = patch.expiresAt === null || patch.expiresAt === undefined
          ? null
          : Number(patch.expiresAt);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'disabled')) {
        next.disabled = patch.disabled === true;
      }
      next.updatedAt = this.now();
      next.source = { ...next.source, kind: isManual(existing) ? 'manual' : (next.source?.kind || 'unknown') };
      this.records[index] = next;
      return clone(next);
    });
  }

  async setDisabled(id, disabled) {
    return this.update(id, { disabled: disabled === true });
  }

  async delete(id) {
    if (!this._initialized) await this.init();
    return this._withWrite(async () => {
      const before = this.records.length;
      this.records = this.records.filter(record => record.id !== id);
      return this.records.length !== before;
    });
  }

  async clear({ confirm = false } = {}) {
    if (!this._initialized) await this.init();
    if (confirm !== true && confirm !== 'CLEAR') {
      throw new Error('Clearing memory requires confirm=true or confirm="CLEAR"');
    }
    return this._withWrite(async () => {
      const count = this.records.length;
      this.records = [];
      return { ok: true, deleted: count };
    });
  }

  async retrieve(query, {
    maxRecords = DEFAULT_RETRIEVAL_RECORDS,
    maxChars = DEFAULT_RETRIEVAL_CHARS,
    allowPersonal = false,
    types = null,
    now = null,
  } = {}) {
    if (!this._initialized) await this.init();
    const at = Number.isFinite(now) ? now : this.now();
    const queryText = normalizeText(query);
    const queryTokens = tokenSet(queryText);
    const allowedTypes = Array.isArray(types) && types.length > 0
      ? new Set(types.filter(type => MEMORY_TYPE_SET.has(type)))
      : null;
    const candidates = this.records.filter(record => {
      if (record.disabled) return false;
      if (isExpired(record, at)) return false;
      if (record.sensitivity === 'secret') return false;
      if (record.sensitivity === 'personal' && !allowPersonal) return false;
      if (allowedTypes && !allowedTypes.has(record.type)) return false;
      return true;
    });

    const scored = candidates.map(record => {
      const recordTokens = tokenSet(record.text);
      const overlap = tokenOverlap(queryTokens, recordTokens);
      let score = overlap;
      if (queryText && normalizedKey(record.text).includes(normalizedKey(queryText))) score += 0.35;
      if (!queryText) score = 0.1;
      if (record.type === 'preference') score += 0.03;
      if (record.type === 'procedure' && record.verification?.status === 'verified') score += 0.05;
      if (score > 0) {
        const ageDays = Math.max(0, (at - (record.updatedAt || at)) / 86400000);
        score += Math.max(0, 0.02 - ageDays * 0.0002);
      }
      return { record, score };
    }).filter(entry => entry.score > 0);

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.record.updatedAt || 0) - (a.record.updatedAt || 0);
    });

    const header = '[RELEVANT MEMORY]\n';
    const footer = '\n[END MEMORY]';
    const budget = Math.max(80, Number.isFinite(maxChars) ? Number(maxChars) : DEFAULT_RETRIEVAL_CHARS);
    const countLimit = Math.max(1, Number.isInteger(maxRecords) ? maxRecords : DEFAULT_RETRIEVAL_RECORDS);
    const selected = [];
    let used = header.length + footer.length;

    for (const entry of scored) {
      if (selected.length >= countLimit) break;
      const prefix = `- [${entry.record.type}] `;
      const remaining = budget - used - prefix.length - 1;
      if (remaining < 20) break;
      const text = entry.record.text.length > remaining
        ? `${entry.record.text.slice(0, Math.max(0, remaining - 1))}…`
        : entry.record.text;
      if (!text) continue;
      selected.push(clone(entry.record));
      used += prefix.length + text.length + 1;
    }

    if (selected.length > 0) {
      await this._withWrite(async () => {
        const ids = new Set(selected.map(record => record.id));
        for (const record of this.records) {
          if (ids.has(record.id)) record.lastUsedAt = at;
        }
      });
    }

    const lines = selected.map(record => `- [${record.type}] ${record.text}`);
    return {
      records: selected,
      context: selected.length > 0 ? `${header}${lines.join('\n')}${footer}` : '',
      chars: selected.length > 0 ? used : 0,
      budget: {
        maxChars: budget,
        maxRecords: countLimit,
        usedChars: selected.length > 0 ? used : 0,
      },
    };
  }

  async addEpisode(text, {
    source = { kind: 'conversation' },
    confidence = 0.8,
    sensitivity = null,
  } = {}) {
    const value = normalizeText(text);
    if (!value) return null;
    return this.add({
      type: 'episode',
      text: value,
      source,
      confidence,
      sensitivity: sensitivity || classifySensitivity(value),
    });
  }

  async recordConversation({ sessionId = null, messages = [], source = null } = {}) {
    if (!this._initialized) await this.init();
    const summary = summarizeConversation(messages);
    const candidates = extractConversationCandidates(messages, { sessionId });
    return this._withWrite(async () => {
      let episode = null;
      if (summary) {
        const record = normalizeRecord({
          type: 'episode',
          text: summary,
          source: source || { kind: 'conversation', ...(sessionId ? { sessionId } : {}) },
          confidence: 0.8,
          sensitivity: classifySensitivity(summary),
        }, { now: this.now() });
        const result = this._insertNormalized(record);
        episode = clone(result.record);
      }

      const extracted = [];
      for (const candidate of candidates) {
        const record = normalizeRecord(candidate, {
          now: this.now(),
          source: candidate.source || { kind: 'conversation', ...(sessionId ? { sessionId } : {}) },
        });
        const result = this._insertNormalized(record);
        extracted.push(clone(result.record));
      }

      return { episode, extracted, extractedCount: extracted.length };
    });
  }

  _taskProcedureText(task, toolSteps) {
    const goal = normalizeText(task.goal).slice(0, 600);
    const steps = toolSteps.map((step, index) => {
      const tool = normalizeText(step.tool || 'tool').slice(0, 80);
      const argKeys = step.args && typeof step.args === 'object'
        ? Object.keys(step.args).slice(0, 8).join(', ')
        : '';
      return `${index + 1}. Use ${tool}${argKeys ? ` with arguments (${argKeys})` : ''}.`;
    });
    return [
      `Verified procedure for: ${goal}`,
      ...steps,
      'Only reuse this procedure when the current request has the same prerequisites and permissions.',
    ].join('\n').slice(0, 6000);
  }

  async recordTaskOutcome(task) {
    if (!this._initialized) await this.init();
    if (!task || typeof task !== 'object') return { episode: null, procedure: null };
    const taskId = typeof task.id === 'string' ? task.id : null;
    if (!taskId) return { episode: null, procedure: null };
    const completed = task.status === 'completed';
    const tainted = task.tainted === true;
    const result = normalizeText(task.result || task.error || '').slice(0, 1200);
    const goal = normalizeText(task.goal).slice(0, 800);

    const toolSteps = Array.isArray(task.steps)
      ? task.steps.filter(step => step && step.kind === 'tool')
      : [];
    const cleanToolSteps = toolSteps.filter(step => step.status === 'completed');
    const hasFailedTool = toolSteps.some(step => !['completed'].includes(step.status));

    return this._withWrite(async () => {
      let episode = null;
      if (goal) {
        const episodeText = [
          `Task: ${goal}`,
          `Status: ${completed ? 'completed' : String(task.status || 'unknown')}${tainted ? ' (tainted)' : ''}`,
          result ? `Outcome: ${result}` : '',
        ].filter(Boolean).join('\n');
        const record = normalizeRecord({
          type: 'episode',
          text: episodeText,
          source: {
            kind: 'task',
            taskId,
            ...(task.metadata?.schedule?.id ? { scheduled: true } : {}),
            ...(tainted ? { tainted: true } : {}),
          },
          confidence: 0.8,
          sensitivity: classifySensitivity(episodeText),
        }, { now: this.now() });
        episode = clone(this._insertNormalized(record).record);
      }

      // A procedural memory is evidence-backed. The task must be completed,
      // untainted, have at least one successful tool step, and no failed or
      // unknown tool step. The completion itself is the verification event.
      const eligible = completed
        && !tainted
        && cleanToolSteps.length > 0
        && !hasFailedTool;
      let procedure = null;
      if (eligible) {
        const text = this._taskProcedureText(task, cleanToolSteps);
        const record = normalizeRecord({
          type: 'procedure',
          text,
          source: {
            kind: 'task',
            taskId,
            ...(task.metadata?.schedule?.id ? { scheduled: true } : {}),
          },
          confidence: 0.85,
          sensitivity: classifySensitivity(text),
          verification: {
            status: 'verified',
            method: 'completed-task',
            taskId,
            verifiedAt: this.now(),
          },
        }, { now: this.now() });
        if (record.sensitivity !== 'secret') {
          procedure = clone(this._insertNormalized(record).record);
        }
      }

      return { episode, procedure, tainted, eligible };
    });
  }

  async export({ format = 'json' } = {}) {
    if (!this._initialized) await this.init();
    if (format !== 'json') throw new Error('Only JSON memory export is supported');
    return JSON.stringify({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      records: this.records,
    }, null, 2);
  }

  async import(records, { replace = false } = {}) {
    if (!this._initialized) await this.init();
    if (!Array.isArray(records)) throw new Error('Memory import requires an array');
    return this._withWrite(async () => {
      if (replace) this.records = [];
      const imported = [];
      for (const raw of records) {
        try {
          const record = normalizeRecord(raw, {
            now: this.now(),
            source: raw && raw.source ? raw.source : { kind: 'migration' },
          });
          imported.push(this._insertNormalized(record).record);
        } catch (error) {
          (this.logger.warn || this.logger.log || (() => {}))(`[Memory] Skipping import: ${error.message}`);
        }
      }
      return { imported: imported.length, records: imported.map(clone) };
    });
  }

  stats() {
    const byType = Object.fromEntries(MEMORY_TYPES.map(type => [type, 0]));
    let disabled = 0;
    let sensitive = 0;
    for (const record of this.records) {
      byType[record.type] = (byType[record.type] || 0) + 1;
      if (record.disabled) disabled += 1;
      if (record.sensitivity !== 'public') sensitive += 1;
    }
    return {
      ok: true,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      total: this.records.length,
      byType,
      disabled,
      sensitive,
      migration: clone(this.migration),
      filePath: this.filePath,
      backupPath: this.backupPath,
    };
  }
}

module.exports = {
  MemoryStore,
  DEFAULT_MAX_RECORDS,
  DEFAULT_RETRIEVAL_RECORDS,
  DEFAULT_RETRIEVAL_CHARS,
  sourcePriority,
  normalizedKey,
  tokenOverlap,
};
