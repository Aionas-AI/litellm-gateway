import { TenantKeyStore } from '../dal/tenantKey.store';
import { UpsertKeyInput } from '../schemas/tenantKey.schema';
import { PaginatedResult, TenantModelKeyMeta, UpsertResult } from '../types';

export function createTenantKeyService(store: TenantKeyStore) {
  return {
    async upsert(tenant: string, alias: string, input: UpsertKeyInput): Promise<UpsertResult> {
      const existing = await store.findByTenantAlias(tenant, alias);
      const now = new Date().toISOString();
      return store.upsert({
        tenant,
        alias,
        provider: input.provider,
        model: input.model,
        apiKey: input.apiKey,
        region: input.region,
        apiBase: input.apiBase,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    async getMeta(tenant: string, alias: string): Promise<TenantModelKeyMeta | undefined> {
      const key = await store.findByTenantAlias(tenant, alias);
      if (!key) return undefined;
      const { apiKey: _apiKey, ...meta } = key;
      return meta;
    },

    async list(page: number, limit: number): Promise<PaginatedResult<TenantModelKeyMeta>> {
      const result = await store.findPaginated(page, limit);
      return {
        ...result,
        data: result.data.map(({ apiKey: _apiKey, ...meta }) => meta),
      };
    },

    async delete(tenant: string, alias: string): Promise<boolean> {
      return store.delete(tenant, alias);
    },
  };
}

export type TenantKeyService = ReturnType<typeof createTenantKeyService>;
