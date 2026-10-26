'use strict';

const { parseJsonResponse } = require('../tools/tool-call-fallback');
const { resolveContextBudget, fitMessagesToBudget } = require('../context/token-budget');

function compactToolResults(steps, limit = 8) {
  const results = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || step.kind !== 'tool') continue;
    const result = step.result;
    let text = '';
    if (typeof result === 'string') text = result;
    else if (result && typeof result === 'object') {
      text = result.agentText || result.summaryText
        || JSON.stringify(result.result ?? result.data ?? result.error ?? result);
    }
    results.push({
      tool: step.tool,
      status: step.status,
      error: step.error || null,
      output: String(text || '').slice(0, 1200),
    });
  }
  return results.slice(-limit);
}

function buildVerifierPrompt({ task, plan = [], finalAnswer = '', toolResults = [] }) {
  return [
    {
      role: 'system',
      content: `You are an independent verifier for a local desktop agent.
Decide whether the final answer actually satisfies the user's goal and is supported by the recorded tool results.
Return only one JSON object:
{"verdict":"accept"|"reject","reason":"short explanation","guidance":"what to change if rejected"}
Rules:
- Reject if the answer invents measurements, ignores a failed required step, or claims an unsafe action that did not happen.
- Do not accept merely because the agent says it is done.
- Do not request new tools; only judge the result.`,
    },
    {
      role: 'user',
      content: `[GOAL]\n${String(task?.goal || '').slice(0, 4000)}\n\n[PLAN]\n${JSON.stringify(plan).slice(0, 4000)}\n\n[TOOL RESULTS]\n${JSON.stringify(toolResults).slice(0, 6000)}\n\n[FINAL ANSWER]\n${String(finalAnswer).slice(0, 5000)}\n[END FINAL ANSWER]\n\nReturn the verdict JSON now.`,
    },
  ];
}

function parseVerdict(raw, text) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const verdict = String(raw.verdict ?? raw.status ?? raw.result ?? '').toLowerCase();
    if (['accept', 'accepted', 'pass', 'passed', 'ok'].includes(verdict)) {
      return { accepted: true, reason: String(raw.reason || ''), guidance: String(raw.guidance || '') };
    }
    if (['reject', 'rejected', 'fail', 'failed', 'no'].includes(verdict)) {
      return { accepted: false, reason: String(raw.reason || ''), guidance: String(raw.guidance || '') };
    }
    if (raw.ok === true) return { accepted: true, reason: String(raw.reason || ''), guidance: '' };
    if (raw.ok === false) return { accepted: false, reason: String(raw.reason || ''), guidance: String(raw.guidance || '') };
  }

  const value = typeof text === 'string' ? text.toLowerCase() : '';
  if (/\breject(ed)?\b|\bfail(ed)?\b/.test(value)) {
    return { accepted: false, reason: 'Verifier rejected the result', guidance: '' };
  }
  if (/\baccept(ed)?\b|\bpass(ed)?\b/.test(value)) {
    return { accepted: true, reason: 'Verifier accepted the result', guidance: '' };
  }
  return { accepted: false, reason: 'Verifier returned an invalid decision', guidance: '' };
}

class Verifier {
  constructor({ model } = {}) {
    if (!model || typeof model.chat !== 'function') {
      throw new Error('Verifier requires a model gateway');
    }
    this.model = model;
  }

  async verify({
    task,
    plan = [],
    finalAnswer = '',
    toolResults = [],
    capabilities = {},
    modelOptions = {},
    signal = null,
  } = {}) {
    const { contextWindow } = resolveContextBudget({ capabilities, modelOptions });
    const fitted = fitMessagesToBudget(
      buildVerifierPrompt({ task, plan, finalAnswer, toolResults }),
      { contextWindow, outputReserve: 256 }
    );
    const response = await this.model.chat({
      messages: fitted.messages,
      tools: [],
      options: { ...modelOptions, temperature: 0, num_predict: 256 },
      signal,
    });
    const raw = parseJsonResponse(response.text);
    return {
      ...parseVerdict(raw, response.text),
      usage: response.usage || null,
      raw: response.text,
    };
  }
}

module.exports = {
  Verifier,
  buildVerifierPrompt,
  compactToolResults,
  parseVerdict,
};
