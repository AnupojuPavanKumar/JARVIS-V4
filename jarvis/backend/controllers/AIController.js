const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, exec } = require('child_process');
const os = require('os');
const { unpackedPath } = require('../asar-paths');
const { createTranscriptionService } = require('../voice/transcription-service');
const { createWhisperSidecar } = require('../voice/whisper-sidecar');
const { WHISPER_ASSET_MANIFEST } = require('../voice/whisper-assets-manifest');

module.exports = function registerAIController({
  ipcMain,
  app,
  mainWindowProvider,
  secAudit,
  secCheckRate,
  voicePolicy,
}) {
  
  // ─── Web Search / DuckDuckGo ────────────────────────────────────────────────────
  // Issue 5 fix: replaced exec()+shell string with spawnShellCommand().
  function spawnShellCommand(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, options);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      
      const timeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Process timed out after 60s'));
      }, 60000);
      
      child.on('error', err => {
        clearTimeout(timeoutId);
        reject(err);
      });
      child.on('close', code => {
        clearTimeout(timeoutId);
        resolve({ code, stdout, stderr });
      });
    });
  }

  ipcMain.handle('web-search', async (_, query) => {
    if (!secCheckRate('webSearch', 10)) return { ok: false, error: 'Rate limit' };
    secAudit('WEB_SEARCH', query, 'ALLOWED');
    try {
      const q = query.slice(0, 512);
      const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'q=' + encodeURIComponent(q)
      });
      
      if (!res.ok) {
        throw new Error(`Search failed with status: ${res.status}`);
      }
      
      const html = await res.text();
      const results = [];
      const linkRegex = /<a rel="nofollow" href="([^"]+)" class='result-link'>([^<]+)<\/a>/g;
      const snippetRegex = /<td class='result-snippet'>\s*(.*?)\s*<\/td>/gs;

      let linkMatch;
      while ((linkMatch = linkRegex.exec(html)) !== null && results.length < 5) {
        const url = linkMatch[1];
        const title = linkMatch[2];
        const snippetMatch = snippetRegex.exec(html);
        const snippet = snippetMatch ? snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim() : "";
        
        // Decode HTML entities (basic)
        const cleanSnippet = snippet.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
        const cleanTitle = title.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
        
        results.push({ url, title: cleanTitle, snippet: cleanSnippet });
      }
      
      return { ok: true, results: results, query: q, fetchedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Ollama Start / Fetch / Stream ──────────────────────────────
  const OLLAMA_HOST = '127.0.0.1';
  const OLLAMA_PORT = 11434;
  const OLLAMA_ALLOWED = ['/api/generate', '/api/chat', '/api/tags', '/api/embeddings'];
  const activeOllamaStreams = new Map();

  // OLLAMA AUTO-START LOGIC
  // Boot smoke tests exercise the real app composition with an isolated
  // userData directory; they must not start GPU/transcription services.
  const testMode = process.env.JARVIS_TEST_MODE === '1';
  const ollamaStartScript = unpackedPath(path.join(__dirname, '../../start-ollama-gpu.ps1'));
  if (!testMode && fs.existsSync(ollamaStartScript)) {
    console.log('[OLLAMA] Auto-starting via powershell...');
    const ollamaProcess = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', ollamaStartScript
    ], { windowsHide: true, shell: false });
    
    ollamaProcess.stdout.on('data', data => console.log('[OLLAMA]', data.toString().trim()));
    ollamaProcess.stderr.on('data', data => console.error('[OLLAMA]', data.toString().trim()));
    app.on('before-quit', () => {
      try { ollamaProcess.kill(); } catch (e) {}
    });
  }

  ipcMain.handle('ollama-fetch', async (_, { path, method, body }) => {
    if (!secCheckRate('ollamaFetch', 60)) return { ok: false, error: 'Rate limit' };
    if (!OLLAMA_ALLOWED.includes(path)) return { ok: false, error: 'Forbidden path' };
    
    return new Promise((resolve) => {
      const options = {
        hostname: OLLAMA_HOST, port: OLLAMA_PORT, path,
        method: method || 'GET', headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      };
      
      const req = http.request(options, (res) => {
        let data = Buffer.alloc(0);
        res.on('data', chunk => data = Buffer.concat([data, chunk]));
        res.on('end', () => {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data.toString('utf8') });
        });
      });
      
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  });

  ipcMain.on('ollama-stream-start', (event, { reqId, path, method, body }) => {
    if (!secCheckRate('ollamaFetch', 60)) {
      event.sender.send('ollama-stream-error', { reqId, error: 'Rate limit' });
      return;
    }
    const mainWindow = mainWindowProvider();
    const senderOk = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    const urlOk = event.senderFrame && typeof event.senderFrame.url === 'string' &&
                  event.senderFrame.url.startsWith(_allowedRendererBase);
    if (!senderOk || !urlOk) {
      secAudit('IPC_BLOCK', 'ollama-stream-start', `BLOCKED sender=${senderOk} url=${urlOk}`);
      return;
    }
  
    if (!OLLAMA_ALLOWED.includes(path)) {
      event.sender.send('ollama-stream-error', { reqId, error: 'Forbidden path' });
      return;
    }
    
    const options = {
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path,
      method: method || 'POST', headers: { 'Content-Type': 'application/json' },
      timeout: 90000
    };
    
    const req = http.request(options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        event.sender.send('ollama-stream-error', { reqId, error: `Ollama ${res.statusCode}` });
        return;
      }
      res.on('data', chunk => event.sender.send('ollama-stream-chunk', { reqId, chunk: chunk.toString('utf8') }));
      res.on('end', () => {
        event.sender.send('ollama-stream-end', { reqId });
        activeOllamaStreams.delete(reqId);
      });
    });
    
    req.on('error', e => {
      event.sender.send('ollama-stream-error', { reqId, error: e.message });
      activeOllamaStreams.delete(reqId);
    });
    
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
    activeOllamaStreams.set(reqId, req);
  });
  
  ipcMain.on('ollama-stream-abort', (event, { reqId }) => {
    const mainWindow = mainWindowProvider();
    const senderOk = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    const urlOk = event.senderFrame && typeof event.senderFrame.url === 'string' &&
                  event.senderFrame.url.startsWith(_allowedRendererBase);
    if (!senderOk || !urlOk) {
      secAudit('IPC_BLOCK', 'ollama-stream-abort', `BLOCKED sender=${senderOk} url=${urlOk}`);
      return;
    }
  
    if (typeof reqId !== 'string' || !reqId) {
      secAudit('IPC_BLOCK', 'ollama-stream-abort', 'Forged or unknown reqId');
      return;
    }
    const req = activeOllamaStreams.get(reqId);
    if (!req) {
      secAudit('IPC_BLOCK', 'ollama-stream-abort', 'Forged or unknown reqId');
      return;
    }
    req.destroy(); 
    activeOllamaStreams.delete(reqId);
  });

  // ═══════════════════════════════════════════════════════════════
  // PIPER TTS ENGINE
  // ═══════════════════════════════════════════════════════════════
  let piperProcess = null;
  let piperCallbacks = {};
  let __piperSeq = 0;
  
  function initPiperProcess() {
    if (piperProcess) return piperProcess;
    const piperExe = unpackedPath(path.join(__dirname, '../../bin', 'piper', 'piper', 'piper.exe'));
    const jarvisModelPath = unpackedPath(path.join(__dirname, '../../bin', 'piper', 'piper', 'models', 'jarvis.onnx'));
    const defaultModelPath = unpackedPath(path.join(__dirname, '../../bin', 'piper', 'piper', 'models', 'en_GB-alan-medium.onnx'));
    const model = fs.existsSync(jarvisModelPath) ? jarvisModelPath : defaultModelPath;
    if (!fs.existsSync(piperExe) || !fs.existsSync(model)) return null;
  
    piperProcess = spawn(piperExe, [
      '--model', model,
      '--json-input',
      '--noise_scale', '0.333',
      '--noise_w', '0.333'
    ], { windowsHide: true, shell: false });
  
    let buffer = '';
    piperProcess.stdout.on('data', (data) => {
      buffer += data.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop();
      for (let line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = Object.values(piperCallbacks).find(cb => cb.tmpFile === trimmed);
        if (entry) {
          const seqKey = Object.keys(piperCallbacks).find(k => piperCallbacks[k] === entry);
          delete piperCallbacks[seqKey];
          try {
            if (fs.existsSync(entry.tmpFile)) {
              const wavBuffer = fs.readFileSync(entry.tmpFile);
              fs.unlinkSync(entry.tmpFile);
              entry.resolve({ ok: true, data: wavBuffer });
            } else {
              entry.resolve({ ok: false, error: 'WAV not found' });
            }
          } catch (e) { entry.resolve({ ok: false, error: e.message }); }
        }
      }
    });
  
    piperProcess.on('exit', () => {
      piperProcess = null;
      for (let key in piperCallbacks) {
        piperCallbacks[key].resolve({ ok: false, error: 'Piper process exited' });
      }
      piperCallbacks = {};
    });
    return piperProcess;
  }
  
  ipcMain.handle('piper-tts', async (_, text) => {
    return new Promise((resolve) => {
      try {
        const p = initPiperProcess();
        if (!p) {
          return resolve({ ok: false, error: 'Piper binary or model not found' });
        }
        const seqId = String(++__piperSeq);
        const tmpFile = path.join(app.getPath('temp'), `piper_${seqId}.wav`);
        
        const timeoutId = setTimeout(() => {
          if (piperCallbacks[seqId]) {
            delete piperCallbacks[seqId];
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
            resolve({ ok: false, error: 'TTS request timed out' });
          }
        }, 30000);
  
        piperCallbacks[seqId] = { 
          tmpFile,
          resolve: (res) => {
            clearTimeout(timeoutId);
            resolve(res);
          }
        };
        
        p.stdin.write(JSON.stringify({ text, output_file: tmpFile }) + '\n');
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // NATIVE WHISPER SIDECAR
  // ═══════════════════════════════════════════════════════════════
  // The packaged app carries its own whisper.cpp executable and model under
  // bin/whisper. There is no Python dependency, no cloud fallback, and no
  // resident loopback server. One JARVIS-owned child runs per utterance.
  const whisperSidecar = createWhisperSidecar({
    appPath: app.getAppPath(),
    manifest: WHISPER_ASSET_MANIFEST,
    logger: console,
  });

  if (!testMode) {
    whisperSidecar.initialize().then(result => {
      if (result.ok) {
        console.log('[WHISPER] Bundled local transcription is ready.');
      }
    });
  }

  app.once('will-quit', () => whisperSidecar.dispose('app-quit'));

  const transcriptionService = voicePolicy
    ? createTranscriptionService({
      voicePolicy,
      queueTranscription: whisperSidecar.transcribe,
      audioDirProvider: () => path.join(app.getPath('userData'), 'audio-cache'),
      audit: secAudit,
    })
    : null;

  ipcMain.handle('transcribe-audio', async (event, payload) => {
    if (!transcriptionService) {
      return { success: false, error: 'Local voice policy is unavailable' };
    }
    return transcriptionService.handle(event, payload);
  });

  // ─── Telemetry Broadcast ──────────────────────────────────────────────
  let lastCpuInfo = os.cpus();
  function getCpuUsage() {
    const cpus = os.cpus();
    let idle = 0; let total = 0;
    for (const cpu of cpus) { for (const type in cpu.times) { total += cpu.times[type]; } idle += cpu.times.idle; }
    let oldIdle = 0; let oldTotal = 0;
    for (const cpu of lastCpuInfo) { for (const type in cpu.times) { oldTotal += cpu.times[type]; } oldIdle += cpu.times.idle; }
    const idleDiff = idle - oldIdle;
    const totalDiff = total - oldTotal;
    lastCpuInfo = cpus;
    if (totalDiff === 0) return 0;
    return (10000 - Math.round(10000 * idleDiff / totalDiff)) / 100;
  }

  let lastGpuPayload = {};
  let lastGpuFetchTime = 0;

  setInterval(() => {
    const mainWindow = mainWindowProvider();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const hours = Math.floor(os.uptime() / 3600);
      const mins = Math.floor((os.uptime() % 3600) / 60);

      const payload = {
        cpuUsage: getCpuUsage().toFixed(1),
        memUsed: (usedMem / 1024 / 1024 / 1024).toFixed(1),
        memTotal: (totalMem / 1024 / 1024 / 1024).toFixed(1),
        uptime: `${hours}h ${mins}m`
      };

      const now = Date.now();
      // GPU queries spawn an external nvidia-smi process. The performance HUD
      // does not need a fresh sample every few seconds; 30s keeps it useful
      // without keeping the GPU/CPU busy while JARVIS sits idle.
      if (now - lastGpuFetchTime >= 30000) {
        lastGpuFetchTime = now;
        const child = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name', '--format=csv,noheader,nounits'], { shell: false });
        let stdout = '';
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e) {}
        }, 5000);

        child.stdout.on('data', chunk => stdout += chunk.toString());
        child.on('close', code => {
          clearTimeout(timer);
          if (code === 0 && stdout) {
            const parts = stdout.trim().split(',').map(s => s.trim());
            if (parts.length >= 5) {
              lastGpuPayload = {
                gpuUsage: parts[0],
                gpuMemUsed: parts[1],
                gpuMemTotal: parts[2],
                gpuTemp: parts[3],
                gpuName: parts[4]
              };
            }
          }
          Object.assign(payload, lastGpuPayload);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('telemetry-update', payload);
          }
        });
        child.on('error', () => {
          clearTimeout(timer);
          Object.assign(payload, lastGpuPayload);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('telemetry-update', payload);
          }
        });
      } else {
        Object.assign(payload, lastGpuPayload);
        mainWindow.webContents.send('telemetry-update', payload);
      }
    }
  }, 5000);

  return Object.freeze({
    getWhisperStatus: () => whisperSidecar.status(),
  });
};
