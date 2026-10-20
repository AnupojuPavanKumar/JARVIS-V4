// JARVIS — Durable Agent Client
// Thin renderer view over the main-process AgentRuntime. The main process owns
// task state, approvals, and recovery; this module only starts tasks, renders
// events, and forwards user decisions. It is inactive unless the preload
// feature flag (JARVIS_DURABLE_AGENT=1) is enabled.

window.AgentClient = (() => {
  const STORAGE_KEY = 'jarvis_active_agent_task';
  const MAX_PREVIEW = 4000;
  const views = new Map();
  let listening = false;
  let currentTaskId = null;

  function enabled() {
    return Boolean(
      window.jarvis
      && window.jarvis.durableAgentEnabled === true
      && window.jarvis.agentTaskStart
      && window.jarvis.onAgentTaskEvent
    );
  }

  function toast(message, kind = 'info') {
    if (typeof window.showToast === 'function') window.showToast(message, kind);
  }

  function escHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, match => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[match]));
  }

  function preview(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…[truncated]` : text;
  }

  function isTerminal(status) {
    return status === 'completed'
      || status === 'failed'
      || status === 'cancelled';
  }

  function statusLabel(task) {
    switch (task.status) {
      case 'queued': return ['⏳ QUEUED', 'task-status-thinking'];
      case 'planning': return ['🧠 PLANNING', 'task-status-thinking'];
      case 'running': return ['⚡ RUNNING', 'task-status-executing'];
      case 'waiting_approval': return ['🔐 APPROVAL REQUIRED', 'task-status-error'];
      case 'paused': return ['⏸ PAUSED', 'task-status-thinking'];
      case 'completed': return ['✅ COMPLETED', 'task-status-completed'];
      case 'failed': return ['❌ FAILED', 'task-status-error'];
      case 'cancelled': return ['🛑 CANCELLED', 'task-status-error'];
      case 'interrupted': return ['⚠️ INTERRUPTED', 'task-status-error'];
      default: return [String(task.status || 'UNKNOWN').toUpperCase(), 'task-status-thinking'];
    }
  }

  function createTaskView(task) {
    const $messages = document.getElementById('chat-messages');
    if (!$messages) return null;

    const mode = window.MODES && window.state ? window.MODES[window.state.mode] : null;
    const icon = (mode && mode.icon) || '⚙️';
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    const parentEl = document.createElement('div');
    parentEl.className = 'message jarvis-message agentic-task';
    parentEl.id = `agent-task-${task.id}`;
    parentEl.innerHTML = `
      <div class="msg-avatar">${icon}</div>
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-sender">JARVIS (Durable Agent)</span>
          <span class="msg-mode-tag task-status task-status-thinking">⏳ QUEUED</span>
          <span class="msg-time">${time}</span>
          <button type="button" class="task-cancel" title="Cancel task">Cancel</button>
        </div>
        <div class="msg-bubble task-bubble">
          <details class="task-details" open>
            <summary>Agent Process &amp; Logs</summary>
            <div class="task-log-content"></div>
          </details>
          <div class="task-approval" style="display: none;"></div>
          <div class="task-final-output msg-content" style="display: none;"></div>
        </div>
      </div>
    `;
    $messages.appendChild(parentEl);
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();

    const view = {
      taskId: task.id,
      task,
      mode: task.metadata?.runtime?.mode || 'general',
      request: null,
      parentEl,
      statusEl: parentEl.querySelector('.task-status'),
      logEl: parentEl.querySelector('.task-log-content'),
      approvalEl: parentEl.querySelector('.task-approval'),
      finalEl: parentEl.querySelector('.task-final-output'),
      cancelBtn: parentEl.querySelector('.task-cancel'),
      steps: new Map(),
      tools: new Map(),
      approvalId: null,
      refreshTimer: null,
      finalized: false,
    };

    view.cancelBtn.addEventListener('click', async () => {
      view.cancelBtn.disabled = true;
      const result = await window.jarvis.agentTaskCancel(view.taskId, 'user-request');
      if (!result || !result.ok) {
        view.cancelBtn.disabled = false;
        toast((result && result.error) || 'Could not cancel task.', 'error');
      }
    });

    return view;
  }

  function setStatus(view, text, cssClass) {
    if (!view || !view.statusEl) return;
    view.statusEl.className = `msg-mode-tag task-status ${cssClass}`;
    view.statusEl.innerText = text;
  }

  function createStepBlock(view, stepId, index) {
    if (view.steps.has(stepId)) return view.steps.get(stepId);
    const block = document.createElement('div');
    block.className = 'task-step streaming';
    block.innerHTML = `
      <div class="task-step-title">Step ${index || ''}</div>
      <div class="msg-content stream-text"></div>
    `;
    view.logEl.appendChild(block);
    view.steps.set(stepId, block);
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
    return block;
  }

  function updateStepBlock(view, step) {
    const block = createStepBlock(view, step.id, step.index);
    const textEl = block.querySelector('.stream-text');
    if (step.status === 'started') {
      textEl.textContent = 'Thinking…';
    } else if (step.status === 'unknown') {
      textEl.textContent = `[interrupted] ${step.error || 'step was in flight during a restart'}`;
    } else if (step.text) {
      textEl.textContent = step.text;
    }
  }

  function createToolBlock(view, stepId, tool) {
    if (view.tools.has(stepId)) return view.tools.get(stepId);
    const block = document.createElement('div');
    block.className = 'task-tool-result';
    block.innerHTML = `
      <div class="task-step-title tool-title">Result: ${escHtml(tool)}</div>
      <pre><code></code></pre>
    `;
    view.logEl.appendChild(block);
    view.tools.set(stepId, block);
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
    return block;
  }

  function updateToolBlock(view, step) {
    const block = createToolBlock(view, step.id, step.tool);
    const codeEl = block.querySelector('code');
    if (step.status === 'started') {
      codeEl.textContent = `Running ${step.tool}…`;
      return;
    }
    if (step.error) {
      codeEl.textContent = `[ERROR] ${step.error}`;
      return;
    }
    codeEl.textContent = preview(step.result) || '(no output)';
  }

  function showApproval(view, approval) {
    if (!view || !approval) return;
    if (view.approvalId === approval.id) return;
    view.approvalId = approval.id;

    const tool = approval.toolCall?.tool || 'tool';
    const args = preview(approval.toolCall?.args || {});
    view.approvalEl.innerHTML = `
      <div class="task-approval-title">Approval required — <strong>${escHtml(tool)}</strong></div>
      <div class="task-approval-reason">${escHtml(approval.reason || 'policy requires confirmation')}</div>
      <pre><code>${escHtml(args)}</code></pre>
      <div class="task-approval-actions">
        <button type="button" data-approve>Approve</button>
        <button type="button" data-deny>Deny</button>
      </div>
    `;
    view.approvalEl.style.display = 'block';

    const approveBtn = view.approvalEl.querySelector('[data-approve]');
    const denyBtn = view.approvalEl.querySelector('[data-deny]');
    const resolve = async (approved) => {
      approveBtn.disabled = true;
      denyBtn.disabled = true;
      const result = await window.jarvis.agentTaskApprove(view.taskId, {
        ...(view.request || {}),
        approved,
        reason: approved ? 'user-approved' : 'user-denied',
      });
      if (!result || !result.ok) {
        approveBtn.disabled = false;
        denyBtn.disabled = false;
        toast((result && result.error) || 'Approval could not be recorded.', 'error');
        return;
      }
      view.approvalEl.style.display = 'none';
      view.approvalId = null;
      setStatus(view, approved ? '⚡ RESUMING…' : '🛑 CANCELLED', approved ? 'task-status-executing' : 'task-status-error');
    };

    approveBtn.addEventListener('click', () => resolve(true));
    denyBtn.addEventListener('click', () => resolve(false));
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
  }

  function clearApproval(view) {
    if (!view) return;
    view.approvalId = null;
    view.approvalEl.style.display = 'none';
    view.approvalEl.innerHTML = '';
  }

  function showFinal(view, task) {
    if (!view || view.finalized || !isTerminal(task.status)) return;
    view.finalized = true;

    let text = task.result || '';
    if (!text && task.status === 'failed') text = `[ERROR] ${task.error || 'Task failed'}`;
    if (!text && task.status === 'cancelled') text = '[CANCELLED] Task was cancelled.';
    if (!text && task.status === 'completed') text = 'Task completed.';

    if (text) {
      if (typeof window.renderMarkdown === 'function') {
        view.finalEl.innerHTML = window.renderMarkdown(text);
        if (typeof window.highlightBlock === 'function') {
          view.finalEl.querySelectorAll('pre code').forEach(window.highlightBlock);
        }
      } else {
        view.finalEl.textContent = text;
      }
      view.finalEl.style.display = 'block';
    }

    const details = view.parentEl.querySelector('details.task-details');
    if (details) details.removeAttribute('open');

    if (task.status === 'completed' && text) {
      try {
        if (window.state && window.state.conversations) {
          const conversation = window.state.conversations[view.mode] || window.state.conversations[window.state.mode];
          if (conversation && Array.isArray(conversation.messages)) {
            conversation.messages.push({ role: 'assistant', content: text, timestamp: new Date().toISOString() });
          }
        }
        if (window.state && window.state.ttsEnabled && typeof window.speakText === 'function' && typeof window.extractPlainText === 'function') {
          const spoken = window.extractPlainText(text);
          if (spoken) window.speakText(spoken, true);
        }
        if (typeof window.saveSession === 'function') window.saveSession();
      } catch (_) { /* session persistence must not break the view */ }
    }

    if (currentTaskId === task.id) {
      currentTaskId = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
  }

  function renderSnapshot(view, task) {
    if (!view || !task) return;
    view.task = task;
    if (task.status !== 'running' || !view.statusEl.className.includes('task-status-executing')) {
      const [label, css] = statusLabel(task);
      setStatus(view, label, css);
    }

    for (const step of task.steps || []) {
      if (!step || !step.id) continue;
      if (step.kind === 'tool') updateToolBlock(view, step);
      else updateStepBlock(view, step);
    }

    const pending = (task.approvals || []).find(approval => approval.status === 'pending');
    if (pending) showApproval(view, pending);
    else clearApproval(view);

    if (isTerminal(task.status)) showFinal(view, task);
  }

  function refreshTask(view) {
    if (!view || view.refreshTimer) return;
    view.refreshTimer = setTimeout(async () => {
      view.refreshTimer = null;
      const result = await window.jarvis.agentTaskGet(view.taskId);
      if (result && result.ok) renderSnapshot(view, result.task);
    }, 50);
  }

  function handleEvent(event) {
    if (!event || !event.taskId) return;
    const view = views.get(event.taskId);
    if (!view) {
      // Tasks started outside this window (e.g. by the scheduler) are
      // surfaced when they need supervision or reach a new state.
      if (event.type === 'approval.requested' || event.type === 'task.updated') {
        attachTask(event.taskId, { allowTerminal: true }).catch(error => {
          console.error('[AgentClient] Failed to attach external task:', error);
        });
      }
      return;
    }
    const data = event.data || {};

    switch (event.type) {
      case 'step.started':
        setStatus(view, `⚙️ EXECUTING STEP ${data.index || ''}`.trim(), 'task-status-executing');
        createStepBlock(view, data.stepId, data.index);
        break;
      case 'step.completed': {
        const step = {
          id: data.stepId,
          index: data.index,
          status: 'completed',
          text: data.text || '',
        };
        updateStepBlock(view, step);
        if (data.toolCall?.tool) setStatus(view, `🔧 TOOL: ${String(data.toolCall.tool).toUpperCase()}`, 'task-status-tool');
        break;
      }
      case 'tool.started':
        setStatus(view, `🔧 TOOL: ${String(data.tool || '').toUpperCase()}`, 'task-status-tool');
        createToolBlock(view, data.stepId, data.tool);
        break;
      case 'tool.completed':
      case 'tool.failed':
        setStatus(view, data.ok === false ? '❌ TOOL FAILED' : '✅ TOOL DONE', data.ok === false ? 'task-status-error' : 'task-status-tool');
        updateToolBlock(view, {
          id: data.stepId,
          tool: data.tool,
          status: data.ok === false ? 'failed' : 'completed',
          error: data.error || null,
        });
        refreshTask(view);
        break;
      case 'approval.requested':
        setStatus(view, '🔐 APPROVAL REQUIRED', 'task-status-error');
        showApproval(view, data.approval || data);
        break;
      case 'task.failed':
        setStatus(view, '❌ FAILED', 'task-status-error');
        break;
      case 'runtime.recovered':
        setStatus(view, '⚠️ RECOVERED', 'task-status-error');
        break;
      case 'task.updated':
        renderSnapshot(view, data.task);
        break;
      default:
        break;
    }
  }

  function ensureListener() {
    if (listening || !window.jarvis.onAgentTaskEvent) return;
    listening = true;
    window.jarvis.onAgentTaskEvent(event => {
      try { handleEvent(event); } catch (error) { console.error('[AgentClient] Event handling failed:', error); }
    });
  }

  const attaching = new Set();

  async function attachTask(taskId, { allowTerminal = false } = {}) {
    const existing = views.get(taskId);
    if (existing) return existing;
    if (attaching.has(taskId)) return null;
    attaching.add(taskId);
    try {
      const result = await window.jarvis.agentTaskGet(taskId);
      if (!result || !result.ok) return null;
      if (!allowTerminal && isTerminal(result.task.status)) return null;
      ensureListener();
      let view = views.get(taskId);
      if (!view) {
        view = createTaskView(result.task);
        if (!view) return null;
        views.set(taskId, view);
      }
      renderSnapshot(view, result.task);
      return view;
    } finally {
      attaching.delete(taskId);
    }
  }

  async function runDeepWork(goal, options = {}) {
    if (!enabled()) return { ok: false, error: 'Durable agent is disabled' };

    const active = currentTaskId && views.get(currentTaskId);
    if (active && active.task && !isTerminal(active.task.status)) {
      toast('A durable agent task is already running. Cancel it before starting another.', 'info');
      return { ok: false, error: 'A task is already active' };
    }

    const request = {
      goal,
      source: options.source || 'deep-work',
      model: options.model || (window.state && window.state.model) || 'llama3.2',
      mode: options.mode || (window.state && window.state.mode) || 'general',
      maxSteps: Number.isInteger(options.maxSteps) ? options.maxSteps : 15,
      systemSpecs: options.systemSpecs,
      memory: Array.isArray(options.memory) ? options.memory : [],
      projectContext: options.projectContext,
      webSearchContext: options.webSearchContext,
      deepWorkEnabled: true,
      modelOptions: options.modelOptions || {
        temperature: 0.3,
        top_p: 0.85,
        num_predict: 2048,
        num_ctx: 4096,
        num_gpu: 99,
        num_thread: 8,
      },
    };
    if (request.systemSpecs === undefined) delete request.systemSpecs;
    if (request.projectContext === undefined) delete request.projectContext;
    if (request.webSearchContext === undefined) delete request.webSearchContext;

    const started = await window.jarvis.agentTaskStart(request);
    if (!started || !started.ok) {
      toast((started && started.error) || 'Could not start the durable agent task.', 'error');
      return started || { ok: false, error: 'start failed' };
    }

    currentTaskId = started.task.id;
    try { localStorage.setItem(STORAGE_KEY, currentTaskId); } catch (_) {}
    ensureListener();

    let view = views.get(currentTaskId);
    if (!view) {
      view = createTaskView(started.task);
      if (!view) return { ok: true, task: started.task };
      views.set(currentTaskId, view);
    }
    view.request = request;
    renderSnapshot(view, started.task);
    return { ok: true, task: started.task };
  }

  async function cancelCurrent() {
    if (!currentTaskId) return { ok: false, error: 'No active task' };
    const result = await window.jarvis.agentTaskCancel(currentTaskId, 'user-request');
    if (!result || !result.ok) toast((result && result.error) || 'Could not cancel task.', 'error');
    return result;
  }

  async function init() {
    if (!enabled()) return;
    ensureListener();
    let taskId = null;
    try { taskId = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    if (taskId) {
      const view = await attachTask(taskId);
      if (view) {
        currentTaskId = taskId;
        view.request = {
          model: view.task.metadata?.runtime?.model,
          mode: view.mode,
          modelOptions: view.task.metadata?.runtime?.modelOptions || {},
        };
      } else {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      }
    }

    // Surface live tasks that this window did not start — for example
    // autonomous runs started by the scheduler while it was hidden.
    try {
      const listed = await window.jarvis.agentTaskList({ limit: 20 });
      if (listed && listed.ok) {
        for (const task of listed.tasks || []) {
          if (task.status === 'running' || task.status === 'waiting_approval') {
            await attachTask(task.id);
          }
        }
      }
    } catch (error) {
      console.error('[AgentClient] Failed to list live tasks:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }

  return {
    enabled,
    runDeepWork,
    cancelCurrent,
    attachTask,
    getCurrentTaskId: () => currentTaskId,
  };
})();
