// JARVIS — Unified Memory Client
// The main process owns the memory store. This module is only an IPC view plus
// a small DOM panel; it never keeps a second localStorage copy of memories.
(() => {
  const TYPES = ['fact', 'preference', 'episode', 'procedure', 'relationship'];
  const SENSITIVITY = ['public', 'personal', 'secret'];
  const panel = {
    records: [],
    stats: null,
    loading: false,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function toast(message, kind = 'info') {
    if (typeof window.showToast === 'function') window.showToast(message, kind);
  }

  async function refresh() {
    if (!window.jarvis || !window.jarvis.memoryLoad) return panel;
    panel.loading = true;
    try {
      const result = await window.jarvis.memoryLoad();
      if (result && result.ok) {
        panel.records = Array.isArray(result.records) ? result.records : [];
        panel.stats = result.stats || null;
      } else {
        panel.records = [];
        if (result?.error) console.warn('[Memory] Load failed:', result.error);
      }
    } catch (error) {
      console.warn('[Memory] Load failed:', error.message);
    } finally {
      panel.loading = false;
    }
    renderMemory();
    return panel;
  }

  function renderMemory() {
    const target = document.getElementById('mem-list');
    if (!target) return;
    if (panel.loading) {
      target.innerHTML = '<div class="mem-empty">Loading memory…</div>';
      return;
    }
    if (!panel.records.length) {
      target.innerHTML = '<div class="mem-empty">No memories yet. Add a fact below.</div>';
      return;
    }

    target.innerHTML = panel.records.map(record => {
      const sensitivity = String(record.sensitivity || 'public');
      const source = record.source && record.source.kind ? record.source.kind : 'unknown';
      return `
    <div class="mem-item${record.disabled ? ' mem-item-disabled' : ''}" data-memory-id="${esc(record.id)}">
      <span class="mem-item-icon">◈</span>
      <span class="mem-item-text">${esc(record.text)}</span>
      <span class="mem-item-meta">${esc(record.type)} · ${esc(source)} · ${esc(sensitivity)}${record.disabled ? ' · disabled' : ''}</span>
      <span class="mem-item-actions">
        <button class="mem-item-edit" data-action="memoryEdit" data-arg="${esc(record.id)}" title="Edit">✎</button>
        <button class="mem-item-toggle" data-action="memoryToggle" data-arg="${esc(record.id)}" title="${record.disabled ? 'Enable' : 'Disable'}">${record.disabled ? '◉' : '◌'}</button>
        <button class="mem-item-del" data-action="memoryDelete" data-arg="${esc(record.id)}" title="Delete">✕</button>
      </span>
    </div>`;
    }).join('');
  }

  async function memoryAdd() {
    const input = document.getElementById('mem-input');
    const text = input?.value?.trim();
    if (!text) return;
    if (!window.jarvis || !window.jarvis.memoryAdd) {
      toast('Memory service unavailable', 'error');
      return;
    }
    const type = document.getElementById('mem-type')?.value || 'fact';
    const sensitivity = document.getElementById('mem-sensitivity')?.value || undefined;
    try {
      const result = await window.jarvis.memoryAdd({ text, type, ...(sensitivity ? { sensitivity } : {}) });
      if (!result?.ok) throw new Error(result?.error || 'Memory write failed');
      input.value = '';
      await refresh();
      toast('Memory updated', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function memoryEdit(id) {
    const record = panel.records.find(candidate => candidate.id === id);
    if (!record) return;
    const item = Array.from(document.querySelectorAll('.mem-item'))
      .find(candidate => candidate.dataset.memoryId === id);
    if (!item) return;
    const text = item.querySelector('.mem-item-text');
    const actions = item.querySelector('.mem-item-actions');
    if (!text || !actions || text.querySelector('.mem-edit-input')) return;

    // Electron does not implement window.prompt, so edits stay inside the
    // memory panel. Enter saves; Escape cancels; both clean up their listeners.
    const input = document.createElement('input');
    input.className = 'mem-edit-input';
    input.value = record.text;
    input.maxLength = 8000;
    const save = document.createElement('button');
    save.className = 'mem-item-edit';
    save.textContent = '✓';
    save.title = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'mem-item-del';
    cancel.textContent = '✕';
    cancel.title = 'Cancel';

    const finish = () => {
      text.textContent = record.text;
      actions.replaceChildren();
      actions.insertAdjacentHTML('beforeend', `
        <button class="mem-item-edit" data-action="memoryEdit" data-arg="${esc(record.id)}" title="Edit">✎</button>
        <button class="mem-item-toggle" data-action="memoryToggle" data-arg="${esc(record.id)}" title="${record.disabled ? 'Enable' : 'Disable'}">${record.disabled ? '◉' : '◌'}</button>
        <button class="mem-item-del" data-action="memoryDelete" data-arg="${esc(record.id)}" title="Delete">✕</button>`);
    };

    const commit = async () => {
      const value = input.value.trim();
      if (!value || value === record.text) {
        finish();
        return;
      }
      input.disabled = true;
      try {
        const result = await window.jarvis.memoryUpdate(id, { text: value });
        if (!result?.ok) throw new Error(result?.error || 'Memory update failed');
        await refresh();
        toast('Memory updated', 'success');
      } catch (error) {
        input.disabled = false;
        toast(error.message, 'error');
      }
    };

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      }
    });
    save.addEventListener('click', commit);
    cancel.addEventListener('click', finish);

    text.textContent = '';
    text.appendChild(input);
    actions.replaceChildren(save, cancel);
    input.focus();
    input.select();
  }

  async function memoryToggle(id) {
    const record = panel.records.find(candidate => candidate.id === id);
    if (!record) return;
    try {
      const result = await window.jarvis.memoryDisable(id, !record.disabled);
      if (!result?.ok) throw new Error(result?.error || 'Memory update failed');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function memoryDelete(id) {
    if (typeof window.confirm === 'function' && !window.confirm('Delete this memory permanently?')) return;
    try {
      const result = await window.jarvis.memoryDelete(id);
      if (!result?.ok) throw new Error(result?.error || 'Memory delete failed');
      await refresh();
      toast('Memory deleted', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function memoryClear() {
    if (typeof window.confirm === 'function' && !window.confirm('Delete ALL memory records? This cannot be undone.')) return;
    try {
      const result = await window.jarvis.memoryClear({ confirm: 'CLEAR' });
      if (!result?.ok) throw new Error(result?.error || 'Memory clear failed');
      await refresh();
      toast(`Deleted ${result.deleted || 0} memories`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function memoryExport() {
    try {
      const result = await window.jarvis.memoryExport();
      if (!result?.ok) throw new Error(result?.error || 'Memory export failed');
      const saved = await window.jarvis.saveDialog('jarvis-memory.json', result.json);
      if (saved?.ok) toast('Memory exported', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function recordConversation(messages, sessionId) {
    if (!window.jarvis || !window.jarvis.memoryRecordConversation) return null;
    if (!Array.isArray(messages) || !messages.length) return null;
    try {
      const result = await window.jarvis.memoryRecordConversation({ messages, sessionId });
      if (result?.ok) await refresh();
      return result;
    } catch (error) {
      console.warn('[Memory] Conversation recording failed:', error.message);
      return null;
    }
  }

  // Thin compatibility/memory-context API used by the existing chat renderer.
  const jarvisMemory = {
    get memories() {
      return panel.records.map(record => ({ text: record.text, timestamp: record.updatedAt }));
    },
    save() { /* The main process owns persistence. */ },
    loadFromIPC() { return refresh(); },
    async getRelevantContext(query) {
      if (!query || !window.jarvis || !window.jarvis.memoryRetrieve) return '';
      try {
        const result = await window.jarvis.memoryRetrieve(query, {
          maxRecords: 6,
          maxChars: 1800,
          allowPersonal: false,
        });
        return result?.ok ? (result.context || '') : '';
      } catch (error) {
        console.warn('[Memory] Retrieval failed:', error.message);
        return '';
      }
    },
    async extractAndStore(text) {
      if (typeof text !== 'string' || !text.trim()) return;
      return recordConversation([{ role: 'user', content: text }], null);
    },
    recordConversation,
    refresh,
    get records() { return panel.records.slice(); },
  };

  function init() {
    const input = document.getElementById('mem-input');
    if (input && !input.dataset.memoryBound) {
      input.dataset.memoryBound = '1';
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          memoryAdd();
        }
      });
    }
    refresh();
  }

  window.jarvisMemory = jarvisMemory;
  window.MemoryPanel = {
    loadFromIPC: jarvisMemory.loadFromIPC,
    getRelevantContext: query => jarvisMemory.getRelevantContext(query),
    extractAndStore: text => jarvisMemory.extractAndStore(text),
    recordConversation,
    refresh,
    get memories() { return jarvisMemory.memories; },
    get records() { return jarvisMemory.records; },
    getStats: () => panel.stats,
    renderMemory,
    init,
  };

  // data-action handlers resolve against window.
  Object.assign(window, {
    renderMemory,
    memoryAdd,
    memoryEdit,
    memoryToggle,
    memoryDelete,
    memoryClear,
    memoryExport,
    memoryRefresh: refresh,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
