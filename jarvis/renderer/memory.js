export const jarvisMemory = (function () {
  const LS_KEY = 'jarvis_memory';
  const MAX_FACTS = 200;   // hard cap — oldest evicted first
  const TOP_K = 4;     // memories returned per query
  const MIN_SCORE = 0.50;  // cosine similarity threshold

  // Pure JS Vector Cosine Similarity
  function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ── State ────────────────────────────────────────────────────────
  const store = { memories: [] };

  // ── Load from localStorage on boot ──────────────────────────────
  try { store.memories = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { }

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
        store.memories.push({ text: f.text.trim(), timestamp: f.timestamp || Date.now(), embedding: f.embedding || null });
        existing.add(key);
      }
    }
    // Enforce cap
    if (store.memories.length > MAX_FACTS) {
      store.memories = store.memories.slice(-MAX_FACTS);
    }
    save();
  }

  // ── Public: getRelevantContext — Vector Semantic Retrieval ─────────
  async function getRelevantContext(query) {
    if (!query || !store.memories.length) return '';
    
    // 1. Get embedding for the user's query via IPC
    let qEmbedding = null;
    try {
      if (window.jarvis && window.jarvis.embedText) {
        qEmbedding = await window.jarvis.embedText(query);
      }
    } catch(e) { console.warn("Embedding failed", e); }
    
    if (!qEmbedding) return '';

    // 2. Score all memories using cosine similarity
    let backfilled = false;
    for (const m of store.memories) {
      if (!m.embedding) {
        try { m.embedding = await window.jarvis.embedText(m.text); backfilled = !!m.embedding || backfilled; } catch { }
      }
    }
    if (backfilled) save();
    const scored = store.memories.map(m => ({ text: m.text, score: cosineSimilarity(qEmbedding, m.embedding) }));

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

    // Generate embedding for the new memory
    let embedding = null;
    try {
      if (window.jarvis && window.jarvis.embedText) {
        embedding = await window.jarvis.embedText(cleaned);
      }
    } catch(e) {}

    if (!embedding) return; // don't store if embedding fails

    // Dedup using cosine similarity > 0.90
    const isDupe = store.memories.some(m => m.embedding && cosineSimilarity(embedding, m.embedding) > 0.90);
    if (isDupe) return;

    store.memories.push({ text: cleaned, timestamp: Date.now(), embedding });

    // Enforce cap
    if (store.memories.length > MAX_FACTS) store.memories = store.memories.slice(-MAX_FACTS);

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
