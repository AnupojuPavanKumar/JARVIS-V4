// JARVIS — Task Controller
// Orchestrates multi-step agentic execution over existing V4 systems.

window.TaskController = (() => {
  const MAX_STEPS = 15;
  let currentTask = null;

  function createTask(goal) {
    currentTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      goal: goal,
      state: 'IDLE',
      stepCount: 0,
      messages: [] // internal message history for the task
    };
    return currentTask;
  }

  // Helper to escape HTML safely
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, match => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
      return map[match];
    });
  }

  function stripToolCalls(text) {
    if (!text) return "";
    return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").replace(/```json\s*\{\s*"tool"[\s\S]*?```/gi, "").trim();
  }

  async function executeTask() {
    if (!currentTask) return;
    currentTask.state = 'EXECUTING';

    const $messages = document.getElementById("chat-messages");
    if (!$messages) return; // Fallback if UI is missing

    // Create Parent Agentic Task Element
    const n = window.MODES ? window.MODES[window.state.mode] : { icon: '⚙️', name: 'Agent' };
    const formatTime = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    const taskParentEl = document.createElement("div");
    taskParentEl.className = "message jarvis-message agentic-task";
    taskParentEl.id = currentTask.id;
    taskParentEl.innerHTML = `
      <div class="msg-avatar">${n.icon}</div>
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-sender">JARVIS (Agent)</span>
          <span class="msg-mode-tag task-status task-status-thinking">⚡ THINKING...</span>
          <span class="msg-time">${formatTime()}</span>
        </div>
        <div class="msg-bubble task-bubble">
          <details class="task-details" open>
            <summary>Agent Process & Logs</summary>
            <div class="task-log-content"></div>
          </details>
          <div class="task-final-output msg-content" style="display: none;"></div>
        </div>
      </div>
    `;
    $messages.appendChild(taskParentEl);
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();

    const statusEl = taskParentEl.querySelector(".task-status");
    const logContentEl = taskParentEl.querySelector(".task-log-content");
    const finalOutputEl = taskParentEl.querySelector(".task-final-output");

    function setStatus(text, cssClass) {
      statusEl.className = `msg-mode-tag task-status ${cssClass}`;
      statusEl.innerText = text;
    }

    setStatus('⚡ THINKING...', 'task-status-thinking');

    // Setup initial task prompt
    currentTask.messages.push({ 
      role: 'user', 
      content: `[AGENTIC GOAL]\n${currentTask.goal}\n\nYou are an autonomous agent. Use your available tools to achieve this goal step by step.\n\nCRITICAL RULE: Whenever you want to use a tool, you MUST wrap the JSON exactly inside <tool_call> and </tool_call> tags. Example:\n<tool_call>\n{"tool": "weather", "args": {"location": "London"}}\n</tool_call>\n\nThink step by step. When the goal is completely achieved, output your final response.`
    });

    let finalResponse = "";

    while (currentTask.stepCount < MAX_STEPS && currentTask.state === 'EXECUTING') {
      currentTask.stepCount++;
      setStatus(`⚙️ EXECUTING STEP ${currentTask.stepCount}`, 'task-status-executing');

      // Create UI streaming element for this step inside the log
      const stepWrapper = document.createElement("div");
      stepWrapper.className = "task-step streaming";
      stepWrapper.innerHTML = `
        <div class="task-step-title">Step ${currentTask.stepCount}</div>
        <div class="msg-content stream-text"></div>
      `;
      logContentEl.appendChild(stepWrapper);
      if (typeof window.scrollToBottom === 'function') window.scrollToBottom();

      let fullResponse = '';

      try {
        await new Promise((resolve, reject) => {
          let payload = currentTask.messages;
          if (typeof window.buildMessages === 'function') {
            const systemContext = window.buildMessages().find(m => m.role === 'system');
            if (systemContext) {
              payload = [systemContext, ...currentTask.messages];
            }
          }

          window.streamOllama(payload, {
            onChunk: (chunk, full) => {
              fullResponse = full;
              if (typeof window.updateStreamingEl === 'function') {
                window.updateStreamingEl(stepWrapper, full);
              }
            },
            onDone: (full) => {
              fullResponse = full;
              if (typeof window.finalizeStreamingEl === 'function') {
                window.finalizeStreamingEl(stepWrapper, full);
              }
              resolve();
            },
            onError: (err) => { reject(err); }
          });
        });
      } catch (err) {
        currentTask.state = 'ERROR';
        setStatus(`❌ ERROR`, 'task-status-error');
        if (typeof window.finalizeStreamingEl === 'function') {
          window.finalizeStreamingEl(stepWrapper, `[ERROR: ${err.message}]`);
        }
        break;
      }

      currentTask.messages.push({ role: 'assistant', content: fullResponse });

      // Check for tools using existing ToolExecutor
      const toolCall = window.ToolExecutor ? window.ToolExecutor.detectToolCall(fullResponse) : null;

      if (toolCall) {
        setStatus(`🔧 TOOL: ${toolCall.tool.toUpperCase()}`, 'task-status-tool');

        const toolResult = await window.ToolExecutor.executeToolCall(toolCall);
        currentTask.messages.push({ role: 'user', content: toolResult });

        // Append Tool result to log silently
        const toolEl = document.createElement("div");
        toolEl.className = "task-tool-result";
        toolEl.innerHTML = `<div class="task-step-title tool-title">Result: ${toolCall.tool}</div><pre><code>${escHtml(toolResult)}</code></pre>`;
        logContentEl.appendChild(toolEl);
        if (typeof window.scrollToBottom === 'function') window.scrollToBottom();

      } else {
        // No tool call detected, task is finished
        currentTask.state = 'COMPLETED';
        setStatus('✅ COMPLETED', 'task-status-completed');

        // Save final response
        finalResponse = stripToolCalls(fullResponse);

        // Collapse the log since we're done
        const detailsEl = taskParentEl.querySelector("details.task-details");
        if (detailsEl) detailsEl.removeAttribute("open");

        // Show Final Output natively
        if (typeof window.renderMarkdown === 'function') {
          finalOutputEl.innerHTML = window.renderMarkdown(finalResponse);
          if (typeof window.highlightBlock === 'function') {
            finalOutputEl.querySelectorAll("pre code").forEach(window.highlightBlock);
          }
        } else {
          finalOutputEl.innerText = finalResponse;
        }
        finalOutputEl.style.display = "block";
        if (typeof window.scrollToBottom === 'function') window.scrollToBottom();

        // Trigger procedural memory extraction if it was a multi-step effort
        if (window.ProceduralMemory && currentTask.stepCount > 1) {
          window.ProceduralMemory.extract(currentTask);
        }
        break;
      }
    }

    if (currentTask.stepCount >= MAX_STEPS) {
      currentTask.state = 'ERROR';
      setStatus('⚠️ MAX STEPS REACHED', 'task-status-error');
    }

    // Output Walkthrough Summary
    if (typeof window.appendUserMessage === 'function') {
      const summary = `**Task Summary:**\n- Completed in ${currentTask.stepCount} step(s).\n- Status: ${currentTask.state}\nCheck the expandable log above for raw execution details.`;
      // We can just append an assistant message for the summary
      if (typeof window.state !== 'undefined' && window.state.conversations) {
        window.state.conversations[window.state.mode].messages.push({ role: 'assistant', content: finalResponse });
      }
    }

    if (typeof window.saveSession === 'function') {
      window.saveSession();
    }
  }

  return { createTask, executeTask, getCurrentTask: () => currentTask };
})();