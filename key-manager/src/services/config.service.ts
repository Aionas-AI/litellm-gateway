import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { TenantKeyStore } from '../dal/tenantKey.store';
import { Reloader } from '../lib/reloader';
import { Logger } from '../lib/logger';
import { ApplyResult, TenantModelKey } from '../types';

interface LiteLLMModelEntry {
  model_name: string;
  litellm_params: Record<string, unknown>;
}

export interface ConfigServiceOptions {
  baseConfigPath: string;
  runtimeConfigPath: string;
  store: TenantKeyStore;
  reloader: Reloader;
  logger: Logger;
}

function toModelEntry(key: TenantModelKey): LiteLLMModelEntry {
  const params: Record<string, unknown> = {
    model: `${key.provider}/${key.model}`,
    api_key: key.apiKey,
  };
  if (key.provider === 'bedrock' && key.region) params.aws_region_name = key.region;
  if (key.apiBase) params.api_base = key.apiBase;
  return { model_name: `${key.tenant}-${key.alias}`, litellm_params: params };
}

export function createConfigService(opts: ConfigServiceOptions) {
  const { baseConfigPath, runtimeConfigPath, store, reloader, logger } = opts;

  async function collectAllKeys(): Promise<TenantModelKey[]> {
    const all: TenantModelKey[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      // eslint-disable-next-line no-await-in-loop -- sequential pagination
      const result = await store.findPaginated(page, 100);
      all.push(...result.data);
      totalPages = result.totalPages;
      page += 1;
    } while (page <= totalPages);
    return all;
  }

  return {
    /** Merge the committed base config with all tenant entries from the secret store. */
    async generate(): Promise<{ content: string; tenantModels: number }> {
      const base = parse(fs.readFileSync(baseConfigPath, 'utf8')) as {
        model_list?: LiteLLMModelEntry[];
        [k: string]: unknown;
      };
      const keys = await collectAllKeys();
      const merged = {
        ...base,
        model_list: [...(base.model_list ?? []), ...keys.map(toModelEntry)],
      };
      return { content: stringify(merged), tenantModels: keys.length };
    },

    /**
     * Regenerate the runtime config and reload the gateway. The file is written
     * atomically (tmp + rename) into a directory that is bind-mounted into the
     * LiteLLM container, then the container is restarted to re-read it.
     */
    async apply(): Promise<ApplyResult> {
      const { content, tenantModels } = await this.generate();
      fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
      const tmpPath = `${runtimeConfigPath}.tmp`;
      fs.writeFileSync(tmpPath, content, { mode: 0o600 });
      fs.renameSync(tmpPath, runtimeConfigPath);
      logger.info({ runtimeConfigPath, tenantModels }, 'Runtime config written');
      const reloaded = await reloader.reload();
      return { tenantModels, configPath: runtimeConfigPath, reloaded };
    },
  };
}

export type ConfigService = ReturnType<typeof createConfigService>;
