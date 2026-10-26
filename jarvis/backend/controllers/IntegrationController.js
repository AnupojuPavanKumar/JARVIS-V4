'use strict';

const { SCOPES } = require('../../core/integrations/integration-store');

function errorResult(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

module.exports = function registerIntegrationController({
  ipcMain,
  integrationService = null,
  secAudit = () => {},
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerIntegrationController requires ipcMain');
  }

  function audit(action, detail, verdict) {
    try { secAudit(action, detail, verdict); } catch { /* audit must not break IPC */ }
  }

  async function statusPayload() {
    if (!integrationService) {
      return { ok: false, enabled: false, error: 'Personal integrations are disabled' };
    }
    const stats = await integrationService.stats();
    let secrets = [];
    let vaultAvailable = false;
    if (integrationService.vault) {
      try {
        secrets = await integrationService.vault.list();
        vaultAvailable = true;
      } catch {
        vaultAvailable = false;
      }
    }
    return {
      ok: true,
      enabled: true,
      vaultAvailable,
      secrets,
      availableScopes: SCOPES,
      ...stats,
    };
  }

  ipcMain.handle('integrations-list', async () => {
    try {
      return await statusPayload();
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle('integrations-update-scopes', async (_, payload = {}) => {
    if (!integrationService) return { ok: false, error: 'Personal integrations are disabled' };
    const integration = typeof payload.integration === 'string' ? payload.integration : '';
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : null;
    if (!integration || !scopes) return { ok: false, error: 'integration and scopes are required' };
    try {
      await integrationService.setScopes(integration, scopes);
      audit('INTEGRATION_SCOPES_UPDATE', integration, 'ALLOWED');
      return await statusPayload();
    } catch (error) {
      audit('INTEGRATION_SCOPES_UPDATE', `${integration} ${error.message}`, 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('integrations-revoke', async (_, payload = {}) => {
    if (!integrationService) return { ok: false, error: 'Personal integrations are disabled' };
    const integration = typeof payload.integration === 'string' ? payload.integration : '';
    if (!integration) return { ok: false, error: 'integration is required' };
    try {
      await integrationService.revoke(integration);
      audit('INTEGRATION_REVOKE', integration, 'ALLOWED');
      return await statusPayload();
    } catch (error) {
      audit('INTEGRATION_REVOKE', `${integration} ${error.message}`, 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('integrations-delete-data', async (_, payload = {}) => {
    if (!integrationService) return { ok: false, error: 'Personal integrations are disabled' };
    const integration = typeof payload.integration === 'string' ? payload.integration : '';
    if (!integration) return { ok: false, error: 'integration is required' };
    try {
      await integrationService.deleteData(integration);
      audit('INTEGRATION_DELETE_DATA', integration, 'ALLOWED');
      return await statusPayload();
    } catch (error) {
      audit('INTEGRATION_DELETE_DATA', `${integration} ${error.message}`, 'ERROR');
      return errorResult(error);
    }
  });

  ipcMain.handle('integrations-activity', async (_, payload = {}) => {
    if (!integrationService) return { ok: false, error: 'Personal integrations are disabled' };
    try {
      const limit = Number.isInteger(payload.limit) ? payload.limit : 50;
      return { ok: true, actions: await integrationService.activity({ limit }) };
    } catch (error) {
      return errorResult(error);
    }
  });
};
