'use strict';

// Provider-neutral, deliberately conservative token estimate. Local models
// tokenize differently (and code/JSON often tokenizes worse than prose), so we
// budget with 3.5 characters per token rather than the usual ~4. Callers still
// reserve real output space before every request, which is what prevents a
// silent context overflow.
const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD_TOKENS = 4;

function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  tokens += estimateTokens(typeof message.content === 'string' ? message.content : '');
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    try {
      tokens += estimateTokens(JSON.stringify(message.toolCalls));
    } catch {
      tokens += MESSAGE_OVERHEAD_TOKENS;
    }
  }
  if (message.name) tokens += 1;
  return tokens;
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function truncateToTokens(text, maxTokens, marker = '\n[... truncated ...]') {
  if (typeof text !== 'string') return '';
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (text.length <= maxChars) return text;
  if (maxChars === 0) return '';
  const suffix = marker.length < maxChars ? marker : '';
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function overflowError(message) {
  const error = new Error(message);
  error.code = 'context-overflow';
  return error;
}

function truncateMiddleToTokens(text, maxTokens, marker = '\n[... middle truncated ...]\n') {
  if (typeof text !== 'string') return '';
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (text.length <= maxChars) return text;
  if (maxChars === 0) return '';
  const suffix = marker.length < maxChars ? marker : '';
  const usable = Math.max(0, maxChars - suffix.length);
  const headChars = Math.floor(usable * 0.62);
  const tailChars = usable - headChars;
  return `${text.slice(0, headChars)}${suffix}${tailChars > 0 ? text.slice(-tailChars) : ''}`;
}

// Planner/verifier prompts are built outside PromptBuilder but still need the
// same hard guarantee: never send more input tokens than the window allows.
// Keep the system prompt intact, then trim the middle of the largest user
// message so both the opening goal and the closing instruction survive.
function fitMessagesToBudget(messages, {
  contextWindow,
  outputReserve = 512,
  minInputTokens = 128,
} = {}) {
  const window = positiveInteger(contextWindow);
  if (!window) throw new Error('fitMessagesToBudget requires a positive contextWindow');
  const reserve = positiveInteger(outputReserve) || 0;
  const inputBudget = window - reserve;
  if (inputBudget < minInputTokens) {
    throw overflowError(`Prompt needs at least ${minInputTokens} input tokens, but only ${inputBudget} are available`);
  }
  if (!Array.isArray(messages)) throw new Error('fitMessagesToBudget requires messages');

  const copies = messages.map(message => ({ ...message }));
  const systemTokens = copies
    .filter(message => message.role === 'system')
    .reduce((total, message) => total + estimateMessageTokens(message), 0);
  if (systemTokens >= inputBudget) {
    throw overflowError(`System prompt uses ${systemTokens} tokens but only ${inputBudget} are available`);
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const total = estimateMessagesTokens(copies);
    if (total <= inputBudget) {
      return {
        messages: copies,
        budget: {
          contextWindow: window,
          inputBudget,
          outputReserve: reserve,
          promptTokens: total,
          truncated: total < estimateMessagesTokens(messages),
        },
      };
    }

    const candidates = copies
      .map((message, index) => ({ message, index }))
      .filter(entry => entry.message.role !== 'system' && typeof entry.message.content === 'string')
      .sort((a, b) => estimateTokens(b.message.content) - estimateTokens(a.message.content));
    if (candidates.length === 0) break;

    const target = candidates[0].message;
    const currentTokens = estimateTokens(target.content);
    if (currentTokens <= 8) break;
    const excess = total - inputBudget;
    const nextTokens = Math.max(8, currentTokens - Math.max(16, excess + 8));
    target.content = truncateMiddleToTokens(target.content, nextTokens);
  }

  throw overflowError(`Prompt cannot fit in ${inputBudget} input tokens`);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function resolveContextBudget({
  capabilities = {},
  modelOptions = {},
  defaultContextLength = 4096,
  defaultOutputTokens = 512,
  outputReserveTokens = null,
} = {}) {
  const configuredContext = positiveInteger(modelOptions.num_ctx);
  const capabilityContext = positiveInteger(capabilities.contextLength);
  const contextWindow = Math.min(
    configuredContext || capabilityContext || defaultContextLength,
    capabilityContext || configuredContext || defaultContextLength
  );
  const configuredOutput = positiveInteger(modelOptions.num_predict);
  const capabilityOutput = positiveInteger(capabilities.maxOutputTokens);
  const requestedReserve = positiveInteger(outputReserveTokens);
  const outputReserve = Math.min(
    requestedReserve || configuredOutput || capabilityOutput || defaultOutputTokens,
    Math.max(64, contextWindow - 512)
  );
  const inputBudget = contextWindow - outputReserve;

  return {
    contextWindow,
    inputBudget,
    outputReserve,
    estimated: true,
    charsPerToken: CHARS_PER_TOKEN,
  };
}

module.exports = {
  CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  truncateToTokens,
  truncateMiddleToTokens,
  fitMessagesToBudget,
  resolveContextBudget,
};
