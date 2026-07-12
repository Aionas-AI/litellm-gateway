/**
 * Batch entrypoint: regenerate the runtime config.yaml from Secrets Manager
 * and reload the gateway. Same code path as POST /config/apply, callable from
 * cron/SSM without going through HTTP:
 *
 *   docker compose exec key-manager npm run apply
 */
import { createSecretsManagerTenantKeyStore } from '../dal/tenantKey.store';
import { createLogger } from '../lib/logger';
import { createDockerReloader } from '../lib/reloader';
import { createConfigService } from '../services/config.service';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const configSvc = createConfigService({
    baseConfigPath: requireEnv('BASE_CONFIG_PATH'),
    runtimeConfigPath: requireEnv('RUNTIME_CONFIG_PATH'),
    store: createSecretsManagerTenantKeyStore({
      region: process.env.AWS_REGION ?? 'eu-north-1',
      prefix: process.env.SECRET_PREFIX ?? 'litellm-gateway/tenants',
    }),
    reloader: createDockerReloader({
      socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
      containerName: process.env.LITELLM_CONTAINER ?? 'litellm-gateway-litellm-1',
      logger,
    }),
    logger,
  });

  const result = await configSvc.apply();
  logger.info(result, 'Config applied');
}

main().catch((err) => {
  createLogger().fatal({ err }, 'Apply failed');
  process.exit(1);
});
