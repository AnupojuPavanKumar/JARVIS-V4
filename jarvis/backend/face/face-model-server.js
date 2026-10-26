/**
 * Loopback-only static server for the bundled face models.
 *
 * TensorFlow.js loads graph models with fetch(). Electron's file:// origin is
 * not a reliable fetch target for every model loader, so the models are served
 * from 127.0.0.1 on an ephemeral port. Only files inside the face model folder
 * with .json/.bin extensions are exposed. No application data or user data is
 * served here.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const REQUIRED_MODELS = [
  'blazeface.json',
  'blazeface.bin',
  'facemesh.json',
  'facemesh.bin',
  'iris.json',
  'iris.bin',
  'faceres.json',
  'faceres.bin',
  'antispoof.json',
  'antispoof.bin',
  'liveness.json',
  'liveness.bin',
];

class FaceModelServer {
  constructor({ modelsDir, logger = console } = {}) {
    this.modelsDir = modelsDir ? path.resolve(modelsDir) : null;
    this.logger = logger || console;
    this.server = null;
    this.port = null;
    this.baseUrl = null;
  }

  isAvailable() {
    if (!this.modelsDir) return false;
    try {
      return REQUIRED_MODELS.every(name => fs.existsSync(path.join(this.modelsDir, name)));
    } catch {
      return false;
    }
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  async start() {
    if (this.baseUrl) return this.baseUrl;
    if (!this.isAvailable()) {
      throw new Error('Bundled face models are missing');
    }
    this.server = http.createServer((request, response) => this._handle(request, response));
    this.server.on('clientError', (_error, socket) => {
      try { socket.destroy(); } catch { /* best effort */ }
    });
    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server = null;
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    this.port = address && typeof address === 'object' ? address.port : null;
    if (!this.port) {
      await this.stop();
      throw new Error('Face model server did not receive a port');
    }
    this.baseUrl = `http://127.0.0.1:${this.port}/models/`;
    return this.baseUrl;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.port = null;
    if (!server) return;
    await new Promise(resolve => server.close(() => resolve()));
  }

  _send(response, status, headers, body) {
    response.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...headers,
    });
    if (body) response.end(body);
    else response.end();
  }

  _handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this._send(response, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'Method Not Allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      this._send(response, 400, { 'Content-Type': 'text/plain' }, 'Bad Request');
      return;
    }
    if (!pathname.startsWith('/models/')) {
      this._send(response, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return;
    }
    const relative = pathname.slice('/models/'.length);
    if (!relative || relative.includes('\0') || relative.includes('..')) {
      this._send(response, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return;
    }
    const extension = path.extname(relative).toLowerCase();
    if (extension !== '.json' && extension !== '.bin') {
      this._send(response, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return;
    }
    const resolved = path.resolve(this.modelsDir, relative);
    const root = this.modelsDir.endsWith(path.sep) ? this.modelsDir : `${this.modelsDir}${path.sep}`;
    if (!resolved.startsWith(root)) {
      this._send(response, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return;
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      this._send(response, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return;
    }
    if (!stat.isFile()) {
      this._send(response, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return;
    }
    const headers = {
      'Content-Type': extension === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream',
      'Content-Length': stat.size,
    };
    if (request.method === 'HEAD') {
      this._send(response, 200, headers);
      return;
    }
    response.writeHead(200, {
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...headers,
    });
    const stream = fs.createReadStream(resolved);
    stream.on('error', () => {
      try { response.destroy(); } catch { /* best effort */ }
    });
    stream.pipe(response);
  }
}

module.exports = { FaceModelServer, REQUIRED_MODELS };
