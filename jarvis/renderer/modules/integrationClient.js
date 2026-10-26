// JARVIS — Personal Integrations Panel
// Read-only status plus revoke/delete controls. Secrets are never exposed here.

window.IntegrationsPanel = (() => {
  let loading = false;
  let currentData = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, match => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[match]));
  }

  function toast(message, kind = 'info') {
    if (typeof window.showToast === 'function') window.showToast(message, kind);
  }

  function panel() {
    return document.getElementById('integration-panel');
  }

  function labelFor(name) {
    return {
      calendar: 'CALENDAR',
      email: 'EMAIL',
      contacts: 'CONTACTS',
      tasks: 'TASKS',
      notes: 'NOTES',
      messaging: 'MESSAGING',
    }[name] || String(name).toUpperCase();
  }

  function countsText(counts) {
    if (!counts || typeof counts !== 'object') return '';
    const labels = {
      events: 'event',
      emails: 'email',
      contacts: 'contact',
      tasks: 'task',
      notes: 'note',
      messages: 'message',
    };
    return Object.entries(counts).map(([key, value]) => {
      const label = labels[key] || key;
      return `${value} ${label}${value === 1 ? '' : 's'}`;
    }).join(' · ');
  }

  function render(data) {
    const el = panel();
    if (!el) return;
    if (!data || data.ok !== true || data.enabled !== true) {
      el.innerHTML = `<div class="panel-placeholder" style="padding:12px">${esc(data?.error || 'Personal integrations are unavailable.')}</div>`;
      return;
    }

    const integrations = data.integrations || {};
    currentData = data;
    const rows = Object.entries(integrations).map(([name, record]) => {
      const enabled = record && record.enabled === true;
      const scopes = Array.isArray(record?.scopes) && record.scopes.length
        ? record.scopes.join(', ')
        : 'no scopes';
      return `
        <div class="integration-row" data-integration="${esc(name)}">
          <div class="integration-main">
            <div class="integration-title">
              <span class="integration-name">${esc(labelFor(name))}</span>
              <span class="integration-state ${enabled ? 'is-on' : 'is-off'}">${enabled ? 'ENABLED' : 'REVOKED'}</span>
            </div>
            <div class="integration-meta">${esc(scopes)}</div>
            <div class="integration-meta">${esc(countsText(record?.counts))}</div>
          </div>
          <div class="integration-actions">
            <button type="button" class="integration-btn" data-integration-action="${enabled ? 'revoke' : 'enable'}" data-name="${esc(name)}">${enabled ? 'REVOKE' : 'ENABLE'}</button>
            <button type="button" class="integration-btn danger" data-integration-action="delete" data-name="${esc(name)}">DELETE DATA</button>
          </div>
        </div>
      `;
    }).join('');

    el.innerHTML = `
      <div class="integration-vault">Secrets vault: ${data.vaultAvailable ? 'OS-encrypted' : 'unavailable'}</div>
      ${rows || '<div class="panel-placeholder" style="padding:12px">No integrations configured.</div>'}
    `;
  }

  async function refresh() {
    if (loading) return;
    const el = panel();
    if (!el) return;
    if (!window.jarvis || typeof window.jarvis.integrationsList !== 'function') {
      render({ ok: false, error: 'Integration IPC is unavailable.' });
      return;
    }
    loading = true;
    try {
      render(await window.jarvis.integrationsList());
    } catch (error) {
      render({ ok: false, error: error.message || 'Could not load integrations.' });
    } finally {
      loading = false;
    }
  }

  async function act(name, action) {
    if (!name) return;
    if (action === 'delete') {
      const confirmed = window.confirm(`Delete all stored data for ${labelFor(name)}? This cannot be undone.`);
      if (!confirmed) return;
    } else if (action === 'enable') {
      const confirmed = window.confirm(`Re-enable ${labelFor(name)} with its default scopes?`);
      if (!confirmed) return;
    } else {
      const confirmed = window.confirm(`Revoke ${labelFor(name)}? The assistant will not be able to use it until it is re-enabled.`);
      if (!confirmed) return;
    }

    let api;
    let payload = { integration: name };
    if (action === 'delete') {
      api = window.jarvis.integrationsDeleteData;
    } else if (action === 'enable') {
      api = window.jarvis.integrationsUpdateScopes;
      const scopes = currentData?.availableScopes?.[name];
      if (!Array.isArray(scopes) || scopes.length === 0) {
        toast('Default scopes are unavailable for this integration.', 'error');
        return;
      }
      payload = { integration: name, scopes };
    } else {
      api = window.jarvis.integrationsRevoke;
    }
    if (typeof api !== 'function') {
      toast('Integration control is unavailable.', 'error');
      return;
    }
    try {
      const result = await api(payload);
      render(result);
      if (result && result.ok) {
        toast(
          action === 'delete'
            ? `${labelFor(name)} data deleted.`
            : action === 'enable'
              ? `${labelFor(name)} enabled.`
              : `${labelFor(name)} revoked.`,
          'info'
        );
      } else {
        toast((result && result.error) || 'Integration action failed.', 'error');
      }
    } catch (error) {
      toast(error.message || 'Integration action failed.', 'error');
    }
  }

  function bind() {
    const el = panel();
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', event => {
      const button = event.target.closest('[data-integration-action]');
      if (!button || button.disabled) return;
      act(button.dataset.name, button.dataset.integrationAction);
    });
  }

  function init() {
    bind();
    const settingsButton = document.getElementById('btn-settings');
    if (settingsButton) {
      settingsButton.addEventListener('click', () => setTimeout(refresh, 80));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  return { refresh };
})();
