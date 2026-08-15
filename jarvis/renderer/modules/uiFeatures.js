// ═══════════════════════════════════════════════════════════════
// JARVIS — UI FEATURES MODULE
// Chat Search, Message Bookmarks, Prompt Library, Snippet Manager,
// Notes Scratchpad, Calculator, Keyboard Shortcuts
// Extracted from renderer.js §MEGA-UPGRADE for modular architecture.
// ═══════════════════════════════════════════════════════════════

function _uiEscHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Chat Search ───────────────────────────────────────────────

let _chatSearchVisible = false;

function openChatSearch() {
  let overlay = document.getElementById('chat-search-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'chat-search-overlay';
    overlay.innerHTML = `<div class="chat-search-row"><input class="chat-search-input" id="chat-search-input" type="text" placeholder="Search messages…" autocomplete="off"><button class="chat-search-close" onclick="closeChatSearch()">✕</button></div><div class="chat-search-count" id="chat-search-count"></div><div class="chat-search-hits" id="chat-search-hits"></div>`;
    document.body.appendChild(overlay);
    document.getElementById('chat-search-input').addEventListener('input', e => runChatSearch(e.target.value));
    document.getElementById('chat-search-input').addEventListener('keydown', e => { if (e.key === 'Escape') closeChatSearch(); });
  }
  overlay.removeAttribute('hidden');
  _chatSearchVisible = true;
  setTimeout(() => document.getElementById('chat-search-input')?.focus(), 50);
}
window.openChatSearch = openChatSearch;

function closeChatSearch() {
  document.getElementById('chat-search-overlay')?.setAttribute('hidden', '');
  _chatSearchVisible = false;
}
window.closeChatSearch = closeChatSearch;

function runChatSearch(query) {
  const hitsEl = document.getElementById('chat-search-hits');
  const countEl = document.getElementById('chat-search-count');
  if (!hitsEl) return;
  const q = query.trim().toLowerCase();
  if (!q) { hitsEl.innerHTML = ''; if (countEl) countEl.textContent = ''; return; }
  const messages = Array.from(document.querySelectorAll('#chat-messages .message'));
  const hits = messages.map((el, idx) => ({ el, text: el.textContent || '', idx })).filter(h => h.text.toLowerCase().includes(q));
  if (countEl) countEl.textContent = hits.length ? `${hits.length} result${hits.length !== 1 ? 's' : ''}` : 'No results';
  hitsEl.innerHTML = hits.slice(0, 20).map(h => {
    const who = h.el.classList.contains('message-user') ? 'YOU' : 'JARVIS';
    const preview = h.text.slice(0, 120).replace(/\n/g, ' ');
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const highlighted = preview.replace(re, m => `<mark>${m}</mark>`);
    return `<div class="chat-search-hit" onclick="scrollToMsg(${h.idx})"><div class="chat-search-hit-who">${who}</div>${highlighted}</div>`;
  }).join('') || '<div class="chat-search-hit"><div class="chat-search-hit-who">NO MATCHES</div></div>';
}
window.runChatSearch = runChatSearch;

function scrollToMsg(idx) {
  const msgs = document.querySelectorAll('#chat-messages .message');
  if (msgs[idx]) {
    msgs[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    msgs[idx].style.outline = '2px solid var(--cyan)';
    setTimeout(() => { if (msgs[idx]) msgs[idx].style.outline = ''; }, 2000);
  }
}
window.scrollToMsg = scrollToMsg;

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); _chatSearchVisible ? closeChatSearch() : openChatSearch(); }
});

// ─── Message Bookmarks ─────────────────────────────────────────

const _bookmarks = new Set();

function toggleBookmark(msgEl) {
  const id = msgEl.dataset.msgId || (msgEl.dataset.msgId = `msg-${Date.now()}`);
  const btn = msgEl.querySelector('.msg-bookmark-btn');
  if (_bookmarks.has(id)) {
    _bookmarks.delete(id); msgEl.classList.remove('bookmarked');
    if (btn) { btn.textContent = '☆'; btn.classList.remove('bookmarked'); }
    if (typeof showToast === 'function') showToast('Bookmark removed', 'info');
  } else {
    _bookmarks.add(id); msgEl.classList.add('bookmarked');
    if (btn) { btn.textContent = '★'; btn.classList.add('bookmarked'); }
    if (typeof showToast === 'function') showToast('Message bookmarked ★', 'success');
  }
}
window.toggleBookmark = toggleBookmark;

function _addBookmarkBtn(msgEl) {
  if (!msgEl || msgEl.querySelector('.msg-bookmark-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'msg-bookmark-btn'; btn.textContent = '☆'; btn.title = 'Bookmark';
  btn.onclick = () => toggleBookmark(msgEl);
  msgEl.appendChild(btn);
}

const _msgObserver = new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
  if (n.nodeType === 1 && n.classList?.contains('message-jarvis')) setTimeout(() => _addBookmarkBtn(n), 300);
})));

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('chat-messages');
  if (container) _msgObserver.observe(container, { childList: true });
}, { once: true });

// ─── Prompt Library ────────────────────────────────────────────

let _prompts = [];

async function openPromptLibrary() {
  try { const res = await window.jarvis.invoke('prompts-load'); _prompts = res?.data || []; } catch { _prompts = []; }
  if (!_prompts.length) {
    _prompts = [
      { id: 'p1', title: 'Professional Email', category: 'Writing', body: 'Write a professional email about {topic}. Keep it concise and polite.' },
      { id: 'p2', title: 'Code Review', category: 'Code', body: 'Review this code for bugs and improvements:```\n{paste code here}\n```' },
      { id: 'p3', title: 'Explain Simply', category: 'Learning', body: 'Explain {topic} simply so a beginner can understand.' },
      { id: 'p4', title: 'Debug Error', category: 'Code', body: 'I\'m getting this error: {error}Code:\n```\n{code}\n```\nHow do I fix it?' },
      { id: 'p5', title: 'Write Unit Tests', category: 'Code', body: 'Write comprehensive unit tests for:```\n{function}\n```' },
    ];
    try { await window.jarvis.invoke('prompts-save', _prompts); } catch {}
  }
  if (typeof openModal === 'function') openModal('prompts-modal');
  renderPrompts('');
}
window.openPromptLibrary = openPromptLibrary;

function renderPrompts(filter) {
  const grid = document.getElementById('prompts-grid');
  if (!grid) return;
  const q = filter.toLowerCase();
  const list = q ? _prompts.filter(p => (p.title + p.body + p.category).toLowerCase().includes(q)) : _prompts;
  grid.innerHTML = list.length ? list.map(p => `<div class="prompt-card"><div class="prompt-card-cat">${_uiEscHtml(p.category)}</div><div class="prompt-card-title">${_uiEscHtml(p.title)}</div><div class="prompt-card-body">${_uiEscHtml(p.body)}</div><div class="prompt-card-actions"><button class="prompt-card-use" onclick="usePrompt(${JSON.stringify(p.id)})">▶ USE</button><button class="prompt-card-del" onclick="deletePrompt(${JSON.stringify(p.id)})">✕</button></div></div>`).join('') : '<div class="panel-placeholder">No prompts found</div>';
}
window.renderPrompts = renderPrompts;

function usePrompt(id) {
  const p = _prompts.find(x => x.id === id);
  if (p) {
    if (typeof injectPrompt === 'function') injectPrompt(p.body);
    if (typeof closeModal === 'function') closeModal('prompts-modal');
    if (typeof showToast === 'function') showToast(`Prompt: ${p.title}`, 'success');
  }
}
window.usePrompt = usePrompt;

async function deletePrompt(id) {
  _prompts = _prompts.filter(p => p.id !== id);
  try { await window.jarvis.invoke('prompts-save', _prompts); } catch {}
  renderPrompts(document.getElementById('prompts-search')?.value || '');
  if (typeof showToast === 'function') showToast('Deleted', 'info');
}
window.deletePrompt = deletePrompt;

function togglePromptAddForm() { document.getElementById('prompt-add-form')?.toggleAttribute('hidden'); }
window.togglePromptAddForm = togglePromptAddForm;

async function saveNewPrompt() {
  const title = document.getElementById('prompt-new-title')?.value.trim();
  const cat = document.getElementById('prompt-new-cat')?.value.trim() || 'General';
  const body = document.getElementById('prompt-new-body')?.value.trim();
  if (!title || !body) { if (typeof showToast === 'function') showToast('Title and body required', 'error'); return; }
  _prompts.unshift({ id: `p${Date.now()}`, title, category: cat, body });
  try { await window.jarvis.invoke('prompts-save', _prompts); } catch {}
  renderPrompts('');
  document.getElementById('prompt-add-form')?.setAttribute('hidden', '');
  if (typeof showToast === 'function') showToast('Saved!', 'success');
}
window.saveNewPrompt = saveNewPrompt;

// ─── Snippet Manager ───────────────────────────────────────────

let _snippets = [];

async function openSnippetManager() {
  try { const res = await window.jarvis.invoke('snippets-load'); _snippets = res?.data || []; } catch { _snippets = []; }
  if (!_snippets.length) {
    _snippets = [
      { id: 's1', title: 'HTTP GET (Python)', lang: 'python', code: 'import requests\nres = requests.get("https://api.example.com")\nprint(res.status_code, res.json())' },
      { id: 's2', title: 'Async Fetch (JS)', lang: 'javascript', code: 'const data = await fetch("https://api.example.com").then(r=>r.json());\nconsole.log(data);' },
      { id: 's3', title: 'List Files', lang: 'python', code: 'import os\nfor f in os.listdir("."):\n    print(f)' },
    ];
    try { await window.jarvis.invoke('snippets-save', _snippets); } catch {}
  }
  if (typeof openModal === 'function') openModal('snippets-modal');
  renderSnippets('');
}
window.openSnippetManager = openSnippetManager;

function renderSnippets(filter) {
  const list = document.getElementById('snippets-list');
  if (!list) return;
  const q = filter.toLowerCase();
  const items = q ? _snippets.filter(s => (s.title + s.code + s.lang).toLowerCase().includes(q)) : _snippets;
  list.innerHTML = items.length ? items.map(s => `<div class="snip-item"><div class="snip-item-hdr"><span class="snip-title">${_uiEscHtml(s.title)}</span><span class="snip-tag ${s.lang}">${s.lang.toUpperCase()}</span></div><div class="snip-code-preview">${_uiEscHtml(s.code.slice(0, 200))}</div><div class="snip-actions"><button class="snip-btn use" onclick="useSnippet(${JSON.stringify(s.id)})">▶ INSERT</button><button class="snip-btn" onclick="copySnip(${JSON.stringify(s.id)})">⧉ COPY</button><button class="snip-btn del" onclick="deleteSnippet(${JSON.stringify(s.id)})">✕</button></div></div>`).join('') : '<div class="panel-placeholder">No snippets found</div>';
}
window.renderSnippets = renderSnippets;

function useSnippet(id) {
  const s = _snippets.find(x => x.id === id);
  if (s) {
    if (typeof injectPrompt === 'function') injectPrompt('```' + s.lang + '\n' + s.code + '\n```');
    if (typeof closeModal === 'function') closeModal('snippets-modal');
    if (typeof showToast === 'function') showToast('Inserted!', 'success');
  }
}
window.useSnippet = useSnippet;

function copySnip(id) {
  const s = _snippets.find(x => x.id === id);
  if (s) navigator.clipboard.writeText(s.code).then(() => { if (typeof showToast === 'function') showToast('Copied!', 'success'); });
}
window.copySnip = copySnip;

async function deleteSnippet(id) {
  _snippets = _snippets.filter(s => s.id !== id);
  try { await window.jarvis.invoke('snippets-save', _snippets); } catch {}
  renderSnippets(document.getElementById('snippets-search')?.value || '');
  if (typeof showToast === 'function') showToast('Deleted', 'info');
}
window.deleteSnippet = deleteSnippet;

function toggleSnipAddForm() { document.getElementById('snip-add-form')?.toggleAttribute('hidden'); }
window.toggleSnipAddForm = toggleSnipAddForm;

async function saveNewSnippet() {
  const title = document.getElementById('snip-new-title')?.value.trim();
  const lang = document.getElementById('snip-new-lang')?.value || 'other';
  const code = document.getElementById('snip-new-code')?.value.trim();
  if (!title || !code) { if (typeof showToast === 'function') showToast('Title and code required', 'error'); return; }
  _snippets.unshift({ id: `s${Date.now()}`, title, lang, code });
  try { await window.jarvis.invoke('snippets-save', _snippets); } catch {}
  renderSnippets('');
  document.getElementById('snip-add-form')?.setAttribute('hidden', '');
  if (typeof showToast === 'function') showToast('Saved!', 'success');
}
window.saveNewSnippet = saveNewSnippet;

// ─── Notes Scratchpad ──────────────────────────────────────────

async function openNotes() {
  let content = '';
  try { const res = await window.jarvis.invoke('notes-load'); content = res?.data || ''; } catch {}
  if (typeof openModal === 'function') openModal('notes-modal');
  setTimeout(() => { const ed = document.getElementById('notes-editor'); if (ed) { ed.value = content; updateNotesStatus(); } }, 50);
}
window.openNotes = openNotes;

function updateNotesStatus() {
  const ed = document.getElementById('notes-editor');
  const st = document.getElementById('notes-status-bar');
  if (!ed || !st) return;
  const w = ed.value.trim() ? ed.value.trim().split(/\s+/).length : 0;
  st.textContent = `${ed.value.length} chars  ·  ${w} words  ·  ${ed.value.split('\n').length} lines`;
}
window.updateNotesStatus = updateNotesStatus;

async function saveNotes() {
  const ed = document.getElementById('notes-editor');
  if (!ed) return;
  try {
    await window.jarvis.invoke('notes-save', ed.value);
    if (typeof showToast === 'function') showToast('Notes saved', 'success');
  } catch {
    if (typeof showToast === 'function') showToast('Save failed', 'error');
  }
}
window.saveNotes = saveNotes;

function notesInsert(text) {
  const ed = document.getElementById('notes-editor'); if (!ed) return;
  const s = ed.selectionStart, e2 = ed.selectionEnd, sel = ed.value.slice(s, e2);
  ed.value = ed.value.slice(0, s) + text.replace('{}', sel || 'text') + ed.value.slice(e2);
  updateNotesStatus();
}
window.notesInsert = notesInsert;

// ─── Calculator (safe parser — no eval / new Function) ─────────────

/**
 * Tiny recursive-descent parser for arithmetic expressions.
 * Supports: +, -, *, /, mod, parens, unary minus, decimal numbers.
 * Rejects letters and non-math symbols before parsing.
 */
function _calcParse(src) {
  const s = src.replace(/\s+/g, '');
  let pos = 0;
  const peek = () => s[pos];
  const consume = (ch) => { if (s[pos] !== ch) throw new Error(`Expected '${ch}'`); pos++; };
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = s[pos++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[pos++]; const r = unary();
      if (op === '/' && r === 0) throw new Error('Division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary() { if (peek() === '-') { pos++; return -unary(); } return primary(); }
  function primary() {
    if (peek() === '(') { pos++; const v = expr(); consume(')'); return v; }
    const start = pos;
    while (pos < s.length && /[0-9.]/.test(s[pos])) pos++;
    if (pos === start) throw new Error(`Unexpected '${s[pos]}'`);
    return parseFloat(s.slice(start, pos));
  }
  const result = expr();
  if (pos !== s.length) throw new Error(`Trailing '${s[pos]}'`);
  return result;
}

let _calcExpr = '', _calcDisplay = '0';

function calcPress(val) {
  if (val === 'C') { _calcExpr = ''; _calcDisplay = '0'; }
  else if (val === '⌫') { _calcExpr = _calcExpr.slice(0, -1); _calcDisplay = _calcExpr || '0'; }
  else if (val === '=') {
    try {
      const cleaned = _calcExpr.replace(/×/g, '*').replace(/÷/g, '/');
      if (/[^0-9+\-*/%.() ]/.test(cleaned)) throw new Error('Invalid characters');
      const r = _calcParse(cleaned);
      if (!isFinite(r)) throw new Error('Result not finite');
      _calcDisplay = String(parseFloat(r.toFixed(10)));
      _calcExpr = _calcDisplay;
    } catch { _calcDisplay = 'ERROR'; _calcExpr = ''; }
  } else { _calcExpr += val; _calcDisplay = _calcExpr; }
  const d = document.getElementById('calc-display'); if (d) d.textContent = _calcDisplay;
  const ex = document.getElementById('calc-expr'); if (ex) ex.textContent = _calcExpr !== _calcDisplay ? _calcExpr : '';
}
window.calcPress = calcPress;


function buildCalcPanel() {
  const panel = document.getElementById('panel-calc');
  if (!panel) return;
  const rows = [['C', '⌫', '(', '÷'], ['7', '8', '9', '×'], ['4', '5', '6', '-'], ['1', '2', '3', '+'], ['0', '.', '=']];
  const btns = rows.map(r => r.map(b => {
    let c = 'calc-btn';
    if (['+', '-', '×', '÷'].includes(b)) c += ' calc-btn-op';
    if (b === '=') c += ' calc-btn-eq';
    if (b === 'C') c += ' calc-btn-clear';
    return `<button class="${c}" onclick="calcPress(${JSON.stringify(b)})">${b}</button>`;
  }).join('')).join('');
  panel.querySelector('.panel-body').innerHTML = `<div class="calc-expr" id="calc-expr"></div><div class="calc-display" id="calc-display">0</div><div class="calc-grid">${btns}</div>`;
}
window.buildCalcPanel = buildCalcPanel;

// ─── Keyboard Shortcuts ────────────────────────────────────────

function openShortcuts() {
  let ov = document.getElementById('shortcuts-overlay');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'shortcuts-overlay';
    ov.onclick = e => { if (e.target === ov) closeShortcuts(); };
    const sk = (keys, desc) => `<div class="shortcut-row"><div class="shortcut-keys">${keys.map(k => `<span class="shortcut-key">${k}</span>`).join('+')}</div><span class="shortcut-desc">${desc}</span></div>`;
    ov.innerHTML = `<div id="shortcuts-box"><div class="shortcuts-hdr"><span class="shortcuts-title">⌨ KEYBOARD SHORTCUTS</span><button class="shortcuts-close" onclick="closeShortcuts()">✕</button></div>
      <div class="shortcuts-section-title">GENERAL</div><div class="shortcuts-grid">
        ${sk(['Ctrl', 'K'], 'Command Palette')}${sk(['Ctrl', 'F'], 'Search Chat')}${sk(['Ctrl', '?'], 'Keyboard Shortcuts')}${sk(['Ctrl', 'L'], 'Clear Chat')}
        ${sk(['Enter'], 'Send Message')}${sk(['Shift', 'Enter'], 'New Line')}</div>
      <div class="shortcuts-section-title">FEATURES</div><div class="shortcuts-grid">
        ${sk(['Ctrl', 'P'], 'Prompt Library')}${sk(['Ctrl', 'Shift', 'S'], 'Snippets')}${sk(['Ctrl', 'N'], 'Notes')}${sk(['Ctrl', 'T'], 'API Tester')}
        ${sk(['Ctrl', 'M'], 'Memory')}${sk(['Ctrl', 'H'], 'History')}</div>
    </div>`;
    document.body.appendChild(ov);
  }
  ov.removeAttribute('hidden');
}
window.openShortcuts = openShortcuts;

function closeShortcuts() { document.getElementById('shortcuts-overlay')?.setAttribute('hidden', ''); }
window.closeShortcuts = closeShortcuts;

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === '?') { e.preventDefault(); openShortcuts(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p' && !e.shiftKey) { e.preventDefault(); openPromptLibrary(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') { e.preventDefault(); openSnippetManager(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !e.shiftKey) { e.preventDefault(); openNotes(); }
  if (e.key === 'Escape') { closeShortcuts(); closeChatSearch(); }
});

// ─── Font Size ─────────────────────────────────────────────────

const FONT_SIZES = ['font-sm', 'font-md', 'font-lg', 'font-xl'];

function setFontSize(size) {
  FONT_SIZES.forEach(c => document.documentElement.classList.remove(c));
  if (size !== 'font-md') document.documentElement.classList.add(size);
  try {
    const s = JSON.parse(localStorage.getItem('jarvis-settings') || '{}');
    s.fontSize = size; localStorage.setItem('jarvis-settings', JSON.stringify(s));
  } catch {}
  document.querySelectorAll('.font-size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === size));
  if (typeof showToast === 'function') showToast(`Font: ${size.replace('font-', '').toUpperCase()}`, 'info');
}
window.setFontSize = setFontSize;

// Restore saved font size on load
(function() {
  try {
    const s = JSON.parse(localStorage.getItem('jarvis-settings') || '{}');
    if (s.fontSize && s.fontSize !== 'font-md') {
      FONT_SIZES.forEach(c => document.documentElement.classList.remove(c));
      document.documentElement.classList.add(s.fontSize);
    }
  } catch {}
})();

// ─── API Tester ────────────────────────────────────────────────

function openApiTester() { if (typeof openModal === 'function') openModal('api-modal'); }
window.openApiTester = openApiTester;

function switchApiTab(tab) {
  document.querySelectorAll('.api-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.api-tab-panel').forEach(el => el.classList.toggle('active', el.id === `api-tab-${tab}`));
}
window.switchApiTab = switchApiTab;

async function sendApiRequest() {
  const method = document.getElementById('api-method')?.value || 'GET';
  const url = document.getElementById('api-url-inp')?.value.trim();
  if (!url) { if (typeof showToast === 'function') showToast('Enter a URL', 'error'); return; }
  let headers = {};
  try { const h = document.getElementById('api-headers-inp')?.value.trim(); if (h) headers = JSON.parse(h); }
  catch { if (typeof showToast === 'function') showToast('Headers must be valid JSON', 'error'); return; }
  const body = document.getElementById('api-body-inp')?.value.trim();
  const btn = document.getElementById('api-send-btn'); if (btn) btn.disabled = true;
  const respEl = document.getElementById('api-response-body');
  const respHdr = document.getElementById('api-response-hdr');
  if (respEl) respEl.textContent = 'Sending…';
  if (respHdr) respHdr.innerHTML = '';
  try {
    const res = await window.jarvis.invoke('http-request', { method, url, headers, body });
    if (respHdr) {
      const cls = res.status >= 500 ? 'api-status-5xx' : res.status >= 400 ? 'api-status-4xx' : 'api-status-2xx';
      respHdr.innerHTML = `<span class="api-status-badge ${cls}">${res.status} ${res.statusText || ''}</span><span class="api-time">${res.time}ms</span>`;
    }
    if (respEl) { let b = res.body || ''; try { b = JSON.stringify(JSON.parse(b), null, 2); } catch {} respEl.textContent = b; }
  } catch (e) { if (respEl) respEl.textContent = `Error: ${e.message}`; }
  if (btn) btn.disabled = false;
}
window.sendApiRequest = sendApiRequest;

// ─── Image Analysis ────────────────────────────────────────────

let _imgB64 = null, _imgMime = null;

function openImageAnalysis() { if (typeof openModal === 'function') openModal('img-modal'); }
window.openImageAnalysis = openImageAnalysis;

async function pickImage() {
  try {
    const res = await window.jarvis.invoke('open-image-dialog');
    if (!res?.ok) return;
    await loadImg(res.filePath);
  } catch { if (typeof showToast === 'function') showToast('Could not open image dialog', 'error'); }
}
window.pickImage = pickImage;

async function loadImg(fp) {
  try {
    const res = await window.jarvis.invoke('fs-read-binary', fp);
    if (!res?.ok) { if (typeof showToast === 'function') showToast('Failed to read image', 'error'); return; }
    _imgB64 = res.data; _imgMime = res.mimeType;
    const prev = document.getElementById('img-preview');
    if (prev) prev.src = `data:${_imgMime};base64,${_imgB64}`;
    document.getElementById('img-drop-zone-inner')?.setAttribute('hidden', '');
    document.getElementById('img-preview-wrap')?.removeAttribute('hidden');
    document.getElementById('img-analyze-btn')?.removeAttribute('disabled');
  } catch { if (typeof showToast === 'function') showToast('Error loading image', 'error'); }
}
window.loadImg = loadImg;

function clearImg() {
  _imgB64 = null; _imgMime = null;
  const prev = document.getElementById('img-preview'); if (prev) prev.src = '';
  document.getElementById('img-drop-zone-inner')?.removeAttribute('hidden');
  document.getElementById('img-preview-wrap')?.setAttribute('hidden', '');
  document.getElementById('img-analyze-btn')?.setAttribute('disabled', '');
}
window.clearImg = clearImg;

// Export image state accessors for use by renderer.js analyzeImage
function getImgB64() { return _imgB64; }
function getImgMime() { return _imgMime; }
function clearImgState() { _imgB64 = null; _imgMime = null; }
function setImgState(b64, mime) { _imgB64 = b64; _imgMime = mime; }
window.getImgB64 = getImgB64;
window.getImgMime = getImgMime;
window.clearImgState = clearImgState;
window.setImgState = setImgState;

// Initialise calculator panel on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  buildCalcPanel();
}, { once: true });

console.log('[JARVIS] UI Features module loaded.');
// ─── Scheduler UI ────────────────────────────────────────────────
window.openSchedulerModal = function() {
  openModal('scheduler-modal');
  renderSchedulerJobs();
};

window.toggleSchedulerAddForm = function() {
  const form = document.getElementById('scheduler-add-form');
  form.hidden = !form.hidden;
};

window.renderSchedulerJobs = async function() {
  const list = document.getElementById('scheduler-list');
  if (!list) return;
  const res = await window.jarvis.schedulerList();
  if (!res.ok) {
    list.innerHTML = `<div style="color:red">Failed to load tasks.</div>`;
    return;
  }
  const jobs = res.jobs;
  if (jobs.length === 0) {
    list.innerHTML = `<div style="padding:10px; color:var(--text-dim); text-align:center;">No active background tasks.</div>`;
    return;
  }

  list.innerHTML = jobs.map(job => `
    <div style="background: rgba(0,0,0,0.4); border: 1px solid var(--hud-border); padding: 10px; margin-bottom: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="font-weight:bold; color:var(--text-bright);">${_uiEscHtml(job.name)}</div>
        <div style="font-size:11px; color:var(--text-dim);">
          Type: ${job.type} | Active: ${job.active ? 'YES' : 'NO'}<br>
          ${job.type === 'one-off' ? `Triggers: ${new Date(job.triggerTime).toLocaleString()}` : `Interval: ${job.intervalMs / 1000}s`}
        </div>
        <div style="font-size:10px; color:var(--accent-blue); margin-top:4px;">Payload: ${_uiEscHtml(job.payload.text || '')}</div>
      </div>
      <div>
        <button class="micro-btn" style="color:var(--accent-red); border-color:var(--accent-red);" onclick="deleteSchedulerJob('${job.id}')">✕ DELETE</button>
      </div>
    </div>
  `).join('');
};

window.addSchedulerJob = async function() {
  const name = document.getElementById('sched-name').value;
  const type = document.getElementById('sched-type').value;
  const text = document.getElementById('sched-payload').value;
  
  if (!text.trim()) { alert('Payload required!'); return; }
  
  const jobData = { name, type, payload: { text } };
  
  if (type === 'one-off') {
    const dt = document.getElementById('sched-datetime').value;
    if (!dt) { alert('Trigger date required!'); return; }
    jobData.triggerTime = new Date(dt).getTime();
  } else {
    const inv = parseInt(document.getElementById('sched-interval').value);
    if (!inv || inv < 1) { alert('Valid interval required!'); return; }
    jobData.intervalMs = inv * 1000;
  }
  
  const res = await window.jarvis.schedulerAdd(jobData);
  if (res.ok) {
    document.getElementById('sched-name').value = '';
    document.getElementById('sched-payload').value = '';
    document.getElementById('scheduler-add-form').hidden = true;
    renderSchedulerJobs();
  } else {
    alert('Failed to create task: ' + res.error);
  }
};

window.deleteSchedulerJob = async function(id) {
  const res = await window.jarvis.schedulerRemove(id);
  if (res.ok) {
    renderSchedulerJobs();
  } else {
    alert('Failed to delete task: ' + res.error);
  }
};

window.jarvis.onSchedulerTrigger((job) => {
  console.log('[SCHEDULER] Job triggered:', job);
  
  // Directly append the message to the UI
  if (typeof window.appendMessage === 'function') {
    window.appendMessage('JARVIS', `[Scheduled Task Triggered: ${job.name}]\nExecuting payload...`, true);
  }
  
  // Feed it back into the main execution loop
  if (typeof window.executeCommand === 'function') {
    window.executeCommand(job.payload.text);
  }
});
