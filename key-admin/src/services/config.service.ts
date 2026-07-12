import { parse, stringify } from 'yaml';
import { ConfigStore } from '../dal/config.store.js';
import { TenantKeyStore } from '../dal/tenantKey.store.js';
import { LitellmReloader } from '../lib/reloader.js';
import { ApplyResult, GeneratedConfig, TenantModelKey } from '../types/index.js';

const GENERATED_HEADER =
  '# GENERATED FILE - DO NOT EDIT.\n' +
  '# Produced by key-admin from config.base.yaml + tenant keys in AWS Secrets Manager.\n' +
  '# Regenerate: POST /config/apply on the key-admin service.\n';

interface LitellmConfig {
  model_list?: unknown[];
  general_settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConfigServiceOptions {
  awsRegion: string;
}

export function createConfigService(
  keyStore: TenantKeyStore,
  configStore: ConfigStore,
  reloader: LitellmReloader,
  options: ConfigServiceOptions,
) {
  async function collectAllEntries(): Promise<TenantModelKey[]> {
    const limit = 100;
    const first = await keyStore.findPaginated(1, limit);
    const entries = [...first.data];
    for (let page = 2; page <= first.totalPages; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- pages must be fetched sequentially
      const res = await keyStore.findPaginated(page, limit);
      entries.push(...res.data);
    }
    return entries;
  }

  async function generate(): Promise<GeneratedConfig> {
    const [baseText, entries] = await Promise.all([configStore.readBase(), collectAllEntries()]);
    const config = (parse(baseText) ?? {}) as LitellmConfig;

    const tenantModelEntries = entries.map((e) => ({
      model_name: e.modelName,
      litellm_params: {
        model: e.litellmModel,
        // Resolved by LiteLLM from AWS Secrets Manager at runtime - the raw
        // key never touches this file or the container environment.
        api_key: `os.environ/${e.secretName}`,
      },
    }));

    config.model_list = [...(config.model_list ?? []), ...tenantModelEntries];

    if (entries.length > 0) {
      config.general_settings = {
        ...(config.general_settings ?? {}),
        key_management_system: 'aws_secret_manager',
        key_management_settings: {
          access_mode: 'read_only',
          aws_region_name: options.awsRegion,
          hosted_keys: entries.map((e) => e.secretName),
        },
      };
    }

    return {
      yaml: GENERATED_HEADER + stringify(config),
      tenantModels: entries.map((e) => e.modelName),
    };
  }

  return {
    generate,

    async apply(): Promise<ApplyResult> {
      const generated = await generate();
      await configStore.writeGenerated(generated.yaml);
      await reloader.reload();
      return {
        tenantModels: generated.tenantModels,
        configPath: configStore.generatedPath(),
        reload: 'litellm restarted',
      };
    },
  };
}

export type ConfigService = ReturnType<typeof createConfigService>;
