import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import express from 'express';
import { ConfigStore, createFileConfigStore } from './dal/config.store.js';
import { createAwsTenantKeyStore, TenantKeyStore } from './dal/tenantKey.store.js';
import { createAuthMiddleware } from './lib/auth.js';
import { errorHandler } from './lib/errors.js';
import { createDockerReloader, LitellmReloader } from './lib/reloader.js';
import { createConfigController } from './controllers/config.controller.js';
import { createTenantKeyController } from './controllers/tenantKey.controller.js';
import { createConfigRouter } from './routes/config.routes.js';
import { createTenantKeyRouter } from './routes/tenantKey.routes.js';
import { createConfigService } from './services/config.service.js';
import { createTenantKeyService } from './services/tenantKey.service.js';

export interface AppDeps {
  tenantKeyStore?: TenantKeyStore;
  configStore?: ConfigStore;
  reloader?: LitellmReloader;
  adminToken?: string;
  awsRegion?: string;
}

export function createApp(deps: AppDeps = {}) {
  const awsRegion = deps.awsRegion ?? process.env['AWS_REGION'] ?? 'eu-north-1';
  const adminToken = deps.adminToken ?? process.env['KEY_ADMIN_TOKEN'] ?? '';
  if (!adminToken) {
    throw new Error('KEY_ADMIN_TOKEN must be set - refusing to start an unauthenticated admin API');
  }

  const tenantKeyStore =
    deps.tenantKeyStore ?? createAwsTenantKeyStore(new SecretsManagerClient({ region: awsRegion }));
  const configStore =
    deps.configStore ??
    createFileConfigStore(
      process.env['CONFIG_BASE_PATH'] ?? '/gateway/config.base.yaml',
      process.env['CONFIG_OUT_PATH'] ?? '/gateway/config.yaml',
    );
  const reloader =
    deps.reloader ?? createDockerReloader(process.env['LITELLM_CONTAINER'] ?? 'litellm-gateway-litellm-1');

  const tenantKeySvc = createTenantKeyService(tenantKeyStore);
  const configSvc = createConfigService(tenantKeyStore, configStore, reloader, { awsRegion });

  const tenantKeyCtrl = createTenantKeyController(tenantKeySvc);
  const configCtrl = createConfigController(configSvc);

  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const auth = createAuthMiddleware(adminToken);
  app.use('/tenants', auth, createTenantKeyRouter(tenantKeyCtrl));
  app.use('/config', auth, createConfigRouter(configCtrl));

  app.use(errorHandler);
  return app;
}
