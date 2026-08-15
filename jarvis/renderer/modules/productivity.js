// ═══════════════════════════════════════════════════════════════
// JARVIS — PRODUCTIVITY MODULE
// Kanban board, Task list, Time blocks, Pomodoro timer
// Extracted from renderer.js §17-17i for modular architecture.
// All functions are exposed on window to preserve compatibility.
// ═══════════════════════════════════════════════════════════════

// ─── Kanban Board ──────────────────────────────────────────────

function _kanbanEscHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderKanbanHTML() {
  const board = loadKanban();
  const cols = [
    { id: 'todo',  label: 'TO DO',       icon: '□' },
    { id: 'doing', label: 'IN PROGRESS', icon: '◎' },
    { id: 'done',  label: 'DONE',        icon: '✓' },
  ];
  return cols.map(col => {
    const cards = board[col.id] || [];
    const cardHTML = cards.map((text, i) => `
      <div class="kanban-card" draggable="true"
           ondragstart="kanbanDragStart(event,'${col.id}',${i})"
           ondragend="kanbanDragEnd(event)">
        <span class="kanban-card-text">${_kanbanEscHtml(text)}</span>
        <button class="kanban-card-del" onclick="kanbanDeleteCard('${col.id}',${i})" title="Remove">✕</button>
      </div>`).join('');
    return `<div class="kanban-col ${col.id}" id="kanban-col-${col.id}"
              ondragover="kanbanDragOver(event)"
              ondragleave="kanbanDragLeave(event)"
              ondrop="kanbanDrop(event,'${col.id}')">
      <div class="kanban-col-hdr">
        <span class="kanban-col-title">${col.icon} ${col.label}</span>
        <span class="kanban-col-count">${cards.length}</span>
      </div>
      ${cardHTML || '<div style="color:var(--text-dim);font-size:10px;text-align:center;padding:8px 0;opacity:0.5">Empty</div>'}
      <div class="kanban-add-row">
        <input class="kanban-add-input" id="kanban-inp-${col.id}" type="text" placeholder="Add card…"
               onkeydown="if(event.key==='Enter') kanbanAddCard('${col.id}')">
        <button class="kanban-add-btn" onclick="kanbanAddCard('${col.id}')">+</button>
      </div>
    </div>`;
  }).join('');
}
window.renderKanbanHTML = renderKanbanHTML;

function loadKanban() {
  try { return JSON.parse(localStorage.getItem('jarvis-kanban') || '{"todo":[],"doing":[],"done":[]}'); }
  catch { return { todo: [], doing: [], done: [] }; }
}

function saveKanban(board) {
  localStorage.setItem('jarvis-kanban', JSON.stringify(board));
}

function refreshKanban() {
  const el = document.getElementById('kanban-wrap');
  if (el) el.innerHTML = renderKanbanHTML();
}
window.refreshKanban = refreshKanban;

window.kanbanAddCard = function(col) {
  const inp = document.getElementById(`kanban-inp-${col}`);
  const text = inp?.value?.trim();
  if (!text) return;
  const board = loadKanban();
  board[col].push(text);
  saveKanban(board);
  inp.value = '';
  refreshKanban();
};

window.kanbanDeleteCard = function(col, idx) {
  const board = loadKanban();
  board[col].splice(idx, 1);
  saveKanban(board);
  refreshKanban();
};

window.clearKanbanDone = function() {
  const board = loadKanban();
  board.done = [];
  saveKanban(board);
  refreshKanban();
  if (typeof showToast === 'function') showToast('Kanban: done column cleared', 'info');
};

let _kanbanDragSrc = null;
window.kanbanDragStart = function(e, col, idx) {
  _kanbanDragSrc = { col, idx };
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
};
window.kanbanDragEnd = function(e) {
  e.currentTarget.classList.remove('dragging');
};
window.kanbanDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
};
window.kanbanDragLeave = function(e) {
  e.currentTarget.classList.remove('drag-over');
};
window.kanbanDrop = function(e, targetCol) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!_kanbanDragSrc) return;
  const { col: srcCol, idx: srcIdx } = _kanbanDragSrc;
  _kanbanDragSrc = null;
  if (srcCol === targetCol) return;
  const board = loadKanban();
  const [card] = board[srcCol].splice(srcIdx, 1);
  board[targetCol].push(card);
  saveKanban(board);
  refreshKanban();
  if (typeof showToast === 'function') showToast(`Moved to ${targetCol.toUpperCase()}`, 'success');
};

// ─── Task List ─────────────────────────────────────────────────

function renderTasksHTML(tasks) {
  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const p = { HIGH: 0, MED: 1, LOW: 2 };
    return (p[a.priority] || 1) - (p[b.priority] || 1);
  });
  return sorted.map((t, si) => {
    const ri = tasks.indexOf(t);
    return `<div class="task-item ${t.done ? 'done' : ''}">
      <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleTask(${ri})">
      <span class="task-text">${_kanbanEscHtml(t.text)}</span>
      <span class="task-pri task-${t.priority.toLowerCase()}">${t.priority}</span>
      <button class="item-del" onclick="deleteTask(${ri})">✕</button>
    </div>`;
  }).join('') || '<div class="list-ph">Add tasks for today</div>';
}
window.renderTasksHTML = renderTasksHTML;

window.addTask = function() {
  const inp = document.getElementById('task-input');
  const pri = document.getElementById('task-priority')?.value || 'MED';
  if (!inp?.value?.trim()) return;
  const tasks = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]');
  tasks.push({ id: Date.now(), text: inp.value.trim(), priority: pri, done: false });
  localStorage.setItem('jarvis-tasks', JSON.stringify(tasks));
  inp.value = '';
  const el = document.getElementById('tasks-list');
  if (el) el.innerHTML = renderTasksHTML(tasks);
};
window.toggleTask = function(i) {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]');
  if (t[i]) { t[i].done = !t[i].done; localStorage.setItem('jarvis-tasks', JSON.stringify(t)); const el = document.getElementById('tasks-list'); if (el) el.innerHTML = renderTasksHTML(t); }
};
window.deleteTask = function(i) {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]');
  t.splice(i, 1); localStorage.setItem('jarvis-tasks', JSON.stringify(t));
  const el = document.getElementById('tasks-list'); if (el) el.innerHTML = renderTasksHTML(t);
};
window.clearDoneTasks = function() {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]').filter(x => !x.done);
  localStorage.setItem('jarvis-tasks', JSON.stringify(t));
  const el = document.getElementById('tasks-list'); if (el) el.innerHTML = renderTasksHTML(t);
};

window.prioritizeWithJarvis = function() {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]').filter(x => !x.done);
  if (!t.length) { if (typeof showToast === 'function') showToast('Add tasks first.', 'error'); return; }
  if (typeof dashSend === 'function') {
    dashSend(`Prioritize and sequence these tasks for maximum impact:${t.map(x => `- [${x.priority}] ${x.text}`).join('\n')}Consider urgency, importance, dependencies, and effort.`);
  }
};

// ─── Time Blocks ───────────────────────────────────────────────

function renderTBsHTML(tbs) {
  return tbs.map((tb, i) => `
    <div class="tb-item ${tb.done ? 'done' : ''}">
      <input type="checkbox" ${tb.done ? 'checked' : ''} onchange="toggleTB(${i})">
      <span class="tb-task">${_kanbanEscHtml(tb.task)}</span>
      <span class="tb-dur">${tb.mins}m</span>
      <button class="item-del" onclick="deleteTB(${i})">✕</button>
    </div>`).join('') || '<div class="list-ph">Plan your time blocks</div>';
}
window.renderTBsHTML = renderTBsHTML;

window.addTimeBlock = function() {
  const task = document.getElementById('tb-task');
  const mins = parseInt(document.getElementById('tb-mins')?.value || '25');
  if (!task?.value?.trim()) return;
  const tbs = JSON.parse(localStorage.getItem('jarvis-tbs') || '[]');
  tbs.push({ task: task.value.trim(), mins, done: false }); task.value = '';
  localStorage.setItem('jarvis-tbs', JSON.stringify(tbs));
  const el = document.getElementById('tb-list'); if (el) el.innerHTML = renderTBsHTML(tbs);
  const tot = document.getElementById('tb-total');
  const total = tbs.reduce((s, x) => s + x.mins, 0);
  if (tot) tot.textContent = `Total: ${total}m (${(total / 60).toFixed(1)}h)`;
};
window.toggleTB = function(i) {
  const tbs = JSON.parse(localStorage.getItem('jarvis-tbs') || '[]');
  if (tbs[i]) { tbs[i].done = !tbs[i].done; localStorage.setItem('jarvis-tbs', JSON.stringify(tbs)); const el = document.getElementById('tb-list'); if (el) el.innerHTML = renderTBsHTML(tbs); }
};
window.deleteTB = function(i) {
  const tbs = JSON.parse(localStorage.getItem('jarvis-tbs') || '[]');
  tbs.splice(i, 1); localStorage.setItem('jarvis-tbs', JSON.stringify(tbs));
  const el = document.getElementById('tb-list'); if (el) el.innerHTML = renderTBsHTML(tbs);
  const tot = document.getElementById('tb-total');
  const total = tbs.reduce((s, x) => s + x.mins, 0);
  if (tot) tot.textContent = `Total: ${total}m (${(total / 60).toFixed(1)}h)`;
};
window.clearTBs = function() {
  localStorage.removeItem('jarvis-tbs');
  const el = document.getElementById('tb-list'); if (el) el.innerHTML = '<div class="list-ph">Plan your time blocks</div>';
  const tot = document.getElementById('tb-total'); if (tot) tot.textContent = 'Total: 0m (0.0h)';
};
window.planWithJarvis = function() {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]').filter(x => !x.done);
  if (typeof dashSend === 'function') {
    dashSend(`Help me plan my day. My tasks:${t.map(x => `- [${x.priority}] ${x.text}`).join('\n') || 'No tasks yet.'}Create an optimized time block schedule considering energy, priorities, and breaks.`);
  }
};

// ─── Pomodoro Timer ────────────────────────────────────────────

function initProdDash() {
  const canvas = document.getElementById('pomo-canvas');
  if (!canvas) return [];
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, r = (W - 20) / 2;
  let timeLeft = 25 * 60, totalTime = 25 * 60, isRunning = false;
  let interval = null, phase = 'FOCUS', pomos = 0, focusMins = 0;

  function pad(n) { return String(n).padStart(2, '0'); }

  function drawRing() {
    ctx.clearRect(0, 0, W, H);
    const progress = 1 - timeLeft / totalTime;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,212,255,0.12)'; ctx.lineWidth = 10; ctx.stroke();
    const color = phase === 'FOCUS' ? '#06b6d4' : '#00ff88';
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.stroke(); ctx.shadowBlur = 0;
  }

  function updateDisplay() {
    const el = document.getElementById('pomo-time');
    const ph = document.getElementById('pomo-phase');
    if (el) el.textContent = `${pad(Math.floor(timeLeft / 60))}:${pad(timeLeft % 60)}`;
    if (ph) { ph.textContent = phase; ph.style.color = phase === 'FOCUS' ? '#06b6d4' : '#00ff88'; }
    drawRing();
  }

  function phaseEnd() {
    clearInterval(interval); isRunning = false;
    if (phase === 'FOCUS') {
      pomos++; focusMins += 25;
      const pc = document.getElementById('pomo-count'), ft = document.getElementById('pomo-focus');
      if (pc) pc.textContent = pomos;
      if (ft) ft.textContent = `${focusMins}m`;
      phase = 'BREAK'; timeLeft = totalTime = (pomos % 4 === 0) ? 15 * 60 : 5 * 60;
      if (typeof showToast === 'function') showToast(`🎉 Pomodoro #${pomos} complete! ${pomos % 4 === 0 ? 'Long break (15 min)' : 'Short break (5 min)'}`, 'success');
    } else {
      phase = 'FOCUS'; timeLeft = totalTime = 25 * 60;
      if (typeof showToast === 'function') showToast('Break over. Back to focus, sir.', 'info');
    }
    const sb = document.getElementById('pomo-start'); if (sb) sb.textContent = '▶ START';
    updateDisplay();
  }

  window.startPomodoro = function() {
    if (isRunning) {
      clearInterval(interval); isRunning = false;
      const sb = document.getElementById('pomo-start'); if (sb) sb.textContent = '▶ RESUME';
    } else {
      isRunning = true;
      const sb = document.getElementById('pomo-start'); if (sb) sb.textContent = '⏸ PAUSE';
      interval = setInterval(() => {
        if (!document.getElementById('pomo-canvas')) { clearInterval(interval); return; }
        timeLeft--; updateDisplay(); if (timeLeft <= 0) phaseEnd();
      }, 1000);
    }
  };
  window.resetPomodoro = function() {
    clearInterval(interval); isRunning = false; phase = 'FOCUS'; timeLeft = totalTime = 25 * 60;
    const sb = document.getElementById('pomo-start'); if (sb) sb.textContent = '▶ START';
    updateDisplay();
  };
  window.skipPhase = function() { clearInterval(interval); isRunning = false; phaseEnd(); };

  updateDisplay();
  return [() => {
    clearInterval(interval);
    ['startPomodoro', 'resetPomodoro', 'skipPhase'].forEach(k => delete window[k]);
  }];
}
window.initProdDash = initProdDash;

console.log('[JARVIS] Productivity module loaded.');
