export const supportedClients = ['claude-code', 'codex', 'openclaw', 'cursor'] as const;

export type SupportedClient = (typeof supportedClients)[number];

export interface EnrollmentPrincipal {
  tenantId: string;
  userId: string;
  tokenId: string;
  expiresAt: number;
}

export interface EnrollmentClientInput {
  clientId: SupportedClient;
  duration?: string;
  maxBudget?: number;
}

export interface EnrollmentInput {
  credentialId: string;
  provider: string;
  model: string;
  modelAlias: string;
  apiKey: string;
  apiBase?: string;
  region?: string;
  deviceId: string;
  clients: EnrollmentClientInput[];
}

export interface ProvisionedClient {
  clientId: SupportedClient;
  keyAlias: string;
  virtualKey: string;
  expires?: string;
}

export interface EnrollmentResult {
  credentialId: string;
  modelAlias: string;
  internalModelId: string;
  internalModelName: string;
  modelCreated: boolean;
  gatewayBaseUrl: string;
  clients: ProvisionedClient[];
}

export interface ManagedModel {
  modelId: string;
  internalModelName: string;
  modelAlias: string;
  provider: string;
  model: string;
  tenantId: string;
  userId: string;
  credentialId: string;
}
