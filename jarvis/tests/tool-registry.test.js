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

  const manifest = {
    version: '1.0',
    skills: [{
      id: 'echo',
      name: 'Echo',
      description: 'Echo text',
      script: 'echo.js',
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
  fs.writeFileSync(path.join(dir, 'echo.js'), `
    const args = JSON.parse(process.argv[2] || '{}');
    console.log(JSON.stringify({ ok: true, result: args.text }));
  `);

  return { dir, publicPem, manifestRaw };
}

test('loads a verified catalog, exposes native tools, and executes a skill', async () => {
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
