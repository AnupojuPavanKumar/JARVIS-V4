'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VAULT_VERSION = 1;
const MAX_SECRET_BYTES = 64 * 1024;

function assertIntegrationName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{1,40}$/.test(name)) {
    throw new Error('Invalid integration name for secret storage');
  }
}

class SecretVault {
  constructor({ filePath, encrypt, decrypt, now = Date.now } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('SecretVault requires filePath');
    }
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
      throw new Error('SecretVault requires encrypt and decrypt functions');
    }
    this.filePath = filePath;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.now = now;
    this.state = null;
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        let raw = null;
        try {
          raw = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
        } catch {
          raw = null;
        }
        this.state = {
          version: VAULT_VERSION,
          secrets: raw && raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {},
        };
        for (const [name, entry] of Object.entries(this.state.secrets)) {
          if (!entry || typeof entry.ciphertext !== 'string' || !/^[a-z][a-z0-9_-]{1,40}$/.test(name)) {
            delete this.state.secrets[name];
          }
        }
        await this._persist(this.state);
        return this.list();
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async _ensure() {
    if (!this.state) await this.init();
  }

  async _persist(state) {
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(tempPath, this.filePath);
  }

  async set(integration, secret) {
    assertIntegrationName(integration);
    if (typeof secret !== 'string' || !secret) throw new Error('Secret must be a non-empty string');
    if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) throw new Error('Secret is too large');
    await this._ensure();
    const encrypted = await this.encrypt(secret);
    if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
      throw new Error('Encryptor must return a Buffer');
    }
    const ciphertext = Buffer.from(encrypted).toString('base64');
    const draft = structuredClone(this.state);
    draft.secrets[integration] = {
      ciphertext,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this._persist(draft);
    this.state = draft;
    return { integration, updatedAt: draft.secrets[integration].updatedAt };
  }

  async get(integration) {
    assertIntegrationName(integration);
    await this._ensure();
    const entry = this.state.secrets[integration];
    if (!entry) return null;
    const decrypted = await this.decrypt(Buffer.from(entry.ciphertext, 'base64'));
    if (Buffer.isBuffer(decrypted)) return decrypted.toString('utf8');
    return String(decrypted);
  }

  async delete(integration) {
    assertIntegrationName(integration);
    await this._ensure();
    const draft = structuredClone(this.state);
    const existed = Boolean(draft.secrets[integration]);
    delete draft.secrets[integration];
    await this._persist(draft);
    this.state = draft;
    return { deleted: existed };
  }

  async list() {
    await this._ensure();
    return Object.entries(this.state.secrets).map(([integration, entry]) => ({
      integration,
      updatedAt: entry.updatedAt || null,
    }));
  }
}

module.exports = { SecretVault, VAULT_VERSION };
