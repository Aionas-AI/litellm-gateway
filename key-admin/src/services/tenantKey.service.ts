import { TenantKeyStore } from '../dal/tenantKey.store.js';
import { NotFoundError } from '../lib/errors.js';
import { PaginatedResult, TenantModelKey, UpsertResult, UpsertTenantKeyInput } from '../types/index.js';

export function createTenantKeyService(store: TenantKeyStore) {
  return {
    upsert(input: UpsertTenantKeyInput): Promise<UpsertResult> {
      return store.upsert(input);
    },

    list(page: number, limit: number, tenant?: string): Promise<PaginatedResult<TenantModelKey>> {
      return store.findPaginated(page, limit, tenant);
    },

    async remove(tenant: string, modelAlias: string): Promise<void> {
      const deleted = await store.delete(tenant, modelAlias);
      if (!deleted) {
        throw new NotFoundError(`No key stored for tenant "${tenant}" model "${modelAlias}"`);
      }
    },
  };
}

export type TenantKeyService = ReturnType<typeof createTenantKeyService>;
