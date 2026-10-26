'use strict';

const { SecretVault } = require('../../core/integrations/secret-vault');

function createSafeStorageVault({ safeStorage, filePath } = {}) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error('safeStorage is not available');
  }
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('A vault file path is required');
  }
  if (safeStorage.isEncryptionAvailable() !== true) {
    throw new Error('OS-backed secret encryption is unavailable');
  }
  if (typeof safeStorage.getSelectedStorageBackend === 'function') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text') {
      throw new Error('OS-backed secret encryption is unavailable (basic_text backend)');
    }
  }

  return new SecretVault({
    filePath,
    encrypt: value => safeStorage.encryptString(value),
    decrypt: buffer => safeStorage.decryptString(buffer),
  });
}

module.exports = { createSafeStorageVault };
