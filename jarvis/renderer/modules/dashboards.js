/**
 * JARVIS — Dashboards Module
 * Handles: all 8 mode dashboards and their event handlers.
 * Dependencies: state, MODES, showToast, dashSend, injectPrompt, escHtml, formatBytes (globals)
 */

'use strict';

// ─── Dashboard Dispatcher ───────────────────────────────────────

function showModeDashboard(modeId) {
  state.dashCleanup.forEach(fn => { try { fn(); } catch { /* ignore cleanup errors */ } });
  state.dashCleanup = [];

  if (!$dashboard) return;

  const renderers = {
    general:      dashGeneral,
    code:         dashCode,
    debug:        dashDebug,
    research:     dashResearch,
    automation:   dashAutomation,
    business:     dashBusiness,
    creative:     dashCreative,
    productivity: dashProductivity,
  };

  const html = (renderers[modeId] || renderers.general)();
  $dashboard.innerHTML = html;

  const inits = {
    general:      () => {},
    code:         initCodeDash,
    debug:        initDebugDash,
    research:     initResearchDash,
    automation:   initAutoDash,
    business:     initBizDash,
    creative:     initCreativeDash,
    productivity: initProdDash,
  };

  setTimeout(() => {
    const initFn = inits[modeId];
    if (initFn) {
      const cleanup = initFn() || [];
      state.dashCleanup = Array.isArray(cleanup) ? cleanup : (cleanup ? [cleanup] : []);
    }
  }, 60);
}

// ─── 17a. General Dashboard ─────────────────────────────────────

function dashGeneral() {
  const prompts = [
    'What can you help me with today?', 'Explain quantum computing simply',
    'Give me 5 productivity tips', 'Help me write a professional email',
    'Debug my code — I\'ll paste it', 'Generate a Python automation script',
    'Research the latest in AI', 'Build a React component for me',
  ];
  const chips = prompts.map(p =>
    `<button class="welcome-chip" onclick="injectPrompt(${JSON.stringify(p)})">${escHtml(p)}</button>`
  ).join('');

  return `<div class="mode-dashboard dash-general">
    <div class="dash-hero-tech">
      <div class="tech-core-container">
        <!-- HUD Background Crosshairs -->
        <div class="hud-crosshair hud-crosshair-v"></div>
        <div class="hud-crosshair hud-crosshair-h"></div>
        
        <!-- Energy Ripples -->
        <div class="hud-ripple"></div>
        <div class="hud-ripple"></div>
        
        <!-- HUD Data Streams -->
        <div class="hud-data-stream hud-data-1"></div>
        <div class="hud-data-stream hud-data-2"></div>
        <div class="hud-data-stream hud-data-3"></div>
        
        <!-- HUD Scanner Line -->
        <div class="hud-scanner"></div>

        <!-- HUD Segmented Rings -->
        <div class="hud-ring hud-ring-outer"></div>
        <div class="hud-ring hud-ring-middle"></div>
        <div class="hud-ring hud-ring-inner"></div>
        
        <!-- Orb Canvas -->
        <canvas id="jarvis-orb-canvas" width="400" height="400" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); z-index:5;"></canvas>
        
        <!-- Hex Core -->
        <div class="hud-center-hex">
          <div class="hud-hex-inner">
            <div class="hud-hex-pulse"></div>
          </div>
          <div class="hud-hex-label">J.A.R.V.I.S</div>
        </div>
      </div>
      <!-- Labels -->
      <div class="tech-labels">
        <div class="tech-label-main">CORE INTERFACE ACTIVE</div>
        <div class="tech-label-sub">INTELLIGENCE ENGINE ON</div>
        <div class="tech-label-sub">SYSTEMS INTEGRATED</div>
      </div>
    </div>
    <div class="dash-gen-chips-new">${chips}</div>
  </div>`;
}

// ─── Animated Orb Canvas Renderer ──────────────────────────────

function initOrbCanvas() {
  const canvas = document.getElementById('jarvis-orb-canvas');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  let animFrame = null;
  let t = 0;

  function getAccentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() || '#00d4ff';
  }

  function parseColor(c) {
    const m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const v = parseInt(m[1], 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
    const m2 = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m2) return [+m2[1], +m2[2], +m2[3]];
    return [0, 212, 255];
  }

  const PARTICLE_COUNT = 40;
  const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
    angle: Math.random() * Math.PI * 2,
    radius: 80 + Math.random() * 80,
    speed: (Math.random() - 0.5) * 0.008,
    size: Math.random() * 2.5 + 0.5,
    opacity: Math.random() * 0.6 + 0.2,
    phase: Math.random() * Math.PI * 2,
  }));

  function draw() {
    ctx.clearRect(0, 0, W, H);

    const accentHex = getAccentColor();
    const [r, g, b] = parseColor(accentHex);
    const cx = W / 2, cy = H / 2;
    const streaming = state.isStreaming;
    const spinMult = streaming ? 3.5 : 1;
    const glowMult = streaming ? 1.8 : 1;

    t += 0.012 * spinMult;

    const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, 190);
    grad.addColorStop(0, `rgba(${r},${g},${b},${0.22 * glowMult})`);
    grad.addColorStop(0.4, `rgba(${r},${g},${b},${0.06 * glowMult})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, 190, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    const rings = [
      { radius: 145, dash: [16, 10], width: 1.2, opacity: 0.25, dir: 1 },
      { radius: 118, dash: [8, 14],  width: 1.5, opacity: 0.4,  dir: -1 },
      { radius: 90,  dash: [4, 8],   width: 1.8, opacity: 0.55, dir: 1 },
      { radius: 62,  dash: [2, 6],   width: 2.0, opacity: 0.7,  dir: -1 },
    ];

    rings.forEach((ring, i) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * (0.4 + i * 0.15) * ring.dir);
      ctx.beginPath();
      ctx.arc(0, 0, ring.radius, 0, Math.PI * 2);
      ctx.setLineDash(ring.dash);
      ctx.strokeStyle = `rgba(${r},${g},${b},${ring.opacity * glowMult})`;
      ctx.lineWidth = ring.width;
      ctx.stroke();
      ctx.restore();
    });

    const nodeCount = 8;
    for (let i = 0; i < nodeCount; i++) {
      const angle = (i / nodeCount) * Math.PI * 2 + t * 0.5;
      const nx = cx + Math.cos(angle) * 145;
      const ny = cy + Math.sin(angle) * 145;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 + i * 0.8);
      ctx.beginPath();
      ctx.arc(nx, ny, 3 + pulse * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.5 + pulse * 0.5})`;
      ctx.fill();
    }

    const pulse = 0.5 + 0.5 * Math.sin(t * 1.5);
    const coreR = 38 + pulse * (streaming ? 8 : 4);

    const coreGrad = ctx.createRadialGradient(cx - 8, cy - 8, 2, cx, cy, coreR);
    coreGrad.addColorStop(0, `rgba(255,255,255,${0.9 * glowMult})`);
    coreGrad.addColorStop(0.3, `rgba(${r},${g},${b},${0.85})`);
    coreGrad.addColorStop(0.7, `rgba(${r},${g},${b},${0.5})`);
    coreGrad.addColorStop(1, `rgba(${r},${g},${b},0.05)`);

    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fillStyle = coreGrad;
    ctx.fill();

    const bloomGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
    bloomGrad.addColorStop(0, `rgba(${r},${g},${b},${0.3 * glowMult})`);
    bloomGrad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = bloomGrad;
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.3);
    ctx.font = `${22 + pulse * 3}px "Segoe UI Symbol", sans-serif`;
    ctx.fillStyle = `rgba(255,255,255,${0.85 + pulse * 0.15})`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⬡', 0, 0);
    ctx.restore();

    particles.forEach(p => {
      p.angle += p.speed * spinMult;
      const pr = p.radius + Math.sin(t * 0.8 + p.phase) * 12;
      const px = cx + Math.cos(p.angle) * pr;
      const py = cy + Math.sin(p.angle) * pr;
      const pop = p.opacity * (0.6 + 0.4 * Math.sin(t * 1.2 + p.phase));
      ctx.beginPath();
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${pop})`;
      ctx.fill();
    });

    if (streaming) {
      const beamAngle = t * 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(beamAngle);
      const beamGrad = ctx.createLinearGradient(0, 0, 160, 0);
      beamGrad.addColorStop(0, `rgba(${r},${g},${b},0.5)`);
      beamGrad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 160, -0.05, 0.05);
      ctx.closePath();
      ctx.fillStyle = beamGrad;
      ctx.fill();
      ctx.restore();
    }

    animFrame = requestAnimationFrame(draw);
  }

  draw();
  return () => { if (animFrame) cancelAnimationFrame(animFrame); };
}

// ─── 17b. Code Dashboard ────────────────────────────────────────

function dashCode() {
  const templates = [
    { label: 'Hello World',  code: 'print("Hello, JARVIS!")' },
    { label: 'HTTP Request', code: 'import requests\nres = requests.get("https://httpbin.org/get")\nprint(res.status_code, res.json()["url"])' },
    { label: 'List Files',   code: 'import os\nfor f in sorted(os.listdir(".")):\n    print(f)' },
    { label: 'Sort & Search',code: 'arr = [64, 25, 12, 22, 11, 90, 47]\narr.sort()\nprint("Sorted:", arr)\nprint("Max:", max(arr), "Min:", min(arr))' },
    { label: 'Date / Time',  code: 'from datetime import datetime\nnow = datetime.now()\nprint(now.strftime("%A, %d %B %Y  %H:%M:%S"))' },
    { label: 'JSON Parse',   code: 'import json\ndata = \'{"name": "JARVIS", "version": 2}\'\nobj = json.loads(data)\nprint(obj["name"], obj["version"])' },
  ];
  const chips = templates.map(t =>
    `<button class="template-chip" onclick="loadCodeTemplate(${JSON.stringify(t.code)})">${t.label}</button>`
  ).join('');
  return `<div class="mode-dashboard dash-code">
    <div class="dash-code-topbar">
      <div class="dash-code-controls">
        <select id="code-lang" class="dash-select" onchange="onCodeLangChange()">
          <option value="python">Python</option>
          <option value="javascript">JavaScript (Node)</option>
          <option value="powershell">PowerShell</option>
          <option value="bash">Bash / Shell</option>
        </select>
        <button class="dash-btn dash-btn-green" onclick="runDashCode()">▶ RUN</button>
        <button class="dash-btn" onclick="clearDashCode()">⊘ CLEAR</button>
        <div class="dash-sep"></div>
        <button class="dash-btn dash-btn-cyan" onclick="reviewWithJarvis()">⬡ REVIEW</button>
        <button class="dash-btn" onclick="explainWithJarvis()">◎ EXPLAIN</button>
        <button class="dash-btn" onclick="optimizeWithJarvis()">⚡ OPTIMIZE</button>
      </div>
      <span id="code-line-count" class="code-meta">0 lines · 0 chars</span>
    </div>
    <div class="dash-code-templates">
      <span class="tpl-label">TEMPLATES:</span>${chips}
    </div>
    <div class="dash-code-workspace">
      <div class="code-editor-panel">
        <div class="code-panel-hdr"><span>EDITOR</span></div>
        <textarea id="dash-code-editor" class="dash-code-textarea" spellcheck="false" autocomplete="off"
          placeholder="# Write your code here&#10;# RUN executes it · REVIEW sends to JARVIS · EXPLAIN for analysis"></textarea>
      </div>
      <div class="code-output-panel">
        <div class="code-panel-hdr">
          <span>OUTPUT</span>
          <div class="phdr-actions">
            <button class="micro-btn" onclick="clearCodeOutput()">CLEAR</button>
            <button class="micro-btn" onclick="sendOutputToJarvis()">ASK JARVIS</button>
          </div>
        </div>
        <div id="dash-code-output" class="dash-code-output">
          <div class="output-placeholder"><span class="op-icon">▶</span><span>Run your code to see output here</span></div>
        </div>
      </div>
    </div>
  </div>`;
}

function initCodeDash() {
  const ed = document.getElementById('dash-code-editor');
  if (!ed) return [];
  ed.addEventListener('input', () => {
    const lines = ed.value.split('\n').length, chars = ed.value.length;
    const lc = document.getElementById('code-line-count');
    if (lc) lc.textContent = `${lines} line${lines !== 1 ? 's' : ''} · ${chars} chars`;
  });
  ed.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ed.selectionStart, end = ed.selectionEnd;
      ed.value = ed.value.substring(0, s) + '    ' + ed.value.substring(end);
      ed.selectionStart = ed.selectionEnd = s + 4;
    }
  });
  return [];
}

window.runDashCode = async function() {
  const ed = document.getElementById('dash-code-editor');
  const out = document.getElementById('dash-code-output');
  if (!ed || !out) return;
  const code = ed.value.trim();
  if (!code) { showToast('Write some code first.', 'error'); return; }
  const lang = document.getElementById('code-lang')?.value || 'python';
  out.innerHTML = '<div class="output-running"><span class="spin-icon">◈</span> Executing…</div>';
  const ext = { python: '.py', javascript: '.js', powershell: '.ps1', bash: '.sh' }[lang] || '.txt';
  const tmpPath = (state.userDataPath || 'C:\\Temp') + `\\jarvis_run_${Date.now()}${ext}`;
  await window.jarvis.writeFile(tmpPath, code);
  const cmds = { python: `python "${tmpPath}"`, javascript: `node "${tmpPath}"`, powershell: `powershell -ExecutionPolicy Bypass -File "${tmpPath}"`, bash: `bash "${tmpPath}"` };
  const cmd = cmds[lang];
  if (!cmd) { out.innerHTML = '<div class="output-info">Direct execution not available. Use REVIEW instead.</div>'; return; }
  const res = await window.jarvis.runCommand(cmd);
  if (!document.getElementById('dash-code-output')) return;
  let html = '';
  if (res.stdout) html += `<div class="out-section"><div class="out-lbl stdout-lbl">STDOUT</div><pre class="out-pre">${escHtml(res.stdout.trimEnd())}</pre></div>`;
  if (res.stderr) html += `<div class="out-section"><div class="out-lbl stderr-lbl">STDERR</div><pre class="out-pre err-pre">${escHtml(res.stderr.trimEnd())}</pre></div>`;
  if (!res.stdout && !res.stderr) html = '<div class="out-ok">✓ Executed with no output (exit 0)</div>';
  html += `<div class="out-exit ${(res.exitCode ?? 0) === 0 ? '' : 'err-exit'}">Exit ${res.exitCode ?? 0} · ${new Date().toLocaleTimeString()}</div>`;
  out.innerHTML = html;
};

window.clearDashCode = function() {
  const ed = document.getElementById('dash-code-editor');
  if (ed) { ed.value = ''; ed.dispatchEvent(new Event('input')); ed.focus(); }
  window.clearCodeOutput();
};
window.clearCodeOutput = function() {
  const el = document.getElementById('dash-code-output');
  if (el) el.innerHTML = '<div class="output-placeholder"><span class="op-icon">▶</span><span>Run your code to see output here</span></div>';
};
window.reviewWithJarvis = function() {
  const code = document.getElementById('dash-code-editor')?.value?.trim();
  if (!code) { showToast('Write code first.', 'error'); return; }
  const lang = document.getElementById('code-lang')?.value || 'code';
  dashSend(`Review this ${lang} code for correctness, best practices, security, and improvements:\`\`\`${lang}\n${code}\n\`\`\``);
};
window.explainWithJarvis = function() {
  const code = document.getElementById('dash-code-editor')?.value?.trim();
  if (!code) { showToast('Write code first.', 'error'); return; }
  const lang = document.getElementById('code-lang')?.value || 'code';
  dashSend(`Explain this ${lang} code step by step — what it does, how it works, and any notable patterns:\`\`\`${lang}\n${code}\n\`\`\``);
};
window.optimizeWithJarvis = function() {
  const code = document.getElementById('dash-code-editor')?.value?.trim();
  if (!code) { showToast('Write code first.', 'error'); return; }
  const lang = document.getElementById('code-lang')?.value || 'code';
  dashSend(`Optimize this ${lang} code for performance, readability, and efficiency. Show the improved version:\`\`\`${lang}\n${code}\n\`\`\``);
};
window.sendOutputToJarvis = function() {
  const out = document.getElementById('dash-code-output')?.innerText?.trim();
  const code = document.getElementById('dash-code-editor')?.value?.trim();
  if (!out || out.includes('Run your code')) { showToast('Run code first.', 'error'); return; }
  dashSend(`I ran this code and got this output. Help me understand it or suggest next steps:Code:\n\`\`\`\n${code}\n\`\`\`Output:\n\`\`\`\n${out}\n\`\`\``);
};
window.loadCodeTemplate = function(code) {
  const ed = document.getElementById('dash-code-editor');
  if (ed) { ed.value = code; ed.dispatchEvent(new Event('input')); ed.focus(); }
};
window.onCodeLangChange = function() {
  const lang = document.getElementById('code-lang')?.value;
  const ed = document.getElementById('dash-code-editor');
  if (ed && !ed.value.trim()) {
    const hints = { python: '# Python 3\n', javascript: '// Node.js\n', powershell: '# PowerShell\n', bash: '#!/bin/bash\n' };
    ed.value = hints[lang] || '';
    ed.dispatchEvent(new Event('input'));
  }
};

// ─── 17c. Debug Dashboard ───────────────────────────────────────

function dashDebug() {
  return `<div class="mode-dashboard dash-debug">
    <div class="debug-top">
      <div class="debug-error-panel">
        <div class="debug-phdr">
          <span>⚠ PASTE ERROR / STACK TRACE</span>
          <div class="phdr-actions">
            <button class="micro-btn" onclick="clearErrorInput()">CLEAR</button>
            <button class="dash-btn dash-btn-orange" onclick="analyzeError()">⚠ ANALYZE</button>
          </div>
        </div>
        <textarea id="debug-error-input" class="debug-textarea" spellcheck="false"
          placeholder="Paste your error, stack trace, or exception here...

Example:
Traceback (most recent call last):
  File 'app.py', line 42, in main
    result = process(data)
KeyError: 'user_id'"></textarea>
        <div class="debug-patterns">
          <span class="pat-label">QUICK ANALYZE:</span>
          <button class="pat-chip" onclick="debugPattern('memory leak')">Memory Leak</button>
          <button class="pat-chip" onclick="debugPattern('null pointer / undefined reference')">Null Reference</button>
          <button class="pat-chip" onclick="debugPattern('race condition / concurrency bug')">Race Condition</button>
          <button class="pat-chip" onclick="debugPattern('infinite loop')">Infinite Loop</button>
          <button class="pat-chip" onclick="debugPattern('CORS error')">CORS Error</button>
          <button class="pat-chip" onclick="debugPattern('type mismatch / type error')">Type Error</button>
          <button class="pat-chip" onclick="debugPattern('SQL injection vulnerability')">SQL Injection</button>
          <button class="pat-chip" onclick="debugPattern('async/await / promise rejection')">Promise Error</button>
        </div>
      </div>
      <div class="debug-proc-panel">
        <div class="debug-phdr">
          <span>◈ LIVE PROCESSES</span>
          <div class="phdr-actions">
            <span id="proc-refresh-time" class="meta-txt">—</span>
            <button class="micro-btn" onclick="refreshProcesses()">↻</button>
          </div>
        </div>
        <div class="proc-list-hdr"><span>PROCESS</span><span>CPU(s)</span><span>MEM(MB)</span></div>
        <div id="debug-proc-list" class="proc-list"><div class="proc-loading">◈ Loading…</div></div>
      </div>
    </div>
    <div class="debug-footer">
      <div class="dbg-stat"><span class="dbg-stat-label">TOP PROCESS</span><span class="dbg-stat-val" id="dbg-top">—</span></div>
      <div class="dbg-stat"><span class="dbg-stat-label">LAST REFRESH</span><span class="dbg-stat-val" id="dbg-time">—</span></div>
      <button class="dash-btn dash-btn-orange" onclick="analyzeSystem()">⬡ ANALYZE MY SYSTEM WITH JARVIS</button>
    </div>
  </div>`;
}

function initDebugDash() {
  refreshProcesses();
  const interval = setInterval(() => {
    if (document.getElementById('debug-proc-list')) refreshProcesses();
    else clearInterval(interval);
  }, 10000);
  return [() => clearInterval(interval)];
}

window.refreshProcesses = async function() {
  const list = document.getElementById('debug-proc-list');
  if (!list) return;
  const res = await window.jarvis.runCommand(
    `powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, @{N='CPU';E={[math]::Round($_.CPU,1)}}, @{N='MB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Csv -NoTypeInformation"`
  );
  if (!document.getElementById('debug-proc-list')) return;
  const timeEl = document.getElementById('dbg-time');
  if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
  if (res.stdout) {
    const lines = res.stdout.trim().split('\n').slice(1);
    let html = '', topProc = { name: '', cpu: 0 };
    lines.forEach(line => {
      const parts = line.split(',').map(s => s.replace(/^"|"$/g, '').trim());
      if (parts.length >= 3) {
        const [name, cpu, mem] = parts;
        const cpuNum = parseFloat(cpu) || 0;
        if (cpuNum > topProc.cpu) { topProc.cpu = cpuNum; topProc.name = name; }
        const heat = Math.min(1, cpuNum / 50);
        html += `<div class="proc-row" style="--heat:${heat}"><span class="proc-name">${escHtml(name)}</span><span class="proc-cpu">${cpu || '0'}</span><span class="proc-mem">${mem || '0'}</span></div>`;
      }
    });
    const el = document.getElementById('debug-proc-list');
    if (el) el.innerHTML = html || '<div class="proc-loading">No data</div>';
    const top = document.getElementById('dbg-top');
    if (top) top.textContent = topProc.name || '—';
  } else {
    const r2 = await window.jarvis.runCommand('tasklist /FO CSV /NH');
    if (!document.getElementById('debug-proc-list')) return;
    if (r2.stdout) {
      const lines = r2.stdout.trim().split('\n').slice(0, 15);
      let html = '';
      lines.forEach(line => {
        const p = line.split('","').map(s => s.replace(/^"|"$/g, '').trim());
        if (p.length >= 5) html += `<div class="proc-row"><span class="proc-name">${escHtml(p[0])}</span><span class="proc-cpu">—</span><span class="proc-mem">${escHtml(p[4])}</span></div>`;
      });
      const el = document.getElementById('debug-proc-list');
      if (el) el.innerHTML = html;
    }
  }
};

window.analyzeError  = function() { const err = document.getElementById('debug-error-input')?.value?.trim(); if (!err) { showToast('Paste an error first.', 'error'); return; } dashSend(`Debug this error. Identify root cause, explain why it occurs, provide the exact fix, and suggest prevention:\`\`\`\n${err}\n\`\`\``); };
window.clearErrorInput = function() { const el = document.getElementById('debug-error-input'); if (el) el.value = ''; };
window.debugPattern  = function(p) { dashSend(`Explain what causes "${p}" bugs, how to detect them, and the best strategies to fix and prevent them. Include concrete code examples.`); };
window.analyzeSystem = function() { dashSend('Analyze common Windows performance issues, potential process bottlenecks, and system health checks I should run. Give me a diagnostic checklist.'); };

// ─── 17d. Research Dashboard ────────────────────────────────────

function dashResearch() {
  const notes    = localStorage.getItem('jarvis-research-notes') || '';
  const questions= JSON.parse(localStorage.getItem('jarvis-research-questions') || '[]');
  const outline  = JSON.parse(localStorage.getItem('jarvis-research-outline') || '[]');
  const qHTML = questions.map((q, i) =>
    `<div class="list-item"><span class="li-bullet">◎</span><span>${escHtml(q)}</span><button class="item-del" onclick="removeQuestion(${i})">✕</button></div>`
  ).join('') || '<div class="list-ph">Add questions to guide your research</div>';
  const oHTML = outline.map((o, i) =>
    `<div class="list-item"><span class="li-bullet">›</span><span>${escHtml(o)}</span><button class="item-del" onclick="removeOutlineItem(${i})">✕</button></div>`
  ).join('') || '<div class="list-ph">Add outline items or ask JARVIS to generate one</div>';
  return `<div class="mode-dashboard dash-research">
    <div class="research-topbar">
      <span class="res-icon">◎</span>
      <input type="text" id="research-topic" class="research-topic-input" placeholder="Enter research topic, question, or domain…"
        onkeydown="if(event.key==='Enter') window.startResearch()">
      <button class="dash-btn dash-btn-purple" onclick="window.startResearch()">⬡ RESEARCH</button>
      <button class="dash-btn" onclick="window.generateOutline()">≡ OUTLINE</button>
      <button class="dash-btn" onclick="window.findSources()">⎋ SOURCES</button>
    </div>
    <div class="research-workspace">
      <div class="research-notes-panel">
        <div class="res-phdr">
          <span>📄 NOTES</span>
          <div class="phdr-actions">
            <span id="notes-saved" class="save-ind">—</span>
            <button class="micro-btn" onclick="window.clearResearchNotes()">CLEAR</button>
            <button class="micro-btn" onclick="window.sendNotesToJarvis()">ASK JARVIS</button>
          </div>
        </div>
        <textarea id="research-notes" class="research-notes-ta"
          placeholder="Capture your findings, insights, and notes here…&#10;Auto-saved as you type.">${escHtml(notes)}</textarea>
      </div>
      <div class="research-right">
        <div class="research-outline-panel">
          <div class="res-phdr">
            <span>≡ OUTLINE</span>
            <div class="phdr-actions">
              <button class="micro-btn" onclick="window.addOutlineItem()">+ ADD</button>
              <button class="micro-btn" onclick="window.clearOutline()">CLEAR</button>
            </div>
          </div>
          <div id="research-outline" class="res-list">${oHTML}</div>
          <input type="text" id="outline-input" class="list-input" placeholder="Add outline item…"
            onkeydown="if(event.key==='Enter') window.addOutlineItem()">
        </div>
        <div class="research-questions-panel">
          <div class="res-phdr">
            <span>? KEY QUESTIONS</span>
            <div class="phdr-actions">
              <button class="micro-btn" onclick="window.generateQuestions()">⬡ GENERATE</button>
              <button class="micro-btn" onclick="window.clearQuestions()">CLEAR</button>
            </div>
          </div>
          <div id="research-questions" class="res-list">${qHTML}</div>
          <input type="text" id="question-input" class="list-input" placeholder="Add research question…"
            onkeydown="if(event.key==='Enter') window.addQuestion()">
        </div>
      </div>
    </div>
  </div>`;
}

function initResearchDash() {
  const notesEl = document.getElementById('research-notes');
  let saveTimer = null;
  if (notesEl) {
    notesEl.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        localStorage.setItem('jarvis-research-notes', notesEl.value);
        const ind = document.getElementById('notes-saved');
        if (ind) { ind.textContent = 'SAVED'; setTimeout(() => { if (ind) ind.textContent = '—'; }, 1500); }
      }, 1200);
    });
  }
  return [() => clearTimeout(saveTimer)];
}

window.startResearch    = function() { const t = document.getElementById('research-topic')?.value?.trim(); if (!t) { showToast('Enter a topic first.', 'error'); return; } dashSend(`Conduct comprehensive research on: "${t}"Provide: overview, key concepts, current state, important findings, contrasting viewpoints, and recommended resources.`); };
window.generateOutline  = function() { const t = document.getElementById('research-topic')?.value?.trim() || 'the research topic'; dashSend(`Generate a detailed research outline for: "${t}". Include main sections, subsections, and key questions.`); };
window.findSources      = function() { const t = document.getElementById('research-topic')?.value?.trim() || 'the research topic'; dashSend(`What are the best sources, books, papers, websites, and databases for researching: "${t}"?`); };
window.sendNotesToJarvis= function() { const n = document.getElementById('research-notes')?.value?.trim(); if (!n) { showToast('Add notes first.', 'error'); return; } dashSend(`Review my research notes. Provide insights, fill gaps, correct errors, and suggest areas to explore:${n}`); };
window.clearResearchNotes = function() { const el = document.getElementById('research-notes'); if (el) { el.value = ''; localStorage.removeItem('jarvis-research-notes'); } };
window.generateQuestions= function() { const t = document.getElementById('research-topic')?.value?.trim() || 'the research topic'; dashSend(`Generate 8-10 deep research questions for: "${t}". Include fundamental and advanced questions.`); };
window.clearQuestions   = function() { localStorage.removeItem('jarvis-research-questions'); const el = document.getElementById('research-questions'); if (el) el.innerHTML = '<div class="list-ph">Add questions to guide your research</div>'; };
window.clearOutline     = function() { localStorage.removeItem('jarvis-research-outline'); const el = document.getElementById('research-outline'); if (el) el.innerHTML = '<div class="list-ph">Add outline items or ask JARVIS to generate one</div>'; };

function resRerender(key, elId, emptyMsg, fmtFn) {
  const arr = JSON.parse(localStorage.getItem(key) || '[]');
  const el = document.getElementById(elId);
  if (el) el.innerHTML = arr.map(fmtFn).join('') || `<div class="list-ph">${emptyMsg}</div>`;
  return arr;
}
window.addQuestion = function() {
  const inp = document.getElementById('question-input'); if (!inp?.value?.trim()) return;
  const arr = JSON.parse(localStorage.getItem('jarvis-research-questions') || '[]');
  arr.push(inp.value.trim()); localStorage.setItem('jarvis-research-questions', JSON.stringify(arr)); inp.value = '';
  resRerender('jarvis-research-questions', 'research-questions', 'Add questions', (q, i) => `<div class="list-item"><span class="li-bullet">◎</span><span>${escHtml(q)}</span><button class="item-del" onclick="removeQuestion(${i})">✕</button></div>`);
};
window.removeQuestion = function(i) {
  const arr = JSON.parse(localStorage.getItem('jarvis-research-questions') || '[]');
  arr.splice(i, 1); localStorage.setItem('jarvis-research-questions', JSON.stringify(arr));
  resRerender('jarvis-research-questions', 'research-questions', 'Add questions', (q, j) => `<div class="list-item"><span class="li-bullet">◎</span><span>${escHtml(q)}</span><button class="item-del" onclick="removeQuestion(${j})">✕</button></div>`);
};
window.addOutlineItem = function() {
  const inp = document.getElementById('outline-input'); if (!inp?.value?.trim()) return;
  const arr = JSON.parse(localStorage.getItem('jarvis-research-outline') || '[]');
  arr.push(inp.value.trim()); localStorage.setItem('jarvis-research-outline', JSON.stringify(arr)); inp.value = '';
  resRerender('jarvis-research-outline', 'research-outline', 'Add outline items', (o, i) => `<div class="list-item"><span class="li-bullet">›</span><span>${escHtml(o)}</span><button class="item-del" onclick="removeOutlineItem(${i})">✕</button></div>`);
};
window.removeOutlineItem = function(i) {
  const arr = JSON.parse(localStorage.getItem('jarvis-research-outline') || '[]');
  arr.splice(i, 1); localStorage.setItem('jarvis-research-outline', JSON.stringify(arr));
  resRerender('jarvis-research-outline', 'research-outline', 'Add outline items', (o, j) => `<div class="list-item"><span class="li-bullet">›</span><span>${escHtml(o)}</span><button class="item-del" onclick="removeOutlineItem(${j})">✕</button></div>`);
};

// ─── 17e. Automation Dashboard ──────────────────────────────────

function dashAutomation() {
  const tpls = [
    { name: 'System Info',     lang: 'powershell', code: 'Get-ComputerInfo | Select-Object CsName, OsTotalVisibleMemorySize, OsArchitecture | Format-List' },
    { name: 'Disk Usage',      lang: 'powershell', code: 'Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="Used(GB)";E={[math]::Round($_.Used/1GB,2)}}, @{N="Free(GB)";E={[math]::Round($_.Free/1GB,2)}} | Format-Table' },
    { name: 'Top Processes',   lang: 'powershell', code: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU, @{N="Mem(MB)";E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table' },
    { name: 'Network Info',    lang: 'powershell', code: 'Get-NetIPAddress | Where-Object {$_.AddressFamily -eq "IPv4"} | Select-Object IPAddress, InterfaceAlias | Format-Table' },
    { name: 'Ping Google',     lang: 'powershell', code: 'Test-Connection -ComputerName google.com -Count 4 | Select-Object Address, ResponseTime | Format-Table' },
    { name: 'Running Services',lang: 'powershell', code: 'Get-Service | Where-Object {$_.Status -eq "Running"} | Select-Object Name, Status, DisplayName | Sort-Object Name | Format-Table' },
    { name: 'File Backup',     lang: 'powershell', code: '$src = "$env:USERPROFILE\\Documents"\n$dst = "$env:USERPROFILE\\Desktop\\Backup_$(Get-Date -Format "yyyyMMdd_HHmmss")"\nCopy-Item $src $dst -Recurse -Force\nWrite-Host "Backup complete: $dst"' },
    { name: 'Event Log Errors',lang: 'powershell', code: 'Get-EventLog -LogName System -Newest 5 -EntryType Error | Select-Object TimeGenerated, Source, Message | Format-List' },
  ];
  const chips = tpls.map(t =>
    `<button class="auto-tpl-chip" onclick="loadAutoTemplate(${JSON.stringify(t.lang)},${JSON.stringify(t.code)})">${t.name}</button>`
  ).join('');
  return `<div class="mode-dashboard dash-auto">
    <div class="auto-left">
      <div class="auto-editor-hdr">
        <select id="auto-lang" class="dash-select">
          <option value="powershell">PowerShell</option>
          <option value="python">Python</option>
          <option value="bash">Bash</option>
        </select>
        <button class="dash-btn dash-btn-yellow" onclick="runAutoScript()">▶ EXECUTE</button>
        <button class="dash-btn" onclick="clearAutoScript()">⊘ CLEAR</button>
        <button class="dash-btn dash-btn-cyan" onclick="generateAutoScript()">⬡ GENERATE</button>
        <button class="dash-btn" onclick="scheduleScript()">⏱ SCHEDULE</button>
      </div>
      <textarea id="auto-editor" class="auto-editor-ta" spellcheck="false"
        placeholder="# Write or generate your automation script here…&#10;# Pick a quick template below or ask JARVIS to generate one"></textarea>
      <div class="auto-tpls">
        <span class="tpl-label">QUICK SCRIPTS:</span>${chips}
      </div>
    </div>
    <div class="auto-right">
      <div class="auto-out-hdr">
        <span>⌨ EXECUTION OUTPUT</span>
        <div class="phdr-actions">
          <span id="auto-exec-time" class="meta-txt">—</span>
          <button class="micro-btn" onclick="clearAutoOutput()">CLEAR</button>
          <button class="micro-btn" onclick="analyzeAutoOutput()">ANALYZE</button>
        </div>
      </div>
      <div id="auto-output" class="auto-output">
        <div class="output-placeholder"><span class="op-icon">⚙</span><span>Execute a script to see output</span></div>
      </div>
    </div>
  </div>`;
}

function initAutoDash() { return []; }

window.loadAutoTemplate = function(lang, code) {
  const l = document.getElementById('auto-lang'); if (l) l.value = lang;
  const e = document.getElementById('auto-editor'); if (e) { e.value = code; e.focus(); }
};
window.runAutoScript = async function() {
  const code = document.getElementById('auto-editor')?.value?.trim();
  const out = document.getElementById('auto-output');
  if (!code || !out) return;
  out.innerHTML = '<div class="output-running"><span class="spin-icon">⚙</span> Running automation…</div>';
  const lang = document.getElementById('auto-lang')?.value || 'powershell';
  const ext = { powershell: '.ps1', python: '.py', bash: '.sh' }[lang] || '.ps1';
  const tmp = (state.userDataPath || 'C:\\Temp') + `\\jarvis_auto_${Date.now()}${ext}`;
  await window.jarvis.writeFile(tmp, code);
  const t0 = Date.now();
  const cmds = { powershell: `powershell -ExecutionPolicy Bypass -File "${tmp}"`, python: `python "${tmp}"`, bash: `bash "${tmp}"` };
  const res = await window.jarvis.runCommand(cmds[lang]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const timeEl = document.getElementById('auto-exec-time');
  if (timeEl) timeEl.textContent = `${elapsed}s`;
  if (!document.getElementById('auto-output')) return;
  let html = '';
  if (res.stdout) html += `<pre class="auto-out-pre">${escHtml(res.stdout.trimEnd())}</pre>`;
  if (res.stderr) html += `<pre class="auto-out-pre auto-err">${escHtml(res.stderr.trimEnd())}</pre>`;
  if (!res.stdout && !res.stderr) html = '<div class="out-ok">✓ Script executed successfully with no output</div>';
  html += `<div class="out-exit ${(res.exitCode ?? 0) === 0 ? '' : 'err-exit'}">Exit ${res.exitCode ?? 0} · ${elapsed}s · ${new Date().toLocaleTimeString()}</div>`;
  document.getElementById('auto-output').innerHTML = html;
};
window.clearAutoScript  = function() { const e = document.getElementById('auto-editor'); if (e) e.value = ''; };
window.clearAutoOutput  = function() { const e = document.getElementById('auto-output'); if (e) e.innerHTML = '<div class="output-placeholder"><span class="op-icon">⚙</span><span>Execute a script to see output</span></div>'; };
window.generateAutoScript = function() { const lang = document.getElementById('auto-lang')?.value || 'PowerShell'; dashSend(`Write a ${lang} automation script. Suggest 5 useful automations and let me choose, or describe what you need.`); };
window.scheduleScript   = function() { const code = document.getElementById('auto-editor')?.value?.trim(); if (!code) { showToast('Write a script first.', 'error'); return; } dashSend(`How do I schedule this script to run automatically on Windows using Task Scheduler?\`\`\`powershell\n${code}\n\`\`\``); };
window.analyzeAutoOutput= function() { const out = document.getElementById('auto-output')?.innerText?.trim(); if (!out || out.includes('Execute a script')) { showToast('Run a script first.', 'error'); return; } dashSend(`Analyze this script output and explain what it means:\`\`\`\n${out}\n\`\`\``); };

// ─── 17f. Business Dashboard ────────────────────────────────────

function dashBusiness() {
  const defaultKPIs = [
    { label: 'REVENUE TARGET', value: '$0', progress: 0, color: '#00ff88' },
    { label: 'GROWTH RATE',    value: '0%', progress: 0, color: '#00d4ff' },
    { label: 'TASKS DONE',     value: '0/0', progress: 0, color: '#b86bff' },
    { label: 'TEAM HEALTH',    value: '—',   progress: 0, color: '#f59e0b' },
  ];
  const kpis  = JSON.parse(localStorage.getItem('jarvis-kpis')  || 'null') || defaultKPIs;
  const goals = JSON.parse(localStorage.getItem('jarvis-goals') || '[]');
  const swot  = JSON.parse(localStorage.getItem('jarvis-swot')  || '{"s":"","w":"","o":"","t":""}');
  const kpiCards = kpis.map((k, i) => `
    <div class="kpi-card" style="--kc:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" contenteditable="true" id="kpi-val-${i}" onblur="saveKPI(${i},this.innerText)">${escHtml(k.value)}</div>
      <div class="kpi-bar-track"><div class="kpi-bar-fill" id="kpi-bar-${i}" style="width:${k.progress}%;background:${k.color}"></div></div>
      <input type="range" class="kpi-slider" min="0" max="100" value="${k.progress}" oninput="updateKPIProg(${i},this.value)">
    </div>`).join('');
  const goalHTML = goals.map((g, i) => `
    <div class="goal-item ${g.done ? 'done' : ''}">
      <input type="checkbox" ${g.done ? 'checked' : ''} onchange="toggleGoal(${i})" id="g-${i}">
      <label for="g-${i}">${escHtml(g.text)}</label>
      <span class="goal-pri goal-${g.priority.toLowerCase()}">${g.priority}</span>
      <button class="item-del" onclick="deleteGoal(${i})">✕</button>
    </div>`).join('') || '<div class="list-ph">Add your strategic goals</div>';
  return `<div class="mode-dashboard dash-biz">
    <div class="biz-kpi-row">${kpiCards}</div>
    <div class="biz-bottom">
      <div class="biz-goals-panel">
        <div class="biz-phdr"><span>▲ STRATEGIC GOALS</span><button class="micro-btn" onclick="askGoalsJarvis()">⬡ JARVIS</button></div>
        <div id="goals-list" class="goals-list">${goalHTML}</div>
        <div class="biz-add-row">
          <input type="text" id="goal-input" class="list-input" placeholder="Add goal…" onkeydown="if(event.key==='Enter') addGoal()">
          <select id="goal-priority" class="mini-sel"><option>HIGH</option><option selected>MED</option><option>LOW</option></select>
          <button class="dash-btn-sm" onclick="addGoal()">+</button>
        </div>
      </div>
      <div class="biz-swot-panel">
        <div class="biz-phdr"><span>◈ SWOT ANALYSIS</span><div class="phdr-actions"><button class="micro-btn" onclick="analyzeSwot()">⬡ ANALYZE</button><button class="micro-btn" onclick="saveSwot()">SAVE</button></div></div>
        <div class="swot-grid">
          <div class="swot-cell swot-s"><div class="swot-label">STRENGTHS</div><textarea id="swot-s" class="swot-ta" placeholder="Internal strengths…">${escHtml(swot.s)}</textarea></div>
          <div class="swot-cell swot-w"><div class="swot-label">WEAKNESSES</div><textarea id="swot-w" class="swot-ta" placeholder="Internal weaknesses…">${escHtml(swot.w)}</textarea></div>
          <div class="swot-cell swot-o"><div class="swot-label">OPPORTUNITIES</div><textarea id="swot-o" class="swot-ta" placeholder="External opportunities…">${escHtml(swot.o)}</textarea></div>
          <div class="swot-cell swot-t"><div class="swot-label">THREATS</div><textarea id="swot-t" class="swot-ta" placeholder="External threats…">${escHtml(swot.t)}</textarea></div>
        </div>
      </div>
      <div class="biz-ask-panel">
        <div class="biz-phdr"><span>⬡ STRATEGY ADVISOR</span></div>
        <div class="biz-asks">
          <button class="biz-ask-btn" onclick="bizAsk('growth strategy')">Growth Strategy</button>
          <button class="biz-ask-btn" onclick="bizAsk('competitive analysis')">Competitive Analysis</button>
          <button class="biz-ask-btn" onclick="bizAsk('revenue optimization')">Revenue Optimization</button>
          <button class="biz-ask-btn" onclick="bizAsk('market expansion')">Market Expansion</button>
          <button class="biz-ask-btn" onclick="bizAsk('risk assessment and mitigation')">Risk Assessment</button>
          <button class="biz-ask-btn" onclick="bizAsk('fundraising and investor strategy')">Fundraising</button>
        </div>
        <button class="dash-btn dash-btn-yellow fw-btn" onclick="fullBizAnalysis()">⬡ FULL STRATEGIC ANALYSIS</button>
      </div>
    </div>
  </div>`;
}

function initBizDash() { return []; }

window.saveKPI = function(i, val) {
  const kpis = JSON.parse(localStorage.getItem('jarvis-kpis') || 'null') || [];
  if (kpis[i]) { kpis[i].value = val; localStorage.setItem('jarvis-kpis', JSON.stringify(kpis)); }
};
window.updateKPIProg = function(i, val) {
  const bar = document.getElementById(`kpi-bar-${i}`); if (bar) bar.style.width = val + '%';
  const kpis = JSON.parse(localStorage.getItem('jarvis-kpis') || 'null') || [];
  if (kpis[i]) { kpis[i].progress = parseInt(val); localStorage.setItem('jarvis-kpis', JSON.stringify(kpis)); }
};
window.addGoal = function() {
  const inp = document.getElementById('goal-input'), pri = document.getElementById('goal-priority')?.value || 'MED';
  if (!inp?.value?.trim()) return;
  const goals = JSON.parse(localStorage.getItem('jarvis-goals') || '[]');
  goals.push({ id: Date.now(), text: inp.value.trim(), priority: pri, done: false });
  localStorage.setItem('jarvis-goals', JSON.stringify(goals)); inp.value = ''; renderGoals(goals);
};
window.toggleGoal = function(i) {
  const g = JSON.parse(localStorage.getItem('jarvis-goals') || '[]');
  if (g[i]) { g[i].done = !g[i].done; localStorage.setItem('jarvis-goals', JSON.stringify(g)); renderGoals(g); }
};
window.deleteGoal = function(i) {
  const g = JSON.parse(localStorage.getItem('jarvis-goals') || '[]');
  g.splice(i, 1); localStorage.setItem('jarvis-goals', JSON.stringify(g)); renderGoals(g);
};
function renderGoals(goals) {
  const el = document.getElementById('goals-list'); if (!el) return;
  el.innerHTML = goals.map((g, i) => `
    <div class="goal-item ${g.done ? 'done' : ''}">
      <input type="checkbox" ${g.done ? 'checked' : ''} onchange="toggleGoal(${i})" id="g-${i}">
      <label for="g-${i}">${escHtml(g.text)}</label>
      <span class="goal-pri goal-${g.priority.toLowerCase()}">${g.priority}</span>
      <button class="item-del" onclick="deleteGoal(${i})">✕</button>
    </div>`).join('') || '<div class="list-ph">Add your strategic goals</div>';
}
window.saveSwot = function() {
  const s = { s: document.getElementById('swot-s')?.value || '', w: document.getElementById('swot-w')?.value || '', o: document.getElementById('swot-o')?.value || '', t: document.getElementById('swot-t')?.value || '' };
  localStorage.setItem('jarvis-swot', JSON.stringify(s)); showToast('SWOT saved.', 'info');
};
window.analyzeSwot = function() {
  const sw = JSON.parse(localStorage.getItem('jarvis-swot') || '{}');
  dashSend(`Analyze my SWOT:\nStrengths: ${sw.s || 'N/A'}\nWeaknesses: ${sw.w || 'N/A'}\nOpportunities: ${sw.o || 'N/A'}\nThreats: ${sw.t || 'N/A'}Provide strategic recommendations.`);
};
window.askGoalsJarvis = function() {
  const g = JSON.parse(localStorage.getItem('jarvis-goals') || '[]');
  dashSend(`Review my business goals and suggest prioritization and next steps:${g.map(x => `- [${x.done?'x':' '}] ${x.text} (${x.priority})`).join('\n') || 'No goals added yet.'}`);
};
window.bizAsk = function(t) { dashSend(`Provide a strategic analysis and recommendations for: ${t}. Be specific and actionable.`); };
window.fullBizAnalysis = function() {
  const g = JSON.parse(localStorage.getItem('jarvis-goals') || '[]');
  const sw = JSON.parse(localStorage.getItem('jarvis-swot') || '{}');
  dashSend(`Comprehensive business strategic analysis:Goals: ${g.map(x=>x.text).join(', ') || 'Not specified'}\nStrengths: ${sw.s || 'Not specified'}\nWeaknesses: ${sw.w || 'Not specified'}\nOpportunities: ${sw.o || 'Not specified'}\nThreats: ${sw.t || 'Not specified'}Provide: situation analysis, strategic priorities, 90-day action plan, KPIs to track, risk mitigation.`);
};

// ─── 17g. Creative Dashboard ────────────────────────────────────

function dashCreative() {
  const saved = localStorage.getItem('jarvis-creative-content') || '';
  return `<div class="mode-dashboard dash-creative">
    <div class="creative-topbar">
      <div class="creative-topbar-left">
        <select id="creative-format" class="dash-select">
          <option>Blog Post</option><option>Email</option><option>Tweet Thread</option>
          <option>LinkedIn Post</option><option>Product Description</option><option>Short Story</option>
          <option>Marketing Copy</option><option>Cover Letter</option><option>Press Release</option><option>Script</option>
        </select>
        <select id="creative-tone" class="dash-select">
          <option value="professional">Professional</option>
          <option value="casual and friendly">Casual &amp; Friendly</option>
          <option value="witty and humorous">Witty &amp; Humorous</option>
          <option value="inspiring and motivational">Inspiring</option>
          <option value="dramatic">Dramatic</option>
          <option value="authoritative">Authoritative</option>
        </select>
        <input type="text" id="creative-subject" class="creative-subject" placeholder="Topic, subject, or brief…">
      </div>
      <div class="creative-topbar-right">
        <span id="creative-wc" class="wc-badge">0 words</span>
        <button class="dash-btn dash-btn-pink" onclick="generateCreative()">✦ GENERATE</button>
        <button class="dash-btn" onclick="improveCreative()">◎ IMPROVE</button>
        <button class="dash-btn" onclick="sparkIdea()">⚡ SPARK</button>
        <button class="dash-btn" onclick="copyCreative()">⎘ COPY</button>
        <button class="dash-btn" onclick="clearCreative()">⊘ CLEAR</button>
      </div>
    </div>
    <div class="creative-workspace">
      <textarea id="creative-editor" class="creative-ta" oninput="updateWordCount()"
        placeholder="Start writing here…&#10;&#10;Or use:&#10;✦ GENERATE — create from scratch&#10;◎ IMPROVE — enhance existing text&#10;⚡ SPARK  — get creative ideas">${escHtml(saved)}</textarea>
    </div>
    <div class="creative-footer">
      <div class="creative-ideas-panel">
        <div class="ci-hdr"><span>✦ IDEA SPARKS</span><button class="micro-btn" onclick="sparkIdea()">GENERATE</button></div>
        <div id="creative-ideas" class="creative-ideas"><div class="list-ph">Click SPARK to generate creative ideas</div></div>
      </div>
    </div>
  </div>`;
}

function initCreativeDash() {
  updateWordCount();
  const ed = document.getElementById('creative-editor');
  if (ed) {
    ed.addEventListener('input', () => {
      localStorage.setItem('jarvis-creative-content', ed.value);
      updateWordCount();
    });
  }
  return [];
}

window.updateWordCount = function() {
  const text = document.getElementById('creative-editor')?.value || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const el = document.getElementById('creative-wc');
  if (el) el.textContent = `${words} words · ${text.length} chars`;
};
window.generateCreative = function() {
  const fmt = document.getElementById('creative-format')?.value || 'content';
  const tone = document.getElementById('creative-tone')?.value || 'professional';
  const subj = document.getElementById('creative-subject')?.value?.trim() || 'a compelling topic';
  dashSend(`Write a ${fmt} about: "${subj}"\nTone: ${tone}\nMake it complete, compelling, and publication-ready.`);
};
window.improveCreative = function() {
  const c = document.getElementById('creative-editor')?.value?.trim();
  if (!c) { showToast('Write something first, then improve it.', 'error'); return; }
  const tone = document.getElementById('creative-tone')?.value || 'professional';
  dashSend(`Improve this content — make it more compelling, better structured, and ${tone}. Show the improved version:${c}`);
};
window.sparkIdea = function() {
  const fmt = document.getElementById('creative-format')?.value || 'content';
  const subj = document.getElementById('creative-subject')?.value?.trim();
  dashSend(subj ? `Generate 5 creative angles for a ${fmt} about "${subj}". Be specific and original.` : `Give me 5 original ${fmt} ideas that are compelling right now. Be specific.`);
};
window.copyCreative = function() {
  const t = document.getElementById('creative-editor')?.value;
  if (!t?.trim()) { showToast('Nothing to copy.', 'error'); return; }
  navigator.clipboard.writeText(t).then(() => showToast('Copied to clipboard!', 'success'));
};
window.clearCreative = function() {
  const e = document.getElementById('creative-editor');
  if (e) { e.value = ''; updateWordCount(); localStorage.removeItem('jarvis-creative-content'); }
};

// ─── 17h. Productivity Dashboard ────────────────────────────────

function dashProductivity() {
  const tasks  = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]');
  const tbs    = JSON.parse(localStorage.getItem('jarvis-tbs')   || '[]');
  const taskHTML = renderTasksHTML(tasks);
  const tbHTML   = renderTBsHTML(tbs);
  const tbTotal  = tbs.reduce((s, t) => s + (t.mins || 0), 0);
  return `<div class="mode-dashboard dash-prod">
    <div class="prod-left">
      <div class="prod-pomo-panel">
        <div class="prod-phdr"><span>⏱ POMODORO TIMER</span></div>
        <div class="pomo-center">
          <canvas id="pomo-canvas" width="160" height="160"></canvas>
          <div class="pomo-overlay">
            <div class="pomo-phase" id="pomo-phase">FOCUS</div>
            <div class="pomo-time" id="pomo-time">25:00</div>
          </div>
        </div>
        <div class="pomo-controls">
          <button class="pomo-btn pomo-start" id="pomo-start" onclick="startPomodoro()">▶ START</button>
          <button class="pomo-btn" onclick="resetPomodoro()">↺ RESET</button>
          <button class="pomo-btn" onclick="skipPhase()">⏭ SKIP</button>
        </div>
        <div class="pomo-stats">
          <div class="ps-stat"><span class="ps-label">POMODOROS</span><span class="ps-val" id="pomo-count">0</span></div>
          <div class="ps-stat"><span class="ps-label">FOCUS TIME</span><span class="ps-val" id="pomo-focus">0m</span></div>
        </div>
      </div>
    </div>
    <div class="prod-middle">
      <div class="prod-tasks-panel">
        <div class="prod-phdr">
          <span>✓ TODAY'S TASKS</span>
          <div class="phdr-actions">
            <button class="micro-btn" onclick="clearDoneTasks()">CLEAR DONE</button>
            <button class="micro-btn" onclick="prioritizeWithJarvis()">⬡ PRIORITIZE</button>
          </div>
        </div>
        <div id="tasks-list" class="tasks-list">${taskHTML}</div>
        <div class="task-add-row">
          <input type="text" id="task-input" class="list-input" placeholder="Add task…" onkeydown="if(event.key==='Enter') addTask()">
          <select id="task-priority" class="mini-sel"><option>HIGH</option><option selected>MED</option><option>LOW</option></select>
          <button class="dash-btn-sm" onclick="addTask()">+</button>
        </div>
        <button class="dash-btn fw-btn" onclick="planWithJarvis()">⬡ PLAN MY DAY WITH JARVIS</button>
      </div>
    </div>
    <div class="prod-right">
      <div class="prod-tb-panel">
        <div class="prod-phdr">
          <span>⏰ TIME BLOCKS</span>
          <div class="phdr-actions">
            <span id="tb-total" class="meta-txt">Total: ${tbTotal}m (${(tbTotal/60).toFixed(1)}h)</span>
            <button class="micro-btn" onclick="clearTBs()">CLEAR</button>
          </div>
        </div>
        <div id="tb-list" class="tb-list">${tbHTML}</div>
        <div class="tb-add-row">
          <input type="text" id="tb-task" class="list-input" placeholder="Task name…" onkeydown="if(event.key==='Enter') addTimeBlock()">
          <input type="number" id="tb-mins" class="tb-mins-inp" value="25" min="5" max="240">
          <button class="dash-btn-sm" onclick="addTimeBlock()">+</button>
        </div>
      </div>
    </div>
  </div>`;
}

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
      <span class="task-text">${escHtml(t.text)}</span>
      <span class="task-pri task-${t.priority.toLowerCase()}">${t.priority}</span>
      <button class="item-del" onclick="deleteTask(${ri})">✕</button>
    </div>`;
  }).join('') || '<div class="list-ph">Add tasks for today</div>';
}

function renderTBsHTML(tbs) {
  return tbs.map((tb, i) => `
    <div class="tb-item ${tb.done ? 'done' : ''}">
      <input type="checkbox" ${tb.done ? 'checked' : ''} onchange="toggleTB(${i})">
      <span class="tb-task">${escHtml(tb.task)}</span>
      <span class="tb-dur">${tb.mins}m</span>
      <button class="item-del" onclick="deleteTB(${i})">✕</button>
    </div>`).join('') || '<div class="list-ph">Plan your time blocks</div>';
}

function initProdDash() {
  const canvas = document.getElementById('pomo-canvas');
  if (!canvas) return [];
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2, r = (W - 20) / 2;
  let timeLeft = 25*60, totalTime = 25*60, isRunning = false;
  let interval = null, phase = 'FOCUS', pomos = 0, focusMins = 0;

  function drawRing() {
    ctx.clearRect(0, 0, W, H);
    const progress = 1 - timeLeft / totalTime;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(0,212,255,0.12)'; ctx.lineWidth = 10; ctx.stroke();
    const color = phase === 'FOCUS' ? '#06b6d4' : '#00ff88';
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + progress * Math.PI*2);
    ctx.strokeStyle = color; ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.stroke(); ctx.shadowBlur = 0;
  }

  function updateDisplay() {
    const el = document.getElementById('pomo-time');
    const ph = document.getElementById('pomo-phase');
    if (el) el.textContent = `${pad(Math.floor(timeLeft/60))}:${pad(timeLeft%60)}`;
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
      phase = 'BREAK'; timeLeft = totalTime = (pomos % 4 === 0) ? 15*60 : 5*60;
      showToast(`🎉 Pomodoro #${pomos} complete! ${pomos % 4 === 0 ? 'Long break (15 min)' : 'Short break (5 min)'}`, 'success');
    } else {
      phase = 'FOCUS'; timeLeft = totalTime = 25*60;
      showToast('Break over. Back to focus, sir.', 'info');
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
    clearInterval(interval); isRunning = false; phase = 'FOCUS'; timeLeft = totalTime = 25*60;
    const sb = document.getElementById('pomo-start'); if (sb) sb.textContent = '▶ START';
    updateDisplay();
  };
  window.skipPhase = function() { clearInterval(interval); isRunning = false; phaseEnd(); };

  updateDisplay();
  return [() => {
    clearInterval(interval);
    ['startPomodoro','resetPomodoro','skipPhase'].forEach(k => delete window[k]);
  }];
}

window.addTask = function() {
  const inp = document.getElementById('task-input'), pri = document.getElementById('task-priority')?.value || 'MED';
  if (!inp?.value?.trim()) return;
  const tasks = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]');
  tasks.push({ id: Date.now(), text: inp.value.trim(), priority: pri, done: false });
  localStorage.setItem('jarvis-tasks', JSON.stringify(tasks)); inp.value = '';
  const el = document.getElementById('tasks-list'); if (el) el.innerHTML = renderTasksHTML(tasks);
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
window.addTimeBlock = function() {
  const task = document.getElementById('tb-task'), mins = parseInt(document.getElementById('tb-mins')?.value || '25');
  if (!task?.value?.trim()) return;
  const tbs = JSON.parse(localStorage.getItem('jarvis-tbs') || '[]');
  tbs.push({ task: task.value.trim(), mins, done: false }); task.value = '';
  localStorage.setItem('jarvis-tbs', JSON.stringify(tbs));
  const el = document.getElementById('tb-list'); if (el) el.innerHTML = renderTBsHTML(tbs);
  const tot = document.getElementById('tb-total'); const total = tbs.reduce((s,x) => s + x.mins, 0); if (tot) tot.textContent = `Total: ${total}m (${(total/60).toFixed(1)}h)`;
};
window.toggleTB = function(i) {
  const tbs = JSON.parse(localStorage.getItem('jarvis-tbs') || '[]');
  if (tbs[i]) { tbs[i].done = !tbs[i].done; localStorage.setItem('jarvis-tbs', JSON.stringify(tbs)); const el = document.getElementById('tb-list'); if (el) el.innerHTML = renderTBsHTML(tbs); }
};
window.deleteTB = function(i) {
  const tbs = JSON.parse(localStorage.getItem('jarvis-tbs') || '[]');
  tbs.splice(i, 1); localStorage.setItem('jarvis-tbs', JSON.stringify(tbs));
  const el = document.getElementById('tb-list'); if (el) el.innerHTML = renderTBsHTML(tbs);
  const tot = document.getElementById('tb-total'); const total = tbs.reduce((s,x) => s + x.mins, 0); if (tot) tot.textContent = `Total: ${total}m (${(total/60).toFixed(1)}h)`;
};
window.clearTBs = function() {
  localStorage.removeItem('jarvis-tbs');
  const el = document.getElementById('tb-list'); if (el) el.innerHTML = '<div class="list-ph">Plan your time blocks</div>';
  const tot = document.getElementById('tb-total'); if (tot) tot.textContent = 'Total: 0m (0.0h)';
};
window.planWithJarvis = function() {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]').filter(x => !x.done);
  dashSend(`Help me plan my day. My tasks:${t.map(x=>`- [${x.priority}] ${x.text}`).join('\n') || 'No tasks yet.'}Create an optimized time block schedule considering energy, priorities, and breaks.`);
};
window.prioritizeWithJarvis = function() {
  const t = JSON.parse(localStorage.getItem('jarvis-tasks') || '[]').filter(x => !x.done);
  if (!t.length) { showToast('Add tasks first.', 'error'); return; }
  dashSend(`Prioritize and sequence these tasks for maximum impact:${t.map(x=>`- [${x.priority}] ${x.text}`).join('\n')}Consider urgency, importance, dependencies, and effort.`);
};

