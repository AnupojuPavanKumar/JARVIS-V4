// ═══════════════════════════════════════════════════════════════
// JARVIS — TOOL EXECUTOR (Agentic Loop)
// ═══════════════════════════════════════════════════════════════
// Detects when the LLM outputs a TOOL_CALL block, executes the
// corresponding skill via window.jarvis.skillsRun, then re-injects
// the result into the conversation so the model can formulate a
// final response — forming a single-step agentic loop.
//
// Tool call format expected from LLM:
//   <<<TOOL_CALL>>>
//   {"tool": "get_datetime", "args": {}}
//   <<<END_TOOL_CALL>>>
// ═══════════════════════════════════════════════════════════════

const ToolExecutor = (() => {
  const XML_RE = /<tool_call>([\s\S]*?)<\/tool_call>/i;

  function detectToolCall(text) {
    const matches = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)];
    if (matches.length > 0) {
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(matches[i][1].trim());
          if (parsed && typeof parsed.tool === 'string') {
            const textBefore = text.slice(0, matches[i].index).trim().toLowerCase();
            if (textBefore.endsWith('example:') || textBefore.includes('example:\n') || textBefore.includes('command should be:')) {
              continue;
            }
            return parsed;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  // ── Validate tool args against the manifest params schema ─────
  function validateToolArgs(toolId, args) {
    const skill = window.Skills?._manifest?.find(s => s.id === toolId);
    if (!skill || !skill.params) return null; // no schema = anything goes
    for (const [key, schema] of Object.entries(skill.params)) {
      if (schema.required && (args[key] === undefined || args[key] === null || args[key] === '')) {
        return `Missing required param "${key}" for tool "${toolId}"`;
      }
      if (args[key] !== undefined && schema.type && typeof args[key] !== schema.type) {
        return `Param "${key}" must be ${schema.type}, got ${typeof args[key]}`;
      }
      if (schema.enum && args[key] !== undefined && !schema.enum.includes(args[key])) {
        return `Param "${key}" must be one of [${schema.enum.join(', ')}]`;
      }
    }
    return null; // valid
  }

  // ── Execute a tool call and return its result string ───────
  async function executeToolCall(toolCall) {
    const { tool, args = {} } = toolCall;
    if (!window.jarvis || !window.jarvis.skillsRun) {
      return `[TOOL_RESULT: error — Skills IPC not available]`;
    }
    // ponytail: validate args before hitting IPC
    const validationError = validateToolArgs(tool, args);
    if (validationError) {
      console.warn(`[ToolExecutor] Validation error: ${validationError}`);
      return `[TOOL_RESULT: error — ${validationError}]`;
    }
    try {
      const res = await window.jarvis.skillsRun(tool, args);
      if (res && res.ok) {
        const payload = res.result !== undefined ? res.result : (res.data !== undefined ? res.data : res);
        const output = typeof payload === 'object'
          ? JSON.stringify(payload, null, 2)
          : String(payload);
        return `[TOOL_RESULT: ${tool}]\n${output}\n[END_TOOL_RESULT]`;
      } else {
        return `[TOOL_RESULT: error — ${res?.error || 'unknown error from skill ' + tool}]`;
      }
    } catch (e) {
      return `[TOOL_RESULT: error — ${e.message}]`;
    }
  }


  // ── Build the system-level tool manifest for the LLM ───────
  // This is injected as part of the system prompt so the model
  // knows which tools it can call, including their parameter schemas.
  function buildToolManifestPrompt(skills) {
    if (!skills || !skills.length) return '';

    const toolDefs = skills.map(sk => {
      let def = `  • ${sk.id}: ${sk.description}`;

      // Append parameter hints when the skill has defined params
      const params = sk.params ? Object.entries(sk.params) : [];
      if (params.length) {
        const paramLines = params.map(([key, schema]) => {
          const req  = schema.required ? 'required' : 'optional';
          const type = schema.type || 'string';
          const enumHint = schema.enum ? ` [${schema.enum.join('|')}]` : '';
          const desc = schema.description ? ` — ${schema.description}` : '';
          return `      - ${key} (${type}, ${req}${enumHint})${desc}`;
        });
        def += `\n    Args:\n${paramLines.join('\n')}`;
      }
      return def;
    }).join('\n\n');

    return `
[JARVIS TOOL SYSTEM]
You have access to the following tools. To use a tool, output EXACTLY this format (nothing else on those lines):
<tool_call>
{"tool": "<tool_id>", "args": {<key-value args>}}
</tool_call>

Available tools:
${toolDefs}

Rules:
- CRITICAL: You MUST wrap your JSON inside <tool_call> and </tool_call> tags.
- CRITICAL: After outputting the <tool_call> block, STOP GENERATING IMMEDIATELY. DO NOT output the result yourself.
- NEVER hallucinate, fake, or invent tool results. You MUST wait for the system to inject the [TOOL_RESULT] data.
- Supply ALL required args.
- DO NOT provide examples of tool calls in your conversation.
[END TOOL SYSTEM]
`.trim();
  }

  // ── Main: intercept a completed response and handle tool calls ──
  // Returns { handled: bool, resultText?: string }
  async function handleResponse(fullText) {
    const toolCall = detectToolCall(fullText);
    if (!toolCall) return { handled: false };

    console.log(`[ToolExecutor] Detected tool call: ${toolCall.tool}`, toolCall.args);

    // Show brief UI feedback
    if (typeof window.showToast === 'function') {
      window.showToast(`⚙ Executing tool: ${toolCall.tool}…`, 'info');
    }

    const resultText = await executeToolCall(toolCall);
    return { handled: true, toolCall, resultText };
  }

  // ── Determine if a user message could benefit from a tool ──
  // Used for proactive skill triggering (keyword-based fallback)
  function matchSkillByTrigger(text, skills) {
    if (!skills || !skills.length) return null;
    const lower = text.toLowerCase();
    for (const sk of skills) {
      if (!sk.trigger) continue;
      if (sk.trigger.some(t => lower.includes(t.toLowerCase()))) {
        return sk;
      }
    }
    return null;
  }

  return {
    detectToolCall,
    executeToolCall,
    handleResponse,
    buildToolManifestPrompt,
    matchSkillByTrigger,
    validateToolArgs,
  };

})();

window.ToolExecutor = ToolExecutor;
console.log('[JARVIS] ToolExecutor module loaded.');
