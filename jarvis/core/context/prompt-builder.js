'use strict';

const {
  CHARS_PER_TOKEN,
  estimateTokens,
  estimateMessagesTokens,
  truncateToTokens,
  resolveContextBudget,
} = require('./token-budget');

const DEFAULT_MAX_SYSTEM_CHARS = 24000;
const DEFAULT_MAX_HISTORY_CHARS = 16000;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;

const DEFAULT_AGENT_PROMPT = `You are JARVIS, an autonomous desktop agent running locally on the user's machine.

Operating principles:
- Work toward the user's goal one step at a time.
- Use tools when they are needed; do not invent tool results.
- For live measurements or time-series observations, use the system_metrics tool. Never guess or substitute measurements.
- Before a risky, destructive, or externally visible action, wait for approval.
- Keep the user informed through concise progress updates.
- When the goal is complete, provide a final answer and stop.

Tool rules:
- Use the provided tool interface, and call at most one tool per step.
- Supply every required argument and never fabricate a tool result.
- The runtime executes the tool and returns the real result.
- Do not include tool-call examples in your final answer.`;

const NATIVE_TOOL_PROTOCOL = `[TOOL PROTOCOL]
Native function calling is enabled. Use the API's tool interface.
- Call at most one tool per step.
- After a tool call, stop and wait for the real tool result.
- Never fabricate, guess, or repeat a tool result.
[END TOOL PROTOCOL]`;

const JSON_TOOL_PROTOCOL = `[TOOL PROTOCOL — JSON FALLBACK]
Native tool calls are not available for this model. If you need a tool, respond with exactly one JSON object and no prose:
{"tool":"tool_id","args":{}}
- Use the exact tool ids and argument names below.
- Do not use XML tags.
- After emitting a tool call, stop and wait for the real tool result.
- Never fabricate, guess, or repeat a tool result.`;

const PLAN_STATUS_MARK = Object.freeze({
  pending: '○',
  active: '▶',
  completed: '✓',
  failed: '✗',
  skipped: '–',
  revised: '↻',
});

class ContextOverflowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContextOverflowError';
    this.code = 'context-overflow';
    this.details = details;
  }
}

function truncate(text, maxChars, marker = '\n[... truncated ...]') {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
  const name = fn.id || fn.name;
  if (typeof name !== 'string' || !name.trim()) return null;

  const params = fn.parameters || fn.params || {};
  return {
    name: name.trim(),
    description: typeof fn.description === 'string' ? fn.description : '',
    parameters: params && typeof params === 'object' ? params : {},
  };
}

function buildJsonSchema(params) {
  const properties = {};
  const required = [];

  for (const [key, schema] of Object.entries(params || {})) {
    if (!schema || typeof schema !== 'object') continue;
    const property = {
      type: schema.type || 'string',
    };
    if (schema.description) property.description = schema.description;
    if (Array.isArray(schema.enum)) property.enum = schema.enum;
    properties[key] = property;
    if (schema.required) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

function toNativeTool(tool) {
  const normalized = normalizeTool(tool);
  if (!normalized) return null;
  return {
    type: 'function',
    function: {
      name: normalized.name,
      description: normalized.description,
      parameters: buildJsonSchema(normalized.parameters),
    },
  };
}

function buildToolManifestText(tools) {
  const normalized = (tools || []).map(normalizeTool).filter(Boolean);
  if (normalized.length === 0) return '';

  const definitions = normalized.map(tool => {
    const params = Object.entries(tool.parameters || {}).map(([key, schema]) => {
      const required = schema?.required ? 'required' : 'optional';
      const type = schema?.type || 'string';
      const enumHint = Array.isArray(schema?.enum) ? ` [${schema.enum.join('|')}]` : '';
      const description = schema?.description ? ` — ${schema.description}` : '';
      return `    - ${key} (${type}, ${required}${enumHint})${description}`;
    });
    return `  • ${tool.name}: ${tool.description}${params.length ? `\n${params.join('\n')}` : ''}`;
  }).join('\n\n');

  return `Available tools:
${definitions}`;
}

function normalizeMemory(memory) {
  if (!Array.isArray(memory)) return [];
  return memory
    .map(item => (typeof item === 'string' ? item : item?.text))
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim());
}

function buildProjectContext(projectContext, budget = 8000) {
  if (!projectContext || typeof projectContext !== 'object') return '';
  const files = Array.isArray(projectContext.files) ? projectContext.files : [];
  if (files.length === 0) return '';

  const tree = files.map(file => `  ${file.relativePath || file.path || 'unknown'}`).join('\n');
  let remaining = budget;
  const excerpts = [];

  for (const file of files) {
    if (remaining <= 0) break;
    if (!file.content) continue;
    const text = String(file.content).slice(0, Math.min(6000, remaining));
    remaining -= text.length;
    excerpts.push(`### ${file.relativePath || file.path || 'unknown'}\n\`\`\`\n${text}\n\`\`\``);
  }

  return `[PROJECT CONTEXT: ${projectContext.name || 'workspace'}]
Root: ${projectContext.rootPath || 'unknown'}
File tree:
${tree}
${excerpts.join('\n')}
[END PROJECT CONTEXT]`;
}

function buildHardwareContext(specs) {
  if (!specs || typeof specs !== 'object') return '';
  const memoryGb = Number.isFinite(specs.totalMem)
    ? (specs.totalMem / (1024 * 1024 * 1024)).toFixed(1)
    : 'Unknown';
  return `[HOST HARDWARE SPECIFICATIONS]
CPU: ${specs.cpuModel || 'Unknown'} (${specs.cpuCount || 'Unknown'} cores)
RAM: ${memoryGb} GB Total
Platform: ${specs.platform || 'Unknown'} (${specs.arch || 'Unknown'})
[END HARDWARE SPECIFICATIONS]`;
}

function buildPlanContext(plan, currentStepId = null) {
  if (!Array.isArray(plan) || plan.length === 0) return '';
  const lines = plan.map(step => {
    const mark = PLAN_STATUS_MARK[step.status] || '○';
    const current = step.id === currentStepId ? ' (current)' : '';
    return `${mark} ${step.id}. ${step.description}${current}`;
  });
  return `[EXECUTION PLAN]
${lines.join('\n')}
[END EXECUTION PLAN]`;
}

function toCharBudget(tokens) {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

class PromptBuilder {
  constructor({
    maxSystemChars = DEFAULT_MAX_SYSTEM_CHARS,
    maxHistoryChars = DEFAULT_MAX_HISTORY_CHARS,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
  } = {}) {
    if (!Number.isInteger(maxSystemChars) || maxSystemChars < 1000) {
      throw new Error('maxSystemChars must be an integer of at least 1000');
    }
    if (!Number.isInteger(maxHistoryChars) || maxHistoryChars < 1000) {
      throw new Error('maxHistoryChars must be an integer of at least 1000');
    }
    if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages < 1) {
      throw new Error('maxHistoryMessages must be a positive integer');
    }

    this.maxSystemChars = maxSystemChars;
    this.maxHistoryChars = maxHistoryChars;
    this.maxHistoryMessages = maxHistoryMessages;
  }

  buildToolDefinitions(tools) {
    return (tools || []).map(toNativeTool).filter(Boolean);
  }

  build(options = {}) {
    return this.buildWithBudget(options).messages;
  }

  buildWithBudget({ task, context = {}, tools = [], capabilities = null, toolMode = 'native' } = {}) {
    if (!task || typeof task !== 'object') throw new Error('PromptBuilder requires a task');
    if (typeof task.goal !== 'string' || !task.goal.trim()) {
      throw new Error('PromptBuilder requires a task goal');
    }
    if (toolMode !== 'native' && toolMode !== 'json') {
      throw new Error('toolMode must be "native" or "json"');
    }

    const budget = resolveContextBudget({
      capabilities: capabilities || context.modelCapabilities || {},
      modelOptions: context.modelOptions || {},
      outputReserveTokens: context.outputReserveTokens,
    });
    const nativeTools = toolMode === 'native' ? this.buildToolDefinitions(tools) : [];
    const toolSchemaTokens = nativeTools.length > 0
      ? estimateTokens(JSON.stringify(nativeTools))
      : 0;
    const manifest = toolMode === 'json' ? buildToolManifestText(tools) : '';
    const nativeNames = nativeTools.map(tool => tool.function.name).join(', ');
    const protocol = toolMode === 'json'
      ? `${JSON_TOOL_PROTOCOL}\n${manifest}\n[END TOOL PROTOCOL]`
      : `${NATIVE_TOOL_PROTOCOL}${nativeNames ? `\nAvailable tool ids: ${nativeNames}` : ''}`;

    if (toolSchemaTokens + estimateTokens(protocol) + 128 > budget.inputBudget) {
      throw new ContextOverflowError(
        `Tool schemas need ${toolSchemaTokens} tokens but the model has only ${budget.inputBudget} input tokens`,
        { ...budget, toolSchemaTokens, toolMode }
      );
    }

    const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
    let truncated = false;
    const available = budget.inputBudget - toolSchemaTokens;
    const systemCap = Math.max(160, Math.floor(available * 0.58));
    const memoryCap = Math.max(0, Math.floor(available * 0.12));
    const projectCap = Math.max(0, Math.floor(available * 0.18));
    const webCap = Math.max(0, Math.floor(available * 0.08));

    const timeSection = `[CURRENT SYSTEM TIME: ${now.toLocaleDateString('en-GB', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    })}, ${now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })}]`;
    const hardware = buildHardwareContext(context.systemSpecs);
    const plan = buildPlanContext(task.plan, task.currentPlanStepId);
    const fixedSections = [timeSection, hardware, plan, protocol].filter(Boolean);
    const fixedTokens = estimateTokens(fixedSections.join('\n\n'));
    const systemPrompt = String(context.systemPrompt || DEFAULT_AGENT_PROMPT);
    const systemPromptBudget = Math.max(64, systemCap - fixedTokens);
    const systemPromptText = truncateToTokens(systemPrompt, systemPromptBudget);
    if (systemPromptText !== systemPrompt) truncated = true;

    const sections = [systemPromptText, ...fixedSections];

    const memory = normalizeMemory(context.memory);
    if (memory.length > 0 && memoryCap > 0) {
      const memoryText = memory.slice(0, 50).map(item => `• ${item}`).join('\n');
      const fitted = truncateToTokens(memoryText, memoryCap);
      if (fitted !== memoryText) truncated = true;
      sections.push(`[USER MEMORY — always remember these facts about the user]
${fitted}
[END MEMORY]`);
    }

    if (context.projectContext && projectCap > 0) {
      const project = buildProjectContext(context.projectContext, toCharBudget(projectCap));
      if (project) {
        const fitted = truncateToTokens(project, projectCap);
        if (fitted !== project) truncated = true;
        sections.push(fitted);
      }
    }

    if (context.webSearchContext && webCap > 0) {
      const web = `[WEB SEARCH CONTEXT]\n${String(context.webSearchContext)}\n[END WEB SEARCH CONTEXT]`;
      const fitted = truncateToTokens(web, webCap);
      if (fitted !== web) truncated = true;
      sections.push(fitted);
    }

    sections.push(`[DIRECTIVE]
${context.deepWorkEnabled
    ? 'Work step by step. Be precise. Use tools when needed. Keep progress updates brief.'
    : 'Respond concisely. Do not expose hidden reasoning. Keep answers short unless detail is requested.'}`);

    let system = sections.join('\n\n');
    system = truncate(system, this.maxSystemChars);
    const systemTokens = estimateTokens(system);
    if (systemTokens + toolSchemaTokens > budget.inputBudget) {
      throw new ContextOverflowError(
        `System prompt and tool schemas need ${systemTokens + toolSchemaTokens} tokens; input budget is ${budget.inputBudget}`,
        { ...budget, systemTokens, toolSchemaTokens, toolMode }
      );
    }

    const historyBudget = Math.max(64, budget.inputBudget - systemTokens - toolSchemaTokens);
    const history = this._normalizeHistory(task, context, {
      maxTokens: historyBudget,
      maxChars: this.maxHistoryChars,
    });
    const historyTokens = estimateMessagesTokens(history);
    const promptTokens = systemTokens + historyTokens + toolSchemaTokens;
    if (promptTokens > budget.inputBudget) {
      throw new ContextOverflowError(
        `Prompt needs ${promptTokens} tokens but input budget is ${budget.inputBudget}`,
        {
          ...budget,
          promptTokens,
          systemTokens,
          historyTokens,
          toolSchemaTokens,
          toolMode,
        }
      );
    }

    const messages = [{ role: 'system', content: system }, ...history];
    Object.defineProperty(messages, 'budget', {
      configurable: true,
      enumerable: false,
      value: {
        ...budget,
        promptTokens,
        systemTokens,
        historyTokens,
        toolSchemaTokens,
        toolMode,
        truncated,
        nativeTools,
      },
    });
    return { messages, budget: messages.budget };
  }

  _normalizeHistory(task, context, { maxTokens, maxChars } = {}) {
    let messages = Array.isArray(task.messages) ? task.messages.slice() : [];

    if (messages.length === 0) {
      messages = [{
        role: 'user',
        content: `[AGENTIC GOAL]\n${task.goal}\n\nUse tools when needed. When the goal is complete, provide the final answer.`,
      }];
    }

    messages = messages
      .filter(message => message && typeof message === 'object')
      .filter(message => ['system', 'user', 'assistant', 'tool'].includes(message.role))
      .map(message => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
          ? { toolCalls: message.toolCalls }
          : {}),
      }))
      .filter(message => message.content.length > 0 || Array.isArray(message.toolCalls));

    if (messages.length === 0) {
      messages = [{
        role: 'user',
        content: `[AGENTIC GOAL]\n${task.goal}`,
      }];
    }

    if (messages.length > this.maxHistoryMessages) {
      const first = messages[0];
      messages = [first, ...messages.slice(-(this.maxHistoryMessages - 1))];
    }

    const tokenLimit = Number.isInteger(maxTokens) ? maxTokens : estimateTokens(String(task.goal || '')) + 512;
    const charLimit = Number.isInteger(maxChars) ? maxChars : this.maxHistoryChars;
    const first = messages[0];
    const kept = [];
    let totalTokens = 0;
    let totalChars = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === first) continue;
      const size = estimateMessagesTokens([message]);
      const chars = message.content.length + 32;
      if (kept.length > 0 && (totalTokens + size > tokenLimit || totalChars + chars > charLimit)) break;
      kept.push(message);
      totalTokens += size;
      totalChars += chars;
    }
    kept.reverse();

    const firstSize = estimateMessagesTokens([first]);
    while (kept.length > 0 && totalTokens + firstSize > tokenLimit) {
      const removed = kept.shift();
      totalTokens -= estimateMessagesTokens([removed]);
      totalChars -= removed.content.length + 32;
    }
    if (totalTokens + firstSize > tokenLimit) {
      throw new ContextOverflowError(
        `The goal message needs ${firstSize} tokens but only ${tokenLimit} history tokens are available`,
        { goalTokens: firstSize, historyBudget: tokenLimit }
      );
    }
    // Preserve the original goal even when it alone exceeds the soft character
    // cap; the hard token budget above is what prevents model context overflow.
    kept.unshift(first);

    return kept;
  }
}

module.exports = {
  PromptBuilder,
  ContextOverflowError,
  buildToolManifestText,
  buildJsonSchema,
  toNativeTool,
  buildPlanContext,
  DEFAULT_AGENT_PROMPT,
  NATIVE_TOOL_PROTOCOL,
  JSON_TOOL_PROTOCOL,
  DEFAULT_MAX_SYSTEM_CHARS,
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_MESSAGES,
};
