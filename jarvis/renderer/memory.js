export const jarvisMemory = (function () {
  // ── Constants ────────────────────────────────────────────────────
  const LS_KEY = 'jarvis_memory';
  const MAX_FACTS = 200;   // hard cap — oldest evicted first
  const TOP_K = 4;     // memories returned per query
  const MIN_SCORE = 0.12;  // cosine similarity threshold

  // ── Common English stop-words to exclude from TF-IDF ────────────
  const STOPS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'is',
    'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'this', 'that', 'these', 'those', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'my', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us',
    'them', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'there', 'then',
    'so', 'if', 'out', 'up', 'about', 'into', 'than', 'more', 'just', 'also',
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
      dot += qv * dv * w * w;
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
  try { store.memories = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { }

  // ── Cache: pre-tokenised TF maps (rebuilt on write) ─────────────
  let _tfCache = [];
  let _idf = {};

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
    try { localStorage.setItem(LS_KEY, JSON.stringify(store.memories)); } catch { }
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
      text: m.text,
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
    } catch { }
  }

  // ── Bootstrap: pull persisted facts from userData on startup ─────
  (async function bootstrap() {
    try {
      if (window.jarvis && window.jarvis.memoryLoad) {
        const res = await window.jarvis.memoryLoad();
        if (res && res.ok && Array.isArray(res.facts)) loadFromIPC(res.facts);
      }
    } catch { }
  })();

  return {
    get memories() { return store.memories; },
    save,
    loadFromIPC,
    getRelevantContext,
    extractAndStore,
  };
})();
