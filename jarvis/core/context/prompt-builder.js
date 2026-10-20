'use strict';

const DEFAULT_MAX_SYSTEM_CHARS = 24000;
const DEFAULT_MAX_HISTORY_CHARS = 16000;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;

const DEFAULT_AGENT_PROMPT = `You are JARVIS, an autonomous desktop agent running locally on the user's machine.

Operating principles:
- Work toward the user's goal one step at a time.
- Use tools when they are needed; do not invent tool results.
- Before a risky, destructive, or externally visible action, wait for approval.
- Keep the user informed through concise progress updates.
- When the goal is complete, provide a final answer and stop.

Tool protocol:
- Prefer native tool calls when the model supports them.
- If native tool calls are unavailable, emit exactly one block in this form and then stop generating:
<tool_call>
{"tool": "tool_id", "args": {}}
</tool_call>
- Never fabricate a result. The runtime will execute the tool and return [TOOL_RESULT].
- Supply every required argument.
- Do not include tool-call examples in your final answer.`;

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

  return `[JARVIS TOOL SYSTEM]
Available tools:
${definitions}

Rules:
- Emit at most one tool call per step.
- After a tool call, stop and wait for the [TOOL_RESULT].
- Never fabricate, guess, or repeat a tool result.
[END TOOL SYSTEM]`;
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
    const text = file.content.slice(0, Math.min(6000, remaining));
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

  build({ task, context = {}, tools = [] } = {}) {
    if (!task || typeof task !== 'object') throw new Error('PromptBuilder requires a task');
    if (typeof task.goal !== 'string' || !task.goal.trim()) {
      throw new Error('PromptBuilder requires a task goal');
    }

    const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
    const sections = [];

    sections.push(context.systemPrompt || DEFAULT_AGENT_PROMPT);
    sections.push(`[CURRENT SYSTEM TIME: ${now.toLocaleDateString('en-GB', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    })}, ${now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })}]`);

    const hardware = buildHardwareContext(context.systemSpecs);
    if (hardware) sections.push(hardware);

    const memory = normalizeMemory(context.memory);
    if (memory.length > 0) {
      sections.push(`[USER MEMORY — always remember these facts about the user]
${memory.slice(0, 50).map(item => `• ${item}`).join('\n')}
[END MEMORY]`);
    }

    const project = buildProjectContext(context.projectContext);
    if (project) sections.push(project);

    if (context.webSearchContext) {
      sections.push(`[WEB SEARCH CONTEXT]\n${String(context.webSearchContext).slice(0, 3000)}\n[END WEB SEARCH CONTEXT]`);
    }

    sections.push(`[DIRECTIVE]
${context.deepWorkEnabled
    ? 'Work step by step. Be precise. Use tools when needed. Keep progress updates brief.'
    : 'Respond concisely. Do not expose hidden reasoning. Keep answers short unless detail is requested.'}`);

    const manifest = buildToolManifestText(tools);
    if (manifest) sections.push(manifest);

    let system = sections.join('\n\n');
    system = truncate(system, this.maxSystemChars);

    const history = this._normalizeHistory(task, context);
    return [{ role: 'system', content: system }, ...history];
  }

  _normalizeHistory(task, context) {
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

    // Keep the newest messages within the character budget. Always retain the
    // first goal message so a long tool transcript cannot erase the objective.
    const kept = [];
    let total = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const size = message.content.length + 32;
      if (kept.length > 0 && total + size > this.maxHistoryChars) break;
      kept.push(message);
      total += size;
    }
    kept.reverse();

    if (messages.length > 0 && kept[0] !== messages[0]) {
      kept.unshift(messages[0]);
    }

    return kept;
  }
}

module.exports = {
  PromptBuilder,
  buildToolManifestText,
  buildJsonSchema,
  toNativeTool,
  DEFAULT_AGENT_PROMPT,
  DEFAULT_MAX_SYSTEM_CHARS,
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_MESSAGES,
};
