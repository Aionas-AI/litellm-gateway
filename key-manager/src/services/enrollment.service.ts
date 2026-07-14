import { createHash, randomBytes } from 'node:crypto';
import {
  LiteLLMAdminClient,
  LiteLLMAdminClientError,
  LiteLLMModelInput,
  LiteLLMModelRecord,
} from '../clients/litellm.client';
import { BadGatewayError, ConflictError, ForbiddenError, NotFoundError } from '../lib/errors';
import { EnrollmentInput, EnrollmentPrincipal, EnrollmentResult, ManagedModel } from '../types';

interface EnrollmentServiceOptions {
  client: LiteLLMAdminClient;
  gatewayBaseUrl: string;
  allowedCustomApiBaseHosts?: string[];
}

const META = {
  managed: 'aionas_managed',
  tenant: 'aionas_tenant_id',
  user: 'aionas_user_id',
  credential: 'aionas_credential_id',
  alias: 'aionas_model_alias',
  internalModel: 'aionas_internal_model',
} as const;

function stableHash(...parts: string[]): string {
  const framed = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  return createHash('sha256').update(framed).digest('hex');
}

function modelIdentity(principal: EnrollmentPrincipal, credentialId: string) {
  const digest = stableHash(principal.tenantId, principal.userId, credentialId).slice(0, 32);
  return { modelId: `aionas-${digest}`, modelName: `aionas-byok-${digest}` };
}

function modelMetadata(
  principal: EnrollmentPrincipal,
  input: EnrollmentInput,
  modelId: string,
  modelName: string,
): Record<string, unknown> {
  return {
    id: modelId,
    [META.managed]: true,
    [META.tenant]: principal.tenantId,
    [META.user]: principal.userId,
    [META.credential]: input.credentialId,
    [META.alias]: input.modelAlias,
    [META.internalModel]: modelName,
    aionas_provider: input.provider,
    aionas_upstream_model: input.model,
  };
}

function readString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function assertOwnedModel(
  record: LiteLLMModelRecord,
  principal: EnrollmentPrincipal,
  credentialId: string,
): void {
  const info = record.model_info;
  if (
    info?.[META.managed] !== true ||
    readString(info, META.tenant) !== principal.tenantId ||
    readString(info, META.user) !== principal.userId ||
    readString(info, META.credential) !== credentialId
  ) {
    throw new ConflictError('The deterministic model id is already owned by another enrollment');
  }
}

function upstreamParams(input: EnrollmentInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: `${input.provider}/${input.model}`,
    api_key: input.apiKey,
  };
  if (input.apiBase) params.api_base = input.apiBase;
  if (input.region) params.aws_region_name = input.region;
  return params;
}

function toManagedModel(record: LiteLLMModelRecord): ManagedModel | undefined {
  const info = record.model_info;
  if (info?.[META.managed] !== true) return undefined;
  const modelId = readString(info, 'id') || record.model_id;
  if (!modelId) return undefined;
  return {
    modelId,
    internalModelName: record.model_name,
    modelAlias: readString(info, META.alias),
    provider: readString(info, 'aionas_provider'),
    model: readString(info, 'aionas_upstream_model'),
    tenantId: readString(info, META.tenant),
    userId: readString(info, META.user),
    credentialId: readString(info, META.credential),
  };
}

function asBadGateway(err: unknown): never {
  if (err instanceof LiteLLMAdminClientError) throw new BadGatewayError(err.message);
  throw err;
}

export function createEnrollmentService(opts: EnrollmentServiceOptions) {
  const allowedHosts = new Set(
    (opts.allowedCustomApiBaseHosts ?? []).map((host) => host.toLowerCase()),
  );
  const gatewayBaseUrl = opts.gatewayBaseUrl.replace(/\/+$/, '');

  function assertApiBaseAllowed(apiBase: string | undefined): void {
    if (!apiBase) return;
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())) {
      throw new ForbiddenError('Custom apiBase is not allowed for this gateway');
    }
  }

  async function ensureModel(
    principal: EnrollmentPrincipal,
    input: EnrollmentInput,
  ): Promise<{ modelId: string; modelName: string; created: boolean }> {
    assertApiBaseAllowed(input.apiBase);
    const { modelId, modelName } = modelIdentity(principal, input.credentialId);
    const payload: LiteLLMModelInput = {
      model_name: modelName,
      litellm_params: upstreamParams(input),
      model_info: modelMetadata(principal, input, modelId, modelName),
    };

    try {
      const existing = await opts.client.getModel(modelId);
      if (existing) {
        assertOwnedModel(existing, principal, input.credentialId);
        await opts.client.updateModel(modelId, payload);
        return { modelId, modelName, created: false };
      }

      try {
        await opts.client.createModel(payload);
        return { modelId, modelName, created: true };
      } catch (err) {
        if (!(err instanceof LiteLLMAdminClientError) || err.status < 400 || err.status >= 500)
          throw err;
        const raced = await opts.client.getModel(modelId);
        if (!raced) throw err;
        assertOwnedModel(raced, principal, input.credentialId);
        await opts.client.updateModel(modelId, payload);
        return { modelId, modelName, created: false };
      }
    } catch (err) {
      return asBadGateway(err);
    }
  }

  return {
    async provision(
      principal: EnrollmentPrincipal,
      input: EnrollmentInput,
    ): Promise<EnrollmentResult> {
      const model = await ensureModel(principal, input);
      const userId = `aionas-${stableHash(principal.tenantId, principal.userId).slice(0, 24)}`;
      const deviceHash = stableHash(input.deviceId).slice(0, 8);

      const keyResults = await Promise.allSettled(
        input.clients.map(async (clientInput) => {
          const keyAlias = `aionas-${clientInput.clientId}-${deviceHash}-${randomBytes(3).toString('hex')}`;
          const key = await opts.client.generateKey({
            key_alias: keyAlias,
            models: [input.modelAlias, model.modelName],
            aliases: { [input.modelAlias]: model.modelName },
            user_id: userId,
            duration: clientInput.duration ?? '90d',
            max_budget: clientInput.maxBudget,
            metadata: {
              [META.managed]: true,
              [META.tenant]: principal.tenantId,
              [META.user]: principal.userId,
              [META.credential]: input.credentialId,
              [META.alias]: input.modelAlias,
              [META.internalModel]: model.modelName,
              aionas_model_id: model.modelId,
              aionas_client_id: clientInput.clientId,
              aionas_device_id: input.deviceId,
            },
            key_type: 'llm_api',
          });
          return {
            clientId: clientInput.clientId,
            keyAlias,
            virtualKey: key.key,
            expires: key.expires,
          };
        }),
      );

      const createdKeys = keyResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const failed = keyResults.some((result) => result.status === 'rejected');

      if (failed) {
        await opts.client
          .deleteKeys(createdKeys.map((key) => key.virtualKey))
          .catch(() => undefined);
        if (model.created) await opts.client.deleteModel(model.modelId).catch(() => undefined);
        throw new BadGatewayError('LiteLLM could not issue every requested client key');
      }

      return {
        credentialId: input.credentialId,
        modelAlias: input.modelAlias,
        internalModelId: model.modelId,
        internalModelName: model.modelName,
        modelCreated: model.created,
        gatewayBaseUrl,
        clients: createdKeys,
      };
    },

    async listManagedModels(): Promise<ManagedModel[]> {
      try {
        return (await opts.client.listModels())
          .map(toManagedModel)
          .filter((model): model is ManagedModel => model !== undefined);
      } catch (err) {
        return asBadGateway(err);
      }
    },

    async deleteManagedModel(modelId: string): Promise<void> {
      try {
        const model = await opts.client.getModel(modelId);
        if (!model || model.model_info?.[META.managed] !== true)
          throw new NotFoundError('Managed model not found');
        await opts.client.deleteModel(modelId);
        return undefined;
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
        return asBadGateway(err);
      }
    },
  };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
