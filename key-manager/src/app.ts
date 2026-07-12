import express from 'express';
import { createSecretsManagerTenantKeyStore, TenantKeyStore } from './dal/tenantKey.store';
import { createErrorHandler } from './lib/errors';
import { createLogger, Logger } from './lib/logger';
import { createDockerReloader, Reloader } from './lib/reloader';
import { createAuthMiddleware } from './middleware/auth';
import { createConfigController } from './controllers/config.controller';
import { createTenantKeyController } from './controllers/tenantKey.controller';
import { createConfigRouter } from './routes/config.routes';
import { createTenantKeyRouter } from './routes/tenantKey.routes';
import { createConfigService } from './services/config.service';
import { createTenantKeyService } from './services/tenantKey.service';

export interface AppDeps {
  store?: TenantKeyStore;
  reloader?: Reloader;
  logger?: Logger;
  adminToken?: string;
  baseConfigPath?: string;
  runtimeConfigPath?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function createApp(deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger();
  const adminToken = deps.adminToken ?? requireEnv('KEY_MANAGER_ADMIN_TOKEN');
  const baseConfigPath = deps.baseConfigPath ?? requireEnv('BASE_CONFIG_PATH');
  const runtimeConfigPath = deps.runtimeConfigPath ?? requireEnv('RUNTIME_CONFIG_PATH');

  const store =
    deps.store ??
    createSecretsManagerTenantKeyStore({
      region: process.env.AWS_REGION ?? 'eu-north-1',
      prefix: process.env.SECRET_PREFIX ?? 'litellm-gateway/tenants',
    });

  const reloader =
    deps.reloader ??
    createDockerReloader({
      socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
      containerName: process.env.LITELLM_CONTAINER ?? 'litellm-gateway-litellm-1',
      logger,
    });

  const tenantKeySvc = createTenantKeyService(store);
  const configSvc = createConfigService({
    baseConfigPath,
    runtimeConfigPath,
    store,
    reloader,
    logger,
  });

  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const auth = createAuthMiddleware(adminToken);
  app.use('/tenant-keys', auth, createTenantKeyRouter(createTenantKeyController(tenantKeySvc)));
  app.use('/config', auth, createConfigRouter(createConfigController(configSvc)));

  app.use(createErrorHandler(logger));
  return app;
}
