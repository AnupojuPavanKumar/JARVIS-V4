'use strict';

const DEFAULT_TIMEOUT_MS = 90_000;
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolCall(call, index) {
  if (!call || typeof call !== 'object') {
    return { id: `call_${index}`, name: '', arguments: null, error: 'Tool call is not an object' };
  }

  const name = call.name || call.tool || call.function?.name || '';
  const rawArgs = call.arguments ?? call.args ?? call.function?.arguments ?? {};
  const id = typeof call.id === 'string' && call.id ? call.id : `call_${index}`;

  let args = rawArgs;
  let error = null;

  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch (parseError) {
      args = null;
      error = `Invalid tool arguments JSON: ${parseError.message}`;
    }
  }

  if (args === null || args === undefined) {
    args = {};
    error = error || 'Tool arguments are missing';
  }
  if (!isPlainObject(args)) {
    args = {};
    error = error || 'Tool arguments must be an object';
  }

  if (typeof name !== 'string' || !name.trim()) {
    error = error || 'Tool name is missing';
  }

  return {
    id,
    name: typeof name === 'string' ? name.trim() : '',
    arguments: args,
    ...(error ? { error } : {}),
  };
}

function normalizeResponse(raw) {
  if (typeof raw === 'string') {
    return {
      text: raw,
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    };
  }

  if (!isPlainObject(raw)) {
    throw new Error('Model adapter returned an invalid response');
  }

  const message = isPlainObject(raw.message) ? raw.message : null;
  const text = raw.text ?? raw.content ?? message?.content ?? '';
  if (typeof text !== 'string') {
    throw new Error('Model response text must be a string');
  }

  const rawCalls = raw.toolCalls ?? raw.tool_calls ?? message?.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) {
    throw new Error('Model response tool calls must be an array');
  }

  const toolCalls = rawCalls.map(normalizeToolCall);
  const rawFinish = raw.finishReason ?? raw.done_reason ?? raw.finish_reason ?? null;
  const finishReason = rawFinish === 'length'
    ? 'length'
    : (toolCalls.length > 0 ? 'tool_calls' : 'stop');

  const usage = raw.usage ?? (Number.isInteger(raw.prompt_eval_count) || Number.isInteger(raw.eval_count)
    ? {
        promptTokens: raw.prompt_eval_count ?? null,
        completionTokens: raw.eval_count ?? null,
        totalTokens: (raw.prompt_eval_count ?? 0) + (raw.eval_count ?? 0),
      }
    : null);

  return { text, toolCalls, finishReason, usage };
}

// Model-agnostic boundary. Adapters return either normalized responses or
// Ollama-style messages; this class is the only place the runtime sees them.
class ModelGateway {
  constructor({
    adapter,
    defaultOptions = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!adapter || typeof adapter.chat !== 'function') {
      throw new Error('ModelGateway requires an adapter with a chat() method');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('ModelGateway timeoutMs must be a positive integer');
    }

    this.adapter = adapter;
    this.defaultOptions = defaultOptions;
    this.timeoutMs = timeoutMs;
  }

  async chat({ messages, tools = [], options = {}, signal = null } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('ModelGateway requires at least one message');
    }
    if (!Array.isArray(tools)) {
      throw new Error('tools must be an array');
    }
    if (options !== null && typeof options !== 'object') {
      throw new Error('options must be an object');
    }

    for (const message of messages) {
      if (!message || typeof message !== 'object' || !VALID_ROLES.has(message.role)) {
        throw new Error(`Invalid model message role: ${String(message?.role)}`);
      }
      if (typeof message.content !== 'string') {
        throw new Error('Model message content must be a string');
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Model request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const raw = await this.adapter.chat({
        messages,
        tools,
        options: { ...this.defaultOptions, ...(options || {}) },
        signal: controller.signal,
      });
      return normalizeResponse(raw);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof Error) throw reason;
        throw new Error(typeof reason === 'string' ? reason : 'Model request aborted');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = {
  ModelGateway,
  normalizeResponse,
  normalizeToolCall,
  DEFAULT_TIMEOUT_MS,
};
