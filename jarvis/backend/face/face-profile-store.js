/**
 * Encrypted local face profile store.
 *
 * The renderer performs face detection/embedding with a local model. Only the
 * numeric embedding leaves the renderer; raw frames are never sent to main and
 * are never written to disk. Embeddings are serialized and encrypted with
 * Electron safeStorage (Windows DPAPI on this build) before being written.
 */

const fs = require('fs');
const path = require('path');

const PROFILE_FILE = 'face-profile.bin';
const PROFILE_VERSION = 1;
const DEFAULT_THRESHOLD = 0.5;
const MIN_EMBEDDING_LENGTH = 128;
const MAX_EMBEDDING_LENGTH = 2048;
const MAX_SAMPLES = 8;

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]);
    const b = Number(right[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function validateEmbedding(embedding) {
  if (!Array.isArray(embedding)) return 'Embedding must be an array';
  if (embedding.length < MIN_EMBEDDING_LENGTH || embedding.length > MAX_EMBEDDING_LENGTH) {
    return 'Embedding has an unexpected length';
  }
  for (const value of embedding) {
    if (!Number.isFinite(Number(value))) return 'Embedding contains a non-finite value';
  }
  return null;
}

function validateEmbeddings(embeddings) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    return 'At least one face sample is required';
  }
  if (embeddings.length > MAX_SAMPLES) return `At most ${MAX_SAMPLES} face samples are allowed`;
  const firstLength = Array.isArray(embeddings[0]) ? embeddings[0].length : 0;
  for (const embedding of embeddings) {
    const error = validateEmbedding(embedding);
    if (error) return error;
    if (embedding.length !== firstLength) return 'Face samples have inconsistent dimensions';
  }
  return null;
}

class FaceProfileStore {
  constructor({ app, baseDir, safeStorage, audit = null, logger = console } = {}) {
    this.baseDir = baseDir || (app ? app.getPath('userData') : null);
    if (!this.baseDir) throw new Error('FaceProfileStore requires app or baseDir');
    this.filePath = path.join(this.baseDir, PROFILE_FILE);
    this.safeStorage = safeStorage;
    this.audit = audit;
    this.logger = logger || console;
  }

  encryptionAvailable() {
    try {
      return !!this.safeStorage && this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  _audit(action, detail, verdict) {
    if (typeof this.audit === 'function') this.audit(action, detail, verdict);
  }

  async _readProfile() {
    if (!fs.existsSync(this.filePath)) {
      return { ok: true, exists: false, profile: null };
    }
    if (!this.encryptionAvailable()) {
      return { ok: false, exists: true, error: 'OS encryption is unavailable' };
    }
    try {
      const encrypted = await fs.promises.readFile(this.filePath);
      const raw = this.safeStorage.decryptString(encrypted);
      const profile = JSON.parse(raw);
      if (!profile || profile.version !== PROFILE_VERSION || !Array.isArray(profile.embeddings)) {
        return { ok: false, exists: true, error: 'Face profile has an unsupported format' };
      }
      const error = validateEmbeddings(profile.embeddings);
      if (error) return { ok: false, exists: true, error };
      return { ok: true, exists: true, profile };
    } catch (error) {
      this._audit('FACE_PROFILE_READ', error.message, 'FAIL');
      return { ok: false, exists: true, error: 'Face profile could not be decrypted' };
    }
  }

  async _writeProfile(profile) {
    if (!this.encryptionAvailable()) {
      return { ok: false, error: 'OS encryption is unavailable; refusing to store face data' };
    }
    const payload = JSON.stringify(profile);
    let encrypted;
    try {
      encrypted = this.safeStorage.encryptString(payload);
    } catch (error) {
      return { ok: false, error: `Could not encrypt face profile: ${error.message}` };
    }
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, encrypted, { mode: 0o600 });
      try {
        await fs.promises.rename(tempPath, this.filePath);
      } catch (error) {
        // Windows can reject rename-over-existing. Remove the old file only
        // after the new encrypted payload has been written successfully.
        if (error.code === 'EEXIST' || error.code === 'EPERM') {
          await fs.promises.rm(this.filePath, { force: true });
          await fs.promises.rename(tempPath, this.filePath);
        } else {
          throw error;
        }
      }
      return { ok: true };
    } catch (error) {
      try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
      return { ok: false, error: `Could not write face profile: ${error.message}` };
    }
  }

  async getStatus() {
    if (!this.encryptionAvailable()) {
      return {
        ok: true,
        available: false,
        enrolled: false,
        enabled: false,
        samples: 0,
        threshold: DEFAULT_THRESHOLD,
        error: 'OS encryption is unavailable',
      };
    }
    const read = await this._readProfile();
    if (!read.ok) {
      return {
        ok: false,
        available: true,
        enrolled: false,
        enabled: false,
        samples: 0,
        threshold: DEFAULT_THRESHOLD,
        error: read.error,
      };
    }
    if (!read.exists) {
      return {
        ok: true,
        available: true,
        enrolled: false,
        enabled: false,
        samples: 0,
        threshold: DEFAULT_THRESHOLD,
        createdAt: null,
        updatedAt: null,
      };
    }
    return {
      ok: true,
      available: true,
      enrolled: true,
      enabled: read.profile.enabled !== false,
      samples: read.profile.embeddings.length,
      threshold: Number.isFinite(read.profile.threshold) ? read.profile.threshold : DEFAULT_THRESHOLD,
      createdAt: read.profile.createdAt || null,
      updatedAt: read.profile.updatedAt || null,
    };
  }

  async enroll(embeddings, options = {}) {
    const error = validateEmbeddings(embeddings);
    if (error) return { ok: false, error };
    if (!this.encryptionAvailable()) {
      return { ok: false, error: 'OS encryption is unavailable; refusing to store face data' };
    }
    const read = await this._readProfile();
    if (!read.ok && read.exists) {
      return { ok: false, error: 'Replace the unreadable face profile before enrolling again' };
    }
    const now = new Date().toISOString();
    const profile = {
      version: PROFILE_VERSION,
      enabled: true,
      threshold: Number.isFinite(options.threshold) ? Math.min(0.95, Math.max(0.2, options.threshold)) : DEFAULT_THRESHOLD,
      embeddings: embeddings.map(embedding => embedding.map(value => round(value))),
      createdAt: read.profile?.createdAt || now,
      updatedAt: now,
    };
    const write = await this._writeProfile(profile);
    if (!write.ok) {
      this._audit('FACE_ENROLL', write.error, 'FAIL');
      return write;
    }
    this._audit('FACE_ENROLL', `${profile.embeddings.length} local template(s)`, 'SUCCESS');
    return { ok: true, status: await this.getStatus() };
  }

  async verify(embedding) {
    const error = validateEmbedding(embedding);
    if (error) return { ok: false, error };
    const read = await this._readProfile();
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.exists) return { ok: false, error: 'No face profile is enrolled' };
    if (read.profile.enabled === false) return { ok: false, error: 'Face unlock is disabled' };
    const threshold = Number.isFinite(read.profile.threshold) ? read.profile.threshold : DEFAULT_THRESHOLD;
    let best = -1;
    for (const template of read.profile.embeddings) {
      const similarity = cosineSimilarity(embedding, template);
      if (similarity > best) best = similarity;
    }
    const similarity = round(best);
    return {
      ok: similarity >= threshold,
      similarity,
      threshold,
      samples: read.profile.embeddings.length,
    };
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
    const read = await this._readProfile();
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.exists) return { ok: false, error: 'No face profile is enrolled' };
    const profile = { ...read.profile, enabled, updatedAt: new Date().toISOString() };
    const write = await this._writeProfile(profile);
    if (!write.ok) return write;
    this._audit('FACE_SET_ENABLED', String(enabled), 'SUCCESS');
    return { ok: true, status: await this.getStatus() };
  }

  async remove() {
    try {
      await fs.promises.rm(this.filePath, { force: true });
      this._audit('FACE_DELETE', 'local face profile removed', 'SUCCESS');
      return { ok: true, status: await this.getStatus() };
    } catch (error) {
      this._audit('FACE_DELETE', error.message, 'FAIL');
      return { ok: false, error: error.message };
    }
  }
}

module.exports = {
  FaceProfileStore,
  PROFILE_FILE,
  DEFAULT_THRESHOLD,
  cosineSimilarity,
  validateEmbedding,
  validateEmbeddings,
};
