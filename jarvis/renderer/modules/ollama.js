/**
 * JARVIS — Ollama Integration Module
 * Handles: streaming API calls, model management, status checks.
 * Dependencies: state, MODES (from renderer.js globals)
 */

'use strict';

// ─── Ollama Health Check ────────────────────────────────────────

async function checkOllama() {
  setOllamaStatus('checking');
  try {
    const res = await fetch(`${state.endpoint}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) { setOllamaStatus('online'); return true; }
    setOllamaStatus('offline'); return false;
  } catch {
    setOllamaStatus('offline'); return false;
  }
}

function setOllamaStatus(status) {
  state.ollamaOnline = (status === 'online');
  if ($ollamaBadge) $ollamaBadge.className = `status-badge ${status}`;
  if ($ollamaLabel) $ollamaLabel.textContent = status.toUpperCase();
  if ($pOllama) {
    $pOllama.textContent = status.toUpperCase();
    $pOllama.className   = `stat-val ${status === 'online' ? 'online' : 'offline'}`;
  }
}

// ─── Ollama Streaming ───────────────────────────────────────────

async function streamOllama(messages, { onChunk, onDone, onError }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 90000); // 90-second connection and model loading timeout

  try {
    const response = await fetch(`${state.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.model,
        messages: messages,
        stream: true,
        keep_alive: -1,
        options: { 
          temperature: 0.3, 
          top_p: 0.85,
          num_predict: 256,
          num_ctx: 4096,
          num_gpu: 99,
          num_thread: 8
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '', buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) { fullContent += data.message.content; onChunk(data.message.content, fullContent); }
          if (data.done) { onDone(fullContent); return; }
        } catch (e) { 
          console.error('[STREAM ERROR] Failed to parse line:', line, e);
        }
      }
    }
    onDone(fullContent);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[OLLAMA ERROR]', err);
    onError(err);
  }
}

// ─── Context Builder ────────────────────────────────────────────

function buildMessages() {
  const conv = state.conversations[state.mode];
  let systemContent = MODES[state.mode].prompt;

  // Inject real hardware specifications to prevent hallucination
  if (state.systemSpecs) {
    systemContent += `[HOST HARDWARE SPECIFICATIONS — use these exact specs if the user asks about the host system performance, CPU, GPU, memory, or hardware details]\n` +
      `CPU: ${state.systemSpecs.cpuModel || 'Unknown CPU'} (${state.systemSpecs.cpuCount || 'Unknown'} cores)\n` +
      `GPU: NVIDIA GeForce RTX 4050 Laptop GPU (6GB VRAM, dedicated, CUDA acceleration active)\n` +
      `RAM: ${(state.systemSpecs.totalMem / (1024 * 1024 * 1024)).toFixed(1)} GB Total\n` +
      `Platform: ${state.systemSpecs.platform || 'Unknown OS'} (${state.systemSpecs.arch || 'Unknown'})\n` +
      `[END HARDWARE SPECIFICATIONS]`;
  }

  // Inject persistent memory
  if (state.memory && state.memory.length) {
    systemContent += `[USER MEMORY — always remember these facts about the user]\n${state.memory.map(f => `• ${f}`).join('\n')}\n[END MEMORY]`;
  }

  // Inject project context
  if (state.projectContext?.files?.length) {
    const { name, rootPath, files } = state.projectContext;
    const tree = files.map(f => `  ${f.relativePath}`).join('\n');
    const contents = files
      .filter(f => f.content)
      .map(f => `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 6000)}\n\`\`\``)
      .join('');
    systemContent += `[PROJECT CONTEXT: ${name}]\nRoot: ${rootPath}File tree:\n${tree}${contents}\n[END PROJECT CONTEXT]`;
  }

  // Inject pending web search context (M-4 defence-in-depth: strip injection markers, hard-cap length)
  if (state.webSearchContext) {
    const _wsCtx = state.webSearchContext
      .replace(/<<<\s*TOOL_CALL\s*>>>/gi, '[FILTERED]')
      .replace(/<<<\s*END_TOOL_CALL\s*>>>/gi, '[FILTERED]')
      .replace(/\[SYSTEM\]/gi, '[FILTERED]')
      .replace(/\[DIRECTIVE\]/gi, '[FILTERED]')
      .slice(0, 3000); // absolute ceiling — cannot exceed this regardless of content
    systemContent += _wsCtx;
    state.webSearchContext = null;
  }

  // Analytical directive
  systemContent += `[DIRECTIVE]\nThink step-by-step before answering. Prioritize logic, absolute accuracy, and concise code formatting. Do not hallucinate. Respond in extremely short, punchy sentences. DO NOT use markdown lists or bullet points unless explicitly requested. Maximize brevity to optimize voice output.`;

  // Inject tool manifest for agentic skill-calling (ToolExecutor)
  if (window.ToolExecutor && window.Skills && window.Skills._loaded && window.Skills._manifest.length) {
    systemContent += '\n' + window.ToolExecutor.buildToolManifestPrompt(window.Skills._manifest);
  }

  // Inject semantic memory
  const lastUserMsg = conv?.messages?.length ? conv.messages[conv.messages.length - 1].content : '';
  const semanticMem = jarvisMemory.getRelevantContext(lastUserMsg);
  if (semanticMem) {
    systemContent += `\n[RELEVANT CONTEXT]\n${semanticMem}\n[END RELEVANT CONTEXT]`;
  }

  const messages = [{ role: 'system', content: systemContent }];
  if (conv?.messages?.length) {
    const start = state.contextWindow > 0
      ? Math.max(0, conv.messages.length - state.contextWindow) : 0;
    conv.messages.slice(start).forEach(m => messages.push({ role: m.role, content: m.content }));
  }
  return messages;
}

// ─── Model Management ───────────────────────────────────────────

async function refreshModels() {
  showToast('Scanning Ollama for installed models…', 'info');
  try {
    const res = await fetch(`${state.endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('Ollama offline');
    const data = await res.json();
    const models = data.models || [];
    renderModelsList(models);
    return models;
  } catch { showToast('Could not fetch models — is Ollama running?', 'error'); return []; }
}

function renderModelsList(models) {
  const sideList = document.getElementById('models-list');
  if (sideList) {
    sideList.innerHTML = '';
    if (!models.length) { sideList.innerHTML = '<div class="panel-placeholder">No models found</div>'; }
    else models.forEach(m => {
      const item = document.createElement('div');
      item.className = `model-item ${m.name === state.model ? 'current' : ''}`;
      const sizeGb = m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '?';
      item.innerHTML = `<span>${m.name.split(':')[0]}</span><span class="model-size">${sizeGb}</span>`;
      item.onclick = () => selectModel(m.name);
      sideList.appendChild(item);
    });
  }
  const modalBody = document.getElementById('models-modal-body');
  if (modalBody) {
    modalBody.innerHTML = '';
    if (!models.length) modalBody.innerHTML = '<div class="panel-placeholder">No models found.<br>Run: <code>ollama pull llama3.1:8b</code></div>';
    else models.forEach(m => {
      const sizeGb = m.size ? (m.size / 1e9).toFixed(2) + ' GB' : 'Unknown';
      const item = document.createElement('div');
      item.className = `models-modal-item ${m.name === state.model ? 'active' : ''}`;
      item.innerHTML = `
        <div><div class="model-info-name">${m.name}</div><div class="model-info-meta">${sizeGb} · ${m.details?.parameter_size || ''} · ${m.details?.quantization_level || ''}</div></div>
        <button class="model-select-btn ${m.name === state.model ? 'active-model' : ''}" onclick="selectModel('${m.name}'); closeModal('models-modal')">${m.name === state.model ? '✓ ACTIVE' : 'SELECT'}</button>`;
      modalBody.appendChild(item);
    });
  }
}

function selectModel(name) {
  state.model = name;
  if ($activeModelLabel) $activeModelLabel.textContent = name;
  if ($pModel) $pModel.textContent = name;
  const cfgModel = document.getElementById('cfg-model');
  if (cfgModel) cfgModel.value = name;
  showToast(`Model switched to ${name}`, 'success');
}
window.selectModel = selectModel;
