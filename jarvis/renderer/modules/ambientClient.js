// JARVIS — Background Presence Panel
// Controls the OS login item and reports tray/scheduler state. Changes apply
// immediately; there is no separate save step for system-level startup.

window.AmbientPanel = (() => {
  let applying = false;

  function api() {
    return window.jarvis || {};
  }

  function toast(message, kind = 'info') {
    if (typeof window.showToast === 'function') window.showToast(message, kind);
  }

  function el(id) {
    return document.getElementById(id);
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function render(data) {
    const startAtLogin = el('cfg-start-at-login');
    const startHidden = el('cfg-start-hidden');
    const status = el('ambient-status');
    const supported = data && data.ok === true && data.supported === true;
    const enabled = data && data.autoStartEnabled === true;

    if (startAtLogin) {
      startAtLogin.checked = enabled;
      startAtLogin.disabled = applying || !supported;
    }
    if (startHidden) {
      startHidden.checked = Boolean(data && data.startHidden);
      startHidden.disabled = applying || !supported || !enabled;
    }

    if (!status) return;
    if (applying) {
      status.textContent = 'Applying background presence settings…';
      return;
    }
    if (!data || data.ok !== true) {
      status.textContent = data?.error || 'Background presence is unavailable.';
      return;
    }
    if (!supported) {
      status.textContent = 'Auto-start is not supported on this platform. JARVIS still runs in the tray while open.';
      return;
    }

    const scheduler = data.schedulerRunning ? 'Scheduler active.' : 'Scheduler idle.';
    const lastResume = formatTime(data.lastResumeAt);
    const resumeText = lastResume ? ` Last resume: ${lastResume}.` : '';
    if (enabled) {
      status.textContent = `Auto-start is on${data.startHidden ? ' and starts hidden' : ''}. ${scheduler}${resumeText}`;
    } else {
      status.textContent = `Auto-start is off. ${scheduler} Closing the window keeps JARVIS in the tray.${resumeText}`;
    }
  }

  async function refresh() {
    if (applying) return;
    if (!api().ambientStatus) {
      render({ ok: false, error: 'Background presence is unavailable.' });
      return;
    }
    try {
      render(await api().ambientStatus());
    } catch (error) {
      render({ ok: false, error: error?.message || 'Could not read background presence.' });
    }
  }

  async function apply() {
    if (applying) return;
    if (!api().ambientSetAutoStart) {
      toast('Background presence is unavailable.', 'error');
      return;
    }

    const enabled = Boolean(el('cfg-start-at-login')?.checked);
    const startHidden = Boolean(el('cfg-start-hidden')?.checked);
    applying = true;
    render({ ok: true, supported: true, autoStartEnabled: enabled, startHidden });

    try {
      const result = await api().ambientSetAutoStart({ enabled, startHidden });
      if (!result || result.ok !== true) {
        toast(result?.error || 'Could not update auto-start.', 'error');
        applying = false;
        await refresh();
        return;
      }
      applying = false;
      render(result);
      toast(
        enabled
          ? (startHidden ? 'JARVIS will start hidden when you log in.' : 'JARVIS will start when you log in.')
          : 'JARVIS auto-start disabled.',
        enabled ? 'success' : 'info'
      );
    } catch (error) {
      applying = false;
      toast(error?.message || 'Could not update auto-start.', 'error');
      await refresh();
    }
  }

  function init() {
    const startAtLogin = el('cfg-start-at-login');
    if (startAtLogin && !startAtLogin.dataset.ambientBound) {
      startAtLogin.dataset.ambientBound = '1';
      startAtLogin.addEventListener('change', apply);
    }
    const startHidden = el('cfg-start-hidden');
    if (startHidden && !startHidden.dataset.ambientBound) {
      startHidden.dataset.ambientBound = '1';
      startHidden.addEventListener('change', apply);
    }

    const settingsButton = el('btn-settings');
    if (settingsButton && !settingsButton.dataset.ambientBound) {
      settingsButton.dataset.ambientBound = '1';
      settingsButton.addEventListener('click', () => setTimeout(refresh, 80));
    }

    if (typeof api().onAmbientResume === 'function') {
      api().onAmbientResume(() => {
        refresh();
        if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
          toast('Background presence resumed — checking scheduled work.', 'info');
        }
      });
    }

    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  return { refresh, apply };
})();
