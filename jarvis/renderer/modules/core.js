import "./settings.js";
import { escHtml, formatTime, pad, scrollToBottom, autoResizeInput, showToast, toggleHamburger, closeHamburger, appendUserMessage, appendJarvisMessage, createStreamingMessage, updateStreamingEl, finalizeStreamingEl } from '../ui.js';
import { jarvisMemory } from '../memory.js';
import { MODES, state } from '../state.js';
import { checkOllamaAPI, cancelStreamAPI, streamOllamaAPI } from '../api.js';
window.jarvisMemory = jarvisMemory;
window.jarvisState = state; // Make state accessible globally if needed


(function () {
  const e = []; let t = null, n = null; async function s() { if (t) return t; try { if (window.jarvis && window.jarvis.getUserDataPath) { const r = await window.jarvis.getUserDataPath(); t = r ? r + "\\renderer_errors.log" : null } } catch { t = null } return t } function o() {
    n || (n = setTimeout(async () => {
      n = null; try {
        const r = await s(); r && window.jarvis && window.jarvis.writeFile && await window.jarvis.writeFile(r, e.slice(-500).join(`
`))
      } catch { }
    }, 2e3))
  } function i(r, ...l) {
    const p = new Date().toISOString(), g = l.map(d => {
      if (d instanceof Error) return `${d.message}
${d.stack}`; if (typeof d == "object") try { return JSON.stringify(d) } catch { return String(d) } return String(d)
    }).join(" "); e.push(`[${p}] [${r}] ${g}`), o()
  } window.addEventListener("error", r => { i("ERROR", r.message, r.filename, r.lineno, r.error) }), window.addEventListener("unhandledrejection", r => { i("UNHANDLED_REJECTION", r.reason) }); const a = console.error; console.error = function (...r) { a.apply(console, r), i("CONSOLE_ERROR", ...r) }; const c = console.log; console.log = function (...r) { c.apply(console, r), i("CONSOLE_LOG", ...r) }, console.log("JARVIS debug logging initialized.")
})(); window.addEventListener("blur", () => { state.isFocused = !1, document.body.classList.add("paused-animations") }), window.addEventListener("focus", () => { state.isFocused = !0, document.body.classList.remove("paused-animations") }); let hudInterval = null, $messages, $dashboard, $input, $sendBtn, $voiceBtn, $ttsBtn, $hudTime, $hudDate, $activeModeIcon, $activeModeName, $ollamaBadge, $ollamaLabel, $ollamaDot, $activeModelLabel, $waveformCanvas, $waveformLabel, $pOllama, $pModel, $pPlatform, $pCpu, $pMem, $pSessions, $termOutput, $termInput; 

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) {
    const action = el.getAttribute('data-change');
    let args = extractArgs(el);
    if (e.target.tagName === 'SELECT') {
      args = [e.target.value];
    } else if (args.length === 0 && action.includes('toggle')) {
      args = [e.target.checked];
    }
    resolveAndCall(action, args);
  }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el) {
    const action = el.getAttribute('data-input');
    const args = extractArgs(el);
    if (action === 'updateKPIProg') args.push(e.target.value);
    resolveAndCall(action, args);
  }
});

document.addEventListener('blur', (e) => {
  const el = e.target.closest('[data-blur]');
  if (el) {
    const action = el.getAttribute('data-blur');
    const args = extractArgs(el);
    if (action === 'saveKPI') args.push(e.target.innerText);
    resolveAndCall(action, args);
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const el = e.target.closest('[data-keydown-enter]');
    if (el) {
      const action = el.getAttribute('data-keydown-enter');
      const args = extractArgs(el);
      resolveAndCall(action, args);
    }
  }
});

document.addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-dragstart]');
  if (el) {
    const action = el.getAttribute('data-dragstart');
    const args = [e, ...extractArgs(el)];
    resolveAndCall(action, args);
  }
});

document.addEventListener('dragend', (e) => {
  const el = e.target.closest('[data-dragend]');
  if (el) {
    const action = el.getAttribute('data-dragend');
    resolveAndCall(action, [e]);
  }
});

document.addEventListener('dragover', (e) => {
  const el = e.target.closest('[data-dragover]');
  if (el) {
    const action = el.getAttribute('data-dragover');
    resolveAndCall(action, [e]);
  }
});

document.addEventListener('dragleave', (e) => {
  const el = e.target.closest('[data-dragleave]');
  if (el) {
    const action = el.getAttribute('data-dragleave');
    resolveAndCall(action, [e]);
  }
});

document.addEventListener('drop', (e) => {
  const el = e.target.closest('[data-drop]');
  if (el) {
    const action = el.getAttribute('data-drop');
    const args = [e, ...extractArgs(el)];
    resolveAndCall(action, args);
  }
});

if (typeof hljs !== 'undefined') hljs.highlightAll && document.addEventListener('DOMContentLoaded', () => hljs.highlightAll());
document.addEventListener('DOMContentLoaded', () => { const authInput = document.getElementById('auth-hidden-input'); const authScreen = document.getElementById('auth-screen'); if (authInput && authScreen) { document.addEventListener('click', () => { if (!authScreen.classList.contains('hidden')) { authInput.focus(); } }); window.addEventListener('focus', () => { if (!authScreen.classList.contains('hidden')) { authInput.focus(); } }); } });
export function initCore() {
  cacheDom();
  window.loadSettings();
  buildSidebar();
  setupEventListeners();
  startHUDClock();
  initWaveform();
  setMode(state.mode);
  setupVoice();
  
  Promise.all([
    window.jarvis.getSystemInfo(),
    updateSessionCount() // Removed checkOllama since we stripped it! Wait, we stripped checkOllama but updateSessionCount might still be there.
  ]).then(([sysInfo]) => {
    state.systemSpecs = sysInfo;
    updateSystemPanel(sysInfo);
  });
  
  window.jarvis.getUserDataPath().then(p => state.userDataPath = p || "").catch(e => state.userDataPath = "");
}
