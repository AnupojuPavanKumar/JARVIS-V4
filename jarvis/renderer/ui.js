import { state, MODES } from './state.js';

let toastTimer = null;
let toastHideTimer = null;
let streamThrottleTimer = null;
let pendingStreamText = null;
let pendingStreamEl = null;

export function escHtml(e) {
  return String(e).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatTime(e) {
  return (e ? new Date(e) : new Date()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function pad(e) {
  return String(e).padStart(2, "0");
}

export function scrollToBottom(force = false, animate = false) {
  if (state.autoScroll || force) {
    const chatArea = document.getElementById('chat-area');
    if (chatArea) chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: animate ? 'smooth' : 'auto' });
  }
}

export function autoResizeInput() {
  const $input = document.getElementById("user-input");
  if ($input) {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 150) + "px";
  }
}

export function showToast(e, t = "info") {
  const n = document.getElementById("toast");
  if (n) {
    n.textContent = e;
    n.className = `show ${t}`;
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    toastTimer = setTimeout(() => {
      n.classList.add("hide");
      toastHideTimer = setTimeout(() => { n.className = ""; }, 300);
    }, 3200);
  }
}

export function toggleHamburger() {
  const e = document.getElementById("btn-hamburger");
  const t = document.getElementById("hamburger-menu");
  if (t) {
    if (!t.hidden) { closeHamburger(); return; }
    t.hidden = false;
    if (e) e.classList.add("open");
    setTimeout(() => document.addEventListener("click", _hamOutsideClick, { once: true }), 10);
  }
}

export function closeHamburger() {
  const e = document.getElementById("btn-hamburger");
  const t = document.getElementById("hamburger-menu");
  const n = document.getElementById("git-confirm-panel");
  if (t) t.hidden = true;
  if (n) n.hidden = true;
  if (e) e.classList.remove("open");
}

function _hamOutsideClick(e) {
  const t = document.getElementById("hamburger-wrap");
  if (t && !t.contains(e.target)) closeHamburger();
}

export function appendUserMessage(e, t) {
  const $messages = document.getElementById("chat-messages");
  const n = document.createElement("div");
  n.className = "message user-message";
  n.innerHTML = `
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-sender">YOU</span><span class="msg-time">${formatTime(t)}</span></div>
      <div class="msg-bubble"><div class="msg-content">${escHtml(e)}</div></div>
    </div>
    <div class="msg-avatar">\u{1F464}</div>
  `;
  if ($messages) $messages.appendChild(n);
  scrollToBottom();
}

export function appendJarvisMessage(e, t) {
  const $messages = document.getElementById("chat-messages");
  const n = MODES[state.mode];
  const s = document.createElement("div");
  s.className = "message jarvis-message";
  s.innerHTML = `
    <div class="msg-avatar">${n.icon}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-sender">JARVIS</span>
        <span class="msg-mode-tag">${n.name}</span>
        <span class="msg-time">${formatTime(t)}</span>
      </div>
      <div class="msg-bubble"><div class="msg-content">${window.renderMarkdown ? window.renderMarkdown(e) : escHtml(e)}</div></div>
    </div>
  `;
  if (window.highlightBlock) {
    s.querySelectorAll("pre code").forEach(o => window.highlightBlock(o));
  }
  if ($messages) $messages.appendChild(s);
  scrollToBottom(false, true);
}

export function createStreamingMessage() {
  const $messages = document.getElementById("chat-messages");
  const e = MODES[state.mode];
  const t = document.createElement("div");
  t.className = "message jarvis-message streaming";
  t.innerHTML = `
    <div class="msg-avatar">${e.icon}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-sender">JARVIS</span>
        <span class="msg-mode-tag">${e.name}</span>
        <span class="msg-time">${formatTime()}</span>
      </div>
      <div class="msg-bubble">
        <div class="msg-content stream-text">
          <span class="thinking-dots"><span>\u25CF</span><span>\u25CF</span><span>\u25CF</span></span>
        </div>
      </div>
    </div>
  `;
  if ($messages) $messages.appendChild(t);
  scrollToBottom();
  return t;
}

export function parseThinkingTags(e) {
  let t = e.replace(/&lt;think&gt;/g, '<think>').replace(/&lt;\/think&gt;/g, '</think>');
  return t.includes("<think>") && !t.includes("</think>") 
    ? (t = t.replace("<think>", '<details class="think-box" open><summary>Thinking Process</summary><div class="think-content">'), t += "</div></details>") 
    : (t = t.replace(/<think>([\s\S]*?)<\/think>/g, (n, s) => `<details class="think-box"><summary>Thinking Process</summary><div class="think-content">${s}</div></details>`)), t;
}

export function updateStreamingEl(e, t) {
  pendingStreamEl = e;
  pendingStreamText = t;
  if (!streamThrottleTimer) {
    streamThrottleTimer = requestAnimationFrame(() => {
      if (pendingStreamEl) {
        const n = pendingStreamEl.querySelector(".msg-content");
        if (n) {
          n.innerHTML = `<span>${parseThinkingTags(escHtml(pendingStreamText))}</span><span class="stream-cursor"></span>`;
          scrollToBottom();
        }
      }
      streamThrottleTimer = null;
    });
  }
}

export function finalizeStreamingEl(e, t) {
  if (streamThrottleTimer) {
    cancelAnimationFrame(streamThrottleTimer);
    streamThrottleTimer = null;
  }
  e.classList.remove("streaming");
  const n = e.querySelector(".msg-content");
  if (n) {
    n.innerHTML = window.renderMarkdown ? window.renderMarkdown(parseThinkingTags(t)) : escHtml(parseThinkingTags(t));
    if (window.highlightBlock) {
      n.querySelectorAll("pre code").forEach(s => window.highlightBlock(s));
    }
    if (state.lastWebResults?.length) {
      const s = e.querySelector(".msg-body");
      if (s && window.renderSourceChips) {
        const o = window.renderSourceChips(state.lastWebResults);
        if (o) {
          const i = document.createElement("div");
          i.innerHTML = o;
          if (i.firstElementChild) s.appendChild(i.firstElementChild);
        }
      }
      state.lastWebResults = null;
    }
    scrollToBottom(true);
  }
}

// Make globally available to components that rely on window.*
window.showToast = showToast;
window.scrollToBottom = scrollToBottom;
window.escHtml = escHtml;
window.formatTime = formatTime;
window.appendUserMessage = appendUserMessage;
window.appendJarvisMessage = appendJarvisMessage;
