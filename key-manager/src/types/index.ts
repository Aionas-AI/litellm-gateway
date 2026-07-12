export interface TenantModelKeyMeta {
  tenant: string;
  alias: string;
  provider: string;
  model: string;
  region?: string;
  apiBase?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantModelKey extends TenantModelKeyMeta {
  apiKey: string;
}

export interface UpsertResult {
  meta: TenantModelKeyMeta;
  created: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

export interface ApplyResult {
  tenantModels: number;
  configPath: string;
  reloaded: boolean;
}
