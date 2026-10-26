// JARVIS — Local Document Index Panel
// Folders are added only through the native picker; index contents are never
// displayed as instructions and can be removed with one click.

window.DocumentsPanel = (() => {
  let loading = false;

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

  function api() {
    return window.jarvis || {};
  }

  function formatDate(value) {
    if (!value) return 'never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
  }

  function panel() {
    return document.getElementById('document-panel');
  }

  function setBusy(busy) {
    for (const id of [
      'btn-document-add', 'btn-document-reindex', 'btn-document-retention',
      'btn-document-prune', 'btn-document-delete-all',
    ]) {
      const button = document.getElementById(id);
      if (button) button.disabled = busy;
    }
  }

  function render(data) {
    const el = panel();
    if (!el) return;
    if (!data || data.ok !== true || data.enabled !== true) {
      el.innerHTML = `<div class="panel-placeholder" style="padding:12px">${esc(data?.error || 'Local document search is unavailable.')}</div>`;
      return;
    }

    const folders = Array.isArray(data.folders) ? data.folders : [];
    const retention = document.getElementById('document-retention');
    if (retention && document.activeElement !== retention) {
      retention.value = data.retentionDays ?? '';
    }

    const rows = folders.map(folder => `
      <div class="integration-row" data-folder-id="${esc(folder.id)}">
        <div class="integration-main">
          <div class="integration-title">
            <span class="integration-state is-on">${esc(folder.scope)}</span>
            <span class="document-path" title="${esc(folder.path)}">${esc(folder.path)}</span>
          </div>
          <div class="integration-meta">
            ${folder.documentCount} file${folder.documentCount === 1 ? '' : 's'}
            · ${folder.chunkCount} passage${folder.chunkCount === 1 ? '' : 's'}
            · added ${esc(formatDate(folder.addedAt))}
          </div>
        </div>
        <div class="integration-actions">
          <button type="button" class="integration-btn danger" data-document-action="remove" data-folder-id="${esc(folder.id)}">REMOVE</button>
        </div>
      </div>
    `).join('');

    el.innerHTML = `
      <div class="document-summary">
        ${data.documentCount || 0} file(s) · ${data.chunkCount || 0} passage(s) · indexed ${esc(formatDate(data.lastIndexedAt))}
      </div>
      ${rows || '<div class="panel-placeholder" style="padding:12px">No approved folders. Add a folder to enable cited local search.</div>'}
    `;
  }

  async function refresh() {
    if (loading) return;
    const el = panel();
    if (!el) return;
    if (typeof api().documentsStatus !== 'function') {
      render({ ok: false, error: 'Document IPC is unavailable.' });
      return;
    }
    loading = true;
    try {
      render(await api().documentsStatus());
    } catch (error) {
      render({ ok: false, error: error.message || 'Could not load the document index.' });
    } finally {
      loading = false;
    }
  }

  async function addFolder() {
    if (typeof api().documentsPickFolder !== 'function') {
      toast('Folder picker is unavailable.', 'error');
      return;
    }
    setBusy(true);
    try {
      const picked = await api().documentsPickFolder();
      if (!picked || picked.ok !== true) {
        toast((picked && picked.error) || 'Could not open the folder picker.', 'error');
        return;
      }
      if (picked.canceled) return;
      const scope = document.getElementById('document-scope')?.value || 'work';
      const result = await api().documentsAddFolder({ path: picked.path, scope });
      render(result);
      if (result && result.ok) {
        toast(`Indexed ${result.documentCount} file(s) from the approved folder.`, 'info');
      } else {
        toast((result && result.error) || 'Folder indexing failed.', 'error');
      }
    } catch (error) {
      toast(error.message || 'Folder indexing failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    if (typeof api().documentsReindex !== 'function') return;
    setBusy(true);
    try {
      const result = await api().documentsReindex();
      render(result);
      if (result && result.ok) {
        toast(`Reindexed ${result.documentCount} file(s).`, 'info');
      } else {
        toast((result && result.error) || 'Reindex failed.', 'error');
      }
    } catch (error) {
      toast(error.message || 'Reindex failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeFolder(folderId) {
    if (!folderId || typeof api().documentsRemoveFolder !== 'function') return;
    if (!window.confirm('Remove this folder from the local index? The files on disk are not changed.')) return;
    setBusy(true);
    try {
      const result = await api().documentsRemoveFolder({ folderId });
      render(result);
      if (result && result.ok) toast('Folder removed from the index.', 'info');
      else toast((result && result.error) || 'Could not remove folder.', 'error');
    } catch (error) {
      toast(error.message || 'Could not remove folder.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention() {
    if (typeof api().documentsSetRetention !== 'function') return;
    const input = document.getElementById('document-retention');
    const raw = input?.value?.trim() || '';
    const days = raw ? Number(raw) : null;
    if (raw && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      toast('Retention must be 1-3650 days or blank.', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api().documentsSetRetention({ days });
      render(result);
      if (result && result.ok) toast('Retention saved.', 'info');
      else toast((result && result.error) || 'Could not save retention.', 'error');
    } catch (error) {
      toast(error.message || 'Could not save retention.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function prune() {
    if (typeof api().documentsApplyRetention !== 'function') return;
    setBusy(true);
    try {
      const result = await api().documentsApplyRetention();
      render(result);
      if (result && result.ok) toast(`Removed ${result.removed || 0} aged file(s) from the index.`, 'info');
      else toast((result && result.error) || 'Retention prune failed.', 'error');
    } catch (error) {
      toast(error.message || 'Retention prune failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    if (typeof api().documentsDeleteAll !== 'function') return;
    if (!window.confirm('Delete the entire local document index? Files on disk are not changed.')) return;
    setBusy(true);
    try {
      const result = await api().documentsDeleteAll();
      render(result);
      if (result && result.ok) toast('Document index deleted.', 'info');
      else toast((result && result.error) || 'Could not delete the index.', 'error');
    } catch (error) {
      toast(error.message || 'Could not delete the index.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    const el = panel();
    if (el && el.dataset.bound !== '1') {
      el.dataset.bound = '1';
      el.addEventListener('click', event => {
        const button = event.target.closest('[data-document-action="remove"]');
        if (button && !button.disabled) removeFolder(button.dataset.folderId);
      });
    }
    const add = document.getElementById('btn-document-add');
    if (add && !add.dataset.bound) {
      add.dataset.bound = '1';
      add.addEventListener('click', addFolder);
    }
    const reindexButton = document.getElementById('btn-document-reindex');
    if (reindexButton && !reindexButton.dataset.bound) {
      reindexButton.dataset.bound = '1';
      reindexButton.addEventListener('click', reindex);
    }
    const retentionButton = document.getElementById('btn-document-retention');
    if (retentionButton && !retentionButton.dataset.bound) {
      retentionButton.dataset.bound = '1';
      retentionButton.addEventListener('click', saveRetention);
    }
    const pruneButton = document.getElementById('btn-document-prune');
    if (pruneButton && !pruneButton.dataset.bound) {
      pruneButton.dataset.bound = '1';
      pruneButton.addEventListener('click', prune);
    }
    const deleteButton = document.getElementById('btn-document-delete-all');
    if (deleteButton && !deleteButton.dataset.bound) {
      deleteButton.dataset.bound = '1';
      deleteButton.addEventListener('click', deleteAll);
    }
    const settingsButton = document.getElementById('btn-settings');
    if (settingsButton && !settingsButton.dataset.documentsBound) {
      settingsButton.dataset.documentsBound = '1';
      settingsButton.addEventListener('click', () => setTimeout(refresh, 80));
    }
  }

  function init() {
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  return { refresh };
})();
