export interface TenantModelKey {
  /** Tenant slug, e.g. "ibm" */
  tenant: string;
  /** Model alias within the tenant, e.g. "claude-opus" */
  modelAlias: string;
  /** LiteLLM upstream model id, e.g. "anthropic/claude-opus-4-8" */
  litellmModel: string;
  /** AWS Secrets Manager secret name holding the provider key */
  secretName: string;
  /** Gateway-facing model name, e.g. "ibm-claude-opus" */
  modelName: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTenantKeyInput {
  tenant: string;
  modelAlias: string;
  litellmModel: string;
  apiKey: string;
}

export interface UpsertResult {
  entry: TenantModelKey;
  created: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

export interface GeneratedConfig {
  yaml: string;
  tenantModels: string[];
}

export interface ApplyResult {
  tenantModels: string[];
  configPath: string;
  reload: string;
}
