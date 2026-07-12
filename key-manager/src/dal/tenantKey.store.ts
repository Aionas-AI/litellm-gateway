import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { PaginatedResult, TenantModelKey, UpsertResult } from '../types';

export interface TenantKeyStore {
  upsert(key: TenantModelKey): Promise<UpsertResult>;
  findByTenantAlias(tenant: string, alias: string): Promise<TenantModelKey | undefined>;
  findPaginated(page: number, limit: number): Promise<PaginatedResult<TenantModelKey>>;
  delete(tenant: string, alias: string): Promise<boolean>;
}

function toMeta(key: TenantModelKey) {
  const { apiKey: _apiKey, ...meta } = key;
  return meta;
}

function paginate<T>(all: T[], page: number, limit: number): PaginatedResult<T> {
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

export interface SecretsManagerStoreOptions {
  region: string;
  prefix: string;
}

export function createSecretsManagerTenantKeyStore(
  opts: SecretsManagerStoreOptions,
): TenantKeyStore {
  const client = new SecretsManagerClient({ region: opts.region });
  const prefix = opts.prefix.replace(/\/+$/, '');
  const secretName = (tenant: string, alias: string) => `${prefix}/${tenant}/${alias}`;

  async function listSecretNames(): Promise<string[]> {
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- sequential AWS pagination
      const res = await client.send(
        new ListSecretsCommand({
          Filters: [{ Key: 'name', Values: [`${prefix}/`] }],
          MaxResults: 100,
          NextToken: nextToken,
        }),
      );
      (res.SecretList ?? []).forEach((s) => {
        if (s.Name) names.push(s.Name);
      });
      nextToken = res.NextToken;
    } while (nextToken);
    return names.sort();
  }

  async function getByName(name: string): Promise<TenantModelKey | undefined> {
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
      return res.SecretString ? (JSON.parse(res.SecretString) as TenantModelKey) : undefined;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  return {
    async upsert(key) {
      const name = secretName(key.tenant, key.alias);
      const payload = JSON.stringify(key);
      try {
        await client.send(new CreateSecretCommand({ Name: name, SecretString: payload }));
        return { meta: toMeta(key), created: true };
      } catch (err) {
        if (err instanceof ResourceExistsException) {
          await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: payload }));
          return { meta: toMeta(key), created: false };
        }
        throw err;
      }
    },

    async findByTenantAlias(tenant, alias) {
      return getByName(secretName(tenant, alias));
    },

    async findPaginated(page, limit) {
      const names = await listSecretNames();
      const pageOfNames = paginate(names, page, limit);
      const data = (await Promise.all(pageOfNames.data.map(getByName))).filter(
        (k): k is TenantModelKey => k !== undefined,
      );
      return { ...pageOfNames, data };
    },

    async delete(tenant, alias) {
      try {
        await client.send(
          new DeleteSecretCommand({
            SecretId: secretName(tenant, alias),
            ForceDeleteWithoutRecovery: true,
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return false;
        throw err;
      }
    },
  };
}

/** In-memory implementation for tests — same contract, no AWS. */
export function createInMemoryTenantKeyStore(): TenantKeyStore {
  const store = new Map<string, TenantModelKey>();
  const keyOf = (tenant: string, alias: string) => `${tenant}/${alias}`;

  return {
    async upsert(key) {
      const created = !store.has(keyOf(key.tenant, key.alias));
      store.set(keyOf(key.tenant, key.alias), key);
      return { meta: toMeta(key), created };
    },
    async findByTenantAlias(tenant, alias) {
      return store.get(keyOf(tenant, alias));
    },
    async findPaginated(page, limit) {
      const all = Array.from(store.keys())
        .sort()
        .map((k) => store.get(k) as TenantModelKey);
      return paginate(all, page, limit);
    },
    async delete(tenant, alias) {
      return store.delete(keyOf(tenant, alias));
    },
  };
}
