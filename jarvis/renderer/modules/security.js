/**
 * JARVIS — Security Module
 * Handles: PIN auth lock screen, security config panel, screen capture, audit log.
 * Dependencies: state, showToast, speakText, openModal, closeModal, escHtml (globals)
 */

'use strict';

// ─── Security State ─────────────────────────────────────────────

const JarvisSec = {
  config: {
    blockWritesOutsideWorkspace: false,
    terminalEnabled: true,
    requirePinForDestructive: false,
    auditLogging: true,
    screenCaptureEnabled: false,
  },

  async load() {
    try {
      const res = await window.jarvis.secConfigLoad();
      if (res.ok) this.config = { ...this.config, ...res.config };
    } catch (_) {}
  },

  async save() {
    try {
      await window.jarvis.secConfigSave(this.config);
      showToast('🔒 Security settings saved.', 'success');
    } catch (e) {
      showToast('Error saving security config: ' + e.message, 'error');
    }
  },
};

// ─── Security Modal ─────────────────────────────────────────────

window.openSecurityModal = function() {
  let modal = document.getElementById('security-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'security-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="closeModal('security-modal')"></div>
      <div class="modal-box" style="max-width:640px">
        <div class="modal-hdr">
          <span class="modal-title">🔒 JARVIS SECURITY CONTROL CENTER</span>
          <button class="modal-close-btn" onclick="closeModal('security-modal')">✕</button>
        </div>
        <div class="modal-body">
          <div class="sec-status-banner" id="sec-status-banner">
            <span class="sec-shield-icon">🛡</span>
            <div>
              <div class="sec-banner-title">SECURITY BOUNDARY ACTIVE</div>
              <div class="sec-banner-sub">Path Guard · Command Classifier · Audit Logger · Rate Limiter</div>
            </div>
          </div>

          <div class="sec-section-title">PERMISSION TOGGLES</div>

          <div class="sec-toggle-row" id="sec-row-terminal">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">⌨ Terminal Access</div>
              <div class="sec-toggle-desc">Allow JARVIS terminal to execute system commands</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-terminal" onchange="secToggle('terminalEnabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-toggle-row">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">📁 Restrict File Writes</div>
              <div class="sec-toggle-desc">Block file writes outside the current workspace directory</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-writes" onchange="secToggle('blockWritesOutsideWorkspace', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-toggle-row">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">📸 Screen Capture</div>
              <div class="sec-toggle-desc">Allow JARVIS to capture your screen for visual analysis (disabled by default)</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-screen" onchange="secToggle('screenCaptureEnabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-toggle-row">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">📋 Audit Logging</div>
              <div class="sec-toggle-desc">Log all sensitive operations (terminal, file writes, screen capture) to security_audit.log</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-audit" onchange="secToggle('auditLogging', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-section-title" style="margin-top:16px">HARD BOUNDARIES (Always Active)</div>
          <div class="sec-boundary-list">
            <div class="sec-boundary-item">🚫 <span>System directories blocked (C:\\Windows, Program Files, System32)</span></div>
            <div class="sec-boundary-item">🚫 <span>Credential files blocked (.env, .pem, id_rsa, .key, SSH)</span></div>
            <div class="sec-boundary-item">🚫 <span>Destructive commands blocked (format, del /f/s/q C:\\, rm -rf /)</span></div>
            <div class="sec-boundary-item">🚫 <span>System processes protected (csrss, lsass, winlogon, svchost)</span></div>
            <div class="sec-boundary-item">⚠ <span>Sensitive commands require confirmation before execution</span></div>
            <div class="sec-boundary-item">⏱ <span>Rate limited: max 10 terminal/min, 30 web search/min</span></div>
          </div>

          <div class="sec-section-title" style="margin-top:16px">AUDIT LOG (Last 20 entries)</div>
          <div class="sec-audit-log" id="sec-audit-log">Loading…</div>
          <button class="micro-btn" onclick="refreshSecAudit()" style="margin-top:6px">↻ REFRESH LOG</button>

          <div class="cfg-actions" style="margin-top:16px">
            <button class="cfg-btn-primary" onclick="JarvisSec.save()">🔒 SAVE SECURITY CONFIG</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  JarvisSec.load().then(() => {
    const toggle = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    toggle('sec-terminal', JarvisSec.config.terminalEnabled);
    toggle('sec-writes', JarvisSec.config.blockWritesOutsideWorkspace);
    toggle('sec-screen', JarvisSec.config.screenCaptureEnabled);
    toggle('sec-audit', JarvisSec.config.auditLogging);
    refreshSecAudit();
  });
  openModal('security-modal');
};

window.secToggle = function(key, val) {
  JarvisSec.config[key] = val;
};

window.refreshSecAudit = async function() {
  const el = document.getElementById('sec-audit-log');
  if (!el) return;
  try {
    const res = await window.jarvis.secAuditRead();
    if (!res.ok || !res.data) { el.textContent = 'No audit log entries yet.'; return; }
    const lines = res.data.split('\n').filter(Boolean).slice(-20).reverse();
    el.innerHTML = lines.map(line => {
      const isBlocked = line.includes('[BLOCKED]') || line.includes('[RATE_LIMITED]');
      const isWarn    = line.includes('[WARN');
      const cls = isBlocked ? 'sec-log-blocked' : isWarn ? 'sec-log-warn' : 'sec-log-ok';
      return `<div class="sec-log-entry ${cls}">${escHtml(line)}</div>`;
    }).join('');
  } catch (e) { el.textContent = 'Error loading audit log.'; }
};

// ─── Screen Capture ─────────────────────────────────────────────

window.captureScreenForAnalysis = async function() {
  showToast('📸 Capturing screen…', 'info');
  try {
    const res = await window.jarvis.captureScreen();
    if (!res.ok) {
      showToast(`⛔ ${res.error}`, 'error');
      if (res.error.includes('disabled')) {
        showToast('Go to Security settings to enable screen capture.', 'info');
      }
      return;
    }
    _imgB64 = res.data;
    _imgMime = res.mimeType;
    const prev = document.getElementById('img-preview');
    if (prev) prev.src = `data:${_imgMime};base64,${_imgB64}`;
    document.getElementById('img-drop-zone-inner')?.setAttribute('hidden', '');
    document.getElementById('img-preview-wrap')?.removeAttribute('hidden');
    document.getElementById('img-analyze-btn')?.removeAttribute('disabled');
    showToast(`📸 Screen captured: ${res.source || 'Desktop'}`, 'success');
  } catch (e) {
    showToast('Screen capture failed: ' + e.message, 'error');
  }
};


// ─── Sidebar Security Button Injection ──────────────────────────

(function addSecButton() {
  function _inject() {
    if (document.getElementById('btn-security')) return;
    const sb = document.getElementById('sidebar-bottom');
    if (!sb) return;
    const btn = document.createElement('button');
    btn.id = 'btn-security';
    btn.className = 'sb-btn';
    btn.title = 'Security Control Center';
    btn.innerHTML = '<span class="sb-icon">🔒</span><span class="sb-label">SECURITY</span>';
    btn.onclick = () => window.openSecurityModal();
    const powerBtn = document.getElementById('btn-poweroff');
    if (powerBtn) sb.insertBefore(btn, powerBtn);
    else sb.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _inject, { once: true });
  } else { _inject(); }
})();

// ─── Screen Capture Button in Image Analysis ─────────────────────

(function addScreenCaptureBtn() {
  function _inject() {
    const dropZone = document.getElementById('img-drop-zone');
    if (!dropZone || document.getElementById('screen-capture-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'screen-capture-btn';
    btn.className = 'dash-btn';
    btn.style.cssText = 'margin-top:10px;width:100%';
    btn.innerHTML = '📸 CAPTURE SCREEN';
    btn.onclick = () => window.captureScreenForAnalysis();
    dropZone.parentNode.insertBefore(btn, dropZone.nextSibling);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _inject, { once: true });
  } else { _inject(); }
})();

// ─── Startup ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  JarvisSec.load().then(() => {
    console.log('[JARVIS] Security boundary initialized.', JarvisSec.config);
  });
}, { once: true });
