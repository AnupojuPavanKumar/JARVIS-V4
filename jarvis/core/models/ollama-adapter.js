'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_MODEL_OPTIONS = Object.freeze({
  temperature: 0.3,
  top_p: 0.85,
  num_predict: 256,
  num_ctx: 4096,
  num_gpu: 99,
  num_thread: 8,
});

// The runtime keeps tool-call metadata in a provider-neutral shape; Ollama
// expects assistant tool calls under `tool_calls.function` and the matching
// tool result under `tool_name`/`tool_call_id`. Convert only at the wire edge.
function toOllamaMessage(message) {
  const out = {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
  };

  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((call, index) => ({
      ...(call.id ? { id: call.id } : { id: `call_${index}` }),
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments ?? {},
      },
    }));
  }

  if (message.role === 'tool') {
    if (message.name) out.tool_name = message.name;
    if (message.toolCallId) out.tool_call_id = message.toolCallId;
  }

  return out;
}

// Thin Ollama adapter. It intentionally returns Ollama's response shape; the
// ModelGateway owns normalization so other providers can be added later.
class OllamaAdapter {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    defaultOptions = DEFAULT_MODEL_OPTIONS,
    keepAlive = '30m',
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('OllamaAdapter requires a fetch implementation');
    }
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new Error('OllamaAdapter requires a base URL');
    }
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('OllamaAdapter requires a model name');
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.defaultOptions = { ...defaultOptions };
    this.keepAlive = keepAlive;
  }

  async chat({ messages, tools = [], options = {}, signal = null } = {}) {
    const body = {
      model: this.model,
      messages: messages.map(toOllamaMessage),
      stream: false,
      keep_alive: this.keepAlive,
      options: { ...this.defaultOptions, ...options },
    };
    if (tools.length > 0) body.tools = tools;

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Ollama request failed: ${error.message}`);
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 1000);
      } catch { /* best effort */ }
      throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Ollama returned invalid JSON: ${error.message}`);
    }
  }
}

module.exports = {
  OllamaAdapter,
  toOllamaMessage,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MODEL_OPTIONS,
};
