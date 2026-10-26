'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerIntegrationController = require('../backend/controllers/IntegrationController');
const { IntegrationStore } = require('../core/integrations/integration-store');
const { FixtureProvider } = require('../core/integrations/fixture-provider');
const { IntegrationService } = require('../core/integrations/integration-service');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-integration-controller-'));
}

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

test('integration controller exposes redacted status, scope updates, revoke, and delete', async () => {
  const baseDir = tempDir();
  try {
    const store = new IntegrationStore({ baseDir: path.join(baseDir, 'integrations') });
    await store.init();
    const service = new IntegrationService({
      store,
      provider: new FixtureProvider({ store }),
      audit: () => {},
    });
    service.vault = {
      async list() {
        return [{ integration: 'email', updatedAt: '2026-10-21T12:00:00.000Z' }];
      },
    };
    const ipc = fakeIpc();
    const audit = [];
    registerIntegrationController({
      ipcMain: ipc,
      integrationService: service,
      secAudit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
    });

    const initial = await ipc.handlers.get('integrations-list')();
    assert.equal(initial.ok, true);
    assert.equal(initial.enabled, true);
    assert.equal(initial.vaultAvailable, true);
    assert.equal(initial.integrations.email.enabled, true);
    assert.equal(JSON.stringify(initial).includes('ciphertext'), false);
    assert.deepEqual(initial.secrets, [{ integration: 'email', updatedAt: '2026-10-21T12:00:00.000Z' }]);

    const narrowed = await ipc.handlers.get('integrations-update-scopes')({}, {
      integration: 'email',
      scopes: ['email.read'],
    });
    assert.equal(narrowed.ok, true);
    assert.deepEqual(narrowed.integrations.email.scopes, ['email.read']);

    const revoked = await ipc.handlers.get('integrations-revoke')({}, { integration: 'email' });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.integrations.email.enabled, false);

    const activity = await ipc.handlers.get('integrations-activity')({}, { limit: 10 });
    assert.equal(activity.ok, true);
    assert.ok(Array.isArray(activity.actions));

    const deleted = await ipc.handlers.get('integrations-delete-data')({}, { integration: 'email' });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.integrations.email.counts.emails, 0);
    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_SCOPES_UPDATE'));
    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_REVOKE'));
    assert.ok(audit.some(entry => entry.action === 'INTEGRATION_DELETE_DATA'));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
