'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_ACTIONS = 500;

const INTEGRATIONS = Object.freeze([
  'calendar',
  'email',
  'contacts',
  'tasks',
  'notes',
  'messaging',
]);

const SCOPES = Object.freeze({
  calendar: Object.freeze(['calendar.read', 'calendar.write']),
  email: Object.freeze(['email.read', 'email.draft', 'email.send']),
  contacts: Object.freeze(['contacts.read']),
  tasks: Object.freeze(['tasks.read', 'tasks.write']),
  notes: Object.freeze(['notes.read', 'notes.write']),
  messaging: Object.freeze(['messaging.draft', 'messaging.send']),
});

const DEFAULT_SCOPES = Object.freeze(Object.fromEntries(
  INTEGRATIONS.map(name => [name, SCOPES[name].slice()])
));

const COLLECTION_FOR = Object.freeze({
  calendar: ['events'],
  email: ['emails'],
  contacts: ['contacts'],
  tasks: ['tasks'],
  notes: ['notes'],
  messaging: ['messages'],
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function iso(value) {
  return new Date(value).toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function assertIntegration(name) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
}

function defaultState(now = Date.now()) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  return {
    version: SCHEMA_VERSION,
    updatedAt: iso(now),
    integrations: Object.fromEntries(INTEGRATIONS.map(name => [
      name,
      {
        enabled: true,
        scopes: DEFAULT_SCOPES[name].slice(),
        revokedAt: null,
      },
    ])),
    data: {
      events: [
        {
          id: 'evt_fixture_planning',
          title: 'Project planning',
          start: iso(now + day),
          end: iso(now + day + hour),
          attendees: ['ada@example.test'],
          location: 'Local fixture room',
          createdAt: iso(now),
        },
        {
          id: 'evt_fixture_review',
          title: 'Design review',
          start: iso(now + 2 * day),
          end: iso(now + 2 * day + hour),
          attendees: ['grace@example.test'],
          location: 'Local fixture room',
          createdAt: iso(now),
        },
      ],
      emails: [
        {
          id: 'eml_fixture_kickoff',
          from: 'ada@example.test',
          to: 'user@example.test',
          subject: 'Fixture project kickoff',
          body: 'The local fixture kickoff is ready. Please review the planning notes and confirm the design review time.',
          status: 'received',
          receivedAt: iso(now - hour),
        },
        {
          id: 'eml_fixture_followup',
          from: 'grace@example.test',
          to: 'user@example.test',
          subject: 'Follow-up on notes',
          body: 'I added the fixture follow-up items to the shared notes. Let me know if anything is missing.',
          status: 'received',
          receivedAt: iso(now - 2 * hour),
        },
      ],
      contacts: [
        {
          id: 'con_fixture_ada',
          name: 'Ada Lovelace',
          email: 'ada@example.test',
          phone: '+1-555-0101',
          relationship: 'colleague',
          notes: 'Leads the fixture planning work.',
        },
        {
          id: 'con_fixture_grace',
          name: 'Grace Hopper',
          email: 'grace@example.test',
          phone: '+1-555-0102',
          relationship: 'colleague',
          notes: 'Reviews fixture design notes.',
        },
      ],
      tasks: [
        {
          id: 'tsk_fixture_review',
          title: 'Review fixture planning notes',
          status: 'pending',
          due: iso(now + day),
          notes: 'Check the planning notes before the design review.',
          createdAt: iso(now),
        },
      ],
      notes: [
        {
          id: 'note_fixture_plan',
          title: 'Fixture planning notes',
          body: 'Confirm the fixture design review, prepare the agenda, and send the summary to the team.',
          tags: ['work', 'fixture'],
          createdAt: iso(now - day),
          updatedAt: iso(now - day),
        },
      ],
      messages: [
        {
          id: 'msg_fixture_ada',
          contact: 'Ada Lovelace',
          body: 'The fixture planning draft is ready for review.',
          status: 'received',
          createdAt: iso(now - 3 * hour),
        },
      ],
    },
    actions: [],
  };
}

function normalizeState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || raw.version !== SCHEMA_VERSION) {
    return defaultState(now);
  }
  const state = defaultState(now);
  if (raw.integrations && typeof raw.integrations === 'object') {
    for (const name of INTEGRATIONS) {
      const source = raw.integrations[name];
      if (!source || typeof source !== 'object') continue;
      state.integrations[name] = {
        enabled: source.enabled !== false,
        scopes: Array.isArray(source.scopes)
          ? source.scopes.filter(scope => SCOPES[name].includes(scope))
          : [],
        revokedAt: typeof source.revokedAt === 'string' ? source.revokedAt : null,
      };
    }
  }
  if (raw.data && typeof raw.data === 'object') {
    for (const collection of Object.keys(state.data)) {
      if (Array.isArray(raw.data[collection])) {
        state.data[collection] = raw.data[collection].filter(record => (
          record && typeof record === 'object' && typeof record.id === 'string'
        ));
      }
    }
  }
  if (Array.isArray(raw.actions)) {
    state.actions = raw.actions
      .filter(record => record && typeof record === 'object')
      .slice(-MAX_ACTIONS);
  }
  if (typeof raw.updatedAt === 'string') state.updatedAt = raw.updatedAt;
  return state;
}

class IntegrationStore {
  constructor({ baseDir, now = Date.now } = {}) {
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
      throw new Error('IntegrationStore requires baseDir');
    }
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'integrations.json');
    this.now = now;
    this.state = null;
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await fs.promises.mkdir(this.baseDir, { recursive: true });
        let raw = null;
        try {
          raw = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
        } catch {
          raw = null;
        }
        this.state = normalizeState(raw, this.now());
        await this._persist(this.state);
        return this.stats();
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

  async read() {
    await this._ensure();
    return clone(this.state);
  }

  async update(mutator) {
    if (typeof mutator !== 'function') throw new Error('IntegrationStore.update requires a mutator');
    await this._ensure();
    const draft = clone(this.state);
    const result = await mutator(draft);
    draft.updatedAt = iso(this.now());
    if (Array.isArray(draft.actions) && draft.actions.length > MAX_ACTIONS) {
      draft.actions = draft.actions.slice(-MAX_ACTIONS);
    }
    await this._persist(draft);
    this.state = draft;
    return result === undefined ? clone(draft) : clone(result);
  }

  async getIntegration(name) {
    assertIntegration(name);
    await this._ensure();
    return clone(this.state.integrations[name]);
  }

  async hasScope(name, scope) {
    assertIntegration(name);
    const integration = await this.getIntegration(name);
    return integration.enabled === true && integration.scopes.includes(scope);
  }

  async setScopes(name, scopes) {
    assertIntegration(name);
    if (!Array.isArray(scopes)) throw new Error('scopes must be an array');
    const unique = [...new Set(scopes)].filter(scope => SCOPES[name].includes(scope));
    return this.update(state => {
      state.integrations[name] = {
        ...state.integrations[name],
        scopes: unique,
        revokedAt: null,
        enabled: unique.length > 0,
      };
      return state.integrations[name];
    });
  }

  async revoke(name) {
    assertIntegration(name);
    return this.update(state => {
      state.integrations[name] = {
        ...state.integrations[name],
        enabled: false,
        scopes: [],
        revokedAt: iso(this.now()),
      };
      return state.integrations[name];
    });
  }

  async deleteData(name) {
    assertIntegration(name);
    const collections = COLLECTION_FOR[name];
    return this.update(state => {
      for (const collection of collections) {
        state.data[collection] = [];
      }
      state.actions = state.actions.filter(action => action.integration !== name);
      state.integrations[name] = {
        ...state.integrations[name],
        enabled: false,
        scopes: [],
        revokedAt: iso(this.now()),
      };
      return { deleted: collections };
    });
  }

  async recordAction({ integration, action, scope = null, status = 'ok', metadata = null }) {
    assertIntegration(integration);
    const entry = {
      id: makeId('act'),
      integration,
      action: String(action).slice(0, 80),
      scope,
      status: String(status).slice(0, 40),
      at: iso(this.now()),
      metadata: metadata && typeof metadata === 'object' ? metadata : null,
    };
    await this.update(state => {
      state.actions.push(entry);
      return entry;
    });
    return entry;
  }

  async listActions({ limit = 50 } = {}) {
    await this._ensure();
    const capped = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 50));
    return clone(this.state.actions.slice(-capped).reverse());
  }

  async stats() {
    await this._ensure();
    return {
      version: this.state.version,
      updatedAt: this.state.updatedAt,
      integrations: Object.fromEntries(INTEGRATIONS.map(name => {
        const integration = this.state.integrations[name];
        const counts = {};
        for (const collection of COLLECTION_FOR[name]) {
          counts[collection] = Array.isArray(this.state.data[collection])
            ? this.state.data[collection].length
            : 0;
        }
        return [name, {
          enabled: integration.enabled,
          scopes: integration.scopes.slice(),
          revokedAt: integration.revokedAt,
          counts,
        }];
      })),
    };
  }
}

module.exports = {
  IntegrationStore,
  INTEGRATIONS,
  SCOPES,
  DEFAULT_SCOPES,
  SCHEMA_VERSION,
  defaultState,
  normalizeState,
};
