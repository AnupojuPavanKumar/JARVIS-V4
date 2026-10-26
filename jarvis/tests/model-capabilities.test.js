'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOllamaParameters,
  extractModelInfoContextLength,
  capabilitiesFromOllamaShow,
  normalizeCapabilities,
} = require('../core/models/model-capabilities');
const { ModelGateway } = require('../core/models/model-gateway');

test('parses Ollama parameter lines and model context metadata', () => {
  assert.deepEqual(
    parseOllamaParameters('num_ctx 8192\nnum_predict 512\ntemperature 0.2\nstop "<END>"'),
    { num_ctx: 8192, num_predict: 512, temperature: 0.2 }
  );
  assert.equal(extractModelInfoContextLength({
    'llama.context_length': 131072,
    'llama.rope.freq_base': 10000,
    'general.context_length': 32768,
  }), 131072);
});

test('detects tools, vision, context, and output limits from /api/show', () => {
  const capabilities = capabilitiesFromOllamaShow({
    capabilities: ['completion', 'tools', 'vision'],
    model_info: { 'llama.context_length': 131072 },
    parameters: 'num_ctx 8192\nnum_predict 1024',
  }, { defaultOptions: { num_ctx: 4096, num_predict: 256 } });

  assert.equal(capabilities.tools, true);
  assert.equal(capabilities.vision, true);
  assert.equal(capabilities.contextLength, 8192);
  assert.equal(capabilities.maxOutputTokens, 1024);
  assert.equal(capabilities.source, 'ollama');
});

test('infers tool support from an older Ollama template and falls back safely', () => {
  const toolTemplate = capabilitiesFromOllamaShow({
    template: '{{ if .Tools }}tools{{ end }}',
    model_info: { 'llama.context_length': 8192 },
  }, { defaultOptions: { num_ctx: 2048, num_predict: 128 } });
  assert.equal(toolTemplate.tools, true);
  assert.equal(toolTemplate.contextLength, 2048);

  const unknown = capabilitiesFromOllamaShow({}, {});
  assert.equal(unknown.tools, false);
  assert.equal(unknown.vision, false);
  assert.equal(unknown.contextLength, 4096);
  assert.equal(unknown.maxOutputTokens, 512);
});

test('normalizes capability overrides and clamps output to the context', () => {
  const capabilities = normalizeCapabilities({
    contextLength: 1024,
    maxOutputTokens: 4096,
    tools: true,
  });
  assert.equal(capabilities.contextLength, 1024);
  assert.equal(capabilities.maxOutputTokens, 960);
  assert.equal(capabilities.tools, true);
});

test('ModelGateway caches capability probes and can downgrade native tools', async () => {
  let probes = 0;
  const adapter = {
    async chat() { throw new Error('not used'); },
    async getCapabilities() {
      probes += 1;
      return { tools: true, contextLength: 8192, maxOutputTokens: 1024 };
    },
  };
  const gateway = new ModelGateway({ adapter });

  const first = await gateway.getCapabilities();
  const second = await gateway.getCapabilities();
  assert.equal(probes, 1);
  assert.equal(first.tools, true);
  assert.equal(second.contextLength, 8192);

  const downgraded = gateway.markNativeToolsUnsupported('no tools');
  assert.equal(downgraded.tools, false);
  assert.match(downgraded.source, /downgraded/);
  assert.equal((await gateway.getCapabilities()).tools, false);
});
