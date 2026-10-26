'use strict';

// Deterministic adapter used by unit/eval suites. A script entry can be:
// - a response object returned as-is
// - an Error, which is thrown
// - a function(request) returning a response, Error, or Promise
// This is a real ModelGateway adapter, so it exercises the same wire
// normalization and runtime path as Ollama.
class FakeModelAdapter {
  constructor({
    script = [],
    capabilities = { tools: true, contextLength: 4096, maxOutputTokens: 512 },
    latencyMs = 0,
  } = {}) {
    this.script = Array.isArray(script) ? script.slice() : [];
    this.capabilities = capabilities;
    this.latencyMs = latencyMs;
    this.calls = [];
    this.model = 'fake-model';
  }

  getCapabilities() {
    return this.capabilities;
  }

  async chat(request) {
    this.calls.push(request);
    if (request.signal?.aborted) throw request.signal.reason || new Error('aborted');

    if (this.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    }

    if (this.script.length === 0) throw new Error('Fake model has no scripted response');
    let next = this.script.shift();
    if (typeof next === 'function') next = await next(request);
    if (next instanceof Error) throw next;
    if (!next || typeof next !== 'object') {
      throw new Error('Fake model script entry must return a response object');
    }
    return next;
  }
}

module.exports = { FakeModelAdapter };
