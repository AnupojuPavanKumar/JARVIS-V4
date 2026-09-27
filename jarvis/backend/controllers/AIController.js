const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, exec } = require('child_process');
const os = require('os');

module.exports = function registerAIController({ ipcMain, app, mainWindowProvider, secAudit, _allowedRendererBase }) {
  
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
    secAudit('WEB_SEARCH', query, 'ALLOWED');
    try {
      // Safely spawn python script bypassing cmd.exe
      const result = await spawnShellCommand('python', [
        path.join(__dirname, '../../skills', 'duckduckgo_search.py'), 
        JSON.stringify({ query, max_results: 5 })
      ], { shell: false, windowsHide: true });
      
      if (result.code !== 0) throw new Error(result.stderr || 'Search failed');
      return { ok: true, data: JSON.parse(result.stdout) };
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
  const ollamaStartScript = path.join(__dirname, '../../start-ollama-gpu.ps1');
  if (fs.existsSync(ollamaStartScript)) {
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
    const piperExe = path.join(__dirname, '../../bin', 'piper', 'piper', 'piper.exe');
    const jarvisModelPath = path.join(__dirname, '../../bin', 'piper', 'piper', 'models', 'jarvis.onnx');
    const defaultModelPath = path.join(__dirname, '../../bin', 'piper', 'piper', 'models', 'en_GB-alan-medium.onnx');
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
  // WHISPER TRANSCRIPTION ENGINE
  // ═══════════════════════════════════════════════════════════════
  let whisperProcess = null;
  let _whisperHealthTimer = null;
  let _whisperPongReceived = false;
  let _whisperReadyResolve = null;
  let whisperReadyPromise = new Promise(r => { _whisperReadyResolve = r; });
  const _whisperQueue = [];
  let _whisperBusy = false;
  let _inflight = null;
  
  function _writeToWhisperStdin(line) {
    return new Promise((res, rej) => {
      if (!whisperProcess || !whisperProcess.stdin.writable) {
        return rej(new Error('Whisper stdin not writable'));
      }
      const ok = whisperProcess.stdin.write(line + '\n');
      if (ok) return res();
      whisperProcess.stdin.once('drain', res);
      whisperProcess.stdin.once('error', rej);
    });
  }
  
  async function _drainWhisperQueue() {
    if (_whisperBusy || _whisperQueue.length === 0) return;
    _whisperBusy = true;
  
    const entry = _whisperQueue[0];
    _inflight = entry;
  
    try {
      await _writeToWhisperStdin(entry.resolvedPath);
    } catch (writeErr) {
      _whisperQueue.shift();
      _whisperBusy = false;
      _inflight = null;
      try { fs.unlinkSync(entry.resolvedPath); } catch (_) { }
      entry.resolve({ success: false, error: 'stdin write failed: ' + writeErr.message });
      _drainWhisperQueue();
    }
  }
  
  function _onWhisperSettled(resultOrError) {
    if (!_inflight) return;
    const entry = _whisperQueue.shift();
    _inflight = null;
    _whisperBusy = false;
  
    try { fs.unlinkSync(entry.resolvedPath); } catch (_) { }
  
    if (resultOrError instanceof Error) {
      entry.resolve({ success: false, error: resultOrError.message });
    } else {
      entry.resolve(resultOrError);
    }
  
    _drainWhisperQueue();
  }
  
  function _clearWhisperHealth() {
    if (_whisperHealthTimer) { clearInterval(_whisperHealthTimer); _whisperHealthTimer = null; }
  }
  
  function _startWhisperHealth() {
    _clearWhisperHealth();
    _whisperHealthTimer = setInterval(() => {
      if (!whisperProcess) return;
      _whisperPongReceived = false;
      try { whisperProcess.stdin.write('PING\n'); } catch { }
      setTimeout(() => {
        if (!_whisperPongReceived && whisperProcess) {
          console.warn('[WHISPER] Health check failed — restarting...');
          if (_inflight) {
            _onWhisperSettled(new Error('Whisper process restarted during health check'));
          }
          while (_whisperQueue.length) {
            const stale = _whisperQueue.shift();
            try { fs.unlinkSync(stale.resolvedPath); } catch (_) { }
            stale.resolve({ success: false, error: 'Whisper restarted' });
          }
          _whisperBusy = false;
          try { whisperProcess.kill(); } catch { }
        }
      }, 5000);
    }, 30000);
  }
  
  function initWhisper() {
    if (whisperProcess) return;
    console.log('[WHISPER] Spawning transcription server...');
  
    whisperReadyPromise = new Promise(r => { _whisperReadyResolve = r; });
  
    whisperProcess = require('child_process').spawn(
      'python',
      [path.join(__dirname, '../../skills', 'transcribe_server.py')],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  
    whisperProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
      for (const output of lines) {
        if (output === 'READY') {
          console.log('[WHISPER] Server is ready.');
          if (_whisperReadyResolve) { _whisperReadyResolve(); _whisperReadyResolve = null; }
          _startWhisperHealth();
          _drainWhisperQueue();
        } else if (output === 'PONG') {
          _whisperPongReceived = true;
        } else if (output.startsWith('TRANSCRIPTION:')) {
          const text = output.replace('TRANSCRIPTION:', '').trim();
          _onWhisperSettled({ success: true, text });
        } else if (output.startsWith('ERROR:')) {
          console.error('[WHISPER] Error:', output);
          _onWhisperSettled(new Error(output));
        } else {
          console.log('[WHISPER STDOUT]', output);
        }
      }
    });
  
    whisperProcess.stderr.on('data', (data) => {
      console.log('[WHISPER STDERR]', data.toString().trim());
    });
  
    whisperProcess.on('close', (code) => {
      console.log('[WHISPER] Process exited with code', code);
      _clearWhisperHealth();
      whisperProcess = null;
      if (!app.isQuitting) {
        if (!global.whisperRetries) global.whisperRetries = 0;
        global.whisperRetries++;
        if (global.whisperRetries < 3) {
          setTimeout(() => { if (!whisperProcess) initWhisper(); }, 2000);
        } else {
          console.error('[WHISPER] Failed to start 3 times. Disabling transcription server.');
        }
      }
    });
  }
  
  initWhisper();
  
  ipcMain.handle('transcribe-audio', async (_event, buffer) => {
    if (!whisperProcess) initWhisper();
  
    const audioDir = path.join(app.getPath('userData'), 'audio-cache');
    try { fs.mkdirSync(audioDir, { recursive: true }); } catch (_) { }
    const tempPath = path.join(audioDir, 'audio_' + Date.now() + '_' + process.pid + '.webm');
    const resolvedPath = path.resolve(tempPath);
  
    if (!resolvedPath.startsWith(path.resolve(audioDir))) {
      return { success: false, error: 'Refusing to write temp audio outside audio-cache.' };
    }
  
    try {
      fs.writeFileSync(resolvedPath, buffer);
    } catch (e) {
      return { success: false, error: 'Failed to write audio temp file: ' + e.message };
    }
  
    const result = await new Promise((resolve, reject) => {
      _whisperQueue.push({ resolvedPath, resolve, reject });
      whisperReadyPromise.then(() => _drainWhisperQueue()).catch(() => { });
    });
  
    return result;
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
      if (now - lastGpuFetchTime >= 10000) {
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
  }, 2000);

};
