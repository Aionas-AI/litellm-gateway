import {
  PaginatedResult,
  TenantModelKey,
  UpsertResult,
  UpsertTenantKeyInput,
} from '../types/index.js';
import { DEFAULT_SECRET_PREFIX, paginate, secretNameFor, TenantKeyStore } from './tenantKey.store.js';

interface StoredEntry {
  entry: TenantModelKey;
  apiKey: string;
}

/**
 * In-memory implementation with the same semantics as the AWS-backed store.
 * Used by tests (structural isolation: a fresh store per createApp call) and
 * useful for local development without AWS credentials.
 */
export function createInMemoryTenantKeyStore(
  prefix: string = DEFAULT_SECRET_PREFIX,
): TenantKeyStore {
  const store = new Map<string, StoredEntry>();

  return {
    async upsert(input: UpsertTenantKeyInput): Promise<UpsertResult> {
      const secretName = secretNameFor(prefix, input.tenant, input.modelAlias);
      const existing = store.get(secretName);
      const now = new Date().toISOString();
      const entry: TenantModelKey = {
        tenant: input.tenant,
        modelAlias: input.modelAlias,
        litellmModel: input.litellmModel,
        secretName,
        modelName: `${input.tenant}-${input.modelAlias}`,
        createdAt: existing?.entry.createdAt ?? now,
        updatedAt: now,
      };
      store.set(secretName, { entry, apiKey: input.apiKey });
      return { entry, created: !existing };
    },

    async findPaginated(
      page: number,
      limit: number,
      tenant?: string,
    ): Promise<PaginatedResult<TenantModelKey>> {
      const all = Array.from(store.values())
        .map((s) => s.entry)
        .filter((e) => (tenant ? e.tenant === tenant : true))
        .sort((a, b) => a.secretName.localeCompare(b.secretName));
      return paginate(all, page, limit);
    },

    async delete(tenant: string, modelAlias: string): Promise<boolean> {
      return store.delete(secretNameFor(prefix, tenant, modelAlias));
    },
  };
}
