import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
  TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  PaginatedResult,
  TenantModelKey,
  UpsertResult,
  UpsertTenantKeyInput,
} from '../types/index.js';

export interface TenantKeyStore {
  upsert(input: UpsertTenantKeyInput): Promise<UpsertResult>;
  findPaginated(
    page: number,
    limit: number,
    tenant?: string,
  ): Promise<PaginatedResult<TenantModelKey>>;
  delete(tenant: string, modelAlias: string): Promise<boolean>;
}

export const DEFAULT_SECRET_PREFIX = 'litellm_tenant_';

export function secretNameFor(prefix: string, tenant: string, modelAlias: string): string {
  return `${prefix}${tenant}_${modelAlias}`;
}

export function paginate<T>(all: T[], page: number, limit: number): PaginatedResult<T> {
  const total = all.length;
  if (total === 0) return { data: [], total: 0, totalPages: 0, page, limit };
  const start = (page - 1) * limit;
  return {
    data: all.slice(start, start + limit),
    total,
    totalPages: Math.ceil(total / limit),
    page,
    limit,
  };
}

interface SecretTags {
  tenant: string;
  modelAlias: string;
  litellmModel: string;
}

function toTagList(tags: SecretTags): { Key: string; Value: string }[] {
  return [
    { Key: 'managedBy', Value: 'key-admin' },
    { Key: 'tenant', Value: tags.tenant },
    { Key: 'modelAlias', Value: tags.modelAlias },
    { Key: 'litellmModel', Value: tags.litellmModel },
  ];
}

export function createAwsTenantKeyStore(
  client: SecretsManagerClient,
  prefix: string = DEFAULT_SECRET_PREFIX,
): TenantKeyStore {
  function buildEntry(
    tags: SecretTags,
    createdAt: Date | undefined,
    updatedAt: Date | undefined,
  ): TenantModelKey {
    return {
      tenant: tags.tenant,
      modelAlias: tags.modelAlias,
      litellmModel: tags.litellmModel,
      secretName: secretNameFor(prefix, tags.tenant, tags.modelAlias),
      modelName: `${tags.tenant}-${tags.modelAlias}`,
      createdAt: (createdAt ?? new Date()).toISOString(),
      updatedAt: (updatedAt ?? createdAt ?? new Date()).toISOString(),
    };
  }

  async function listAllManaged(): Promise<TenantModelKey[]> {
    const entries: TenantModelKey[] = [];
    let nextToken: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- AWS pagination is inherently sequential
      const res = await client.send(
        new ListSecretsCommand({
          Filters: [{ Key: 'name', Values: [prefix] }],
          MaxResults: 100,
          NextToken: nextToken,
        }),
      );
      for (const secret of res.SecretList ?? []) {
        const tagMap = new Map((secret.Tags ?? []).map((t) => [t.Key, t.Value]));
        if (tagMap.get('managedBy') === 'key-admin') {
          entries.push(
            buildEntry(
              {
                tenant: tagMap.get('tenant') ?? '',
                modelAlias: tagMap.get('modelAlias') ?? '',
                litellmModel: tagMap.get('litellmModel') ?? '',
              },
              secret.CreatedDate,
              secret.LastChangedDate,
            ),
          );
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return entries.sort((a, b) => a.secretName.localeCompare(b.secretName));
  }

  return {
    async upsert(input: UpsertTenantKeyInput): Promise<UpsertResult> {
      const name = secretNameFor(prefix, input.tenant, input.modelAlias);
      const tags: SecretTags = {
        tenant: input.tenant,
        modelAlias: input.modelAlias,
        litellmModel: input.litellmModel,
      };
      try {
        await client.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: input.apiKey,
            Tags: toTagList(tags),
          }),
        );
        return { entry: buildEntry(tags, new Date(), new Date()), created: true };
      } catch (err) {
        if (!(err instanceof ResourceExistsException)) throw err;
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: input.apiKey }));
        await client.send(new TagResourceCommand({ SecretId: name, Tags: toTagList(tags) }));
        const desc = await client.send(new DescribeSecretCommand({ SecretId: name }));
        return {
          entry: buildEntry(tags, desc.CreatedDate, desc.LastChangedDate),
          created: false,
        };
      }
    },

    async findPaginated(
      page: number,
      limit: number,
      tenant?: string,
    ): Promise<PaginatedResult<TenantModelKey>> {
      const all = await listAllManaged();
      const filtered = tenant ? all.filter((e) => e.tenant === tenant) : all;
      return paginate(filtered, page, limit);
    },

    async delete(tenant: string, modelAlias: string): Promise<boolean> {
      const name = secretNameFor(prefix, tenant, modelAlias);
      try {
        await client.send(
          new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
        );
        return true;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return false;
        throw err;
      }
    },
  };
}
