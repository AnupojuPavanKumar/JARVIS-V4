'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SecretVault } = require('../core/integrations/secret-vault');
const { createSafeStorageVault } = require('../backend/integrations/safe-storage-vault');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-secret-vault-'));
}

function fakeEncrypt(value) {
  return Buffer.from(`enc:${value}`, 'utf8');
}

function fakeDecrypt(buffer) {
  const value = buffer.toString('utf8');
  if (!value.startsWith('enc:')) throw new Error('bad ciphertext');
  return Buffer.from(value.slice(4), 'utf8');
}

test('secrets are encrypted at rest and never listed', async () => {
  const baseDir = tempDir();
  try {
    const filePath = path.join(baseDir, 'secrets.json');
    const vault = new SecretVault({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
    await vault.init();
    assert.deepEqual(await vault.list(), []);

    const written = await vault.set('calendar', 'oauth-token-value');
    assert.equal(written.integration, 'calendar');
    assert.equal(await vault.get('calendar'), 'oauth-token-value');

    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes('oauth-token-value'), false);
    const listed = await vault.list();
    assert.equal(JSON.stringify(listed).includes('oauth-token-value'), false);
    assert.equal(listed[0].integration, 'calendar');

    const deleted = await vault.delete('calendar');
    assert.equal(deleted.deleted, true);
    assert.equal(await vault.get('calendar'), null);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('safeStorage vault fails closed when OS encryption is unavailable', () => {
  assert.throws(() => createSafeStorageVault({
    safeStorage: { isEncryptionAvailable: () => false },
    filePath: path.join(tempDir(), 'secrets.json'),
  }), /unavailable/i);
});

test('safeStorage vault rejects the weak basic_text backend', () => {
  assert.throws(() => createSafeStorageVault({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
    },
    filePath: path.join(tempDir(), 'secrets.json'),
  }), /basic_text/);
});

test('safeStorage vault delegates encryption through the injected safeStorage API', async () => {
  const baseDir = tempDir();
  try {
    const vault = createSafeStorageVault({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(`safe:${value}`),
        decryptString: buffer => buffer.toString('utf8').replace(/^safe:/, ''),
      },
      filePath: path.join(baseDir, 'secrets.json'),
    });
    await vault.init();
    await vault.set('email', 'token-123');
    assert.equal(await vault.get('email'), 'token-123');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
