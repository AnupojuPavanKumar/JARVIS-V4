'use strict';

const { parseJsonResponse } = require('../tools/tool-call-fallback');
const { resolveContextBudget, fitMessagesToBudget } = require('../context/token-budget');
const { validatePlan } = require('./plan-validator');

function fitPlanningMessages(messages, { capabilities, modelOptions, outputReserve }) {
  const { contextWindow } = resolveContextBudget({ capabilities, modelOptions });
  const fitted = fitMessagesToBudget(messages, { contextWindow, outputReserve });
  return fitted.messages;
}

function summarizeTools(tools, limit = 40) {
  const list = Array.isArray(tools) ? tools : [];
  return list.slice(0, limit).map(tool => {
    const name = tool.id || tool.name;
    const description = typeof tool.description === 'string' ? tool.description.slice(0, 180) : '';
    return `- ${name}${description ? `: ${description}` : ''}`;
  }).join('\n');
}

function buildPlannerPrompt({ task, tools, maxSteps }) {
  const goal = String(task?.goal || '').slice(0, 6000);
  return [
    {
      role: 'system',
      content: `You are the planning component of a local desktop agent.
Return only one JSON object. Do not use markdown, prose, or tool calls.
The plan must be small and inspectable. Each step:
{"id":"1","description":"specific action","dependsOn":[],"tool":"optional_tool_name","args":{}}
Rules:
- ${maxSteps} steps maximum.
- IDs must be unique strings and dependencies must refer to earlier step IDs.
- Only use tools from the supplied list. Omit "tool" for reasoning/verification steps.
- Do not invent tool results.
- Keep each description under 300 characters.`,
    },
    {
      role: 'user',
      content: `[GOAL]\n${goal}\n\n[AVAILABLE TOOLS]\n${summarizeTools(tools) || '(none)'}\n\nCreate the plan JSON now.`,
    },
  ];
}

function buildRevisionPrompt({ task, failedStep, error, tools }) {
  const goal = String(task?.goal || '').slice(0, 3000);
  return [
    {
      role: 'system',
      content: `You revise exactly one failed plan step for a local desktop agent.
Return only one JSON object:
{"id":"existing_id","description":"revised action","dependsOn":[],"tool":"optional_tool_name","args":{}}
Do not rewrite or reorder the full plan. Do not use markdown or prose.
Only use tools from the supplied list.`,
    },
    {
      role: 'user',
      content: `[GOAL]\n${goal}\n\n[FAILED STEP]\n${JSON.stringify(failedStep)}\n\n[FAILURE]\n${String(error || 'unknown failure').slice(0, 1000)}\n\n[AVAILABLE TOOLS]\n${summarizeTools(tools) || '(none)'}\n\nReturn the revised step JSON now.`,
    },
  ];
}

class Planner {
  constructor({ model, tools = null, maxSteps = 8 } = {}) {
    if (!model || typeof model.chat !== 'function') {
      throw new Error('Planner requires a model gateway');
    }
    this.model = model;
    this.tools = tools;
    this.maxSteps = maxSteps;
  }

  _toolList() {
    if (!this.tools) return [];
    if (typeof this.tools.listTools === 'function') return this.tools.listTools();
    if (Array.isArray(this.tools.definitions)) return this.tools.definitions;
    return [];
  }

  async createPlan({ task, capabilities = {}, modelOptions = {}, signal = null } = {}) {
    const tools = this._toolList();
    const response = await this.model.chat({
      messages: fitPlanningMessages(
        buildPlannerPrompt({ task, tools, maxSteps: this.maxSteps }),
        { capabilities, modelOptions, outputReserve: 512 }
      ),
      tools: [],
      options: { ...modelOptions, temperature: 0.2, num_predict: 512 },
      signal,
    });
    const raw = parseJsonResponse(response.text);
    const validation = validatePlan(raw, {
      toolNames: tools.map(tool => tool.id || tool.name).filter(Boolean),
      maxSteps: this.maxSteps,
    });
    return {
      ...validation,
      usage: response.usage || null,
      raw: response.text,
    };
  }

  async reviseStep({ task, failedStep, error, capabilities = {}, modelOptions = {}, signal = null } = {}) {
    const tools = this._toolList();
    const toolNames = new Set(tools.map(tool => tool.id || tool.name).filter(Boolean));
    const response = await this.model.chat({
      messages: fitPlanningMessages(
        buildRevisionPrompt({ task, failedStep, error, tools }),
        { capabilities, modelOptions, outputReserve: 320 }
      ),
      tools: [],
      options: { ...modelOptions, temperature: 0.2, num_predict: 320 },
      signal,
    });
    const raw = parseJsonResponse(response.text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Planner did not return a revised step object', usage: response.usage || null };
    }

    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description || description.length > 600) {
      return { ok: false, error: 'Revised step has an invalid description', usage: response.usage || null };
    }
    const tool = typeof raw.tool === 'string' && raw.tool.trim() ? raw.tool.trim() : null;
    if (tool && toolNames.size > 0 && !toolNames.has(tool)) {
      return { ok: false, error: `Revised step references unknown tool: ${tool}`, usage: response.usage || null };
    }

    return {
      ok: true,
      patch: {
        description,
        ...(tool ? { tool } : {}),
        ...(raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? { args: raw.args } : {}),
      },
      usage: response.usage || null,
      raw: response.text,
    };
  }
}

module.exports = {
  Planner,
  buildPlannerPrompt,
  buildRevisionPrompt,
};
