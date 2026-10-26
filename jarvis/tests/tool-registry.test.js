'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolRegistry } = require('../core/tools/tool-registry');

function makeSignedRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-registry-test-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  const script = `
    const args = JSON.parse(process.argv[2] || '{}');
    console.log(JSON.stringify({ ok: true, result: args.text }));
  `;
  const manifest = {
    version: '1.0',
    skills: [{
      id: 'echo',
      name: 'Echo',
      description: 'Echo text',
      script: 'echo.js',
      scriptHash: crypto.createHash('sha256').update(script).digest('hex'),
      type: 'js',
      risk: 'read',
      params: {
        text: { type: 'string', required: true, description: 'Text to echo' },
      },
    }],
  };
  const manifestRaw = JSON.stringify(manifest);
  const signature = crypto.sign(null, Buffer.from(manifestRaw), privateKey);

  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestRaw);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), signature);
  fs.writeFileSync(path.join(dir, 'echo.js'), script);

  return { dir, publicPem, manifestRaw };
}

test('loads a verified catalog and executes a signed skill', async () => {
  const { dir, publicPem } = makeSignedRegistry();
  try {
    const registry = new ToolRegistry({ skillsDir: dir, publicKeyPem: publicPem });
    const loaded = await registry.load();

    assert.equal(loaded.ok, true);
    assert.equal(registry.loaded, true);
    assert.equal(registry.listSkills().length, 1);
    assert.equal(registry.getSkill('echo').risk, 'read');

    const definitions = registry.listDefinitions();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].function.name, 'echo');
    assert.deepEqual(definitions[0].function.parameters.required, ['text']);

    const result = await registry.execute({ tool: 'echo', args: { text: 'hello' } });
    assert.equal(result.ok, true);
    assert.equal(result.result, 'hello');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loads a trusted native tool beside signed skills and validates its args', async () => {
  const { dir, publicPem } = makeSignedRegistry();
  const calls = [];
  const nativeTool = {
    id: 'system_metrics',
    name: 'System Metrics',
    description: 'Real measurements',
    risk: 'read',
    params: {
      target: { type: 'string', required: true, description: 'Target' },
      duration_sec: { type: 'number', required: false, description: 'Seconds' },
    },
    async execute(args, context) {
      calls.push({ args, hasSignal: Boolean(context.signal) });
      return { ok: true, provider: 'gpu', target: args.target };
    },
  };

  try {
    const registry = new ToolRegistry({
      skillsDir: dir,
      publicKeyPem: publicPem,
      nativeTools: [nativeTool],
    });
    const loaded = await registry.load();

    assert.equal(loaded.ok, true);
    assert.equal(registry.listSkills().length, 1);
    assert.equal(registry.listTools().length, 2);
    assert.equal(registry.getSkill('system_metrics').source, 'native');

    const definitions = registry.listDefinitions();
    assert.equal(definitions.length, 2);
    assert.equal(definitions[0].function.name, 'system_metrics');

    const signal = new AbortController().signal;
    const result = await registry.execute(
      { tool: 'system_metrics', args: { target: 'gpu 1', duration_sec: 30 } },
      { signal }
    );
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gpu');
    assert.equal(result.target, 'gpu 1');
    assert.deepEqual(calls, [{ args: { target: 'gpu 1', duration_sec: 30 }, hasSignal: true }]);

    const missing = await registry.execute({ tool: 'system_metrics', args: {} });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Missing required param/);
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unknown tools and invalid args before spawning', async () => {
  const { dir, publicPem } = makeSignedRegistry();
  try {
    const registry = new ToolRegistry({ skillsDir: dir, publicKeyPem: publicPem });
    await registry.load();

    assert.deepEqual(
      await registry.execute({ tool: 'missing', args: {} }),
      { ok: false, error: 'Unknown tool: missing' }
    );

    const unknownArg = await registry.execute({ tool: 'echo', args: { text: 'x', extra: 1 } });
    assert.equal(unknownArg.ok, false);
    assert.match(unknownArg.error, /Unknown param/);

    const missingArg = await registry.execute({ tool: 'echo', args: {} });
    assert.equal(missingArg.ok, false);
    assert.match(missingArg.error, /Missing required param/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('excludes a skill whose script was tampered with after signing', async () => {
  const { dir, publicPem } = makeSignedRegistry();
  try {
    fs.appendFileSync(path.join(dir, 'echo.js'), '// tampered\n');

    const registry = new ToolRegistry({ skillsDir: dir, publicKeyPem: publicPem });
    const loaded = await registry.load();

    assert.equal(loaded.ok, true);
    assert.equal(loaded.excluded.length, 1);
    assert.equal(loaded.excluded[0].id, 'echo');
    assert.match(loaded.excluded[0].reason, /script hash mismatch/);
    assert.deepEqual(registry.listSkills(), []);
    assert.deepEqual(registry.listDefinitions(), []);
    assert.equal(registry.getSkill('echo'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed on an invalid manifest signature', async () => {
  const { dir, publicPem, manifestRaw } = makeSignedRegistry();
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${manifestRaw} `);
    const registry = new ToolRegistry({ skillsDir: dir, publicKeyPem: publicPem });
    const loaded = await registry.load();

    assert.equal(loaded.ok, false);
    assert.equal(registry.loaded, false);
    assert.deepEqual(registry.listDefinitions(), []);
    assert.equal(registry.getSkill('echo'), null);

    const result = await registry.execute({ tool: 'echo', args: { text: 'x' } });
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
