'use strict';

const DEFAULT_CONTEXT_LENGTH = 4096;
const DEFAULT_OUTPUT_TOKENS = 512;

function positiveInteger(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseOllamaParameters(parameters) {
  const result = {};
  if (typeof parameters !== 'string') return result;

  for (const line of parameters.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-zA-Z0-9_]+)\s+(-?\d+(?:\.\d+)?)$/);
    if (!match) continue;
    result[match[1]] = Number(match[2]);
  }
  return result;
}

function extractModelInfoContextLength(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return null;

  let longest = null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!/(^|\.)context_length$/i.test(key)) continue;
    const number = positiveInteger(value);
    if (number && (longest === null || number > longest)) longest = number;
  }
  return longest;
}

function capabilitySet(show) {
  if (Array.isArray(show?.capabilities)) {
    return new Set(show.capabilities.filter(item => typeof item === 'string'));
  }
  return null;
}

// Ollama's /api/show returns both model metadata and a capabilities array on
// newer releases. Older releases only expose the template, so tool support is
// inferred from the template's .Tools guard when possible.
function capabilitiesFromOllamaShow(show, { model = '', defaultOptions = {} } = {}) {
  const source = show && typeof show === 'object' ? show : {};
  const parameters = parseOllamaParameters(source.parameters);
  const defaults = defaultOptions && typeof defaultOptions === 'object' ? defaultOptions : {};
  const declared = capabilitySet(source);
  const template = typeof source.template === 'string' ? source.template : '';
  const modelContext = extractModelInfoContextLength(source.model_info);
  const requestedContext = positiveInteger(parameters.num_ctx)
    || positiveInteger(defaults.num_ctx)
    || null;
  const contextLength = Math.min(
    modelContext || requestedContext || DEFAULT_CONTEXT_LENGTH,
    requestedContext || modelContext || DEFAULT_CONTEXT_LENGTH
  );
  const requestedOutput = positiveInteger(parameters.num_predict)
    || positiveInteger(defaults.num_predict)
    || DEFAULT_OUTPUT_TOKENS;

  let tools = false;
  if (declared) {
    tools = declared.has('tools');
  } else if (template) {
    tools = /\.Tools\b|tool_calls|tool_calls/i.test(template);
  }

  return normalizeCapabilities({
    tools,
    vision: declared ? declared.has('vision') : false,
    contextLength,
    maxOutputTokens: Math.min(requestedOutput, Math.max(64, contextLength - 64)),
    model,
    source: 'ollama',
  });
}

function normalizeCapabilities(raw, {
  model = '',
  defaultContextLength = DEFAULT_CONTEXT_LENGTH,
  defaultOutputTokens = DEFAULT_OUTPUT_TOKENS,
} = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const contextLength = positiveInteger(input.contextLength)
    || positiveInteger(input.context_length)
    || positiveInteger(input.numCtx)
    || defaultContextLength;
  const maxOutputTokens = Math.min(
    positiveInteger(input.maxOutputTokens)
      || positiveInteger(input.max_output_tokens)
      || positiveInteger(input.numPredict)
      || defaultOutputTokens,
    Math.max(64, contextLength - 64)
  );

  return {
    model: typeof input.model === 'string' && input.model ? input.model : model,
    contextLength,
    maxOutputTokens,
    tools: input.tools === true || input.supportsTools === true,
    vision: input.vision === true || input.supportsVision === true,
    source: typeof input.source === 'string' ? input.source : 'default',
  };
}

module.exports = {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_OUTPUT_TOKENS,
  parseOllamaParameters,
  extractModelInfoContextLength,
  capabilitiesFromOllamaShow,
  normalizeCapabilities,
};
