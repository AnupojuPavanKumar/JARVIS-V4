"use strict";

// ═══════════════════════════════════════════════════════════════════
// JARVIS Semantic Memory — TF-IDF Cosine Similarity Engine
// Pure JS, zero external deps, full localStorage + userData sync.
// Public API: jarvisMemory.getRelevantContext(query) → string
//             jarvisMemory.extractAndStore(text)      → Promise<void>
//             jarvisMemory.memories                   → [{text, timestamp}]
//             jarvisMemory.save()                     → void
// ═══════════════════════════════════════════════════════════════════
const jarvisMemory = (function () {
  // ── Constants ────────────────────────────────────────────────────
  const LS_KEY     = 'jarvis_memory';
  const MAX_FACTS  = 200;   // hard cap — oldest evicted first
  const TOP_K      = 4;     // memories returned per query
  const MIN_SCORE  = 0.12;  // cosine similarity threshold

  // ── Common English stop-words to exclude from TF-IDF ────────────
  const STOPS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','is',
    'are','was','were','be','been','being','have','has','had','do','does',
    'did','will','would','could','should','may','might','shall','can',
    'this','that','these','those','with','from','by','as','not','it',
    'its','my','i','you','he','she','we','they','me','him','her','us',
    'them','what','which','who','how','when','where','why','there','then',
    'so','if','out','up','about','into','than','more','just','also',
  ]);

  // ── Tokenise: lowercase, strip punctuation, remove stop-words ───
  function tokenize(str) {
    return (str || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPS.has(w));
  }

  // ── TF: term frequency map for a token list ──────────────────────
  function tf(tokens) {
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    const total = tokens.length || 1;
    const map = {};
    for (const [t, f] of Object.entries(freq)) map[t] = f / total;
    return map;
  }

  // ── Cosine similarity between two TF maps (IDF done inline) ─────
  function cosine(qMap, dMap, idf) {
    let dot = 0, qNorm = 0, dNorm = 0;
    for (const [t, qv] of Object.entries(qMap)) {
      const w = idf[t] || 1;
      const dv = dMap[t] || 0;
      dot   += qv * dv * w * w;
      qNorm += (qv * w) ** 2;
    }
    for (const [t, dv] of Object.entries(dMap)) {
      const w = idf[t] || 1;
      dNorm += (dv * w) ** 2;
    }
    if (!qNorm || !dNorm) return 0;
    return dot / (Math.sqrt(qNorm) * Math.sqrt(dNorm));
  }

  // ── State ────────────────────────────────────────────────────────
  const store = { memories: [] };

  // ── Load from localStorage on boot ──────────────────────────────
  try { store.memories = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch {}

  // ── Cache: pre-tokenised TF maps (rebuilt on write) ─────────────
  let _tfCache = [];
  let _idf     = {};

  function rebuildIndex() {
    _tfCache = store.memories.map(m => tf(tokenize(m.text)));

    // IDF: log(N / df) for each term across all memories
    const N = _tfCache.length || 1;
    const df = {};
    for (const tfMap of _tfCache) {
      for (const term of Object.keys(tfMap)) df[term] = (df[term] || 0) + 1;
    }
    _idf = {};
    for (const [term, count] of Object.entries(df)) {
      _idf[term] = Math.log((N + 1) / (count + 1)) + 1; // smoothed IDF
    }
  }

  rebuildIndex();

  // ── Public: save to localStorage ─────────────────────────────────
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(store.memories)); } catch {}
  }

  // ── Public: bulk-load from userData/memory.json (IPC bridge) ────
  function loadFromIPC(facts) {
    if (!Array.isArray(facts)) return;
    // Merge: prefer IPC facts (persisted), skip duplicates by text
    const existing = new Set(store.memories.map(m => m.text.trim().toLowerCase()));
    for (const f of facts) {
      const key = (f.text || '').trim().toLowerCase();
      if (key && !existing.has(key)) {
        store.memories.push({ text: f.text.trim(), timestamp: f.timestamp || Date.now() });
        existing.add(key);
      }
    }
    // Enforce cap
    if (store.memories.length > MAX_FACTS) {
      store.memories = store.memories.slice(-MAX_FACTS);
    }
    rebuildIndex();
    save();
  }

  // ── Public: getRelevantContext — TF-IDF cosine retrieval ─────────
  function getRelevantContext(query) {
    if (!query || !store.memories.length) return '';
    const qTokens = tokenize(query);
    if (!qTokens.length) return '';
    const qMap = tf(qTokens);
    const scored = store.memories.map((m, i) => ({
      text:  m.text,
      score: cosine(qMap, _tfCache[i] || {}, _idf),
    }));
    const top = scored
      .filter(s => s.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    if (!top.length) return '';
    return `[RELEVANT MEMORY]\n${top.map(s => `- ${s.text}`).join('\n')}\n[END MEMORY]`;
  }

  // ── Public: extractAndStore — enriched trigger phrases ───────────
  const MEMORY_TRIGGERS = [
    'my name is', "i'm called", 'call me',
    'i like', 'i love', 'i hate', 'i prefer', 'i dislike',
    'my favorite', 'my favourite', 'my goal', 'my job',
    'i work at', 'i work for', 'i work on', 'i am a', "i'm a",
    'i am an', "i'm an", 'i use', 'i always', 'i usually',
    'remember that', 'remember this', 'note that',
    'my birthday', 'my age', 'i live in', 'i am from',
  ];

  async function extractAndStore(text) {
    const lower = text.toLowerCase();
    const triggered = MEMORY_TRIGGERS.some(t => lower.includes(t));
    if (!triggered) return;

    const cleaned = text.replace(/remember that|remember this|note that/ig, '').trim();
    if (!cleaned || cleaned.length < 5) return;

    // Dedup: skip if very similar text already stored
    const qTokens = tokenize(cleaned);
    const qMap = tf(qTokens);
    const isDupe = store.memories.some((_, i) => cosine(qMap, _tfCache[i] || {}, _idf) > 0.85);
    if (isDupe) return;

    store.memories.push({ text: cleaned, timestamp: Date.now() });

    // Enforce cap
    if (store.memories.length > MAX_FACTS) store.memories = store.memories.slice(-MAX_FACTS);

    rebuildIndex();
    save();

    // Persist to userData/memory.json via IPC (fire-and-forget)
    try {
      if (window.jarvis && window.jarvis.memorySave) {
        await window.jarvis.memorySave(store.memories);
      }
    } catch {}
  }

  // ── Bootstrap: pull persisted facts from userData on startup ─────
  (async function bootstrap() {
    try {
      if (window.jarvis && window.jarvis.memoryLoad) {
        const res = await window.jarvis.memoryLoad();
        if (res && res.ok && Array.isArray(res.facts)) loadFromIPC(res.facts);
      }
    } catch {}
  })();

  return {
    get memories() { return store.memories; },
    save,
    loadFromIPC,
    getRelevantContext,
    extractAndStore,
  };
})();

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
})(); const MODES = {
  general: {
    id: "general", name: "GENERAL", icon: "\u2B21", color: "#00d4ff", desc: "Elite AI Assistant", prompt: `You are JARVIS (Just A Rather Very Intelligent System) \u2014 an elite AI assistant with unmatched intelligence, precision, and subtle wit.

Personality:
- Strategic thinking and proactive problem-solving \u2014 anticipate the next question
- Concise, expert-level responses without unnecessary padding or filler
- Subtle, dry British wit \u2014 never forced, never over-explained
- High-quality markdown formatting: headers, code blocks, tables, bullet points where appropriate
- Address the user formally but with warmth
- Never start a response with "I" as the first word
- Proactively surface related information the user may not have thought to ask
- Lead with the insight, not the preamble

You are running locally via Ollama on the user's machine. You have full capabilities across all domains.`}, code: {
    id: "code", name: "CODE", icon: "\u27E8/\u27E9", color: "#00ff88", desc: "Code Architect", prompt: `You are JARVIS in Code Mode \u2014 the world's finest code architect and software engineer.

Specialization: Writing, reviewing, and architecting production-quality code across all languages and paradigms.

Approach:
- Write clean, idiomatic, efficient code with proper error handling
- Always include complete, runnable code \u2014 never truncate
- Use language-appropriate best practices and idioms
- Explain the *why* behind architectural decisions
- Proactively suggest improvements beyond what was asked
- Consider performance, security, maintainability, and testability
- Include brief comments for non-obvious logic

Format: Use fenced code blocks with language identifiers. Provide concise explanation before and/or after the code.`}, debug: {
    id: "debug", name: "DEBUG", icon: "\u26A0", color: "#ff7b35", desc: "Systems Diagnostician", prompt: `You are JARVIS in Debug Mode \u2014 a forensic systems diagnostician with expert-level debugging skills.

Specialization: Identifying, isolating, and eliminating bugs with surgical precision across all languages and environments.

Approach:
- Analyze symptoms systematically, identify root causes \u2014 not just symptoms
- Explain WHY the bug occurs mechanically, not just what to fix
- Provide the exact fix with clear before/after
- Add preventive measures to avoid similar issues
- Check for related bugs or code smells proactively
- Consider race conditions, edge cases, memory leaks, type coercion, async issues

Format:
1. **Root Cause** \u2014 what's actually wrong
2. **Fix** \u2014 exact corrected code
3. **Why it works** \u2014 brief mechanism explanation
4. **Prevention** \u2014 how to avoid this class of bug`}, research: {
    id: "research", name: "RESEARCH", icon: "\u25CE", color: "#b86bff", desc: "Intelligence Analyst", prompt: `You are JARVIS in Research Mode \u2014 a comprehensive intelligence analyst and expert researcher.

Specialization: Deep research, synthesis, and analysis across all domains including technology, science, business, history, and culture.

Approach:
- Provide thorough, well-organized information with clear structure
- Distinguish clearly between established facts, expert consensus, and speculation
- Synthesize complex information into actionable insights
- Present multiple perspectives where relevant and genuinely contested
- Surface related information the user may not have thought to ask
- Use concrete examples, analogies, and data points

Format: Use headers, bullet points, tables, and summaries for maximum clarity. Include a "Key Takeaways" or "Bottom Line" section when appropriate.`}, automation: {
    id: "automation", name: "AUTOMATE", icon: "\u2699", color: "#ffd60a", desc: "Systems Automator", prompt: `You are JARVIS in Automation Mode \u2014 master of scripting, workflow automation, and system orchestration.

Specialization: Building scripts, pipelines, automations, and workflows that eliminate repetitive tasks permanently.

Approach:
- Write robust, production-ready automation scripts with error handling
- Include logging, idempotency checks, and edge case handling
- Default to PowerShell for Windows, Bash/Python for cross-platform
- Explain usage, required permissions, and any dependencies
- Suggest related automations the user hasn't thought of
- Prefer simple, maintainable solutions over clever complexity

Tools: PowerShell, Python, Bash, Windows Task Scheduler, Python subprocess, file system, web scraping, API automation, regex.`}, business: {
    id: "business", name: "BUSINESS", icon: "\u25B2", color: "#f59e0b", desc: "Strategic Advisor", prompt: `You are JARVIS in Business Mode \u2014 a world-class strategic advisor, analyst, and executive decision-making partner.

Specialization: Business strategy, growth, operations, marketing, finance, product, and leadership.

Approach:
- Think at the systems level \u2014 interconnected strategy, not isolated tactics
- Provide frameworks alongside concrete, actionable recommendations
- Quantify impact and prioritize by ROI-to-effort ratio
- Identify second-order effects and risks proactively
- Be direct and opinionated \u2014 offer decisions, not just options
- Reference relevant business models, frameworks, and precedents concisely

Format: Executive summary first, then structured analysis. Use prioritized action plans with clear next steps.`}, creative: {
    id: "creative", name: "CREATIVE", icon: "\u2726", color: "#ff5fa0", desc: "Creative Director", prompt: `You are JARVIS in Creative Mode \u2014 a master creative director, writer, and ideation engine.

Specialization: Creative writing, ideation, content creation, copywriting, narrative design, and artistic direction.

Approach:
- Balance raw creativity with strategic purpose \u2014 beauty AND function
- Generate multiple distinct concepts, not just variations of one idea
- Think in narratives, metaphors, and emotional resonance
- Adapt tone, voice, and style to the specific context and audience
- Provide concrete execution paths alongside the creative vision
- Surprise the user with unexpected angles while delivering what they actually need

Format: Lead with the creative work itself, then explain the thinking. Show don't tell.`}, productivity: {
    id: "productivity", name: "OPTIMIZE", icon: "\u26A1", color: "#06b6d4", desc: "Efficiency Engine", prompt: `You are JARVIS in Productivity Mode \u2014 an elite systems designer for human performance, workflow optimization, and leverage.

Specialization: Task management, workflow design, time and energy optimization, personal operating systems, and focus systems.

Approach:
- Diagnose inefficiencies before prescribing solutions
- Apply proven frameworks (GTD, Time Blocking, Zettelkasten, Deep Work, Eisenhower Matrix) contextually
- Be specific and actionable \u2014 provide templates, checklists, and exact processes
- Think about energy management and cognitive load, not just time management
- Automate and eliminate before optimizing
- Design for sustainable systems, not heroic sprints

Format: Action plans, templates, and concrete next steps. Prioritize ruthlessly.`}
}, state = { mode: "general", model: "llama3.2", endpoint: "http://127.0.0.1:11434", temperature: .7, contextWindow: 20, ttsEnabled: !0, speechRate: 1, speechPitch: 1, isStreaming: !1, isRecording: !1, ollamaOnline: !1, conversations: {}, currentSession: null, terminalHistory: [], termHistoryIdx: -1, autoScroll: !0, synth: window.speechSynthesis || null, recognition: null, waveformAnim: null, waveformActive: !1, dashCleanup: [], userDataPath: "", theme: "ironman", isFocused: !0 }; window.addEventListener("blur", () => { state.isFocused = !1, document.body.classList.add("paused-animations") }), window.addEventListener("focus", () => { state.isFocused = !0, document.body.classList.remove("paused-animations") }); let hudInterval = null, $messages, $dashboard, $input, $sendBtn, $voiceBtn, $ttsBtn, $hudTime, $hudDate, $activeModeIcon, $activeModeName, $ollamaBadge, $ollamaLabel, $ollamaDot, $activeModelLabel, $waveformCanvas, $waveformLabel, $pOllama, $pModel, $pPlatform, $pCpu, $pMem, $pSessions, $termOutput, $termInput; document.addEventListener("DOMContentLoaded", async () => { cacheDom(), loadSettings(), buildSidebar(), setupEventListeners(), startHUDClock(), initWaveform(), setMode(state.mode), setupVoice(); const [e] = await Promise.all([window.jarvis.getSystemInfo(), checkOllama(), updateSessionCount()]); state.systemSpecs = e, updateSystemPanel(e); try { const t = await window.jarvis.getUserDataPath(); state.userDataPath = t || "" } catch { state.userDataPath = "" } window.jarvis.onOllamaOnline && window.jarvis.onOllamaOnline(() => { checkOllama(), showToast("Ollama online  ready, sir.", "success") }) }); function cacheDom() { $messages = document.getElementById("chat-messages"), $dashboard = document.getElementById("dashboard-area"), $input = document.getElementById("user-input"), $sendBtn = document.getElementById("send-btn"), $voiceBtn = document.getElementById("voice-btn"), $ttsBtn = document.getElementById("tts-btn"), $hudTime = document.getElementById("hud-time"), $hudDate = document.getElementById("hud-date-str"), $activeModeIcon = document.getElementById("active-mode-icon"), $activeModeName = document.getElementById("active-mode-name"), $ollamaBadge = document.getElementById("ollama-status-badge"), $ollamaLabel = document.getElementById("ollama-label"), $ollamaDot = document.getElementById("ollama-dot"), $activeModelLabel = document.getElementById("active-model-label"), $waveformCanvas = document.getElementById("waveform-canvas"), $waveformLabel = document.getElementById("waveform-label"), $pOllama = document.getElementById("p-ollama"), $pModel = document.getElementById("p-model"), $pPlatform = document.getElementById("p-platform"), $pCpu = document.getElementById("p-cpu"), $pMem = document.getElementById("p-mem"), $pSessions = document.getElementById("p-sessions"), $termOutput = document.getElementById("terminal-output"), $termInput = document.getElementById("terminal-input") } function buildSidebar() {
  const e = document.getElementById("sidebar-modes"); Object.values(MODES).forEach(t => {
    const n = document.createElement("button"); n.className = "mode-btn", n.id = `mode-btn-${t.id}`, n.title = t.desc, n.setAttribute("aria-label", `Switch to ${t.name} mode`), n.innerHTML = `
      <span class="mode-btn-icon">${t.icon}</span>
      <span class="mode-btn-label">${t.name}</span>
    `, n.onclick = () => setMode(t.id), e.appendChild(n)
  })
} function setMode(e) { state.dashCleanup.forEach(a => { try { a() } catch { } }), state.dashCleanup = []; const t = state.mode; state.mode = e; const n = MODES[e]; document.querySelectorAll(".mode-btn").forEach(a => a.classList.remove("active")); const s = document.getElementById(`mode-btn-${e}`); s && s.classList.add("active"), $activeModeIcon.textContent = n.icon, $activeModeName.textContent = n.name; const o = document.getElementById("chat-mode-icon"); o && (o.textContent = n.icon); const i = document.getElementById("mode-badge"); i && (i.style.color = n.color, i.style.borderColor = `${n.color}55`, i.style.background = `${n.color}18`), state.conversations[e] || (state.conversations[e] = newConversation(e)), showModeDashboard(e), renderConversation(e) } function newConversation(e) { return { id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, mode: e, title: null, messages: [], createdAt: new Date().toISOString() } } function renderConversation(e) { clearMessages(); const t = state.conversations[e]; !t || t.messages.length === 0 || (t.messages.forEach(n => { n.role === "user" ? appendUserMessage(n.content, n.timestamp) : n.role === "assistant" && appendJarvisMessage(n.content, n.timestamp) }), scrollToBottom(!0)) } function clearMessages() { $messages.innerHTML = "", state.autoScroll = !0 } async function saveSession() { const e = state.conversations[state.mode]; if (!(!e || e.messages.length === 0)) { if (!e.title) { const t = e.messages.find(n => n.role === "user"); e.title = t ? t.content.slice(0, 60) : "Untitled" } await window.jarvis.saveHistory(e.id, e), await updateSessionCount() } } async function updateSessionCount() { const e = await window.jarvis.listHistory(); e.ok && $pSessions && ($pSessions.textContent = e.data.length) } async function checkOllama() { setOllamaStatus("checking"); try { return (await fetch(`${state.endpoint}/api/tags`, { signal: AbortSignal.timeout(4e3) })).ok ? (setOllamaStatus("online"), !0) : (setOllamaStatus("offline"), !1) } catch { return setOllamaStatus("offline"), !1 } } function setOllamaStatus(e) { state.ollamaOnline = e === "online", $ollamaBadge && ($ollamaBadge.className = `status-badge ${e}`), $ollamaLabel && ($ollamaLabel.textContent = e.toUpperCase()), $pOllama && ($pOllama.textContent = e.toUpperCase(), $pOllama.className = `stat-val ${e === "online" ? "online" : "offline"}`) } let _streamController = null; function cancelStream() { _streamController && (_streamController.abort(), _streamController = null), state.isStreaming = !1, $sendBtn && ($sendBtn.disabled = !1), setWaveformActive(!1); const e = document.getElementById("stream-cancel-btn"); e && (e.style.display = "none") } window.cancelStream = cancelStream; async function streamOllama(e, { onChunk: t, onDone: n, onError: s }) {
  _streamController = new AbortController; const o = setTimeout(() => { _streamController && _streamController.abort() }, 9e4); try {
    const i = await fetch(`${state.endpoint}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: state.model, messages: [{ role: "system", content: jarvisMemory.getRelevantContext(e[e.length - 1]?.content || "") }, ...e], stream: !0, options: { temperature: .3, top_p: .85, num_predict: 256, num_ctx: 4096, num_gpu: 99, num_thread: 8 } }), signal: _streamController.signal }); if (clearTimeout(o), !i.ok) throw new Error(`Ollama ${i.status}: ${await i.text()}`); const a = i.body.getReader(), c = new TextDecoder; let r = "", l = ""; for (; ;) {
      const { done: p, value: g } = await a.read(); if (p) break; l += c.decode(g, { stream: !0 }); const d = l.split(`
`); l = d.pop(); for (const u of d) if (u.trim()) try { const m = JSON.parse(u); if (m.message?.content && (r += m.message.content, t(m.message.content, r)), m.done) { n(r); return } } catch { }
    } n(r)
  } catch (i) { clearTimeout(o), s(i) }
} const _BUDGET_SYSTEM = 24e3, _BUDGET_WEB = 3e3, _BUDGET_PROJ_TOT = 8e3, _CONV_MAX = 100, _CONV_PRUNE = 20; function pruneConversationIfNeeded(e) { if (!e?.messages || e.messages.length <= _CONV_MAX) return; const t = e.messages.splice(0, _CONV_PRUNE); console.log(`[JARVIS] Pruned ${t.length} old messages (history was ${t.length + e.messages.length}).`) } function buildMessages() {
  const e = state.conversations[state.mode]; pruneConversationIfNeeded(e); let t = MODES[state.mode].prompt; if (state.systemSpecs && (t += `[HOST HARDWARE SPECIFICATIONS \u2014 use these exact specs if the user asks about the host system performance, CPU, GPU, memory, or hardware details]
CPU: ${state.systemSpecs.cpuModel || "Unknown CPU"} (${state.systemSpecs.cpuCount || "Unknown"} cores)
GPU: NVIDIA GeForce RTX 4050 Laptop GPU (6GB VRAM, dedicated, CUDA acceleration active)
RAM: ${(state.systemSpecs.totalMem / (1024 * 1024 * 1024)).toFixed(1)} GB Total
Platform: ${state.systemSpecs.platform || "Unknown OS"} (${state.systemSpecs.arch || "Unknown"})
[END HARDWARE SPECIFICATIONS]`), state.memory && state.memory.length && (t += `[USER MEMORY \u2014 always remember these facts about the user]
${state.memory.map(s => `\u2022 ${s}`).join(`
`)}
[END MEMORY]`), state.projectContext?.files?.length) {
    const { name: s, rootPath: o, files: i } = state.projectContext, a = i.map(l => `  ${l.relativePath}`).join(`
`); let c = _BUDGET_PROJ_TOT; const r = i.filter(l => l.content && c > 0).map(l => {
      const p = l.content.slice(0, Math.min(6e3, c)); return c -= p.length, `### ${l.relativePath}
\`\`\`
${p}
\`\`\``}).join(""); t += `[PROJECT CONTEXT: ${s}]
Root: ${o}File tree:
${a}${r}
[END PROJECT CONTEXT]`} state.webSearchContext && (t += state.webSearchContext.slice(0, _BUDGET_WEB), state.webSearchContext = null), t += `[DIRECTIVE]
Think step-by-step before answering. Prioritize logic, absolute accuracy, and concise code formatting. Do not hallucinate. Respond with maximum brevity. Keep answers to 1-2 short sentences unless the user explicitly asks for details. DO NOT use markdown lists or bullet points unless explicitly requested. Optimize for quick voice output.`, window.ToolExecutor && window.Skills && window.Skills._loaded && window.Skills._manifest.length && (t += `
`+ window.ToolExecutor.buildToolManifestPrompt(window.Skills._manifest)), t.length > _BUDGET_SYSTEM && (t = t.slice(0, _BUDGET_SYSTEM) + `
[... context truncated ...]`); const n = [{ role: "system", content: t }]; if (e?.messages?.length) { const s = state.contextWindow > 0 ? Math.max(0, e.messages.length - state.contextWindow) : 0; e.messages.slice(s).forEach(o => n.push({ role: o.role, content: o.content })) } return n
} function stripToolCalls(text) {
  if (!text) return "";
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").replace(/```json\s*\{\s*"tool"[\s\S]*?```/g, "").trim();
} async function sendMessage(e) {
  const t = (e !== void 0 ? String(e) : $input.value).trim(); if (!t || state.isStreaming) return; if (!state.ollamaOnline && !await checkOllama()) { showToast("Ollama is offline. Start Ollama and try again.", "error"); return } const n = new Date().toISOString(); state.conversations[state.mode].messages.push({ role: "user", content: t, timestamp: n }), appendUserMessage(t, n), e !== void 0 || ($input.value = "", autoResizeInput()), state.isStreaming = !0, $sendBtn.disabled = !0, setWaveformActive(!0); const s = document.getElementById("stream-cancel-btn"); s && (s.style.display = "inline-flex"); const o = createStreamingMessage(); state.ttsEnabled && state.synth && state.synth.cancel(); let i = 0; await streamOllama(buildMessages(), {
    onChunk: (c, r) => { const sanitizedR = stripToolCalls(r); if (updateStreamingEl(o, sanitizedR), state.ttsEnabled) { const p = sanitizedR.substring(i).match(/^(.*?[.,!?\n]+)(?:\s|$)/s); if (p) { const g = p[1]; i += g.length; let d = g.replace(/https?:\/\/[^\s]+/gi, "").replace(/```[\s\S]*?(```|$)/g, " code block ").replace(/`[^`]+`/g, "").replace(/[*_~#]/g, "").replace(/[:;]/g, ",").trim(); d && speakText(d, !1) } } }, onDone: async c => { if (window.ToolExecutor) { const l = await window.ToolExecutor.handleResponse(c); if (l.handled) { const sanitizedC = stripToolCalls(c); finalizeStreamingEl(o, sanitizedC); const p = new Date().toISOString(); state.conversations[state.mode].messages.push({ role: "assistant", content: sanitizedC, timestamp: p }), state.conversations[state.mode].messages.push({ role: "user", content: l.resultText, timestamp: p }); const g = createStreamingMessage(); let d = 0; await streamOllama(buildMessages(), { onChunk: (u, m) => { const sanitizedM = stripToolCalls(m); if (updateStreamingEl(g, sanitizedM), state.ttsEnabled) { const h = sanitizedM.substring(d).match(/^(.*?[.,!?\n]+)(?:\s|$)/s); if (h) { d += h[1].length; let w = h[1].replace(/https?:\/\/[^\s]+/gi, "").replace(/```[\s\S]*?(```|$)/g, " code block ").replace(/`[^`]+`/g, "").replace(/[*_~#]/g, "").replace(/[:;]/g, ",").trim(); w && speakText(w, !1) } } }, onDone: u => { const sanitizedU = stripToolCalls(u); finalizeStreamingEl(g, sanitizedU); const m = new Date().toISOString(); if (state.conversations[state.mode].messages.push({ role: "assistant", content: sanitizedU, timestamp: m }), saveSession(), state.ttsEnabled) { const v = sanitizedU.substring(d); if (v.trim()) { let h = v.replace(/https?:\/\/[^\s]+/gi, "").replace(/```[\s\S]*?(```|$)/g, " code block ").replace(/`[^`]+`/g, "").replace(/[*_~#]/g, "").replace(/[:;]/g, ",").trim(); h && speakText(h, !1) } } setWaveformActive(!1), state.isStreaming = !1, $sendBtn.disabled = !1 }, onError: u => { finalizeStreamingEl(g, `\u26A0 **Tool error** \`${u.message}\``), setWaveformActive(!1), state.isStreaming = !1, $sendBtn.disabled = !1 } }); return } } const sanitizedFinalC = stripToolCalls(c); finalizeStreamingEl(o, sanitizedFinalC); const r = new Date().toISOString(); if (state.conversations[state.mode].messages.push({ role: "assistant", content: sanitizedFinalC, timestamp: r }), saveSession(), state.ttsEnabled) { const l = sanitizedFinalC.substring(i); if (l.trim()) { let p = l.replace(/https?:\/\/[^\s]+/gi, "").replace(/```[\s\S]*?(```|$)/g, " code block ").replace(/`[^`]+`/g, "").replace(/[*_~#]/g, "").replace(/[:;]/g, ",").trim(); p && speakText(p, !1) } } setWaveformActive(!1), state.isStreaming = !1, $sendBtn.disabled = !1 }, onError: c => {
      finalizeStreamingEl(o, `\u26A0 **System Error**\`\`\`
${c.message}
\`\`\`Verify Ollama is running: \`ollama serve\``), setWaveformActive(!1), state.isStreaming = !1, $sendBtn.disabled = !1, showToast("Connection error \u2014 check Ollama status.", "error")
    }
  }); const a = document.getElementById("stream-cancel-btn"); a && (a.style.display = "none")
} async function triggerLLMGreeting() {
  if (!state.ollamaOnline && !await checkOllama()) return; const e = new Date, t = e.getHours(), n = t < 12 ? "morning" : t < 17 ? "afternoon" : t < 21 ? "evening" : "night", s = e.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }), o = e.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), i = state.systemSpecs ? `(${state.systemSpecs.cpuCount}-core CPU, ${(state.systemSpecs.totalMem / 1073741824).toFixed(0)}GB RAM)` : "", _userName = (typeof localStorage !== 'undefined' && localStorage.getItem('jarvis_user_name')) || 'sir', a = `You are JARVIS, an AI assistant. Generate a brief intelligent greeting for ${_userName} on his system.
Date: ${s}. Time: ${o} (good ${n}). System: ${i}.
Rules: 1-2 sentences only. No markdown. No exclamation marks. Say "sir" once.
Include one specific insightful detail: something about the time of day, day of week, or a subtle relevant observation.
Do NOT say "How can I help", "I am ready", or anything generic. Make it feel alive and contextual.`, c = createStreamingMessage(); await streamOllama([{ role: "user", content: a }], { onChunk: (r, l) => updateStreamingEl(c, l), onDone: r => { if (finalizeStreamingEl(c, r), state.conversations[state.mode].messages.push({ role: "assistant", content: r, timestamp: new Date().toISOString() }), state.ttsEnabled) { const l = extractPlainText(r); l && speakText(l, !0) } }, onError: () => { try { c.remove() } catch { } } })
} function dashSend(e) { (window.sendMessageWithSearch || sendMessage)(e) } window.dashSend = dashSend; function injectPrompt(e) { $input.value = e, autoResizeInput(), $input.focus() } window.injectPrompt = injectPrompt; function appendUserMessage(e, t) {
  const n = document.createElement("div"); n.className = "message user-message", n.innerHTML = `
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-sender">YOU</span><span class="msg-time">${formatTime(t)}</span></div>
      <div class="msg-bubble"><div class="msg-content">${escHtml(e)}</div></div>
    </div>
    <div class="msg-avatar">\u{1F464}</div>
  `, $messages.appendChild(n), scrollToBottom()
} function appendJarvisMessage(e, t) {
  const n = MODES[state.mode], s = document.createElement("div"); s.className = "message jarvis-message", s.innerHTML = `
    <div class="msg-avatar">${n.icon}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-sender">JARVIS</span>
        <span class="msg-mode-tag">${n.name}</span>
        <span class="msg-time">${formatTime(t)}</span>
      </div>
      <div class="msg-bubble"><div class="msg-content">${renderMarkdown(e)}</div></div>
    </div>
  `, s.querySelectorAll("pre code").forEach(o => highlightBlock(o)), $messages.appendChild(s), scrollToBottom(false, true)
} function createStreamingMessage() {
  const e = MODES[state.mode], t = document.createElement("div"); return t.className = "message jarvis-message streaming", t.innerHTML = `
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
  `, $messages.appendChild(t), scrollToBottom(), t
} let streamThrottleTimer = null, pendingStreamText = null, pendingStreamEl = null; function parseThinkingTags(e) { let t = e.replace(/&lt;think&gt;/g, '<think>').replace(/&lt;\/think&gt;/g, '</think>'); return t.includes("<think>") && !t.includes("</think>") ? (t = t.replace("<think>", '<details class="think-box" open><summary>Thinking Process</summary><div class="think-content">'), t += "</div></details>") : t = t.replace(/<think>([\s\S]*?)<\/think>/g, (n, s) => `<details class="think-box"><summary>Thinking Process</summary><div class="think-content">${s}</div></details>`), t } function updateStreamingEl(e, t) { pendingStreamEl = e, pendingStreamText = t, streamThrottleTimer || (streamThrottleTimer = requestAnimationFrame(() => { if (pendingStreamEl) { const n = pendingStreamEl.querySelector(".msg-content"); n && (n.innerHTML = `<span>${parseThinkingTags(escHtml(pendingStreamText))}</span><span class="stream-cursor"></span>`, scrollToBottom()) } streamThrottleTimer = null })) } function finalizeStreamingEl(e, t) { streamThrottleTimer && (cancelAnimationFrame(streamThrottleTimer), streamThrottleTimer = null), e.classList.remove("streaming"); const n = e.querySelector(".msg-content"); if (n) { if (n.innerHTML = renderMarkdown(parseThinkingTags(t)), n.querySelectorAll("pre code").forEach(s => highlightBlock(s)), state.lastWebResults?.length) { const s = e.querySelector(".msg-body"); if (s) { const o = renderSourceChips?.(state.lastWebResults); if (o) { const i = document.createElement("div"); i.innerHTML = o, i.firstElementChild && s.appendChild(i.firstElementChild) } } state.lastWebResults = null } scrollToBottom(!0) } } if (typeof marked < "u") {
  const e = new marked.Renderer; e.code = (t, n) => {
    const s = n || "plaintext"; let o = ""; try { typeof hljs < "u" && hljs.getLanguage(s) ? o = hljs.highlight(t, { language: s }).value : typeof hljs < "u" ? o = hljs.highlightAuto(t).value : o = escHtml(t) } catch { o = escHtml(t) } return `<div class="code-block">
      <div class="code-header">
        <span class="code-lang">${escHtml(s.toUpperCase())}</span>
        <button class="code-copy-btn" onclick="copyCode(this, ${JSON.stringify(t)})">COPY</button>
      </div>
      <pre><code class="hljs language-${escHtml(s)}">${o}</code></pre>
    </div>`}, marked.use({ renderer: e, breaks: !0, gfm: !0 })
} function renderMarkdown(e) { if (!e) return ""; try { return typeof marked < "u" ? marked.parse(e) : `<p>${escHtml(e)}</p>` } catch { return `<p>${escHtml(e)}</p>` } } function highlightBlock(e) { if (typeof hljs < "u" && !e.classList.contains("hljs")) try { hljs.highlightElement(e) } catch { } } function copyCode(e, t) { navigator.clipboard.writeText(t).then(() => { e.textContent = "COPIED!", e.classList.add("copied"), setTimeout(() => { e.textContent = "COPY", e.classList.remove("copied") }, 2e3) }).catch(() => showToast("Failed to copy.", "error")) } window.copyCode = copyCode; function setupVoice() { const e = window.SpeechRecognition || window.webkitSpeechRecognition; if (!e) { $voiceBtn && ($voiceBtn.title = "Voice not supported", $voiceBtn.style.opacity = "0.4"); return } state.recognition = new e, state.recognition.continuous = !1, state.recognition.interimResults = !0, state.recognition.lang = "en-US", state.recognition.onresult = t => { let n = "", s = ""; for (const o of t.results) o.isFinal ? s += o[0].transcript : n += o[0].transcript; $input.value = s || n, autoResizeInput() }, state.recognition.onend = () => { state.isRecording = !1, $voiceBtn.classList.remove("recording"), $input.value.trim() && sendMessage() }, state.recognition.onerror = t => { state.isRecording = !1, $voiceBtn.classList.remove("recording"), t.error !== "no-speech" && showToast(`Voice error: ${t.error}`, "error") } } function toggleVoice() { if (!state.recognition) { showToast("Voice input not available.", "error"); return } state.isRecording ? (state.recognition.stop(), state.isRecording = !1, $voiceBtn.classList.remove("recording")) : (state.recognition.start(), state.isRecording = !0, $voiceBtn.classList.add("recording"), showToast("Listening\u2026", "info")) } let _audioQueue = []; let _isPlaying = false; let _currentAudio = null; async function playNextAudio() { if (_audioQueue.length === 0) { _isPlaying = false; return; } _isPlaying = true; const b64 = _audioQueue.shift(); _currentAudio = new Audio("data:audio/wav;base64," + b64); _currentAudio.onended = () => { _currentAudio = null; playNextAudio(); }; try { await _currentAudio.play(); } catch (e) { console.error("Audio play failed:", e); _currentAudio = null; playNextAudio(); } } async function speakText(e, t = !0) { if (!state.ttsEnabled || !e.trim()) return; if (t) { _audioQueue = []; if (_currentAudio) { _currentAudio.pause(); _currentAudio = null; } _isPlaying = false; } try { const res = await window.jarvis.piperTTS(e); if (res && res.ok && res.data) { _audioQueue.push(res.data); if (!_isPlaying) playNextAudio(); } else { console.error("Piper TTS error:", res?.error); } } catch(err) { console.error("Piper IPC error:", err); } } function extractPlainText(e) { return e.replace(/```[\s\S]*?```/g, "code block").replace(/`[^`]+`/g, "").replace(/#{1,6}\s/g, "").replace(/[*_~]{1,3}/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*[-*+]\s/gm, "").replace(/^\s*\d+\.\s/gm, "").replace(/\|[^|\n]+/g, "").replace(/\n{2,}/g, ". ").replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim() } function toggleTTS() { state.ttsEnabled = !state.ttsEnabled, $ttsBtn && ($ttsBtn.classList.toggle("active", state.ttsEnabled), $ttsBtn.setAttribute("aria-pressed", state.ttsEnabled)), !state.ttsEnabled && state.synth && state.synth.cancel(), showToast(`Voice output ${state.ttsEnabled ? "enabled" : "disabled"}.`, "info") } function startHUDClock() { const e = () => { const t = new Date; $hudTime && ($hudTime.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`), $hudDate && ($hudDate.textContent = t.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()) }; e(), setInterval(e, 1e3) } function initWaveform() {
  if (!$waveformCanvas) return;
  const e = $waveformCanvas.getContext("2d"), t = $waveformCanvas.width, n = $waveformCanvas.height;
  let s = 0, o = new Array(32).fill(0), lastTime = 0;
  function i(timestamp) {
    if (document.hidden) { state.waveformAnim = null; return; }
    timestamp = timestamp || performance.now();
    const fps = state.waveformActive ? 60 : 10;
    if (timestamp - lastTime < 1000 / fps) { state.waveformAnim = requestAnimationFrame(i); return; }
    lastTime = timestamp;
    e.clearRect(0, 0, t, n), state.waveformActive ? (o = o.map(() => Math.random() * n * .8 + n * .1), $waveformLabel && ($waveformLabel.textContent = state.isStreaming ? "PROCESSING" : "LISTENING", $waveformLabel.style.color = "var(--cyan)")) : (s += .04, $waveformLabel && ($waveformLabel.textContent = "STANDBY", $waveformLabel.style.color = "var(--text-muted)"));
    const a = t / o.length;
    o.forEach((c, r) => {
      const l = state.waveformActive ? o[r] - n / 2 : Math.sin(r / o.length * Math.PI * 2 + s) * 8;
      e.fillStyle = `rgba(0,212,255,${state.waveformActive ? .8 : .35})`, e.fillRect(r * a + 1, n / 2 - Math.abs(l), a - 2, Math.abs(l) * 2 || 2)
    });
    state.waveformAnim = requestAnimationFrame(i);
  }
  state.waveformAnim = requestAnimationFrame(i);
  document.addEventListener("visibilitychange", () => { !document.hidden && !state.waveformAnim && (state.waveformAnim = requestAnimationFrame(i)) }, { once: !1 })
} function setWaveformActive(e) { state.waveformActive = e } function updateSystemPanel(e) { if (e) { if ($pPlatform && ($pPlatform.textContent = `${e.platform}/${e.arch}`.toUpperCase()), $pCpu && ($pCpu.textContent = `${e.cpuCount}\xD7 CORE`), $pMem) { const t = (e.totalMem / 1024 / 1024 / 1024).toFixed(1); $pMem.textContent = `${t} GB` } $pModel && ($pModel.textContent = state.model), $activeModelLabel && ($activeModelLabel.textContent = state.model) } } async function refreshModels() { showToast("Scanning Ollama for installed models\u2026", "info"); try { const e = await fetch(`${state.endpoint}/api/tags`, { signal: AbortSignal.timeout(5e3) }); if (!e.ok) throw new Error("Ollama offline"); const n = (await e.json()).models || []; return renderModelsList(n), n } catch { return showToast("Could not fetch models \u2014 is Ollama running?", "error"), [] } } function renderModelsList(e) {
  const t = document.getElementById("models-list"); t && (t.innerHTML = "", e.length ? e.forEach(s => { const o = document.createElement("div"); o.className = `model-item ${s.name === state.model ? "current" : ""}`; const i = s.size ? (s.size / 1e9).toFixed(1) + " GB" : "?"; o.innerHTML = `<span>${s.name.split(":")[0]}</span><span class="model-size">${i}</span>`, o.onclick = () => selectModel(s.name), t.appendChild(o) }) : t.innerHTML = '<div class="panel-placeholder">No models found</div>'); const n = document.getElementById("models-modal-body"); n && (n.innerHTML = "", e.length ? e.forEach(s => {
    const o = s.size ? (s.size / 1e9).toFixed(2) + " GB" : "Unknown", i = document.createElement("div"); i.className = `models-modal-item ${s.name === state.model ? "active" : ""}`, i.innerHTML = `
        <div><div class="model-info-name">${s.name}</div><div class="model-info-meta">${o} \xB7 ${s.details?.parameter_size || ""} \xB7 ${s.details?.quantization_level || ""}</div></div>
        <button class="model-select-btn ${s.name === state.model ? "active-model" : ""}" onclick="selectModel('${s.name}'); closeModal('models-modal')">${s.name === state.model ? "\u2713 ACTIVE" : "SELECT"}</button>`, n.appendChild(i)
  }) : n.innerHTML = '<div class="panel-placeholder">No models found.<br>Run: <code>ollama pull llama3.1:8b</code></div>')
} function selectModel(e) { quickSwitchModel(e), closeModal("models-modal") } window.selectModel = selectModel; async function openHistory() { const e = await window.jarvis.listHistory(), t = document.getElementById("history-list"); if (t.innerHTML = "", !e.ok || !e.data.length) { t.innerHTML = '<div class="panel-placeholder" style="padding:24px">No saved sessions yet, sir.</div>', openModal("history-modal"); return } e.data.forEach(s => { const o = MODES[s.mode] || MODES.general, i = new Date(s.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }), a = document.createElement("div"); a.className = "history-item", a.innerHTML = '<div class="hist-mode-icon" style="color:' + o.color + ";background:" + o.color + "22;border:1px solid " + o.color + '44">' + o.icon + '</div><div class="hist-info"><div class="hist-title">' + escHtml(s.title || "Untitled Session") + '</div><div class="hist-meta">' + o.name + " \xB7 " + s.messageCount + " messages \xB7 " + i + `</div></div><button class="hist-delete-btn" onclick="deleteSession('` + s.id + `', event)" title="Delete">\u2715</button>`, a.onclick = () => loadSession(s), t.appendChild(a) }); const n = document.getElementById("history-search"); n && (n.value = "", n.oninput = () => { const s = n.value.toLowerCase(); t.querySelectorAll(".history-item").forEach(o => { o.style.display = o.textContent.toLowerCase().includes(s) ? "" : "none" }) }), openModal("history-modal") } async function loadSession(e) { const t = await window.jarvis.loadHistory(e.id); if (!t.ok || !t.data) { showToast("Could not load session.", "error"); return } const n = t.data; state.conversations[n.mode] = n, closeModal("history-modal"), setMode(n.mode), renderConversation(n.mode), showToast("Session restored: " + (n.title || "Untitled"), "success") } async function deleteSession(e, t) { t.stopPropagation(), await window.jarvis.deleteHistory(e), showToast("Session deleted.", "info"), openHistory(), await updateSessionCount() } window.deleteSession = deleteSession; async function exportChat() {
  const e = state.conversations[state.mode]; if (!e || !e.messages.length) { showToast("Nothing to export.", "error"); return } let n = `# JARVIS Session Export

**Mode:** `+ MODES[state.mode].name + `  
**Date:** `+ new Date().toLocaleString("en-GB") + `  
**Model:** `+ state.model + `
---
`; e.messages.forEach(o => {
    const i = o.role === "user" ? "**You**" : "**JARVIS**", a = o.timestamp ? new Date(o.timestamp).toLocaleTimeString() : ""; n += `
### `+ i + "  " + a + `
`+ o.content + `
---
`}); const s = await window.jarvis.saveDialog("jarvis-" + state.mode + "-" + Date.now() + ".md", n); s.ok && showToast("Exported to " + s.filePath, "success")
} const THEMES = { ironman: { name: "IRON MAN", attr: "", label: "Iron Man HUD \u2014 Default" }, phantom: { name: "PHANTOM", attr: "phantom", label: "Phantom \u2014 Blood Red" }, matrix: { name: "MATRIX", attr: "matrix", label: "Matrix \u2014 Terminal Green" }, nova: { name: "NOVA", attr: "nova", label: "Nova \u2014 Deep Space Purple" }, ghost: { name: "GHOST", attr: "ghost", label: "Ghost \u2014 Light Military" } }; function applyTheme(e) { const t = THEMES[e] || THEMES.ironman; state.theme = e, t.attr ? document.documentElement.setAttribute("data-theme", t.attr) : document.documentElement.removeAttribute("data-theme"), document.querySelectorAll(".theme-swatch").forEach(n => { const s = n.id.replace("cfg-theme-", "").replace("ham-theme-", ""); n.classList.toggle("active", s === e) }); try { const n = JSON.parse(localStorage.getItem("jarvis-settings") || "{}"); n.theme = e, localStorage.setItem("jarvis-settings", JSON.stringify(n)) } catch { } showToast("Theme: " + t.label, "info") } window.applyTheme = applyTheme; function loadSettings() { try { const e = JSON.parse(localStorage.getItem("jarvis-settings") || "{}"); if (state.model = e.model || "llama3.2", state.endpoint = e.endpoint || "http://127.0.0.1:11434", state.temperature = e.temperature ?? .7, state.ttsEnabled = e.ttsEnabled ?? !0, state.speechRate = e.speechRate ?? 1, state.speechPitch = e.speechPitch ?? 1, state.contextWindow = e.contextWindow ?? 20, $activeModelLabel && ($activeModelLabel.textContent = state.model), $pModel && ($pModel.textContent = state.model), e.theme && THEMES[e.theme]) { const t = THEMES[e.theme]; state.theme = e.theme, t.attr ? document.documentElement.setAttribute("data-theme", t.attr) : document.documentElement.removeAttribute("data-theme"), requestAnimationFrame(() => { document.querySelectorAll(".theme-swatch").forEach(n => { const s = n.id.replace("cfg-theme-", "").replace("ham-theme-", ""); n.classList.toggle("active", s === e.theme) }) }) } } catch { } } function saveSettings() { state.model = document.getElementById("cfg-model").value, state.endpoint = document.getElementById("cfg-endpoint").value.trim() || "http://127.0.0.1:11434", state.temperature = parseFloat(document.getElementById("cfg-temperature").value), state.ttsEnabled = document.getElementById("cfg-tts").checked, state.speechRate = parseFloat(document.getElementById("cfg-speech-rate").value), state.speechPitch = parseFloat(document.getElementById("cfg-speech-pitch").value), state.contextWindow = parseInt(document.getElementById("cfg-context").value), localStorage.setItem("jarvis-settings", JSON.stringify({ model: state.model, endpoint: state.endpoint, temperature: state.temperature, ttsEnabled: state.ttsEnabled, speechRate: state.speechRate, speechPitch: state.speechPitch, contextWindow: state.contextWindow, theme: state.theme || "ironman" })), $activeModelLabel && ($activeModelLabel.textContent = state.model), $pModel && ($pModel.textContent = state.model), $ttsBtn && $ttsBtn.classList.toggle("active", state.ttsEnabled), document.querySelectorAll(".model-preset-btn").forEach(e => { const t = e.getAttribute("onclick")?.match(/'([^']+)'/); e.classList.toggle("active", t && t[1] === state.model) }), closeModal("settings-modal"), showToast("Configuration saved, sir.", "success"), checkOllama() } window.saveSettings = saveSettings; function quickSwitchModel(e) { if (!e) return; state.model = e; try { const n = JSON.parse(localStorage.getItem("jarvis-settings") || "{}"); n.model = e, localStorage.setItem("jarvis-settings", JSON.stringify(n)) } catch { } $activeModelLabel && ($activeModelLabel.textContent = e), $pModel && ($pModel.textContent = e); const t = document.getElementById("cfg-model"); if (t) { let n = !1; for (const s of t.options) if (s.value === e) { t.value = e, n = !0; break } if (!n) { const s = document.createElement("option"); s.value = e, s.textContent = e + "  (custom)", t.appendChild(s), t.value = e } } document.querySelectorAll(".model-preset-btn").forEach(n => { const s = n.getAttribute("onclick")?.match(/'([^']+)'/); n.classList.toggle("active", s && s[1] === e) }), showToast(`\u25C8 Model \u2192 ${e}`, "success") } window.quickSwitchModel = quickSwitchModel; function resetSettings() { localStorage.removeItem("jarvis-settings"), loadSettings(), populateSettingsModal(), showToast("Defaults restored.", "info") } window.resetSettings = resetSettings; function populateSettingsModal() { const e = document.getElementById("cfg-model"); if (e) { let t = !1; for (const n of e.options) if (n.value === state.model) { t = !0; break } if (!t) { const n = document.createElement("option"); n.value = state.model, n.textContent = state.model + "  (custom)", e.appendChild(n) } e.value = state.model } document.getElementById("cfg-endpoint").value = state.endpoint, document.getElementById("cfg-temperature").value = state.temperature, document.getElementById("cfg-temp-val").textContent = state.temperature.toFixed(2), document.getElementById("cfg-tts").checked = state.ttsEnabled, document.getElementById("cfg-speech-rate").value = state.speechRate, document.getElementById("cfg-rate-val").textContent = `${state.speechRate.toFixed(1)}\xD7`, document.getElementById("cfg-speech-pitch").value = state.speechPitch, document.getElementById("cfg-pitch-val").textContent = state.speechPitch.toFixed(1), document.getElementById("cfg-context").value = state.contextWindow, document.getElementById("cfg-temperature").oninput = t => { document.getElementById("cfg-temp-val").textContent = parseFloat(t.target.value).toFixed(2) }, document.getElementById("cfg-speech-rate").oninput = t => { document.getElementById("cfg-rate-val").textContent = `${parseFloat(t.target.value).toFixed(1)}\xD7` }, document.getElementById("cfg-speech-pitch").oninput = t => { document.getElementById("cfg-pitch-val").textContent = parseFloat(t.target.value).toFixed(1) }, document.querySelectorAll(".model-preset-btn").forEach(t => { const n = t.getAttribute("onclick")?.match(/'([^']+)'/); t.classList.toggle("active", n && n[1] === state.model) }) } function openTerminalModal() { $termOutput.children.length || (termPrint("info", "\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557"), termPrint("info", "\u2551       JARVIS TERMINAL v2.0           \u2551"), termPrint("info", "\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D"), termPrint("info", "Full system access. Type any command.")), openModal("terminal-modal"), setTimeout(() => $termInput.focus(), 100) } function termPrint(e, t) { const n = document.createElement("div"); n.className = `term-line ${e}`, n.textContent = t, $termOutput.appendChild(n), $termOutput.scrollTop = $termOutput.scrollHeight } async function runTerminalCommand(e) {
  if (!e.trim()) return; let t = "safe"; try { t = (await window.jarvis.secClassifyCmd(e))?.verdict || "safe" } catch { } if (t === "blocked") { termPrint("cmd", `JARVIS $> ${e}`), termPrint("err", "\u26D4 BLOCKED \u2014 Command rejected by JARVIS Security Policy."), termPrint("err", "This command is classified as destructive or dangerous."), termPrint("info", "[exit BLOCKED]"), showToast("\u26D4 Command blocked by security policy.", "error"); return } if (t === "warn" && !await showTerminalConfirm(e)) { termPrint("info", "[\u26A0 Command cancelled by user]"); return } state.terminalHistory.unshift(e), state.termHistoryIdx = -1, termPrint("cmd", `JARVIS $> ${e}${t === "warn" ? " \u26A0 CAUTION" : ""}`); const s = await window.jarvis.runCommand(e); if (s.error && (s.error.includes("\u26D4") || s.error.includes("BLOCKED"))) { termPrint("err", s.error), termPrint("info", "[exit BLOCKED]"); return } s.stdout && s.stdout.split(`
`).forEach(o => o && termPrint("out", o)), s.stderr && s.stderr.split(`
`).forEach(o => o && termPrint("err", o)), s.error && !s.stdout && !s.stderr && termPrint("err", s.error), termPrint("info", `[exit ${s.exitCode ?? 0}]`)
} function showTerminalConfirm(e) { return new Promise(t => { let n = document.getElementById("term-confirm-overlay"); n && n.remove(), n = document.createElement("div"), n.id = "term-confirm-overlay", n.className = "term-confirm-overlay", n.innerHTML = '<div class="term-confirm-box"><div class="term-confirm-icon">\u26A0</div><div class="term-confirm-title">CAUTION \u2014 SENSITIVE COMMAND</div><div class="term-confirm-desc">This command is classified as potentially dangerous. Review it carefully before proceeding.</div><pre class="term-confirm-cmd">' + escHtml(e) + '</pre><div class="term-confirm-btns"><button class="term-confirm-cancel" id="term-confirm-cancel">\u2715 Cancel</button><button class="term-confirm-run" id="term-confirm-run">\u25B6 Execute Anyway</button></div></div>', document.body.appendChild(n), document.getElementById("term-confirm-run").onclick = () => { n.remove(), t(!0) }, document.getElementById("term-confirm-cancel").onclick = () => { n.remove(), t(!1) } }) } function clearTerminal() { $termOutput.innerHTML = "" } window.clearTerminal = clearTerminal; async function quickAction(e) { switch (e) { case "new": newSession(); break; case "clear": clearCurrentChat(); break; case "export": exportChat(); break; case "terminal": openTerminalModal(); break; case "models": await refreshModels(), openModal("models-modal"); break } } window.quickAction = quickAction; function clearCurrentChat() { state.conversations[state.mode] = newConversation(state.mode), clearMessages(), showToast("Chat cleared, sir.", "info") } function newSession() { clearCurrentChat(), showToast("New session started.", "info") } function showModeDashboard(e) { if (state.dashCleanup.forEach(o => { try { o() } catch { } }), state.dashCleanup = [], !$dashboard) return; const t = { general: dashGeneral, code: dashCode, debug: dashDebug, research: dashResearch, automation: dashAutomation, business: dashBusiness, creative: dashCreative, productivity: dashProductivity }, n = (t[e] || t.general)(); $dashboard.innerHTML = n; const s = { general: () => { }, code: initCodeDash, debug: initDebugDash, research: initResearchDash, automation: initAutoDash, business: initBizDash, creative: initCreativeDash, productivity: initProdDash }; setTimeout(() => { const o = s[e]; if (o) { const i = o() || []; state.dashCleanup = Array.isArray(i) ? i : i ? [i] : [] } }, 60) } function dashGeneral() {
  return `<div class="mode-dashboard dash-general">
    <div class="dash-hero-tech">
      <div class="tech-core-container">
        <!-- HUD Background Crosshairs -->
        <div class="hud-crosshair hud-crosshair-v"></div>
        <div class="hud-crosshair hud-crosshair-h"></div>
        
        <!-- Energy Ripples -->
        <div class="hud-ripple"></div>
        <div class="hud-ripple"></div>
        
        <!-- HUD Scanner Line -->
        <div class="hud-scanner"></div>

        <!-- HUD Segmented Rings -->
        <div class="hud-ring hud-ring-outer"></div>
        <div class="hud-ring hud-ring-middle"></div>
        <div class="hud-ring hud-ring-inner"></div>
        <canvas id="jarvis-orb-canvas" width="400" height="400" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); z-index:5;"></canvas>
        
        <!-- Hex Core -->
        <div class="hud-center-hex">
          <div class="hud-hex-inner">
            <div class="hud-hex-pulse"></div>
          </div>
          <div class="hud-hex-label">J.A.R.V.I.S</div>
        </div>
      </div>
      <!-- Labels -->
      <div class="tech-labels">
        <div class="tech-label-main">CORE INTERFACE ACTIVE</div>
        <div class="tech-label-sub">INTELLIGENCE ENGINE ON</div>
        <div class="tech-label-sub">SYSTEMS INTEGRATED</div>
      </div>
    </div>
    <div class="dash-gen-chips-new">${["What can you help me with today?", "Explain quantum computing simply", "Give me 5 productivity tips", "Help me write a professional email", "Debug my code \u2014 I'll paste it", "Generate a Python automation script", "Research the latest in AI", "Build a React component for me"].map(n => `<button class="welcome-chip" onclick="injectPrompt(${JSON.stringify(n)})">${escHtml(n)}</button>`).join("")}</div>
  </div>`} function initOrbCanvas() {
  const e = document.getElementById("jarvis-orb-canvas");
  if (!e) return null;
  const t = e.getContext("2d"), n = e.width, s = e.height;
  let o = null, i = 0, lastTime = 0;
  function a() { return getComputedStyle(document.documentElement).getPropertyValue("--cyan").trim() || "#00d4ff" }
  function c(g) {
    const d = g.match(/^#([0-9a-f]{6})$/i);
    if (d) { const m = parseInt(d[1], 16); return [m >> 16 & 255, m >> 8 & 255, m & 255] }
    const u = g.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/); return u ? [+u[1], +u[2], +u[3]] : [0, 212, 255]
  }
  const l = Array.from({ length: 40 }, () => ({ angle: Math.random() * Math.PI * 2, radius: 80 + Math.random() * 80, speed: (Math.random() - .5) * .008, size: Math.random() * 2.5 + .5, opacity: Math.random() * .6 + .2, phase: Math.random() * Math.PI * 2 }));
  function p(timestamp) {
    timestamp = timestamp || performance.now();
    const fps = state.isStreaming ? 60 : (!state.isFocused ? 2 : 10);
    if (timestamp - lastTime < 1000 / fps) { o = requestAnimationFrame(p); return; }
    lastTime = timestamp;
    t.clearRect(0, 0, n, s);
    const g = a(), [d, u, m] = c(g), v = n / 2, h = s / 2, w = state.isStreaming, x = w ? 3.5 : 1, b = w ? 1.8 : 1;
    i += .012 * x;
    const S = t.createRadialGradient(v, h, 10, v, h, 190);
    S.addColorStop(0, `rgba(${d},${u},${m},${.22 * b})`), S.addColorStop(.4, `rgba(${d},${u},${m},${.06 * b})`), S.addColorStop(1, `rgba(${d},${u},${m},0)`);
    t.beginPath(), t.arc(v, h, 190, 0, Math.PI * 2), t.fillStyle = S, t.fill();
    [{ radius: 145, dash: [16, 10], width: 1.2, opacity: .25, dir: 1 }, { radius: 118, dash: [8, 14], width: 1.5, opacity: .4, dir: -1 }, { radius: 90, dash: [4, 8], width: 1.8, opacity: .55, dir: 1 }, { radius: 62, dash: [2, 6], width: 2, opacity: .7, dir: -1 }].forEach((f, y) => {
      t.save(), t.translate(v, h), t.rotate(i * (.4 + y * .15) * f.dir), t.beginPath(), t.arc(0, 0, f.radius, 0, Math.PI * 2), t.setLineDash(f.dash), t.strokeStyle = `rgba(${d},${u},${m},${f.opacity * b})`, t.lineWidth = f.width, t.stroke(), t.restore()
    });
    const B = 8;
    for (let f = 0; f < B; f++) {
      const y = f / B * Math.PI * 2 + i * .5, T = v + Math.cos(y) * 145, A = h + Math.sin(y) * 145, C = .5 + .5 * Math.sin(i * 3 + f * .8);
      t.beginPath(), t.arc(T, A, 3 + C * 1.5, 0, Math.PI * 2), t.fillStyle = `rgba(${d},${u},${m},${.5 + C * .5})`, t.fill()
    }
    const k = .5 + .5 * Math.sin(i * 1.5), I = 38 + k * (w ? 8 : 4), E = t.createRadialGradient(v - 8, h - 8, 2, v, h, I);
    E.addColorStop(0, `rgba(255,255,255,${.9 * b})`), E.addColorStop(.3, `rgba(${d},${u},${m},${.85})`), E.addColorStop(.7, `rgba(${d},${u},${m},${.5})`), E.addColorStop(1, `rgba(${d},${u},${m},0.05)`);
    t.beginPath(), t.arc(v, h, I, 0, Math.PI * 2), t.fillStyle = E, t.fill();
    const $ = t.createRadialGradient(v, h, 0, v, h, I * 2.2);
    if ($.addColorStop(0, `rgba(${d},${u},${m},${.3 * b})`), $.addColorStop(1, `rgba(${d},${u},${m},0)`), t.beginPath(), t.arc(v, h, I * 2.2, 0, Math.PI * 2), t.fillStyle = $, t.fill(), t.save(), t.translate(v, h), t.rotate(i * .3), t.font = `${22 + k * 3}px "Segoe UI Symbol", sans-serif`, t.fillStyle = `rgba(255,255,255,${.85 + k * .15})`, t.textAlign = "center", t.textBaseline = "middle", t.fillText("\u2B21", 0, 0), t.restore(), l.forEach(f => {
      f.angle += f.speed * x; const y = f.radius + Math.sin(i * .8 + f.phase) * 12, T = v + Math.cos(f.angle) * y, A = h + Math.sin(f.angle) * y, C = f.opacity * (.6 + .4 * Math.sin(i * 1.2 + f.phase));
      t.beginPath(), t.arc(T, A, f.size, 0, Math.PI * 2), t.fillStyle = `rgba(${d},${u},${m},${C})`, t.fill()
    }), w) {
      const f = i * 2; t.save(), t.translate(v, h), t.rotate(f); const y = t.createLinearGradient(0, 0, 160, 0); y.addColorStop(0, `rgba(${d},${u},${m},0.5)`), y.addColorStop(1, `rgba(${d},${u},${m},0)`);
      t.beginPath(), t.moveTo(0, 0), t.arc(0, 0, 160, -.05, .05), t.closePath(), t.fillStyle = y, t.fill(), t.restore()
    }
    o = requestAnimationFrame(p);
  }
  o = requestAnimationFrame(p);
  return () => { cancelAnimationFrame(o) }
} function dashCode() {
  return `<div class="mode-dashboard dash-code">
    <div class="dash-code-topbar">
      <div class="dash-code-controls">
        <select id="code-lang" class="dash-select" onchange="onCodeLangChange()">
          <option value="python">Python</option>
          <option value="javascript">JavaScript (Node)</option>
          <option value="powershell">PowerShell</option>
          <option value="bash">Bash / Shell</option>
        </select>
        <button class="dash-btn dash-btn-green" onclick="runDashCode()">\u25B6 RUN</button>
        <button class="dash-btn" onclick="clearDashCode()">\u2298 CLEAR</button>
        <div class="dash-sep"></div>
        <button class="dash-btn dash-btn-cyan" onclick="reviewWithJarvis()">\u2B21 REVIEW</button>
        <button class="dash-btn" onclick="explainWithJarvis()">\u25CE EXPLAIN</button>
        <button class="dash-btn" onclick="optimizeWithJarvis()">\u26A1 OPTIMIZE</button>
      </div>
      <span id="code-line-count" class="code-meta">0 lines \xB7 0 chars</span>
    </div>
    <div class="dash-code-templates">
      <span class="tpl-label">TEMPLATES:</span>${[{ label: "Hello World", code: 'print("Hello, JARVIS!")' }, {
      label: "HTTP Request", code: `import requests
res = requests.get("https://httpbin.org/get")
print(res.status_code, res.json()["url"])`}, {
      label: "List Files", code: `import os
for f in sorted(os.listdir(".")):
    print(f)`}, {
      label: "Sort & Search", code: `arr = [64, 25, 12, 22, 11, 90, 47]
arr.sort()
print("Sorted:", arr)
print("Max:", max(arr), "Min:", min(arr))`}, {
      label: "Date / Time", code: `from datetime import datetime
now = datetime.now()
print(now.strftime("%A, %d %B %Y  %H:%M:%S"))`}, {
      label: "JSON Parse", code: `import json
data = '{"name": "JARVIS", "version": 2}'
obj = json.loads(data)
print(obj["name"], obj["version"])`}].map(n => `<button class="template-chip" onclick="loadCodeTemplate(${JSON.stringify(n.code)})">${n.label}</button>`).join("")}
    </div>
    <div class="dash-code-workspace">
      <div class="code-editor-panel">
        <div class="code-panel-hdr"><span>EDITOR</span></div>
        <textarea id="dash-code-editor" class="dash-code-textarea" spellcheck="false" autocomplete="off"
          placeholder="# Write your code here&#10;# RUN executes it \xB7 REVIEW sends to JARVIS \xB7 EXPLAIN for analysis"></textarea>
      </div>
      <div class="code-output-panel">
        <div class="code-panel-hdr">
          <span>OUTPUT</span>
          <div class="phdr-actions">
            <button class="micro-btn" onclick="clearCodeOutput()">CLEAR</button>
            <button class="micro-btn" onclick="sendOutputToJarvis()">ASK JARVIS</button>
          </div>
        </div>
        <div id="dash-code-output" class="dash-code-output">
          <div class="output-placeholder"><span class="op-icon">\u25B6</span><span>Run your code to see output here</span></div>
        </div>
      </div>
    </div>
  </div>`} function initCodeDash() {
  const e = document.getElementById("dash-code-editor"); return e ? (e.addEventListener("input", () => {
    const t = e.value.split(`
`).length, n = e.value.length, s = document.getElementById("code-line-count"); s && (s.textContent = `${t} line${t !== 1 ? "s" : ""} \xB7 ${n} chars`)
  }), e.addEventListener("keydown", t => { if (t.key === "Tab") { t.preventDefault(); const n = e.selectionStart, s = e.selectionEnd; e.value = e.value.substring(0, n) + "    " + e.value.substring(s), e.selectionStart = e.selectionEnd = n + 4 } }), []) : []
} window.runDashCode = async function () { const e = document.getElementById("dash-code-editor"), t = document.getElementById("dash-code-output"); if (!e || !t) return; const n = e.value.trim(); if (!n) { showToast("Write some code first.", "error"); return } const s = document.getElementById("code-lang")?.value || "python"; t.innerHTML = '<div class="output-running"><span class="spin-icon">\u25C8</span> Executing\u2026</div>'; const o = await window.jarvis.runCodeSafe(s, n); if (!document.getElementById("dash-code-output")) return; if (!o.ok && o.error?.includes("Rate limit")) { t.innerHTML = `<div class="out-exit err-exit">\u26D4 ${escHtml(o.error)}</div>`, showToast(o.error, "error"); return } let i = ""; o.stdout && (i += `<div class="out-section"><div class="out-lbl stdout-lbl">STDOUT</div><pre class="out-pre">${escHtml(o.stdout.trimEnd())}</pre></div>`), o.stderr && (i += `<div class="out-section"><div class="out-lbl stderr-lbl">STDERR</div><pre class="out-pre err-pre">${escHtml(o.stderr.trimEnd())}</pre></div>`), !o.stdout && !o.stderr && (i = '<div class="out-ok">\u2713 Executed with no output (exit 0)</div>'); const a = o.time != null ? ` \xB7 ${(o.time / 1e3).toFixed(2)}s` : ""; i += `<div class="out-exit ${(o.exitCode ?? 0) === 0 ? "" : "err-exit"}">Exit ${o.exitCode ?? 0}${a} \xB7 ${new Date().toLocaleTimeString()}</div>`, t.innerHTML = i }, window.clearDashCode = function () { const e = document.getElementById("dash-code-editor"); e && (e.value = "", e.dispatchEvent(new Event("input")), e.focus()), window.clearCodeOutput() }, window.clearCodeOutput = function () { const e = document.getElementById("dash-code-output"); e && (e.innerHTML = '<div class="output-placeholder"><span class="op-icon">\u25B6</span><span>Run your code to see output here</span></div>') }, window.reviewWithJarvis = function () {
  const e = document.getElementById("dash-code-editor")?.value?.trim(); if (!e) { showToast("Write code first.", "error"); return } const t = document.getElementById("code-lang")?.value || "code"; dashSend(`Review this ${t} code for correctness, best practices, security, and improvements:\`\`\`${t}
${e}
\`\`\``)
}, window.explainWithJarvis = function () {
  const e = document.getElementById("dash-code-editor")?.value?.trim(); if (!e) { showToast("Write code first.", "error"); return } const t = document.getElementById("code-lang")?.value || "code"; dashSend(`Explain this ${t} code step by step \u2014 what it does, how it works, and any notable patterns:\`\`\`${t}
${e}
\`\`\``)
}, window.optimizeWithJarvis = function () {
  const e = document.getElementById("dash-code-editor")?.value?.trim(); if (!e) { showToast("Write code first.", "error"); return } const t = document.getElementById("code-lang")?.value || "code"; dashSend(`Optimize this ${t} code for performance, readability, and efficiency. Show the improved version:\`\`\`${t}
${e}
\`\`\``)
}, window.sendOutputToJarvis = function () {
  const e = document.getElementById("dash-code-output")?.innerText?.trim(), t = document.getElementById("dash-code-editor")?.value?.trim(); if (!e || e.includes("Run your code")) { showToast("Run code first.", "error"); return } dashSend(`I ran this code and got this output. Help me understand it or suggest next steps:Code:
\`\`\`
${t}
\`\`\`Output:
\`\`\`
${e}
\`\`\``)
}, window.loadCodeTemplate = function (e) { const t = document.getElementById("dash-code-editor"); t && (t.value = e, t.dispatchEvent(new Event("input")), t.focus()) }, window.onCodeLangChange = function () {
  const e = document.getElementById("code-lang")?.value, t = document.getElementById("dash-code-editor"); if (t && !t.value.trim()) {
    const n = {
      python: `# Python 3
`, javascript: `// Node.js
`, powershell: `# PowerShell
`, bash: `#!/bin/bash
`}; t.value = n[e] || "", t.dispatchEvent(new Event("input"))
  }
}; function dashDebug() {
  return `<div class="mode-dashboard dash-debug">
    <div class="debug-top">
      <div class="debug-error-panel">
        <div class="debug-phdr">
          <span>\u26A0 PASTE ERROR / STACK TRACE</span>
          <div class="phdr-actions">
            <button class="micro-btn" onclick="clearErrorInput()">CLEAR</button>
            <button class="dash-btn dash-btn-orange" onclick="analyzeError()">\u26A0 ANALYZE</button>
          </div>
        </div>
        <textarea id="debug-error-input" class="debug-textarea" spellcheck="false"
          placeholder="Paste your error, stack trace, or exception here...

Example:
Traceback (most recent call last):
  File 'app.py', line 42, in main
    result = process(data)
KeyError: 'user_id'"></textarea>
        <div class="debug-patterns">
          <span class="pat-label">QUICK ANALYZE:</span>
          <button class="pat-chip" onclick="debugPattern('memory leak')">Memory Leak</button>
          <button class="pat-chip" onclick="debugPattern('null pointer / undefined reference')">Null Reference</button>
          <button class="pat-chip" onclick="debugPattern('race condition / concurrency bug')">Race Condition</button>
          <button class="pat-chip" onclick="debugPattern('infinite loop')">Infinite Loop</button>
          <button class="pat-chip" onclick="debugPattern('CORS error')">CORS Error</button>
          <button class="pat-chip" onclick="debugPattern('type mismatch / type error')">Type Error</button>
          <button class="pat-chip" onclick="debugPattern('SQL injection vulnerability')">SQL Injection</button>
          <button class="pat-chip" onclick="debugPattern('async/await / promise rejection')">Promise Error</button>
        </div>
      </div>
      <div class="debug-proc-panel">
        <div class="debug-phdr">
          <span>\u25C8 LIVE PROCESSES</span>
          <div class="phdr-actions">
            <span id="proc-refresh-time" class="meta-txt">\u2014</span>
            <button class="micro-btn" onclick="refreshProcesses()">\u21BB</button>
          </div>
        </div>
        <div class="proc-list-hdr"><span>PROCESS</span><span>CPU(s)</span><span>MEM(MB)</span></div>
        <div id="debug-proc-list" class="proc-list"><div class="proc-loading">\u25C8 Loading\u2026</div></div>
      </div>
    </div>
    <div class="debug-footer">
      <div class="dbg-stat"><span class="dbg-stat-label">TOP PROCESS</span><span class="dbg-stat-val" id="dbg-top">\u2014</span></div>
      <div class="dbg-stat"><span class="dbg-stat-label">LAST REFRESH</span><span class="dbg-stat-val" id="dbg-time">\u2014</span></div>
      <button class="dash-btn dash-btn-orange" onclick="analyzeSystem()">\u2B21 ANALYZE MY SYSTEM WITH JARVIS</button>
    </div>
  </div>`} function initDebugDash() { refreshProcesses(); const e = setInterval(() => { document.getElementById("debug-proc-list") ? refreshProcesses() : clearInterval(e) }, 3e4); return [() => clearInterval(e)] } window.refreshProcesses = async function () {
  if (!document.getElementById("debug-proc-list") || state.isStreaming) return; const t = await window.jarvis.runCommand("tasklist /FO CSV /NH"); if (!document.getElementById("debug-proc-list")) return; const n = document.getElementById("dbg-time"); if (n && (n.textContent = new Date().toLocaleTimeString()), t.stdout) {
    const s = t.stdout.trim().split(`
`).slice(0, 15); let o = "", i = { name: "", mem: 0 }; s.forEach(r => { const l = r.split('","').map(p => p.replace(/^"|"$/g, "").trim()); if (l.length >= 5) { const p = l[0], g = l[4].replace(/[^0-9]/g, ""), d = parseInt(g, 10) || 0, u = (d / 1024).toFixed(1); d > i.mem && (i.mem = d, i.name = p), o += `<div class="proc-row"><span class="proc-name">${escHtml(p)}</span><span class="proc-cpu">\u2014</span><span class="proc-mem">${u}</span></div>` } }); const a = document.getElementById("debug-proc-list"); a && (a.innerHTML = o || '<div class="proc-loading">No data</div>'); const c = document.getElementById("dbg-top"); c && (c.textContent = i.name || "\u2014")
  }
}, window.analyzeError = function () {
  const e = document.getElementById("debug-error-input")?.value?.trim(); if (!e) { showToast("Paste an error first.", "error"); return } dashSend(`Debug this error. Identify root cause, explain why it occurs, provide the exact fix, and suggest prevention:\`\`\`
${e}
\`\`\``)
}, window.clearErrorInput = function () { const e = document.getElementById("debug-error-input"); e && (e.value = "") }, window.debugPattern = function (e) { dashSend(`Explain what causes "${e}" bugs, how to detect them, and the best strategies to fix and prevent them. Include concrete code examples.`) }, window.analyzeSystem = function () { dashSend("Analyze common Windows performance issues, potential process bottlenecks, and system health checks I should run. Give me a diagnostic checklist.") }; function dashResearch() {
  const e = localStorage.getItem("jarvis-research-notes") || "", t = JSON.parse(localStorage.getItem("jarvis-research-questions") || "[]"), n = JSON.parse(localStorage.getItem("jarvis-research-outline") || "[]"), s = t.map((i, a) => `<div class="list-item"><span class="li-bullet">\u25CE</span><span>${escHtml(i)}</span><button class="item-del" onclick="removeQuestion(${a})">\u2715</button></div>`).join("") || '<div class="list-ph">Add questions to guide your research</div>', o = n.map((i, a) => `<div class="list-item"><span class="li-bullet">\u203A</span><span>${escHtml(i)}</span><button class="item-del" onclick="removeOutlineItem(${a})">\u2715</button></div>`).join("") || '<div class="list-ph">Add outline items or ask JARVIS to generate one</div>'; return `<div class="mode-dashboard dash-research">
    <div class="research-topbar">
      <span class="res-icon">\u25CE</span>
      <input type="text" id="research-topic" class="research-topic-input" placeholder="Enter research topic, question, or domain\u2026"
        onkeydown="if(event.key==='Enter') window.startResearch()">
      <button class="dash-btn dash-btn-purple" onclick="window.startResearch()">\u2B21 RESEARCH</button>
      <button class="dash-btn" onclick="window.generateOutline()">\u2261 OUTLINE</button>
      <button class="dash-btn" onclick="window.findSources()">\u238B SOURCES</button>
    </div>
    <div class="research-workspace">
      <div class="research-notes-panel">
        <div class="res-phdr">
          <span>\u{1F4C4} NOTES</span>
          <div class="phdr-actions">
            <span id="notes-saved" class="save-ind">\u2014</span>
            <button class="micro-btn" onclick="window.clearResearchNotes()">CLEAR</button>
            <button class="micro-btn" onclick="window.sendNotesToJarvis()">ASK JARVIS</button>
          </div>
        </div>
        <textarea id="research-notes" class="research-notes-ta"
          placeholder="Capture your findings, insights, and notes here\u2026&#10;Auto-saved as you type.">${escHtml(e)}</textarea>
      </div>
      <div class="research-right">
        <div class="research-outline-panel">
          <div class="res-phdr">
            <span>\u2261 OUTLINE</span>
            <div class="phdr-actions">
              <button class="micro-btn" onclick="window.addOutlineItem()">+ ADD</button>
              <button class="micro-btn" onclick="window.clearOutline()">CLEAR</button>
            </div>
          </div>
          <div id="research-outline" class="res-list">${o}</div>
          <input type="text" id="outline-input" class="list-input" placeholder="Add outline item\u2026"
            onkeydown="if(event.key==='Enter') window.addOutlineItem()">
        </div>
        <div class="research-questions-panel">
          <div class="res-phdr">
            <span>? KEY QUESTIONS</span>
            <div class="phdr-actions">
              <button class="micro-btn" onclick="window.generateQuestions()">\u2B21 GENERATE</button>
              <button class="micro-btn" onclick="window.clearQuestions()">CLEAR</button>
            </div>
          </div>
          <div id="research-questions" class="res-list">${s}</div>
          <input type="text" id="question-input" class="list-input" placeholder="Add research question\u2026"
            onkeydown="if(event.key==='Enter') window.addQuestion()">
        </div>
      </div>
    </div>
  </div>`} function initResearchDash() { const e = document.getElementById("research-notes"); let t = null; return e && e.addEventListener("input", () => { clearTimeout(t), t = setTimeout(() => { localStorage.setItem("jarvis-research-notes", e.value); const n = document.getElementById("notes-saved"); n && (n.textContent = "SAVED", setTimeout(() => { n && (n.textContent = "\u2014") }, 1500)) }, 1200) }), [() => clearTimeout(t)] } window.startResearch = function () { const e = document.getElementById("research-topic")?.value?.trim(); if (!e) { showToast("Enter a topic first.", "error"); return } dashSend(`Conduct comprehensive research on: "${e}"Provide: overview, key concepts, current state, important findings, contrasting viewpoints, and recommended resources.`) }, window.generateOutline = function () { const e = document.getElementById("research-topic")?.value?.trim() || "the research topic"; dashSend(`Generate a detailed research outline for: "${e}". Include main sections, subsections, and key questions.`) }, window.findSources = function () { const e = document.getElementById("research-topic")?.value?.trim() || "the research topic"; dashSend(`What are the best sources, books, papers, websites, and databases for researching: "${e}"?`) }, window.sendNotesToJarvis = function () { const e = document.getElementById("research-notes")?.value?.trim(); if (!e) { showToast("Add notes first.", "error"); return } dashSend(`Review my research notes. Provide insights, fill gaps, correct errors, and suggest areas to explore:${e}`) }, window.clearResearchNotes = function () { const e = document.getElementById("research-notes"); e && (e.value = "", localStorage.removeItem("jarvis-research-notes")) }, window.generateQuestions = function () { const e = document.getElementById("research-topic")?.value?.trim() || "the research topic"; dashSend(`Generate 8-10 deep research questions for: "${e}". Include fundamental and advanced questions.`) }, window.clearQuestions = function () { localStorage.removeItem("jarvis-research-questions"); const e = document.getElementById("research-questions"); e && (e.innerHTML = '<div class="list-ph">Add questions to guide your research</div>') }, window.clearOutline = function () { localStorage.removeItem("jarvis-research-outline"); const e = document.getElementById("research-outline"); e && (e.innerHTML = '<div class="list-ph">Add outline items or ask JARVIS to generate one</div>') }; function resRerender(e, t, n, s) { const o = JSON.parse(localStorage.getItem(e) || "[]"), i = document.getElementById(t); return i && (i.innerHTML = o.map(s).join("") || `<div class="list-ph">${n}</div>`), o } window.addQuestion = function () { const e = document.getElementById("question-input"); if (!e?.value?.trim()) return; const t = JSON.parse(localStorage.getItem("jarvis-research-questions") || "[]"); t.push(e.value.trim()), localStorage.setItem("jarvis-research-questions", JSON.stringify(t)), e.value = "", resRerender("jarvis-research-questions", "research-questions", "Add questions", (n, s) => `<div class="list-item"><span class="li-bullet">\u25CE</span><span>${escHtml(n)}</span><button class="item-del" onclick="removeQuestion(${s})">\u2715</button></div>`) }, window.removeQuestion = function (e) { const t = JSON.parse(localStorage.getItem("jarvis-research-questions") || "[]"); t.splice(e, 1), localStorage.setItem("jarvis-research-questions", JSON.stringify(t)), resRerender("jarvis-research-questions", "research-questions", "Add questions", (n, s) => `<div class="list-item"><span class="li-bullet">\u25CE</span><span>${escHtml(n)}</span><button class="item-del" onclick="removeQuestion(${s})">\u2715</button></div>`) }, window.addOutlineItem = function () { const e = document.getElementById("outline-input"); if (!e?.value?.trim()) return; const t = JSON.parse(localStorage.getItem("jarvis-research-outline") || "[]"); t.push(e.value.trim()), localStorage.setItem("jarvis-research-outline", JSON.stringify(t)), e.value = "", resRerender("jarvis-research-outline", "research-outline", "Add outline items", (n, s) => `<div class="list-item"><span class="li-bullet">\u203A</span><span>${escHtml(n)}</span><button class="item-del" onclick="removeOutlineItem(${s})">\u2715</button></div>`) }, window.removeOutlineItem = function (e) { const t = JSON.parse(localStorage.getItem("jarvis-research-outline") || "[]"); t.splice(e, 1), localStorage.setItem("jarvis-research-outline", JSON.stringify(t)), resRerender("jarvis-research-outline", "research-outline", "Add outline items", (n, s) => `<div class="list-item"><span class="li-bullet">\u203A</span><span>${escHtml(n)}</span><button class="item-del" onclick="removeOutlineItem(${s})">\u2715</button></div>`) }; function dashAutomation() {
  return `<div class="mode-dashboard dash-auto">
    <div class="auto-left">
      <div class="auto-editor-hdr">
        <select id="auto-lang" class="dash-select">
          <option value="powershell">PowerShell</option>
          <option value="python">Python</option>
          <option value="bash">Bash</option>
        </select>
        <button class="dash-btn dash-btn-yellow" onclick="runAutoScript()">\u25B6 EXECUTE</button>
        <button class="dash-btn" onclick="clearAutoScript()">\u2298 CLEAR</button>
        <button class="dash-btn dash-btn-cyan" onclick="generateAutoScript()">\u2B21 GENERATE</button>
        <button class="dash-btn" onclick="scheduleScript()">\u23F1 SCHEDULE</button>
      </div>
      <textarea id="auto-editor" class="auto-editor-ta" spellcheck="false"
        placeholder="# Write or generate your automation script here\u2026&#10;# Pick a quick template below or ask JARVIS to generate one"></textarea>
      <div class="auto-tpls">
        <span class="tpl-label">QUICK SCRIPTS:</span>${[{ name: "System Info", lang: "powershell", code: "Get-ComputerInfo | Select-Object CsName, OsTotalVisibleMemorySize, OsArchitecture | Format-List" }, { name: "Disk Usage", lang: "powershell", code: 'Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="Used(GB)";E={[math]::Round($_.Used/1GB,2)}}, @{N="Free(GB)";E={[math]::Round($_.Free/1GB,2)}} | Format-Table' }, { name: "Top Processes", lang: "powershell", code: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU, @{N="Mem(MB)";E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table' }, { name: "Network Info", lang: "powershell", code: 'Get-NetIPAddress | Where-Object {$_.AddressFamily -eq "IPv4"} | Select-Object IPAddress, InterfaceAlias | Format-Table' }, { name: "Ping Google", lang: "powershell", code: "Test-Connection -ComputerName google.com -Count 4 | Select-Object Address, ResponseTime | Format-Table" }, { name: "Running Services", lang: "powershell", code: 'Get-Service | Where-Object {$_.Status -eq "Running"} | Select-Object Name, Status, DisplayName | Sort-Object Name | Format-Table' }, {
      name: "File Backup", lang: "powershell", code: `$src = "$env:USERPROFILE\\Documents"
$dst = "$env:USERPROFILE\\Desktop\\Backup_$(Get-Date -Format "yyyyMMdd_HHmmss")"
Copy-Item $src $dst -Recurse -Force
Write-Host "Backup complete: $dst"`}, { name: "Event Log Errors", lang: "powershell", code: "Get-EventLog -LogName System -Newest 5 -EntryType Error | Select-Object TimeGenerated, Source, Message | Format-List" }].map(n => `<button class="auto-tpl-chip" onclick="loadAutoTemplate(${JSON.stringify(n.lang)},${JSON.stringify(n.code)})">${n.name}</button>`).join("")}
      </div>
    </div>
    <div class="auto-right">
      <div class="auto-out-hdr">
        <span>\u2328 EXECUTION OUTPUT</span>
        <div class="phdr-actions">
          <span id="auto-exec-time" class="meta-txt">\u2014</span>
          <button class="micro-btn" onclick="clearAutoOutput()">CLEAR</button>
          <button class="micro-btn" onclick="analyzeAutoOutput()">ANALYZE</button>
        </div>
      </div>
      <div id="auto-output" class="auto-output">
        <div class="output-placeholder"><span class="op-icon">\u2699</span><span>Execute a script to see output</span></div>
      </div>
    </div>
  </div>`} function initAutoDash() { return [] } window.loadAutoTemplate = function (e, t) { const n = document.getElementById("auto-lang"); n && (n.value = e); const s = document.getElementById("auto-editor"); s && (s.value = t, s.focus()) }, window.runAutoScript = async function () { const e = document.getElementById("auto-editor")?.value?.trim(), t = document.getElementById("auto-output"); if (!e || !t) return; t.innerHTML = '<div class="output-running"><span class="spin-icon">\u2699</span> Running automation\u2026</div>'; const n = document.getElementById("auto-lang")?.value || "powershell", s = await window.jarvis.runCodeSafe(n, e), o = s.time != null ? (s.time / 1e3).toFixed(2) : "?", i = document.getElementById("auto-exec-time"); if (i && (i.textContent = `${o}s`), !s.ok && s.error?.includes("Rate limit")) { const c = document.getElementById("auto-output"); c && (c.innerHTML = `<div class="out-exit err-exit">\u26D4 ${escHtml(s.error)}</div>`), showToast(s.error, "error"); return } if (!document.getElementById("auto-output")) return; let a = ""; s.stdout && (a += `<pre class="auto-out-pre">${escHtml(s.stdout.trimEnd())}</pre>`), s.stderr && (a += `<pre class="auto-out-pre auto-err">${escHtml(s.stderr.trimEnd())}</pre>`), !s.stdout && !s.stderr && (a = '<div class="out-ok">\u2713 Script executed successfully with no output</div>'), a += `<div class="out-exit ${(s.exitCode ?? 0) === 0 ? "" : "err-exit"}">Exit ${s.exitCode ?? 0} \xB7 ${o}s \xB7 ${new Date().toLocaleTimeString()}</div>`, document.getElementById("auto-output").innerHTML = a }, window.clearAutoScript = function () { const e = document.getElementById("auto-editor"); e && (e.value = "") }, window.clearAutoOutput = function () { const e = document.getElementById("auto-output"); e && (e.innerHTML = '<div class="output-placeholder"><span class="op-icon">\u2699</span><span>Execute a script to see output</span></div>') }, window.generateAutoScript = function () { const e = document.getElementById("auto-lang")?.value || "PowerShell"; dashSend(`Write a ${e} automation script. Suggest 5 useful automations and let me choose, or describe what you need.`) }, window.scheduleScript = function () {
  const e = document.getElementById("auto-editor")?.value?.trim(); if (!e) { showToast("Write a script first.", "error"); return } dashSend(`How do I schedule this script to run automatically on Windows using Task Scheduler?\`\`\`powershell
${e}
\`\`\``)
}, window.analyzeAutoOutput = function () {
  const e = document.getElementById("auto-output")?.innerText?.trim(); if (!e || e.includes("Execute a script")) { showToast("Run a script first.", "error"); return } dashSend(`Analyze this script output and explain what it means:\`\`\`
${e}
\`\`\``)
}; function dashBusiness() {
  const e = [{ label: "REVENUE TARGET", value: "$0", progress: 0, color: "#00ff88" }, { label: "GROWTH RATE", value: "0%", progress: 0, color: "#00d4ff" }, { label: "TASKS DONE", value: "0/0", progress: 0, color: "#b86bff" }, { label: "TEAM HEALTH", value: "\u2014", progress: 0, color: "#f59e0b" }], t = JSON.parse(localStorage.getItem("jarvis-kpis") || "null") || e, n = JSON.parse(localStorage.getItem("jarvis-goals") || "[]"), s = JSON.parse(localStorage.getItem("jarvis-swot") || '{"s":"","w":"","o":"","t":""}'), o = t.map((a, c) => `
    <div class="kpi-card" style="--kc:${a.color}">
      <div class="kpi-label">${a.label}</div>
      <div class="kpi-value" contenteditable="true" id="kpi-val-${c}" onblur="saveKPI(${c},this.innerText)">${escHtml(a.value)}</div>
      <div class="kpi-bar-track"><div class="kpi-bar-fill" id="kpi-bar-${c}" style="width:${a.progress}%;background:${a.color}"></div></div>
      <input type="range" class="kpi-slider" min="0" max="100" value="${a.progress}" oninput="updateKPIProg(${c},this.value)">
    </div>`).join(""), i = n.map((a, c) => `
    <div class="goal-item ${a.done ? "done" : ""}">
      <input type="checkbox" ${a.done ? "checked" : ""} onchange="toggleGoal(${c})" id="g-${c}">
      <label for="g-${c}">${escHtml(a.text)}</label>
      <span class="goal-pri goal-${a.priority.toLowerCase()}">${a.priority}</span>
      <button class="item-del" onclick="deleteGoal(${c})">\u2715</button>
    </div>`).join("") || '<div class="list-ph">Add your strategic goals</div>'; return `<div class="mode-dashboard dash-biz">
    <div class="biz-kpi-row">${o}</div>
    <div class="biz-bottom">
      <div class="biz-goals-panel">
        <div class="biz-phdr"><span>\u25B2 STRATEGIC GOALS</span><button class="micro-btn" onclick="askGoalsJarvis()">\u2B21 JARVIS</button></div>
        <div id="goals-list" class="goals-list">${i}</div>
        <div class="biz-add-row">
          <input type="text" id="goal-input" class="list-input" placeholder="Add goal\u2026" onkeydown="if(event.key==='Enter') addGoal()">
          <select id="goal-priority" class="mini-sel"><option>HIGH</option><option selected>MED</option><option>LOW</option></select>
          <button class="dash-btn-sm" onclick="addGoal()">+</button>
        </div>
      </div>
      <div class="biz-swot-panel">
        <div class="biz-phdr"><span>\u25C8 SWOT ANALYSIS</span><div class="phdr-actions"><button class="micro-btn" onclick="analyzeSwot()">\u2B21 ANALYZE</button><button class="micro-btn" onclick="saveSwot()">SAVE</button></div></div>
        <div class="swot-grid">
          <div class="swot-cell swot-s"><div class="swot-label">STRENGTHS</div><textarea id="swot-s" class="swot-ta" placeholder="Internal strengths\u2026">${escHtml(s.s)}</textarea></div>
          <div class="swot-cell swot-w"><div class="swot-label">WEAKNESSES</div><textarea id="swot-w" class="swot-ta" placeholder="Internal weaknesses\u2026">${escHtml(s.w)}</textarea></div>
          <div class="swot-cell swot-o"><div class="swot-label">OPPORTUNITIES</div><textarea id="swot-o" class="swot-ta" placeholder="External opportunities\u2026">${escHtml(s.o)}</textarea></div>
          <div class="swot-cell swot-t"><div class="swot-label">THREATS</div><textarea id="swot-t" class="swot-ta" placeholder="External threats\u2026">${escHtml(s.t)}</textarea></div>
        </div>
      </div>
      <div class="biz-ask-panel">
        <div class="biz-phdr"><span>\u2B21 STRATEGY ADVISOR</span></div>
        <div class="biz-asks">
          <button class="biz-ask-btn" onclick="bizAsk('growth strategy')">Growth Strategy</button>
          <button class="biz-ask-btn" onclick="bizAsk('competitive analysis')">Competitive Analysis</button>
          <button class="biz-ask-btn" onclick="bizAsk('revenue optimization')">Revenue Optimization</button>
          <button class="biz-ask-btn" onclick="bizAsk('market expansion')">Market Expansion</button>
          <button class="biz-ask-btn" onclick="bizAsk('risk assessment and mitigation')">Risk Assessment</button>
          <button class="biz-ask-btn" onclick="bizAsk('fundraising and investor strategy')">Fundraising</button>
        </div>
        <button class="dash-btn dash-btn-yellow fw-btn" onclick="fullBizAnalysis()">\u2B21 FULL STRATEGIC ANALYSIS</button>
      </div>
    </div>
  </div>`} function initBizDash() { return [] } window.saveKPI = function (e, t) { const n = JSON.parse(localStorage.getItem("jarvis-kpis") || "null") || []; n[e] && (n[e].value = t, localStorage.setItem("jarvis-kpis", JSON.stringify(n))) }, window.updateKPIProg = function (e, t) { const n = document.getElementById(`kpi-bar-${e}`); n && (n.style.width = t + "%"); const s = JSON.parse(localStorage.getItem("jarvis-kpis") || "null") || []; s[e] && (s[e].progress = parseInt(t), localStorage.setItem("jarvis-kpis", JSON.stringify(s))) }, window.addGoal = function () { const e = document.getElementById("goal-input"), t = document.getElementById("goal-priority")?.value || "MED"; if (!e?.value?.trim()) return; const n = JSON.parse(localStorage.getItem("jarvis-goals") || "[]"); n.push({ id: Date.now(), text: e.value.trim(), priority: t, done: !1 }), localStorage.setItem("jarvis-goals", JSON.stringify(n)), e.value = "", renderGoals(n) }, window.toggleGoal = function (e) { const t = JSON.parse(localStorage.getItem("jarvis-goals") || "[]"); t[e] && (t[e].done = !t[e].done, localStorage.setItem("jarvis-goals", JSON.stringify(t)), renderGoals(t)) }, window.deleteGoal = function (e) { const t = JSON.parse(localStorage.getItem("jarvis-goals") || "[]"); t.splice(e, 1), localStorage.setItem("jarvis-goals", JSON.stringify(t)), renderGoals(t) }; function renderGoals(e) {
  const t = document.getElementById("goals-list"); t && (t.innerHTML = e.map((n, s) => `
    <div class="goal-item ${n.done ? "done" : ""}">
      <input type="checkbox" ${n.done ? "checked" : ""} onchange="toggleGoal(${s})" id="g-${s}">
      <label for="g-${s}">${escHtml(n.text)}</label>
      <span class="goal-pri goal-${n.priority.toLowerCase()}">${n.priority}</span>
      <button class="item-del" onclick="deleteGoal(${s})">\u2715</button>
    </div>`).join("") || '<div class="list-ph">Add your strategic goals</div>')
} window.saveSwot = function () { const e = { s: document.getElementById("swot-s")?.value || "", w: document.getElementById("swot-w")?.value || "", o: document.getElementById("swot-o")?.value || "", t: document.getElementById("swot-t")?.value || "" }; localStorage.setItem("jarvis-swot", JSON.stringify(e)), showToast("SWOT saved.", "info") }, window.analyzeSwot = function () {
  const e = JSON.parse(localStorage.getItem("jarvis-swot") || "{}"); dashSend(`Analyze my SWOT:
Strengths: ${e.s || "N/A"}
Weaknesses: ${e.w || "N/A"}
Opportunities: ${e.o || "N/A"}
Threats: ${e.t || "N/A"}Provide strategic recommendations.`)
}, window.askGoalsJarvis = function () {
  const e = JSON.parse(localStorage.getItem("jarvis-goals") || "[]"); dashSend(`Review my business goals and suggest prioritization and next steps:${e.map(t => `- [${t.done ? "x" : " "}] ${t.text} (${t.priority})`).join(`
`) || "No goals added yet."}`)
}, window.bizAsk = function (e) { dashSend(`Provide a strategic analysis and recommendations for: ${e}. Be specific and actionable.`) }, window.fullBizAnalysis = function () {
  const e = JSON.parse(localStorage.getItem("jarvis-goals") || "[]"), t = JSON.parse(localStorage.getItem("jarvis-swot") || "{}"); dashSend(`Comprehensive business strategic analysis:Goals: ${e.map(n => n.text).join(", ") || "Not specified"}
Strengths: ${t.s || "Not specified"}
Weaknesses: ${t.w || "Not specified"}
Opportunities: ${t.o || "Not specified"}
Threats: ${t.t || "Not specified"}Provide: situation analysis, strategic priorities, 90-day action plan, KPIs to track, risk mitigation.`)
}; function dashCreative() {
  const e = localStorage.getItem("jarvis-creative-content") || ""; return `<div class="mode-dashboard dash-creative">
    <div class="creative-topbar">
      <div class="creative-topbar-left">
        <select id="creative-format" class="dash-select">
          <option>Blog Post</option><option>Email</option><option>Tweet Thread</option>
          <option>LinkedIn Post</option><option>Product Description</option><option>Short Story</option>
          <option>Marketing Copy</option><option>Cover Letter</option><option>Press Release</option><option>Script</option>
        </select>
        <select id="creative-tone" class="dash-select">
          <option value="professional">Professional</option>
          <option value="casual and friendly">Casual & Friendly</option>
          <option value="witty and humorous">Witty & Humorous</option>
          <option value="inspiring and motivational">Inspiring</option>
          <option value="dramatic">Dramatic</option>
          <option value="authoritative">Authoritative</option>
        </select>
        <input type="text" id="creative-subject" class="creative-subject" placeholder="Topic, subject, or brief\u2026">
      </div>
      <div class="creative-topbar-right">
        <span id="creative-wc" class="wc-badge">0 words</span>
        <button class="dash-btn dash-btn-pink" onclick="generateCreative()">\u2726 GENERATE</button>
        <button class="dash-btn" onclick="improveCreative()">\u25CE IMPROVE</button>
        <button class="dash-btn" onclick="sparkIdea()">\u26A1 SPARK</button>
        <button class="dash-btn" onclick="copyCreative()">\u2398 COPY</button>
        <button class="dash-btn" onclick="clearCreative()">\u2298 CLEAR</button>
      </div>
    </div>
    <div class="creative-workspace">
      <textarea id="creative-editor" class="creative-ta" oninput="updateWordCount()"
        placeholder="Start writing here\u2026&#10;&#10;Or use:&#10;\u2726 GENERATE \u2014 create from scratch&#10;\u25CE IMPROVE \u2014 enhance existing text&#10;\u26A1 SPARK  \u2014 get creative ideas">${escHtml(e)}</textarea>
    </div>
    <div class="creative-footer">
      <div class="creative-ideas-panel">
        <div class="ci-hdr"><span>\u2726 IDEA SPARKS</span><button class="micro-btn" onclick="sparkIdea()">GENERATE</button></div>
        <div id="creative-ideas" class="creative-ideas"><div class="list-ph">Click SPARK to generate creative ideas</div></div>
      </div>
    </div>
  </div>`} function initCreativeDash() { updateWordCount(); const e = document.getElementById("creative-editor"); return e && e.addEventListener("input", () => { localStorage.setItem("jarvis-creative-content", e.value), updateWordCount() }), [] } window.updateWordCount = function () { const e = document.getElementById("creative-editor")?.value || "", t = e.trim() ? e.trim().split(/\s+/).length : 0, n = document.getElementById("creative-wc"); n && (n.textContent = `${t} words \xB7 ${e.length} chars`) }, window.generateCreative = function () {
  const e = document.getElementById("creative-format")?.value || "content", t = document.getElementById("creative-tone")?.value || "professional", n = document.getElementById("creative-subject")?.value?.trim() || "a compelling topic"; dashSend(`Write a ${e} about: "${n}"
Tone: ${t}
Make it complete, compelling, and publication-ready.`)
}, window.improveCreative = function () { const e = document.getElementById("creative-editor")?.value?.trim(); if (!e) { showToast("Write something first, then improve it.", "error"); return } const t = document.getElementById("creative-tone")?.value || "professional"; dashSend(`Improve this content \u2014 make it more compelling, better structured, and ${t}. Show the improved version:${e}`) }, window.sparkIdea = function () { const e = document.getElementById("creative-format")?.value || "content", t = document.getElementById("creative-subject")?.value?.trim(); dashSend(t ? `Generate 5 creative angles for a ${e} about "${t}". Be specific and original.` : `Give me 5 original ${e} ideas that are compelling right now. Be specific.`) }, window.copyCreative = function () { const e = document.getElementById("creative-editor")?.value; if (!e?.trim()) { showToast("Nothing to copy.", "error"); return } navigator.clipboard.writeText(e).then(() => showToast("Copied to clipboard!", "success")) }, window.clearCreative = function () { const e = document.getElementById("creative-editor"); e && (e.value = "", updateWordCount(), localStorage.removeItem("jarvis-creative-content")) }; function setupEventListeners() { $sendBtn.onclick = sendMessage, $input.addEventListener("keydown", t => { t.key === "Enter" && !t.shiftKey && (t.preventDefault(), sendMessage()) }), $input.addEventListener("input", () => { autoResizeInput(); const t = document.getElementById("char-count"); t && (t.textContent = $input.value.length > 0 ? `${$input.value.length} chars` : "") }), $ttsBtn.onclick = toggleTTS, document.getElementById("btn-history").onclick = openHistory, document.getElementById("btn-settings").onclick = () => { populateSettingsModal(), openModal("settings-modal") }, $termInput.addEventListener("keydown", async t => { if (t.key === "Enter") { const n = $termInput.value.trim(); $termInput.value = "", await runTerminalCommand(n) } t.key === "ArrowUp" && (t.preventDefault(), state.termHistoryIdx = Math.min(state.termHistoryIdx + 1, state.terminalHistory.length - 1), $termInput.value = state.terminalHistory[state.termHistoryIdx] || ""), t.key === "ArrowDown" && (t.preventDefault(), state.termHistoryIdx = Math.max(state.termHistoryIdx - 1, -1), $termInput.value = state.termHistoryIdx >= 0 ? state.terminalHistory[state.termHistoryIdx] : "") }); const e = document.getElementById("chat-area"); e.addEventListener("scroll", () => { const { scrollTop: t, scrollHeight: n, clientHeight: s } = e; state.autoScroll = n - t - s < 80 }), window.jarvis.onWindowState(t => { const n = document.getElementById("btn-max"); n && (n.textContent = t === "maximized" ? "\u2750" : "\u25A1") }), document.addEventListener("keydown", t => { t.key === "Escape" && document.querySelectorAll(".modal:not([hidden])").forEach(n => { n.hidden = !0 }) }) } function openModal(e) { const t = document.getElementById(e); t && (t.hidden = !1) } function closeModal(e) { const t = document.getElementById(e); t && (t.classList.add("closing"), setTimeout(() => { t.hidden = !0, t.classList.remove("closing") }, 250)) } window.closeModal = closeModal, window.confirmPowerOff = function () { openModal("poweroff-modal") }, window.executePowerOff = async function () { const e = document.querySelector(".power-btn-confirm"); e && (e.textContent = "\u23FB Shutting down\u2026", e.disabled = !0); try { await saveSession() } catch { } showToast("Shutting down JARVIS... Goodbye, sir.", "info"); const t = document.getElementById("shutdown-screen"); t ? (t.classList.remove("hidden"), t.classList.add("active"), setTimeout(() => window.jarvis.quitApp(), 2500)) : setTimeout(() => window.jarvis.quitApp(), 1200) }; function escHtml(e) { return String(e).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") } function formatTime(e) { return (e ? new Date(e) : new Date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) } function pad(e) { return String(e).padStart(2, "0") } function scrollToBottom(force = false, animate = false) {
  if (state.autoScroll || force) {
    const chatArea = document.getElementById('chat-area');
    if (chatArea) chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: animate ? 'smooth' : 'auto' });
  }
} function autoResizeInput() { $input.style.height = "auto", $input.style.height = Math.min($input.scrollHeight, 150) + "px" } let toastTimer = null, toastHideTimer = null; function showToast(e, t = "info") { const n = document.getElementById("toast"); n && (n.textContent = e, n.className = `show ${t}`, clearTimeout(toastTimer), clearTimeout(toastHideTimer), toastTimer = setTimeout(() => { n.classList.add("hide"), toastHideTimer = setTimeout(() => { n.className = "" }, 300) }, 3200)) } function toggleHamburger() { const e = document.getElementById("btn-hamburger"), t = document.getElementById("hamburger-menu"); if (t) { if (!t.hidden) { closeHamburger(); return } t.hidden = !1, e.classList.add("open"), setTimeout(() => document.addEventListener("click", _hamOutsideClick, { once: !0 }), 10) } } window.toggleHamburger = toggleHamburger; function closeHamburger() { const e = document.getElementById("btn-hamburger"), t = document.getElementById("hamburger-menu"), n = document.getElementById("git-confirm-panel"); t && (t.hidden = !0), n && (n.hidden = !0), e && e.classList.remove("open") } window.closeHamburger = closeHamburger; function _hamOutsideClick(e) { const t = document.getElementById("hamburger-wrap"); t && !t.contains(e.target) && closeHamburger() } const GIT_BLOCKED_PATTERNS = ["--force", "--force-with-lease", "reset --hard", "clean -f", "clean -fd", "branch -d", "branch -D", "push origin --delete", "filter-branch", "rm -rf"], GIT_SAFE_CMDS = { status: "git status", log: "git log --oneline -15 --decorate --color=never", diff: "git diff --stat", branch: "git branch -a" }; function getGitCwd() { return state.projectContext?.rootPath || null } window.gitAction = function (e) { if (GIT_SAFE_CMDS[e]) { closeHamburger(), runGitCommand(GIT_SAFE_CMDS[e], getGitCwd(), e.toUpperCase()); return } showGitConfirm(e) }; function showGitConfirm(e) {
  const t = document.getElementById("hamburger-menu"); t && (t.hidden = !0); const s = { pull: { title: "\u2B07\uFE0F Git Pull", desc: "Pull latest changes from remote into current branch.", input: !1, cmd: "git pull" }, push: { title: "\u2B06\uFE0F Git Push", desc: "Type <b>CONFIRM</b> to push to remote.", input: !0, placeholder: "Type CONFIRM\u2026" }, "add-commit": { title: "\u2705 Add & Commit", desc: "Stage all changes. Enter commit message below.", input: !0, placeholder: "Commit message\u2026" } }[e]; if (!s) return; let o = document.getElementById("git-confirm-panel"); o || (o = document.createElement("div"), o.id = "git-confirm-panel", document.getElementById("hamburger-wrap").appendChild(o)), o.innerHTML = `
    <div class="gcp-title">${s.title}</div>
    <div class="gcp-desc">${s.desc}</div>
    ${s.input ? `<input class="gcp-input" id="gcp-field" placeholder="${s.placeholder || ""}" autocomplete="off">` : ""}
    <div class="gcp-btns">
      <button class="gcp-cancel" onclick="closeHamburger()">\u2715 Cancel</button>
      <button class="gcp-run" onclick="executeGitConfirm('${e}')">\u25B6 Run</button>
    </div>`, o.hidden = !1, setTimeout(() => { const i = document.getElementById("gcp-field"); i && i.focus() }, 50)
} window.executeGitConfirm = function (e) { const t = getGitCwd(), n = (document.getElementById("gcp-field")?.value || "").trim(); if (e === "push") { if (n !== "CONFIRM") { showToast("\u26D4 Type CONFIRM exactly to push.", "error"); return } closeHamburger(), runGitCommand("git push", t, "PUSH") } else if (e === "pull") closeHamburger(), runGitCommand("git pull", t, "PULL"); else if (e === "add-commit") { if (!n) { showToast("\u26D4 Enter a commit message.", "error"); return } const s = n.replace(/["`$\\]/g, "").slice(0, 200); closeHamburger(), runGitCommand(`git add -A && git commit -m "${s}"`, t, "COMMIT") } }; async function runGitCommand(e, t, n) {
  const s = e.toLowerCase(); if (GIT_BLOCKED_PATTERNS.some(r => s.includes(r))) { showToast("\u26D4 Destructive command blocked by JARVIS safety policy.", "error"); return } showToast(`\u{1F500} Running git ${n}\u2026`, "info"); let o; try { o = await window.jarvis.runCommand(e, t) } catch (r) { appendJarvisMessage(`\u274C Git error: ${r.message}`); return } const i = o.stdout?.trim(), a = o.stderr?.trim(), c = [i ? `\`\`\`
${i}
\`\`\``: "", a ? `\u26A0\uFE0F \`${a}\`` : ""].filter(Boolean).join(""); appendJarvisMessage(`**\u{1F500} git ${n}**${t ? ` \`(${t.split(/[\\/]/).pop()})\`` : ""}${c || "_(no output)_"}`), showToast(o.exitCode === 0 ? `\u2705 git ${n} complete` : `\u26A0\uFE0F git ${n} exited ${o.exitCode}`, o.exitCode === 0 ? "success" : "error")
} const FDROP_ALLOWED = new Set(["py", "js", "ts", "jsx", "tsx", "html", "css", "json", "md", "txt", "yaml", "yml", "toml", "sh", "ps1", "bat", "sql", "csv", "xml", "java", "cpp", "c", "h", "rs", "go", "rb", "php", "swift", "kt", "vue", "svelte", "scss", "sass", "less", "gitignore", "dockerfile", "makefile", "ini", "cfg", "conf", "log", "env"]), FDROP_MAX_BYTES = 512 * 1024, FDROP_MAX_FILES = 5, FDROP_BAD_PATHS = ["\\windows\\", "\\system32\\", "\\program files\\"]; function setupFileDrop() {
  const e = document.getElementById("chat-panel"); if (!e || document.getElementById("drop-overlay")) return; const t = document.createElement("div"); t.id = "drop-overlay", t.innerHTML = `<div class="drop-inner">
    <span class="drop-icon">\u{1F4C1}</span>
    <span class="drop-label">DROP FILES TO ANALYZE</span>
    <span class="drop-sub">Max 5 files \xB7 500KB each \xB7 Code &amp; text only</span>
  </div>`, e.appendChild(t); let n = 0; document.addEventListener("dragenter", s => { s.preventDefault(), ++n === 1 && t.classList.add("visible") }), document.addEventListener("dragleave", () => { --n === 0 && t.classList.remove("visible") }), document.addEventListener("dragover", s => s.preventDefault()), document.addEventListener("drop", async s => { s.preventDefault(), n = 0, t.classList.remove("visible"); const o = Array.from(s.dataTransfer.files).slice(0, FDROP_MAX_FILES); for (const i of o) await handleDroppedFile(i) })
} async function handleDroppedFile(e) {
  const t = e.name, n = t.split(".").pop().toLowerCase(), s = e.path || ""; if (FDROP_BAD_PATHS.some(r => s.toLowerCase().includes(r))) { showToast(`\u26D4 System path blocked \u2014 ${t}`, "error"); return } if (!FDROP_ALLOWED.has(n)) { showToast(`\u26D4 .${n} files not allowed \u2014 ${t}`, "error"); return } if (e.size > FDROP_MAX_BYTES) { showToast(`\u26D4 File too large (max 500KB) \u2014 ${t}`, "error"); return } let o; try { const r = await window.jarvis.readFile(s); if (!r.ok) throw new Error(r.error); o = r.data } catch (r) { showToast(`\u274C Cannot read ${t}: ${r.message}`, "error"); return } if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(o.slice(0, 512))) { showToast(`\u26D4 Binary file rejected \u2014 ${t}`, "error"); return } const i = { js: "javascript", ts: "typescript", py: "python", html: "html", css: "css", json: "json", md: "markdown", sh: "bash", ps1: "powershell", sql: "sql", java: "java", cpp: "cpp", c: "c", rs: "rust", go: "go", rb: "ruby", php: "php" }[n] || n, a = o.length > 12e3, c = `\u{1F4C1} **File: \`${t}\`** (${formatBytes(e.size)})\`\`\`${i}
${o.slice(0, 12e3)}
\`\`\`${a ? "_\u26A0\uFE0F Truncated to 12KB._" : ""}`; showToast(`\u{1F4C1} ${t} loaded`, "info"), sendMessage(c)
} function formatBytes(e) { return e < 1024 ? `${e} B` : e < 1048576 ? `${(e / 1024).toFixed(1)} KB` : `${(e / 1048576).toFixed(2)} MB` } window.loadProject = async function () { showToast("\u{1F4E6} Opening folder picker\u2026", "info"); try { const e = await window.jarvis.openFolderDialog(); if (!e?.ok || !e.path) { showToast("No folder selected.", "info"); return } showToast(`\u{1F4E6} Scanning ${e.path.split(/[\\/]/).pop()}\u2026`, "info"); const t = await window.jarvis.readProject(e.path); if (!t.ok) { showToast(`\u274C ${t.error}`, "error"); return } state.projectContext = { rootPath: e.path, name: e.path.split(/[\\/]/).pop(), ...t }, updateProjectBadge(), appendJarvisMessage(`\u{1F4E6} **Project loaded: \`${state.projectContext.name}\`**- **${t.fileCount} files** \xB7 ${formatBytes(t.totalBytes)}I now have full context of your project. Ask me anything about it.`), showToast(`\u2705 ${t.fileCount} files loaded`, "success") } catch (e) { showToast(`\u274C ${e.message}`, "error") } }, window.clearProject = function () { state.projectContext = null, updateProjectBadge(), showToast("\u{1F4E6} Project context cleared.", "info") }; function updateProjectBadge() { let e = document.getElementById("project-badge"); state.projectContext ? (e || (e = document.createElement("div"), e.id = "project-badge", e.className = "project-badge", e.title = "Click to clear project context", e.onclick = () => window.clearProject(), document.getElementById("top-left").appendChild(e)), e.innerHTML = `\u{1F4E6} <span>${state.projectContext.name}</span><span class="pb-count">${state.projectContext.fileCount}f</span><span class="pb-x">\u2715</span>`) : e && e.remove() } state.memory = []; async function memoryInit() { try { const e = await window.jarvis.memoryLoad(); state.memory = e.facts || [] } catch { state.memory = [] } } async function memorySave() { try { await window.jarvis.memorySave(state.memory) } catch { } } window.memoryAdd = async function () { const e = document.getElementById("mem-input"), t = e?.value?.trim(); if (t) { if (state.memory.length >= 30) { showToast("Memory full (30 facts max). Remove some first.", "error"); return } state.memory.push(t), await memorySave(), e.value = "", renderMemory(), showToast("\u{1F9E0} Memory updated", "success") } }, window.memoryDelete = async function (e) { state.memory.splice(e, 1), await memorySave(), renderMemory() }, window.renderMemory = function () {
  const e = document.getElementById("mem-list"); if (e) {
    if (!state.memory.length) { e.innerHTML = '<div class="mem-empty">\u{1F9E0} No memories yet. Add facts about yourself below.</div>'; return } e.innerHTML = state.memory.map((t, n) => `
    <div class="mem-item">
      <span class="mem-item-icon">\u25C8</span>
      <span class="mem-item-text">${t}</span>
      <button class="mem-item-del" onclick="memoryDelete(${n})" title="Remove">\u2715</button>
    </div>`).join("")
  }
}; function getMemoryPrefix() {
  return state.memory.length ? `[USER MEMORY \u2014 always remember these facts about the user]
${state.memory.map(e => `\u2022 ${e}`).join(`
`)}
[END MEMORY]`: ""
} document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", _initMemoryUI, { once: !0 }) : _initMemoryUI(); function _initMemoryUI() { const e = document.getElementById("mem-input"); e && !e.dataset.bound && (e.dataset.bound = "1", e.addEventListener("keydown", t => { t.key === "Enter" && window.memoryAdd() })), memoryInit() } const CMD_LIST = [{ group: "SWITCH MODE", icon: "\u2B21", name: "General Mode", shortcut: "G", action: () => setMode("general") }, { group: "SWITCH MODE", icon: "\u{1F4BB}", name: "Code Mode", shortcut: "C", action: () => setMode("code") }, { group: "SWITCH MODE", icon: "\u{1F41B}", name: "Debug Mode", shortcut: "D", action: () => setMode("debug") }, { group: "SWITCH MODE", icon: "\u{1F52C}", name: "Research Mode", shortcut: "R", action: () => setMode("research") }, { group: "SWITCH MODE", icon: "\u26A1", name: "Automation Mode", shortcut: "A", action: () => setMode("automation") }, { group: "SWITCH MODE", icon: "\u{1F4C8}", name: "Business Mode", shortcut: "B", action: () => setMode("business") }, { group: "SWITCH MODE", icon: "\u{1F3A8}", name: "Creative Mode", shortcut: "X", action: () => setMode("creative") }, { group: "SWITCH MODE", icon: "\u26A1", name: "Productivity Mode", shortcut: "P", action: () => setMode("productivity") }, { group: "ACTIONS", icon: "\u{1F195}", name: "New Session", shortcut: "", action: () => newSession() }, { group: "ACTIONS", icon: "\u{1F5D1}\uFE0F", name: "Clear Chat", shortcut: "", action: () => clearCurrentChat() }, { group: "ACTIONS", icon: "\u{1F4E6}", name: "Load Project", shortcut: "", action: () => window.loadProject() }, { group: "ACTIONS", icon: "\u{1F9E0}", name: "Open Memory", shortcut: "", action: () => { openModal("memory-modal"), renderMemory() } }, { group: "ACTIONS", icon: "\u{1F3A4}", name: "Toggle Wake Word", shortcut: "", action: () => toggleWakeWord() }, { group: "ACTIONS", icon: "\u{1F4DC}", name: "Git Log", shortcut: "", action: () => gitAction("log") }, { group: "ACTIONS", icon: "\u{1F4CB}", name: "Git Status", shortcut: "", action: () => gitAction("status") }, { group: "ACTIONS", icon: "\u2193", name: "Export Chat", shortcut: "", action: () => exportChat() }, { group: "ACTIONS", icon: "\u2699\uFE0F", name: "Settings", shortcut: "", action: () => openModal("settings-modal") }, { group: "ACTIONS", icon: "\u23FB", name: "Power Off", shortcut: "", action: () => window.confirmPowerOff() }, { group: "\u{1F3A8} THEMES", icon: "\u2B21", name: "Theme: Iron Man (Default Cyan)", shortcut: "", action: () => applyTheme("ironman") }, { group: "\u{1F3A8} THEMES", icon: "\u2620", name: "Theme: Phantom (Blood Red)", shortcut: "", action: () => applyTheme("phantom") }, { group: "\u{1F3A8} THEMES", icon: "\u229E", name: "Theme: Matrix (Terminal Green)", shortcut: "", action: () => applyTheme("matrix") }, { group: "\u{1F3A8} THEMES", icon: "\u2726", name: "Theme: Nova (Deep Space Purple)", shortcut: "", action: () => applyTheme("nova") }, { group: "\u{1F3A8} THEMES", icon: "\u25C8", name: "Theme: Ghost (Light Military)", shortcut: "", action: () => applyTheme("ghost") }]; let cmdActiveIdx = 0, cmdFiltered = [...CMD_LIST]; function openCmdPalette() { const e = document.getElementById("cmd-palette"), t = document.getElementById("cmd-input"); e && (e.hidden = !1, cmdActiveIdx = 0, cmdFiltered = [...CMD_LIST], renderCmdResults(""), setTimeout(() => t?.focus(), 30)) } window.openCmdPalette = openCmdPalette; function closeCmdPalette() { const e = document.getElementById("cmd-palette"); e && (e.hidden = !0) } window.closeCmdPalette = closeCmdPalette; function renderCmdResults(e) {
  const t = e.toLowerCase().trim(); cmdFiltered = t ? CMD_LIST.filter(i => i.name.toLowerCase().includes(t) || i.group.toLowerCase().includes(t)) : [...CMD_LIST], cmdActiveIdx = 0; const n = document.getElementById("cmd-results"); if (!n) return; if (!cmdFiltered.length) { n.innerHTML = '<div class="cmd-empty">No commands found</div>'; return } let s = "", o = ""; cmdFiltered.forEach((i, a) => {
    i.group !== o && (s += `<div class="cmd-group-label">${i.group}</div>`, o = i.group), s += `<button class="cmd-item${a === 0 ? " active" : ""}" data-idx="${a}" onclick="runCmdItem(${a})">
      <span class="cmd-item-icon">${i.icon}</span>
      <span class="cmd-name">${i.name}</span>
      ${i.shortcut ? `<span class="cmd-shortcut">${i.shortcut}</span>` : ""}
    </button>`}), n.innerHTML = s
} window.runCmdItem = function (e) { const t = cmdFiltered[e]; t && (closeCmdPalette(), setTimeout(() => t.action(), 80)) }, document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(), document.getElementById("cmd-palette")?.hidden === !1 ? closeCmdPalette() : openCmdPalette(); return } const t = document.getElementById("cmd-palette"); if (!(!t || t.hidden)) { if (e.key === "Escape") { closeCmdPalette(); return } e.key === "ArrowDown" ? (e.preventDefault(), cmdActiveIdx = Math.min(cmdActiveIdx + 1, cmdFiltered.length - 1), updateCmdActive()) : e.key === "ArrowUp" ? (e.preventDefault(), cmdActiveIdx = Math.max(cmdActiveIdx - 1, 0), updateCmdActive()) : e.key === "Enter" && (e.preventDefault(), window.runCmdItem(cmdActiveIdx)) } }); function updateCmdActive() { document.querySelectorAll(".cmd-item").forEach((e, t) => { e.classList.toggle("active", t === cmdActiveIdx), t === cmdActiveIdx && e.scrollIntoView({ block: "nearest" }) }) } document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", _initCmdInput, { once: !0 }) : _initCmdInput(); function _initCmdInput() { const e = document.getElementById("cmd-input"); e && !e.dataset.bound && (e.dataset.bound = "1", e.addEventListener("input", t => renderCmdResults(t.target.value))) } window.toggleWakeWord = function () { WakeWord.toggle() }; let gpuPollInterval = null; async function pollGPU() { try { const e = await window.jarvis.runCommand("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits", null); if (!e.ok || !e.stdout?.trim()) return; const t = e.stdout.trim().split(",").map(h => h.trim()); if (t.length < 5) return; const n = parseInt(t[0]) || 0, s = parseInt(t[1]) || 0, o = parseInt(t[2]) || 6144, i = parseInt(t[3]) || 0, a = t.slice(4).join(",").trim().replace("NVIDIA GeForce ", ""), c = Math.round(s / o * 100), r = Math.min(Math.round(i / 95 * 100), 100), l = document.getElementById("gpu-util-bar"), p = document.getElementById("gpu-util-val"); l && (l.style.width = `${n}%`, l.className = `gpu-bar-fill${n > 80 ? " hot" : n > 50 ? " warm" : ""}`), p && (p.textContent = `${n}%`); const g = document.getElementById("gpu-mem-bar"), d = document.getElementById("gpu-mem-val"); g && (g.style.width = `${c}%`, g.className = `gpu-bar-fill${c > 85 ? " hot" : c > 60 ? " warm" : ""}`), d && (d.textContent = `${s}/${o}MB`); const u = document.getElementById("gpu-temp-bar"), m = document.getElementById("gpu-temp-val"); u && (u.style.width = `${r}%`, u.className = `gpu-bar-fill${i > 80 ? " hot" : i > 65 ? " warm" : ""}`), m && (m.textContent = `${i}\xB0C`, m.className = `gpu-temp-val${i > 80 ? " hot" : i > 65 ? " warm" : ""}`); const v = document.getElementById("gpu-name-val"); v && a && (v.textContent = a) } catch { } } function startGPUMonitor() { gpuPollInterval || (pollGPU(), gpuPollInterval = setInterval(pollGPU, 15e3)) } (function () { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", () => { setupFileDrop(), startGPUMonitor() }, { once: !0 }) : (setupFileDrop(), startGPUMonitor()) })(); const WEB_SEARCH_PATTERNS = [/\b(today|tonight|right now|this week|this month|this year|latest|recent|breaking|live|real.?time)\b/i, /\b(news|headlines|happening|update|event|story|report|announce|declare)\b/i, /\b(world|global|international|country|countries|politics|election|war|conflict|summit|protest|disaster)\b/i, /\b(trending|viral|popular|hot topic|who won|who is leading|score|result|outcome)\b/i, /\b(in 202[4-9]|202[4-9])\b/i, /\b(what is the price|stock price|weather|exchange rate|who is the current|who is president|prime minister|ceo of|founded when)\b/i]; function queryNeedsWebSearch(e) { return WEB_SEARCH_PATTERNS.some(t => t.test(e)) } function detectSearchType(e) { return /\b(news|headlines|breaking|today|happening|event|politics|election|war|conflict|protest)\b/i.test(e) ? "news" : /\b(who is|what is|price|stock|weather|capital|population|definition|explain|history of)\b/i.test(e) ? "fact" : "auto" } function buildWebSearchContext(e, t, n) {
  if (!e || !e.length) return '';

  // M-4 fix: strip prompt-injection patterns from web content before it
  // enters the system prompt. A malicious site cannot insert TOOL_CALL
  // markers or SYSTEM overrides through its meta description this way.
  function sanitizeSearchText(str) {
    if (!str) return '';
    return str
      // Strip HTML tags that may have survived server-side stripping
      .replace(/<[^>]+>/g, ' ')
      // Strip known LLM prompt-injection attack phrases
      .replace(/ignore\s+(previous|all|above)\s+(instructions?|prompts?|context)/gi, '[FILTERED]')
      .replace(/<<<\s*TOOL_CALL\s*>>>/gi, '[FILTERED]')
      .replace(/<<<\s*END_TOOL_CALL\s*>>>/gi, '[FILTERED]')
      .replace(/\[SYSTEM\]/gi, '[FILTERED]')
      .replace(/\[DIRECTIVE\]/gi, '[FILTERED]')
      .replace(/\[USER MEMORY\]/gi, '[FILTERED]')
      .replace(/\[END\s+\w+\]/gi, '[FILTERED]')
      .replace(/you\s+are\s+now\s+(?:a\s+)?(?:jarvis|an?\s+ai)/gi, '[FILTERED]')
      .replace(/act\s+as\s+(?:a\s+)?(?:different|another|new)\s+(?:ai|assistant|model)/gi, '[FILTERED]')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Budget: max 2500 chars total across all results (M-4 fix — prevents context hijack)
  const MAX_TOTAL = 2500;
  const MAX_TITLE = 120;
  const MAX_DESC  = 400;

  let o = `[WEB SEARCH RESULTS \u2014 fetched live at ${new Date(n).toUTCString()}]\nQuery: "${sanitizeSearchText(t)}"`;
  let budget = MAX_TOTAL;
  e.forEach((i, a) => {
    if (budget <= 0) return;
    const title = sanitizeSearchText(i.title || '').slice(0, MAX_TITLE);
    const desc  = sanitizeSearchText(i.desc  || '').slice(0, MAX_DESC);
    const url   = (i.url || '').replace(/[<>"]/g, '').slice(0, 200);
    const date  = (i.pubDate || '').slice(0, 40);
    const block = `${a + 1}. **${title}**\n${desc ? `   ${desc}\n` : ''}${url ? `   Source: ${url}\n` : ''}${date ? `   Date: ${date}\n` : ''}\n`;
    o += block;
    budget -= block.length;
  });
  o += '[END WEB RESULTS]IMPORTANT: Use ONLY the above live results for your answer. Do not use training data for current events. Cite source URLs. Never fabricate news.';
  return o;
} function renderSourceChips(e) {
  if (!e || !e.length) return ""; const t = { "Google News": "\u{1F4F0}", "BBC News": "\u{1F310}", DuckDuckGo: "\u{1F986}" }; return `<div class="source-chips-wrap">
    <span class="source-chips-label">\u{1F310} Live Sources</span>
    <div class="source-chips-list">${e.filter(s => s.url && s.title).slice(0, 8).map(s => {
    const o = t[s.engine] || "\u{1F517}", i = (() => { try { return new URL(s.url).hostname.replace("www.", "") } catch { return s.engine || "Web" } })(), a = escHtml(s.title.slice(0, 60)), c = s.pubDate ? ` \xB7 ${new Date(s.pubDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "", r = escHtml(s.url); return `<button class="source-chip" onclick="window.jarvis.openExternal(${JSON.stringify(s.url)})" title="${r}">
        <span class="source-chip-favicon">${o}</span>
        <span class="source-chip-info">
          <span class="source-chip-title">${a}</span>
          <span class="source-chip-meta">${escHtml(i)}${c}</span>
        </span>
        <span class="source-chip-open">\u2197</span>
      </button>`}).join("")}</div>
  </div>`} function showSearchingIndicator() { const e = document.createElement("div"); e.className = "web-searching-row", e.id = "web-searching-row", e.innerHTML = '<span class="web-searching-spinner"></span><span>JARVIS is searching the web for live data\u2026</span>', $messages?.appendChild(e), scrollToBottom?.(); const t = document.getElementById("web-search-indicator"); return t && t.classList.add("active"), e } function hideSearchingIndicator(e) { e?.remove(); const t = document.getElementById("web-search-indicator"); t && t.classList.remove("active") } state.lastWebResults = null; const _origSendMessage = sendMessage; window.sendMessage = sendMessage, state.webSearchContext = null; async function sendMessageWithSearch(e) { const t = (e !== void 0 ? String(e) : $input?.value || "").trim(); if (!(!t || state.isStreaming)) { if (queryNeedsWebSearch(t)) { const n = showSearchingIndicator(); e === void 0 && ($input.value = "", autoResizeInput?.()); try { const s = detectSearchType(t), o = await window.jarvis.webSearch(t, s); hideSearchingIndicator(n), o.ok && o.results?.length ? (state.webSearchContext = buildWebSearchContext(o.results, o.query, o.fetchedAt), state.lastWebResults = o.results, showToast(`\u{1F310} Found ${o.results.length} live sources`, "success")) : (showToast("\u26A0 Web search unavailable \u2014 using training data", "warning"), state.webSearchContext = null, state.lastWebResults = null) } catch { hideSearchingIndicator(n), state.webSearchContext = null, state.lastWebResults = null } return $input && e === void 0 && ($input.value = t), _origSendMessage(t) } return _origSendMessage(e) } } window._patchedFinalize = !0; const _fe = finalizeStreamingEl; window._patchedFinalize, document.addEventListener("DOMContentLoaded", () => { const e = document.getElementById("send-btn"), t = document.getElementById("user-input"); e && e.addEventListener("click", n => { n.stopImmediatePropagation(), n.preventDefault(), sendMessageWithSearch() }), t && t.addEventListener("keydown", n => { n.key === "Enter" && !n.shiftKey && !state.isStreaming && (n.preventDefault(), n.stopImmediatePropagation(), sendMessageWithSearch()) }, { capture: !0 }) }, { once: !0 }), window.sendMessageWithSearch = sendMessageWithSearch; async function analyzeImage() {
  if (!window.getImgB64()) { showToast("No image selected", "error"); return } const e = document.getElementById("img-prompt-inp")?.value.trim() || "Describe this image in detail."; if (closeModal("img-modal"), ["llava", "bakllava", "moondream", "cogvlm", "minicpm-v", "qwen-vl", "internvl"].some(s => state.model.toLowerCase().includes(s))) {
    showToast("\u{1F5BC} Sending image to JARVIS (vision mode)\u2026", "info"); const s = new Date().toISOString(), o = `[Image Analysis Request]
${e}`; state.conversations[state.mode].messages.push({ role: "user", content: o, timestamp: s }), appendUserMessage(`\u{1F5BC} Image attached \u2014 ${e}`, s), state.isStreaming = !0, $sendBtn.disabled = !0, setWaveformActive(!0); const i = createStreamingMessage(), a = buildMessages(), c = { role: "user", content: o, images: [window.getImgB64()] }; a.push(c), await streamOllama(a, { onChunk: (r, l) => updateStreamingEl(i, l), onDone: r => { finalizeStreamingEl(i, r); const l = new Date().toISOString(); state.conversations[state.mode].messages.push({ role: "assistant", content: r, timestamp: l }), saveSession(), state.ttsEnabled && r && speakText(extractPlainText(r)), setWaveformActive(!1), state.isStreaming = !1, $sendBtn.disabled = !1, window.clearImgState() }, onError: r => { finalizeStreamingEl(i, `\u26A0 **Vision Error**\`${r.message}\`Ensure \`${state.model}\` is a vision-capable model.`), setWaveformActive(!1), state.isStreaming = !1, $sendBtn.disabled = !1 } })
  } else {
    const s = `[Image Analysis Request \u2014 model: ${state.model}]
${e}\u26A0 Note: ${state.model} is not a vision model. Switch to llava or moondream for real image analysis. Responding based on prompt only.`; injectPrompt(s), showToast(`\u26A0 ${state.model} is not a vision model. Use llava for real image analysis.`, "warning"), window.clearImgState()
  }
} window.analyzeImage = analyzeImage, setTimeout(() => { typeof CMD_LIST < "u" && CMD_LIST.push({ group: "\u{1F6E0} TOOLS", icon: "\u{1F50D}", name: "Search Chat (Ctrl+F)", shortcut: "", action: () => openChatSearch() }, { group: "\u{1F6E0} TOOLS", icon: "\u{1F4DD}", name: "Prompt Library (Ctrl+P)", shortcut: "", action: () => openPromptLibrary() }, { group: "\u{1F6E0} TOOLS", icon: "\u29C9", name: "Snippet Manager", shortcut: "", action: () => openSnippetManager() }, { group: "\u{1F6E0} TOOLS", icon: "\u{1F4D3}", name: "Notes Scratchpad (Ctrl+N)", shortcut: "", action: () => openNotes() }, { group: "\u{1F6E0} TOOLS", icon: "\u{1F310}", name: "API Tester (Ctrl+T)", shortcut: "", action: () => openApiTester() }, { group: "\u{1F6E0} TOOLS", icon: "\u{1F5BC}", name: "Image Analysis", shortcut: "", action: () => openImageAnalysis() }, { group: "\u{1F6E0} TOOLS", icon: "\u2328", name: "Keyboard Shortcuts (Ctrl+?)", shortcut: "", action: () => openShortcuts() }) }, 200), document.addEventListener("DOMContentLoaded", () => { buildCalcPanel(); const e = document.getElementById("chat-messages"); e && _msgObserver.observe(e, { childList: !0 }) }, { once: !0 }); window._runBootSequence = function(cb) {
  const bs = document.getElementById("boot-screen"); if (!bs) { cb && cb(); return; }
  bs.classList.remove("hidden");
  const bt = document.getElementById("boot-terminal"), bc = document.getElementById("boot-core-flash");
  const lines = ["J.A.R.V.I.S SYSTEM KERNEL v2.0", "INITIALIZING NEURAL NETWORKS...", "LOADING COGNITIVE MODULES... [OK]", "SECURING DATA ENCLAVES... [OK]", "ESTABLISHING UPLINK TO OLLAMA CORE...", "POWER GRID STABLE.", "SYSTEMS INTEGRATION COMPLETE.", "IGNITING CORE..."];
  let li = 0, ci = 0; bt.textContent = "";
  let actx = null; try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
  const pS = () => { if(!actx) return; try { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(50, actx.currentTime); o.frequency.exponentialRampToValueAtTime(400, actx.currentTime + 0.6); g.gain.setValueAtTime(0, actx.currentTime); g.gain.linearRampToValueAtTime(0.08, actx.currentTime + 0.2); g.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 0.6); o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.6); } catch(e){} };
  const pB = () => { if(!actx) return; try { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.setValueAtTime(800 + Math.random()*200, actx.currentTime); g.gain.setValueAtTime(0.015, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.05); o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.05); } catch(e){} };
  const pI = () => { if(!actx) return; try { const o1 = actx.createOscillator(), o2 = actx.createOscillator(), g = actx.createGain(); o1.type = 'sine'; o2.type = 'sine'; o1.frequency.setValueAtTime(200, actx.currentTime); o2.frequency.setValueAtTime(300, actx.currentTime); g.gain.setValueAtTime(0, actx.currentTime); g.gain.linearRampToValueAtTime(0.1, actx.currentTime + 0.1); g.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 1.5); o1.connect(g); o2.connect(g); g.connect(actx.destination); o1.start(); o2.start(); o1.stop(actx.currentTime + 1.5); o2.stop(actx.currentTime + 1.5); } catch(e){} };
  pS();
  const tc = () => {
    if (li >= lines.length) { setTimeout(() => { pI(); bc && bc.classList.add("ignite"); setTimeout(() => { bs.classList.add("hidden"); setTimeout(() => { bs.remove(); cb && cb(); }, 600); }, 1200); }, 300); return; }
    if (ci < lines[li].length) { bt.textContent += lines[li][ci]; if (ci % 3 === 0) pB(); ci++; setTimeout(tc, 10 + Math.random() * 20); } else { bt.textContent += '\n'; li++; ci = 0; setTimeout(tc, 80 + Math.random() * 60); }
  }; setTimeout(tc, 300);
}; const TaskQueue = { _queue: [], _draining: !1, enqueue: function (e) { if (!state.isStreaming) { sendMessage(e); return } TaskQueue._queue.push(e), TaskQueue._updateHUD(), showToast("Command queued \u2014 JARVIS will process it shortly, sir.", "info") }, drainNext: function () { if (TaskQueue._draining || TaskQueue._queue.length === 0) { TaskQueue._updateHUD(); return } TaskQueue._draining = !0; const e = TaskQueue._queue.shift(); TaskQueue._updateHUD(), setTimeout(function () { TaskQueue._draining = !1, sendMessage(e) }, 200) }, _updateHUD: function () { const e = document.getElementById("task-queue-hud"), t = document.getElementById("tq-count"), n = TaskQueue._queue.length; e && e.classList.toggle("hidden", n === 0), t && (t.textContent = n) }, getQueue: function () { return TaskQueue._queue.slice() }, clear: function () { TaskQueue._queue = [], TaskQueue._draining = !1, TaskQueue._updateHUD() } }; window.TaskQueue = TaskQueue; const _origFinalizeStreamingEl = finalizeStreamingEl; window.finalizeStreamingEl = function (e, t) { _origFinalizeStreamingEl(e, t), setTimeout(function () { !state.isStreaming && TaskQueue._queue.length > 0 && TaskQueue.drainNext() }, 300) }; const Skills = { _manifest: [], _loaded: !1, load: async function () { try { if (!window.jarvis || !window.jarvis.skillsList) return; const e = await window.jarvis.skillsList(); if (e.ok) { Skills._manifest = e.skills || [], Skills._loaded = !0; const t = document.getElementById("skills-count"); t && (t.textContent = Skills._manifest.length) } } catch (e) { console.error("[Skills] Failed to load:", e) } }, run: async function (e, t) { if (!window.jarvis || !window.jarvis.skillsRun) return null; try { return await window.jarvis.skillsRun(e, t || {}) } catch { return null } } }; window.Skills = Skills; async function hashPin(e) { const t = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("jarvis-salt:" + e)); return Array.from(new Uint8Array(t)).map(n => n.toString(16).padStart(2, "0")).join("") } const Auth = { _pin: null, _input: "", _setupMode: !1, _firstPin: null, _attempts: 0, _lockedUntil: 0, _lockTimer: null, _keyHandler: null, init: async function () { if (!window.jarvis || !window.jarvis.authLoad) return; const e = await window.jarvis.authLoad(), t = document.getElementById("auth-screen"); if (t) { if (!e.ok || !e.data) { Auth._setupMode = !0, t.classList.remove("hidden"); const n = document.getElementById("auth-subtitle"); n && (n.textContent = "FIRST RUN \u2014 SET YOUR PIN"); const s = document.getElementById("auth-hint"); s && (s.textContent = "Set a 4-digit PIN to secure JARVIS"); const o = document.getElementById("auth-setup"); o && o.classList.remove("hidden") } else if (e.data.pin) { const n = e.data.pin; n && n.length === 64 ? Auth._pin = n : n && hashPin(n).then(s => { Auth._pin = s, window.jarvis && window.jarvis.authSave && window.jarvis.authSave({ pin: s, setAt: new Date().toISOString() }) }), t.classList.remove("hidden") } else setTimeout(() => { if (window._runBootSequence) window._runBootSequence(triggerLLMGreeting); else triggerLLMGreeting(); }, 100); Auth._keyHandler = function (n) { const s = document.getElementById("auth-screen"); !s || s.classList.contains("hidden") || (n.key >= "0" && n.key <= "9" ? (n.preventDefault(), Auth.pressKey(n.key)) : n.key === "Backspace" ? (n.preventDefault(), Auth.pressKey("clear")) : n.key === "Enter" && (n.preventDefault(), Auth.pressKey("enter"))) }, document.addEventListener("keydown", Auth._keyHandler) } }, pressKey: function (e) { const t = document.getElementById("auth-error"); if (t && t.classList.add("hidden"), e === "clear") Auth._input = Auth._input.slice(0, -1); else if (e === "enter") { Auth._verify(); return } else Auth._input.length < 4 && (Auth._input += e); Auth._updateDots(), Auth._input.length === 4 && setTimeout(Auth._verify, 120) }, _updateDots: function () { for (let e = 1; e <= 4; e++) { const t = document.getElementById("pin-d" + e); t && (t.classList.toggle("filled", Auth._input.length >= e), t.classList.remove("error")) } }, _verify: async function () { if (Auth._setupMode) { if (Auth._firstPin) if (Auth._input === Auth._firstPin) { const t = await hashPin(Auth._input); window.jarvis && window.jarvis.authSave && await window.jarvis.authSave({ pin: t, setAt: new Date().toISOString() }), Auth._unlock() } else { Auth._showError("PINs do not match. Try again."), Auth._firstPin = null, Auth._input = "", Auth._updateDots(); const t = document.getElementById("auth-subtitle"); t && (t.textContent = "FIRST RUN \u2014 SET YOUR PIN") } else { Auth._firstPin = Auth._input, Auth._input = "", Auth._updateDots(); const t = document.getElementById("auth-subtitle"); t && (t.textContent = "CONFIRM YOUR PIN") } return } if (await hashPin(Auth._input) === Auth._pin) Auth._attempts = 0, Auth._unlock(); else { Auth._attempts++, Auth._input = ""; for (let t = 1; t <= 4; t++) { const n = document.getElementById("pin-d" + t); n && (n.classList.add("error"), n.classList.remove("filled")) } if (setTimeout(function () { for (let t = 1; t <= 4; t++) { const n = document.getElementById("pin-d" + t); n && n.classList.remove("error") } }, 600), Auth._attempts >= 3) { Auth._lockedUntil = Date.now() + 3e4; const t = () => Math.ceil((Auth._lockedUntil - Date.now()) / 1e3); Auth._showError(`Too many attempts. Locked for ${t()}s.`), document.querySelectorAll(".keypad-btn").forEach(n => n.disabled = !0), Auth._lockTimer = setInterval(() => { if (Date.now() >= Auth._lockedUntil) { clearInterval(Auth._lockTimer), Auth._attempts = 0, Auth._lockedUntil = 0, document.querySelectorAll(".keypad-btn").forEach(s => s.disabled = !1); const n = document.getElementById("auth-error"); n && n.classList.add("hidden") } else Auth._showError(`Too many attempts. Locked for ${t()}s.`) }, 1e3) } else Auth._showError(`Incorrect PIN. ${3 - Auth._attempts} attempt${Auth._attempts === 2 ? "" : "s"} remaining.`) } }, _showError: function (e) { const t = document.getElementById("auth-error"); t && (t.textContent = e, t.classList.remove("hidden")) }, _unlock: function () { Auth._keyHandler && (document.removeEventListener("keydown", Auth._keyHandler), Auth._keyHandler = null); const e = document.getElementById("auth-screen"); e && (e.classList.add("unlocking"), showToast("Identity confirmed. Welcome back, sir.", "success"), setTimeout(function () { e.classList.add("hidden") }, 600), setTimeout(() => { if (window._runBootSequence) window._runBootSequence(triggerLLMGreeting); else triggerLLMGreeting(); }, 650)) }, skip: async function () { window.jarvis && window.jarvis.authSave && await window.jarvis.authSave({ pin: null, skipped: !0 }), Auth._unlock() } }; window.Auth = Auth, window.authKey = function (e) { Auth.pressKey(e) }, window.authSkip = function () { Auth.skip() }, document.addEventListener("visibilitychange", () => { document.hidden ? (typeof gpuPollInterval < "u" && gpuPollInterval && (clearInterval(gpuPollInterval), gpuPollInterval = null), typeof hudInterval < "u" && hudInterval && (clearInterval(hudInterval), hudInterval = null)) : (!gpuPollInterval && typeof pollGPU == "function" && (pollGPU(), gpuPollInterval = setInterval(pollGPU, 15e3)), !hudInterval && typeof updateLiveHUD == "function" && (updateLiveHUD(), hudInterval = setInterval(updateLiveHUD, 3e4))) }); function openChangePinModal() { closeModal("settings-modal"), ["chpin-current", "chpin-new", "chpin-confirm"].forEach(t => { const n = document.getElementById(t); n && (n.value = "") }); const e = document.getElementById("chpin-error"); e && e.classList.add("hidden"), openModal("change-pin-modal"), setTimeout(() => { const t = document.getElementById("chpin-current"); t && t.focus() }, 100) } window.openChangePinModal = openChangePinModal; async function submitChangePin() { const e = document.getElementById("chpin-current")?.value.trim(), t = document.getElementById("chpin-new")?.value.trim(), n = document.getElementById("chpin-confirm")?.value.trim(), s = document.getElementById("chpin-error"); function o(a) { s && (s.textContent = a, s.classList.remove("hidden")) } if (!/^\d{4}$/.test(t)) return o("New PIN must be exactly 4 digits."); if (t !== n) return o("New PINs do not match."); if (Auth._pin && await hashPin(e) !== Auth._pin) return o("Current PIN is incorrect."); const i = await hashPin(t); Auth._pin = i, window.jarvis && window.jarvis.authSave && await window.jarvis.authSave({ pin: i, setAt: new Date().toISOString() }), closeModal("change-pin-modal"), showToast("PIN updated successfully, sir.", "success") } window.submitChangePin = submitChangePin; async function refreshDiagnostics() { const e = document.getElementById("diag-grid"), t = document.getElementById("diag-skills-list"), n = document.getElementById("diag-queue-list"); e && (e.innerHTML = '<div class="panel-placeholder">Loading...</div>'); try { let s = null; if (window.jarvis && window.jarvis.getRuntimeStats && (s = await window.jarvis.getRuntimeStats()), e && s && s.ok) { const o = s.process, i = s.system, a = s.jarvis, c = Math.round(parseFloat(o.heap_used_mb) / parseFloat(o.heap_total_mb) * 100), r = Math.round((parseFloat(i.total_mem_gb) - parseFloat(i.free_mem_gb)) / parseFloat(i.total_mem_gb) * 100); e.innerHTML = ['<div class="diag-card">', '<div class="diag-card-title">PROCESS</div>', '<div class="diag-stat-row"><span class="diag-stat-lbl">UPTIME</span><span class="diag-stat-val">' + o.uptime_human + "</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">HEAP USED</span><span class="diag-stat-val">' + o.heap_used_mb + " MB</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">HEAP TOTAL</span><span class="diag-stat-val">' + o.heap_total_mb + " MB</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">HEAP %</span><span class="diag-stat-val ' + (c > 80 ? "warn" : "ok") + '">' + c + "%</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">RSS</span><span class="diag-stat-val">' + o.rss_mb + " MB</span></div>", "</div>", '<div class="diag-card">', '<div class="diag-card-title">SYSTEM</div>', '<div class="diag-stat-row"><span class="diag-stat-lbl">SYS UPTIME</span><span class="diag-stat-val">' + i.uptime_human + "</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">RAM FREE</span><span class="diag-stat-val">' + i.free_mem_gb + " GB</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">RAM TOTAL</span><span class="diag-stat-val">' + i.total_mem_gb + " GB</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">RAM USED</span><span class="diag-stat-val ' + (r > 85 ? "warn" : "ok") + '">' + r + "%</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">CPU CORES</span><span class="diag-stat-val">' + i.cpu_cores + "</span></div>", "</div>", '<div class="diag-card">', '<div class="diag-card-title">JARVIS</div>', '<div class="diag-stat-row"><span class="diag-stat-lbl">OLLAMA</span><span class="diag-stat-val ' + (a.ollama_running ? "ok" : "err") + '">' + (a.ollama_running ? "ONLINE" : "OFFLINE") + "</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">SKILLS</span><span class="diag-stat-val">' + a.skill_count + "</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">SESSIONS</span><span class="diag-stat-val">' + a.session_count + "</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">ELECTRON</span><span class="diag-stat-val">' + a.electron_ver + "</span></div>", '<div class="diag-stat-row"><span class="diag-stat-lbl">NODE</span><span class="diag-stat-val">' + a.node_ver + "</span></div>", "</div>"].join("") } else e && (e.innerHTML = '<div class="panel-placeholder">Could not fetch diagnostics.</div>') } catch (s) { e && (e.innerHTML = '<div class="panel-placeholder">Error: ' + (s.message || "unknown") + "</div>") } if (t) if (!Skills._manifest.length) t.innerHTML = '<div class="panel-placeholder">No skills loaded.</div>'; else { const s = { get_datetime: "\u23F0", calculator: "\u{1F9F8}", system_status: "\u{1F4BB}", web_search: "\u{1F310}" }; t.innerHTML = Skills._manifest.map(function (o) { return '<div class="diag-skill-chip"><span class="diag-skill-icon">' + (s[o.id] || "\u2B21") + '</span><div><div class="diag-skill-name">' + escHtml(o.name) + '</div><div class="diag-skill-desc">' + escHtml(o.description) + "</div></div></div>" }).join("") } if (n) { const s = TaskQueue.getQueue(); s.length ? n.innerHTML = s.map(function (o, i) { return '<div class="diag-queue-item"><span class="diag-qi-pos">#' + (i + 1) + '</span><span class="diag-qi-text">' + escHtml(o) + "</span></div>" }).join("") : n.innerHTML = '<div class="panel-placeholder">Queue empty \u2014 JARVIS is ready.</div>' } } window.refreshDiagnostics = refreshDiagnostics; function openDiagnosticsModal() { openModal("diag-modal"), refreshDiagnostics() } window.openDiagnosticsModal = openDiagnosticsModal, document.addEventListener("DOMContentLoaded", async function () { await Skills.load(), WakeWord.init(), await Auth.init(), document.addEventListener("keydown", function (e) { e.ctrlKey && e.key === "d" && (e.preventDefault(), openDiagnosticsModal()) }), console.log("[JARVIS] New features initialized: TaskQueue, Skills, Auth, WakeWord, Diagnostics") }); const JarvisSec = { config: { blockWritesOutsideWorkspace: !1, terminalEnabled: !0, requirePinForDestructive: !1, auditLogging: !0, screenCaptureEnabled: !1 }, async load() { try { const e = await window.jarvis.secConfigLoad(); e.ok && (this.config = { ...this.config, ...e.config }) } catch { } }, async save() { try { await window.jarvis.secConfigSave(this.config), showToast("\u{1F512} Security settings saved.", "success") } catch (e) { showToast("Error saving security config: " + e.message, "error") } } }; window.openSecurityModal = function () {
  let e = document.getElementById("security-modal"); e || (e = document.createElement("div"), e.id = "security-modal", e.className = "modal", e.setAttribute("role", "dialog"), e.setAttribute("aria-modal", "true"), e.innerHTML = `
      <div class="modal-backdrop" onclick="closeModal('security-modal')"></div>
      <div class="modal-box" style="max-width:640px">
        <div class="modal-hdr">
          <span class="modal-title">\u{1F512} JARVIS SECURITY CONTROL CENTER</span>
          <button class="modal-close-btn" onclick="closeModal('security-modal')">\u2715</button>
        </div>
        <div class="modal-body">
          <div class="sec-status-banner" id="sec-status-banner">
            <span class="sec-shield-icon">\u{1F6E1}</span>
            <div>
              <div class="sec-banner-title">SECURITY BOUNDARY ACTIVE</div>
              <div class="sec-banner-sub">Path Guard \xB7 Command Classifier \xB7 Audit Logger \xB7 Rate Limiter</div>
            </div>
          </div>

          <div class="sec-section-title">PERMISSION TOGGLES</div>

          <div class="sec-toggle-row" id="sec-row-terminal">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">\u2328 Terminal Access</div>
              <div class="sec-toggle-desc">Allow JARVIS terminal to execute system commands</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-terminal" onchange="secToggle('terminalEnabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-toggle-row">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">\u{1F4C1} Restrict File Writes</div>
              <div class="sec-toggle-desc">Block file writes outside the current workspace directory</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-writes" onchange="secToggle('blockWritesOutsideWorkspace', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-toggle-row">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">\u{1F4F8} Screen Capture</div>
              <div class="sec-toggle-desc">Allow JARVIS to capture your screen for visual analysis (disabled by default)</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-screen" onchange="secToggle('screenCaptureEnabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-toggle-row">
            <div class="sec-toggle-info">
              <div class="sec-toggle-label">\u{1F4CB} Audit Logging</div>
              <div class="sec-toggle-desc">Log all sensitive operations (terminal, file writes, screen capture) to security_audit.log</div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" id="sec-audit" onchange="secToggle('auditLogging', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="sec-section-title" style="margin-top:16px">HARD BOUNDARIES (Always Active)</div>
          <div class="sec-boundary-list">
            <div class="sec-boundary-item">\u{1F6AB} <span>System directories blocked (C:\\Windows, Program Files, System32)</span></div>
            <div class="sec-boundary-item">\u{1F6AB} <span>Credential files blocked (.env, .pem, id_rsa, .key, SSH)</span></div>
            <div class="sec-boundary-item">\u{1F6AB} <span>Destructive commands blocked (format, del /f/s/q C:\\, rm -rf /)</span></div>
            <div class="sec-boundary-item">\u{1F6AB} <span>System processes protected (csrss, lsass, winlogon, svchost)</span></div>
            <div class="sec-boundary-item">\u26A0 <span>Sensitive commands require confirmation before execution</span></div>
            <div class="sec-boundary-item">\u23F1 <span>Rate limited: max 10 terminal/min, 30 web search/min</span></div>
          </div>

          <div class="sec-section-title" style="margin-top:16px">AUDIT LOG (Last 20 entries)</div>
          <div class="sec-audit-log" id="sec-audit-log">Loading\u2026</div>
          <button class="micro-btn" onclick="refreshSecAudit()" style="margin-top:6px">\u21BB REFRESH LOG</button>

          <div class="cfg-actions" style="margin-top:16px">
            <button class="cfg-btn-primary" onclick="JarvisSec.save()">\u{1F512} SAVE SECURITY CONFIG</button>
          </div>
        </div>
      </div>`, document.body.appendChild(e)), JarvisSec.load().then(() => { const t = (n, s) => { const o = document.getElementById(n); o && (o.checked = s) }; t("sec-terminal", JarvisSec.config.terminalEnabled), t("sec-writes", JarvisSec.config.blockWritesOutsideWorkspace), t("sec-screen", JarvisSec.config.screenCaptureEnabled), t("sec-audit", JarvisSec.config.auditLogging), refreshSecAudit() }), openModal("security-modal")
}, window.secToggle = function (e, t) { JarvisSec.config[e] = t }, window.refreshSecAudit = async function () {
  const e = document.getElementById("sec-audit-log"); if (e) try {
    const t = await window.jarvis.secAuditRead(); if (!t.ok || !t.data) { e.textContent = "No audit log entries yet."; return } const n = t.data.split(`
`).filter(Boolean).slice(-20).reverse(); e.innerHTML = n.map(s => { const o = s.includes("[BLOCKED]") || s.includes("[RATE_LIMITED]"), i = s.includes("[WARN"); return `<div class="sec-log-entry ${o ? "sec-log-blocked" : i ? "sec-log-warn" : "sec-log-ok"}">${escHtml(s)}</div>` }).join("")
  } catch { e.textContent = "Error loading audit log." }
}, window.captureScreenForAnalysis = async function () { showToast("\u{1F4F8} Capturing screen\u2026", "info"); try { const e = await window.jarvis.captureScreen(); if (!e.ok) { showToast(`\u26D4 ${e.error}`, "error"), e.error.includes("disabled") && showToast("Go to Security settings to enable screen capture.", "info"); return } window.setImgState(e.data, e.mimeType); const t = document.getElementById("img-preview"); t && (t.src = `data:${window.getImgMime()};base64,${window.getImgB64()}`), document.getElementById("img-drop-zone-inner")?.setAttribute("hidden", ""), document.getElementById("img-preview-wrap")?.removeAttribute("hidden"), document.getElementById("img-analyze-btn")?.removeAttribute("disabled"), showToast(`\u{1F4F8} Screen captured: ${e.source || "Desktop"}`, "success") } catch (e) { showToast("Screen capture failed: " + e.message, "error") } }, (function () {
  let t = null; async function n() {
    try {
      const s = await window.jarvis.getRuntimeStats(); if (!s?.ok) return; const o = parseFloat(s.system.free_mem_gb), i = parseFloat(s.system.total_mem_gb), a = i - o, c = Math.round(a / i * 100); let r = document.getElementById("live-hud-panel"); if (!r) {
        r = document.createElement("div"), r.id = "live-hud-panel", r.className = "hud-panel live-hud-panel", r.innerHTML = `
          <div class="panel-hdr"><span class="panel-hdr-icon">\u{1F4CA}</span>SYSTEM HUD</div>
          <div class="panel-body" id="live-hud-body">
            <div class="gpu-bar-wrap">
              <div class="gpu-bar-label"><span>RAM USAGE</span><span class="gpu-bar-val" id="hud-ram-val">-</span></div>
              <div class="gpu-bar-track"><div class="gpu-bar-fill" id="hud-ram-bar" style="width:0%"></div></div>
            </div>
            <div class="stat-row"><span class="stat-lbl">UPTIME</span><span class="stat-val" id="hud-uptime">-</span></div>
            <div class="stat-row"><span class="stat-lbl">SESSIONS</span><span class="stat-val" id="hud-sessions">-</span></div>
            <div class="stat-row"><span class="stat-lbl">SKILLS</span><span class="stat-val" id="hud-skills">-</span></div>
          </div>`; const m = document.getElementById("panel-gpu"); m ? m.parentNode.insertBefore(r, m) : document.getElementById("hud-panels")?.appendChild(r)
      } const l = document.getElementById("hud-ram-bar"), p = document.getElementById("hud-ram-val"); l && (l.style.width = `${c}%`, l.className = `gpu-bar-fill${c > 85 ? " hot" : c > 65 ? " warm" : ""}`), p && (p.textContent = `${a.toFixed(1)}/${i.toFixed(1)}GB`); const g = document.getElementById("hud-uptime"); g && (g.textContent = s.process.uptime_human || "-"); const d = document.getElementById("hud-sessions"); d && (d.textContent = s.jarvis.session_count); const u = document.getElementById("hud-skills"); u && (u.textContent = s.jarvis.skill_count)
    } catch { }
  } document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", () => { n(), t = setInterval(n, 3e4) }, { once: !0 }) : (n(), t = setInterval(n, 3e4))
})(), (function () { function t() { if (document.getElementById("btn-security")) return; const n = document.getElementById("sidebar-bottom"); if (!n) return; const s = document.createElement("button"); s.id = "btn-security", s.className = "sb-btn", s.title = "Security Control Center", s.innerHTML = '<span class="sb-icon">\u{1F512}</span><span class="sb-label">SECURITY</span>', s.onclick = () => window.openSecurityModal(); const o = document.getElementById("btn-poweroff"); o ? n.insertBefore(s, o) : n.appendChild(s) } document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", t, { once: !0 }) : t() })(), (function () { function t() { const n = document.getElementById("img-drop-zone"); if (!n || document.getElementById("screen-capture-btn")) return; const s = document.createElement("button"); s.id = "screen-capture-btn", s.className = "dash-btn", s.style.cssText = "margin-top:10px;width:100%", s.innerHTML = "\u{1F4F8} CAPTURE SCREEN", s.onclick = () => window.captureScreenForAnalysis(), n.parentNode.insertBefore(s, n.nextSibling) } document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", t, { once: !0 }) : t() })(), document.addEventListener("DOMContentLoaded", () => { JarvisSec.load().then(() => { console.log("[JARVIS] Security boundary initialized.", JarvisSec.config) }) }, { once: !0 });
(function() {
  if (window.jarvis && window.jarvis.onTelemetry) {
    window.jarvis.onTelemetry((data) => {
      const cpuVal = document.getElementById("gpu-util-val");
      const cpuBar = document.getElementById("gpu-util-bar");
      if (cpuVal) cpuVal.textContent = data.cpuUsage + "%";
      if (cpuBar) cpuBar.style.width = data.cpuUsage + "%";
      
      const ramVal = document.getElementById("gpu-mem-val");
      const ramBar = document.getElementById("gpu-mem-bar");
      if (ramVal) ramVal.textContent = data.memUsed + "/" + data.memTotal + "GB";
      if (ramBar) ramBar.style.width = (parseFloat(data.memUsed)/parseFloat(data.memTotal)*100) + "%";
      
      if (data.gpuUsage !== undefined) {
        const gpuVal = document.getElementById("gpu-hw-util-val");
        const gpuBar = document.getElementById("gpu-hw-util-bar");
        if (gpuVal) gpuVal.textContent = data.gpuUsage + "%";
        if (gpuBar) gpuBar.style.width = data.gpuUsage + "%";
        
        const vramVal = document.getElementById("gpu-hw-mem-val");
        const vramBar = document.getElementById("gpu-hw-mem-bar");
        if (vramVal) vramVal.textContent = (data.gpuMemUsed/1024).toFixed(1) + "/" + (data.gpuMemTotal/1024).toFixed(1) + "GB";
        if (vramBar) vramBar.style.width = (data.gpuMemUsed/data.gpuMemTotal*100) + "%";
        
        const nameVal = document.getElementById("gpu-name-val");
        if (nameVal) nameVal.textContent = data.gpuName;
      }
      
      const upVal = document.getElementById("gpu-uptime-val");
      if (upVal) upVal.textContent = data.uptime + (data.gpuTemp ? `  [${data.gpuTemp}°C]` : "");
      
      const pCpu = document.getElementById("p-cpu");
      if (pCpu) pCpu.textContent = data.cpuUsage + "%";
      const pMem = document.getElementById("p-mem");
      if (pMem) pMem.textContent = data.memUsed + "/" + data.memTotal + "GB";
    });
  }
})();
