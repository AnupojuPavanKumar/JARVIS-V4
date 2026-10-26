'use strict';

const { IntegrationError } = require('./fixture-provider');

const DEFAULT_LIMITS = Object.freeze({
  read: 30,
  write: 10,
});
const RATE_WINDOW_MS = 60 * 1000;

function clampLimit(value, fallback, min, max) {
  const number = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function safeAudit(audit, action, detail, verdict = 'ALLOWED') {
  try {
    audit(`INTEGRATION_${action}`, String(detail ?? '').slice(0, 400), verdict);
  } catch {
    // Audit must never break an integration operation.
  }
}

class IntegrationService {
  constructor({
    store,
    provider,
    vault = null,
    audit = () => {},
    now = Date.now,
    limits = {},
    rateWindowMs = RATE_WINDOW_MS,
  } = {}) {
    if (!store || typeof store.getIntegration !== 'function') {
      throw new Error('IntegrationService requires an IntegrationStore');
    }
    if (!provider || typeof provider !== 'object') {
      throw new Error('IntegrationService requires a provider');
    }
    this.store = store;
    this.provider = provider;
    this.vault = vault;
    this.audit = typeof audit === 'function' ? audit : () => {};
    this.now = now;
    this.limits = {
      read: Number.isInteger(limits.read) ? limits.read : DEFAULT_LIMITS.read,
      write: Number.isInteger(limits.write) ? limits.write : DEFAULT_LIMITS.write,
    };
    this.rateWindowMs = rateWindowMs;
    this.rateBuckets = new Map();
  }

  async init() {
    return this.store.init();
  }

  _rateKey(integration, category) {
    return `${integration}:${category}`;
  }

  _checkRate(integration, category) {
    const key = this._rateKey(integration, category);
    const now = this.now();
    const bucket = (this.rateBuckets.get(key) || []).filter(timestamp => now - timestamp < this.rateWindowMs);
    const limit = category === 'write' ? this.limits.write : this.limits.read;
    if (bucket.length >= limit) {
      throw new IntegrationError('rate-limited', `${integration} ${category} limit reached`);
    }
    bucket.push(now);
    this.rateBuckets.set(key, bucket);
  }

  async _authorize(integration, scope, category) {
    const record = await this.store.getIntegration(integration);
    if (!record.enabled) {
      throw new IntegrationError('integration-revoked', `${integration} is revoked`);
    }
    if (!record.scopes.includes(scope)) {
      throw new IntegrationError('scope-denied', `${integration} is missing ${scope}`);
    }
    this._checkRate(integration, category);
    return record;
  }

  async _record(integration, action, scope, status, metadata = null) {
    try {
      await this.store.recordAction({ integration, action, scope, status, metadata });
    } catch {
      safeAudit(this.audit, 'ACTION_LOG_ERROR', `${integration} ${action}`, 'ERROR');
    }
  }

  async _run({ integration, action, scope, category = 'read', summarize = null }, fn) {
    try {
      await this._authorize(integration, scope, category);
      const result = await fn();
      const metadata = summarize ? summarize(result) : null;
      await this._record(integration, action, scope, 'ok', metadata);
      safeAudit(
        this.audit,
        action.toUpperCase(),
        `scope=${scope}${metadata ? ` ${Object.entries(metadata).map(([key, value]) => `${key}=${value}`).join(' ')}` : ''}`,
        'ALLOWED'
      );
      return result;
    } catch (error) {
      const code = error && error.code ? error.code : 'integration-error';
      await this._record(integration, action, scope, code === 'integration-revoked' ? 'revoked' : 'denied', { code });
      safeAudit(this.audit, action.toUpperCase(), `scope=${scope} code=${code}`, 'DENY');
      throw error;
    }
  }

  async calendar({ action = 'list', from = null, to = null, date = null, duration_minutes = 30, limit = 20 } = {}) {
    if (action === 'availability') {
      return this._run(
        {
          integration: 'calendar',
          action: 'calendar_availability',
          scope: 'calendar.read',
          category: 'read',
          summarize: result => ({ slots: Array.isArray(result.slots) ? result.slots.length : 0 }),
        },
        () => this.provider.findAvailability({ date, durationMinutes: duration_minutes })
      );
    }
    if (action !== 'list') throw new IntegrationError('invalid-argument', 'action must be list or availability');
    return this._run(
      {
        integration: 'calendar',
        action: 'calendar_list',
        scope: 'calendar.read',
        category: 'read',
        summarize: result => ({ events: Array.isArray(result) ? result.length : 0 }),
      },
      () => this.provider.listCalendar({ from, to, limit: clampLimit(limit, 20, 1, 50) })
    );
  }

  async createEvent({ title, start, end, attendees = '', location = '' } = {}) {
    return this._run(
      {
        integration: 'calendar',
        action: 'calendar_create_event',
        scope: 'calendar.write',
        category: 'write',
        summarize: result => ({ event: result.id ? 'created' : 'unknown' }),
      },
      () => this.provider.createEvent({ title, start, end, attendees, location })
    );
  }

  async searchEmail({ query = '', limit = 5 } = {}) {
    return this._run(
      {
        integration: 'email',
        action: 'email_search',
        scope: 'email.read',
        category: 'read',
        summarize: result => ({ emails: Array.isArray(result) ? result.length : 0 }),
      },
      () => this.provider.searchEmails({ query, limit: clampLimit(limit, 5, 1, 10) })
    );
  }

  async composeEmail({ action = 'draft', to = '', subject = '', body = '', draft_id = null } = {}) {
    if (action === 'delete_draft') {
      return this._run(
        {
          integration: 'email',
          action: 'email_delete_draft',
          scope: 'email.draft',
          category: 'write',
          summarize: result => ({ deleted: result.deleted || 0 }),
        },
        () => this.provider.deleteDraft({ draftId: draft_id })
      );
    }
    if (action === 'send') {
      return this._run(
        {
          integration: 'email',
          action: 'email_send',
          scope: 'email.send',
          category: 'write',
          summarize: result => ({ sent: result.id ? 1 : 0 }),
        },
        async () => {
          const email = await this.provider.composeEmail({ action: 'send', to, subject, body, draftId: draft_id });
          return {
            id: email.id,
            to: email.to,
            subject: email.subject,
            status: email.status,
            sentAt: email.sentAt,
          };
        }
      );
    }
    if (action !== 'draft') throw new IntegrationError('invalid-argument', 'action must be draft, send, or delete_draft');
    return this._run(
      {
        integration: 'email',
        action: 'email_draft',
        scope: 'email.draft',
        category: 'write',
        summarize: result => ({ draft: result.id ? 'created' : 'unknown' }),
      },
      async () => {
        const email = await this.provider.composeEmail({ action: 'draft', to, subject, body });
        return {
          id: email.id,
          to: email.to,
          subject: email.subject,
          status: email.status,
          createdAt: email.createdAt,
        };
      }
    );
  }

  async searchContacts({ query = '', limit = 5 } = {}) {
    return this._run(
      {
        integration: 'contacts',
        action: 'contacts_search',
        scope: 'contacts.read',
        category: 'read',
        summarize: result => ({ contacts: Array.isArray(result) ? result.length : 0 }),
      },
      () => this.provider.searchContacts({ query, limit: clampLimit(limit, 5, 1, 10) })
    );
  }

  async listTasks({ status = null, limit = 25 } = {}) {
    return this._run(
      {
        integration: 'tasks',
        action: 'tasks_list',
        scope: 'tasks.read',
        category: 'read',
        summarize: result => ({ tasks: Array.isArray(result) ? result.length : 0 }),
      },
      () => this.provider.listTasks({ status, limit: clampLimit(limit, 25, 1, 50) })
    );
  }

  async writeTask({ action = 'create', title = '', due = null, notes = '', task_id = null } = {}) {
    if (action !== 'create' && action !== 'complete') {
      throw new IntegrationError('invalid-argument', 'action must be create or complete');
    }
    if (action === 'create' && !title) {
      throw new IntegrationError('invalid-argument', 'title is required to create a task');
    }
    if (action === 'complete' && !task_id) {
      throw new IntegrationError('invalid-argument', 'task_id is required to complete a task');
    }
    return this._run(
      {
        integration: 'tasks',
        action: action === 'complete' ? 'tasks_complete' : 'tasks_create',
        scope: 'tasks.write',
        category: 'write',
        summarize: result => ({ task: result.id ? 'changed' : 'unknown' }),
      },
      () => this.provider.writeTask({ action, title, due, notes, taskId: task_id })
    );
  }

  async searchNotes({ query = '', limit = 5 } = {}) {
    return this._run(
      {
        integration: 'notes',
        action: 'notes_search',
        scope: 'notes.read',
        category: 'read',
        summarize: result => ({ notes: Array.isArray(result) ? result.length : 0 }),
      },
      () => this.provider.searchNotes({ query, limit: clampLimit(limit, 5, 1, 10) })
    );
  }

  async writeNote({ title, body, tags = '' } = {}) {
    return this._run(
      {
        integration: 'notes',
        action: 'notes_write',
        scope: 'notes.write',
        category: 'write',
        summarize: result => ({ note: result.id ? 'written' : 'unknown' }),
      },
      () => this.provider.writeNote({ title, body, tags })
    );
  }

  async message({ action = 'draft', contact = '', body = '', draft_id = null } = {}) {
    if (action === 'send') {
      return this._run(
        {
          integration: 'messaging',
          action: 'messaging_send',
          scope: 'messaging.send',
          category: 'write',
          summarize: result => ({ sent: result.id ? 1 : 0 }),
        },
        async () => {
          const message = await this.provider.message({ action: 'send', contact, body, draftId: draft_id });
          return {
            id: message.id,
            contact: message.contact,
            status: message.status,
            sentAt: message.sentAt,
          };
        }
      );
    }
    if (action !== 'draft') throw new IntegrationError('invalid-argument', 'action must be draft or send');
    return this._run(
      {
        integration: 'messaging',
        action: 'messaging_draft',
        scope: 'messaging.draft',
        category: 'write',
        summarize: result => ({ draft: result.id ? 'created' : 'unknown' }),
      },
      async () => {
        const message = await this.provider.message({ action: 'draft', contact, body });
        return {
          id: message.id,
          contact: message.contact,
          status: message.status,
          createdAt: message.createdAt,
        };
      }
    );
  }

  async stats() {
    return this.store.stats();
  }

  async activity({ limit = 50 } = {}) {
    return this.store.listActions({ limit });
  }

  async setScopes(integration, scopes) {
    const result = await this.store.setScopes(integration, scopes);
    safeAudit(this.audit, 'SCOPES_UPDATE', `${integration} scopes=${result.scopes.join(',') || 'none'}`, 'ALLOWED');
    return result;
  }

  async revoke(integration) {
    const result = await this.store.revoke(integration);
    safeAudit(this.audit, 'REVOKE', integration, 'ALLOWED');
    return result;
  }

  async deleteData(integration) {
    const result = await this.store.deleteData(integration);
    safeAudit(this.audit, 'DELETE_DATA', integration, 'ALLOWED');
    return result;
  }
}

module.exports = {
  IntegrationService,
  DEFAULT_LIMITS,
  RATE_WINDOW_MS,
};
