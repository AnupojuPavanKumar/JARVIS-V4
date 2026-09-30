import { jarvisMemory } from './memory.js';
import { state } from './state.js';

let currentReqId = null;

export async function checkOllamaAPI() {
  try {
    const res = await window.jarvis.ollamaFetch({ path: '/api/tags', method: 'GET' });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

export function cancelStreamAPI() {
  if (currentReqId) {
    if (window.jarvis.ollamaStreamAbort) window.jarvis.ollamaStreamAbort(currentReqId);
    currentReqId = null;
  }
}

export async function streamOllamaAPI(messages, { onChunk, onDone, onError }) {
  currentReqId = Date.now().toString() + Math.random().toString(36).substring(7);
  const reqId = currentReqId;
  const tout = setTimeout(() => {
    if (window.jarvis.ollamaStreamAbort) window.jarvis.ollamaStreamAbort(reqId);
  }, 9e4);
  
  let full = "";
  
  const cleanupChunk = window.jarvis.onOllamaStreamChunk && window.jarvis.onOllamaStreamChunk((r) => {
    if (r.reqId !== reqId) return;
    const lines = r.chunk.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line);
        if (f.message && f.message.content) {
          full += f.message.content;
          onChunk(f.message.content, full);
        }
        if (f.done) {
          clearTimeout(tout);
          if (typeof cleanupChunk === 'function') cleanupChunk();
          if (typeof cleanupEnd === 'function') cleanupEnd();
          if (typeof cleanupErr === 'function') cleanupErr();
          onDone(full);
        }
      } catch (err) {}
    }
  });

  const cleanupEnd = window.jarvis.onOllamaStreamEnd && window.jarvis.onOllamaStreamEnd((r) => {
    if (r.reqId !== reqId) return;
    clearTimeout(tout);
    if (typeof cleanupChunk === 'function') cleanupChunk();
    if (typeof cleanupEnd === 'function') cleanupEnd();
    if (typeof cleanupErr === 'function') cleanupErr();
    onDone(full);
  });

  const cleanupErr = window.jarvis.onOllamaStreamError && window.jarvis.onOllamaStreamError((r) => {
    if (r.reqId !== reqId) return;
    clearTimeout(tout);
    if (typeof cleanupChunk === 'function') cleanupChunk();
    if (typeof cleanupEnd === 'function') cleanupEnd();
    if (typeof cleanupErr === 'function') cleanupErr();
    onError(new Error(r.error));
  });

  const queryContent = messages[messages.length - 1]?.content || "";
  const memCtx = await jarvisMemory.getRelevantContext(queryContent);
  let ragCtx = null;
  if (window.ragSystem) {
    ragCtx = await window.ragSystem.getContextForQuery(queryContent);
  }

  if (messages.length > 0 && messages[0].role === "system") {
    let extra = '';
    if (memCtx) extra += '\n' + memCtx;
    if (ragCtx) extra += '\n' + ragCtx;
    const MAX = 24000;
    const marker = '\n[... context truncated ...]';
    if (messages[0].content.length + extra.length > MAX) {
      const maxExtra = Math.floor(MAX / 2);
      if (extra.length > maxExtra) extra = extra.slice(0, maxExtra);
      const keep = Math.max(0, MAX - extra.length - marker.length);
      messages[0].content = messages[0].content.slice(0, keep) + marker + extra;
    } else {
      messages[0].content += extra;
    }
  }

  window.jarvis.ollamaStreamStart({
    reqId,
    path: '/api/chat',
    method: 'POST',
    body: {
      model: state.model,
      messages: messages,
      stream: true,
      keep_alive: "30m",
      options: { temperature: 0.3, top_p: 0.85, num_predict: 256, num_ctx: 4096, num_gpu: 99, num_thread: 8 }
    }
  });
}
