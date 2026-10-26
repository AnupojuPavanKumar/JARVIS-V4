'use strict';

const crypto = require('crypto');

class IntegrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function parseDate(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IntegrationError('invalid-argument', `${label} must be an ISO date string`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new IntegrationError('invalid-argument', `${label} must be a valid date`);
  }
  return new Date(timestamp);
}

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new IntegrationError('invalid-argument', 'date must use YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new IntegrationError('invalid-argument', 'date must be a real calendar date');
  }
  return parsed;
}

function capText(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function includesText(record, query) {
  if (!query) return true;
  const haystack = Object.values(record).filter(value => typeof value === 'string').join(' ').toLowerCase();
  return haystack.includes(query);
}

class FixtureProvider {
  constructor({ store, now = Date.now } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
      throw new Error('FixtureProvider requires an IntegrationStore');
    }
    this.store = store;
    this.now = now;
  }

  async listCalendar({ from = null, to = null, limit = 25 } = {}) {
    const state = await this.store.read();
    const fromTime = from ? parseDate(from, 'from').getTime() : -Infinity;
    const toTime = to ? parseDate(to, 'to').getTime() : Infinity;
    if (fromTime > toTime) throw new IntegrationError('invalid-argument', 'from must be before to');
    const events = state.data.events
      .filter(event => {
        const start = Date.parse(event.start);
        const end = Date.parse(event.end);
        return end >= fromTime && start <= toTime;
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, Math.min(50, Math.max(1, limit)));
    return clone(events);
  }

  async findAvailability({ date, durationMinutes = 30 } = {}) {
    const day = parseDay(date);
    const duration = Math.min(240, Math.max(15, Number.isInteger(durationMinutes) ? durationMinutes : 30));
    const state = await this.store.read();
    const dayStart = day.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const busy = state.data.events
      .map(event => ({ start: Date.parse(event.start), end: Date.parse(event.end) }))
      .filter(event => event.end > dayStart && event.start < dayEnd)
      .sort((a, b) => a.start - b.start);

    const slots = [];
    const workStart = dayStart + 9 * 60 * 60 * 1000;
    const workEnd = dayStart + 17 * 60 * 60 * 1000;
    let cursor = workStart;
    for (const event of busy) {
      if (cursor + duration * 60 * 1000 <= event.start) {
        slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + duration * 60 * 1000).toISOString() });
      }
      cursor = Math.max(cursor, event.end);
      if (slots.length >= 5) break;
    }
    if (slots.length < 5 && cursor + duration * 60 * 1000 <= workEnd) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + duration * 60 * 1000).toISOString() });
    }
    return { date, timezone: 'UTC', durationMinutes: duration, slots: slots.slice(0, 5) };
  }

  async createEvent({ title, start, end, attendees = '', location = '' } = {}) {
    const eventTitle = capText(title, 200);
    if (!eventTitle) throw new IntegrationError('invalid-argument', 'title is required');
    const startDate = parseDate(start, 'start');
    const endDate = parseDate(end, 'end');
    if (endDate.getTime() <= startDate.getTime()) {
      throw new IntegrationError('invalid-argument', 'end must be after start');
    }
    const event = {
      id: makeId('evt'),
      title: eventTitle,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      attendees: String(attendees).split(',').map(value => value.trim()).filter(Boolean).slice(0, 20),
      location: capText(location, 200),
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.update(state => {
      state.data.events.push(event);
      return event;
    });
    return clone(event);
  }

  async searchEmails({ query = '', limit = 10 } = {}) {
    const state = await this.store.read();
    const normalized = capText(query, 200).toLowerCase();
    return clone(state.data.emails
      .filter(email => email.status !== 'draft' && includesText(email, normalized))
      .sort((a, b) => Date.parse(b.receivedAt || b.sentAt || 0) - Date.parse(a.receivedAt || a.sentAt || 0))
      .slice(0, Math.min(25, Math.max(1, limit)))
      .map(email => ({ ...email, body: capText(email.body, 2000) })));
  }

  async composeEmail({ action, to = '', subject = '', body = '', draftId = null } = {}) {
    const normalizedAction = action === 'send' ? 'send' : 'draft';
    if (normalizedAction === 'send' && draftId) {
      let sent = null;
      await this.store.update(state => {
        const draft = state.data.emails.find(email => email.id === draftId && email.status === 'draft');
        if (!draft) throw new IntegrationError('not-found', 'Draft email was not found');
        draft.status = 'sent';
        draft.sentAt = new Date(this.now()).toISOString();
        sent = draft;
        return draft;
      });
      return clone(sent);
    }

    const recipient = capText(to, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
      throw new IntegrationError('invalid-argument', 'A valid recipient email is required');
    }
    const emailSubject = capText(subject, 200);
    const emailBody = capText(body, 8000);
    if (!emailSubject) throw new IntegrationError('invalid-argument', 'subject is required');
    if (!emailBody) throw new IntegrationError('invalid-argument', 'body is required');

    const email = {
      id: makeId('eml'),
      from: 'user@example.test',
      to: recipient,
      subject: emailSubject,
      body: emailBody,
      status: normalizedAction === 'send' ? 'sent' : 'draft',
      createdAt: new Date(this.now()).toISOString(),
      ...(normalizedAction === 'send' ? { sentAt: new Date(this.now()).toISOString() } : {}),
    };
    await this.store.update(state => {
      state.data.emails.push(email);
      return email;
    });
    return clone(email);
  }

  async deleteDraft({ draftId } = {}) {
    let deleted = 0;
    await this.store.update(state => {
      const before = state.data.emails.length;
      state.data.emails = state.data.emails.filter(email => !(email.id === draftId && email.status === 'draft'));
      deleted = before - state.data.emails.length;
      if (!deleted) throw new IntegrationError('not-found', 'Draft email was not found');
      return { deleted };
    });
    return { deleted };
  }

  async searchContacts({ query = '', limit = 10 } = {}) {
    const state = await this.store.read();
    const normalized = capText(query, 200).toLowerCase();
    return clone(state.data.contacts
      .filter(contact => includesText(contact, normalized))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, Math.min(25, Math.max(1, limit))));
  }

  async listTasks({ status = null, limit = 25 } = {}) {
    const state = await this.store.read();
    return clone(state.data.tasks
      .filter(task => !status || task.status === status)
      .sort((a, b) => Date.parse(a.due || 0) - Date.parse(b.due || 0))
      .slice(0, Math.min(50, Math.max(1, limit))));
  }

  async writeTask({ action, title = '', due = null, notes = '', taskId = null } = {}) {
    if (action === 'complete') {
      let completed = null;
      await this.store.update(state => {
        const task = state.data.tasks.find(candidate => candidate.id === taskId);
        if (!task) throw new IntegrationError('not-found', 'Task was not found');
        task.status = 'completed';
        task.completedAt = new Date(this.now()).toISOString();
        completed = task;
        return task;
      });
      return clone(completed);
    }

    const taskTitle = capText(title, 200);
    if (!taskTitle) throw new IntegrationError('invalid-argument', 'title is required');
    const task = {
      id: makeId('tsk'),
      title: taskTitle,
      status: 'pending',
      due: due ? parseDate(due, 'due').toISOString() : null,
      notes: capText(notes, 2000),
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.update(state => {
      state.data.tasks.push(task);
      return task;
    });
    return clone(task);
  }

  async searchNotes({ query = '', limit = 10 } = {}) {
    const state = await this.store.read();
    const normalized = capText(query, 200).toLowerCase();
    return clone(state.data.notes
      .filter(note => includesText(note, normalized))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, Math.min(25, Math.max(1, limit))));
  }

  async writeNote({ title = '', body = '', tags = '' } = {}) {
    const noteTitle = capText(title, 200);
    const noteBody = capText(body, 12000);
    if (!noteTitle) throw new IntegrationError('invalid-argument', 'title is required');
    if (!noteBody) throw new IntegrationError('invalid-argument', 'body is required');
    const now = new Date(this.now()).toISOString();
    const note = {
      id: makeId('note'),
      title: noteTitle,
      body: noteBody,
      tags: String(tags).split(',').map(value => value.trim()).filter(Boolean).slice(0, 10),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.update(state => {
      state.data.notes.push(note);
      return note;
    });
    return clone(note);
  }

  async message({ action, contact = '', body = '', draftId = null } = {}) {
    const normalizedAction = action === 'send' ? 'send' : 'draft';
    if (normalizedAction === 'send' && draftId) {
      let sent = null;
      await this.store.update(state => {
        const draft = state.data.messages.find(message => message.id === draftId && message.status === 'draft');
        if (!draft) throw new IntegrationError('not-found', 'Draft message was not found');
        draft.status = 'sent';
        draft.sentAt = new Date(this.now()).toISOString();
        sent = draft;
        return draft;
      });
      return clone(sent);
    }

    const contactName = capText(contact, 200);
    const messageBody = capText(body, 4000);
    if (!contactName) throw new IntegrationError('invalid-argument', 'contact is required');
    if (!messageBody) throw new IntegrationError('invalid-argument', 'body is required');
    const state = await this.store.read();
    const resolved = state.data.contacts.find(candidate => (
      candidate.name.toLowerCase() === contactName.toLowerCase()
      || candidate.email.toLowerCase() === contactName.toLowerCase()
    ));
    if (!resolved) throw new IntegrationError('not-found', 'Contact was not found');

    const message = {
      id: makeId('msg'),
      contact: resolved.name,
      body: messageBody,
      status: normalizedAction === 'send' ? 'sent' : 'draft',
      createdAt: new Date(this.now()).toISOString(),
      ...(normalizedAction === 'send' ? { sentAt: new Date(this.now()).toISOString() } : {}),
    };
    await this.store.update(draft => {
      draft.data.messages.push(message);
      return message;
    });
    return clone(message);
  }
}

module.exports = { FixtureProvider, IntegrationError, parseDate, parseDay };
