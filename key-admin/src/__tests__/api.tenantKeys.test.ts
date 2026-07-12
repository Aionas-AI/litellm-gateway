import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { ConfigStore } from '../dal/config.store.js';
import { createInMemoryTenantKeyStore } from '../dal/tenantKey.store.memory.js';
import { LitellmReloader } from '../lib/reloader.js';

const ADMIN_TOKEN = 'test-admin-token';

const BASE_YAML = `model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/eu.anthropic.claude-sonnet-4-6
      aws_region_name: eu-north-1
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
`;

function createFakeConfigStore(): ConfigStore & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    readBase: async () => BASE_YAML,
    writeGenerated: async (yamlText) => {
      written.push(yamlText);
    },
    generatedPath: () => '/gateway/config.yaml',
  };
}

function createFakeReloader(): LitellmReloader & { reloads: number[] } {
  const reloads: number[] = [];
  return {
    reloads,
    reload: async () => {
      reloads.push(Date.now());
    },
  };
}

let app: ReturnType<typeof createApp>;
let configStore: ReturnType<typeof createFakeConfigStore>;
let reloader: ReturnType<typeof createFakeReloader>;

beforeEach(() => {
  configStore = createFakeConfigStore();
  reloader = createFakeReloader();
  app = createApp({
    tenantKeyStore: createInMemoryTenantKeyStore(),
    configStore,
    reloader,
    adminToken: ADMIN_TOKEN,
    awsRegion: 'eu-north-1',
  });
});

const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

async function seedKey(tenant: string, model: string, litellmModel = 'anthropic/claude-opus-4-8') {
  return request(app)
    .put(`/tenants/${tenant}/models/${model}/key`)
    .set(auth)
    .send({ litellmModel, apiKey: 'sk-ant-test-12345678' });
}

describe('auth', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/tenants');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('rejects requests with a wrong token', async () => {
    const res = await request(app).get('/tenants').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('healthz is open', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('refuses to build an app without an admin token', () => {
    expect(() => createApp({ adminToken: '' })).toThrow(/KEY_ADMIN_TOKEN/);
  });
});

describe('PUT /tenants/:tenant/models/:model/key', () => {
  it('creates a key and returns 201 with the derived names', async () => {
    const res = await seedKey('ibm', 'claude-opus');
    expect(res.status).toBe(201);
    expect(res.body.modelName).toBe('ibm-claude-opus');
    expect(res.body.secretName).toBe('litellm_tenant_ibm_claude-opus');
    expect(res.body.litellmModel).toBe('anthropic/claude-opus-4-8');
  });

  it('never echoes the api key back', async () => {
    const res = await seedKey('ibm', 'claude-opus');
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-test');
  });

  it('updates an existing key and returns 200', async () => {
    await seedKey('ibm', 'claude-opus');
    const res = await seedKey('ibm', 'claude-opus');
    expect(res.status).toBe(200);
  });

  it('returns 400 for an invalid tenant slug', async () => {
    const res = await request(app)
      .put('/tenants/IBM!/models/claude-opus/key')
      .set(auth)
      .send({ litellmModel: 'anthropic/claude-opus-4-8', apiKey: 'sk-ant-test-12345678' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for a missing apiKey', async () => {
    const res = await request(app)
      .put('/tenants/ibm/models/claude-opus/key')
      .set(auth)
      .send({ litellmModel: 'anthropic/claude-opus-4-8' });
    expect(res.status).toBe(400);
  });
});

describe('GET /tenants', () => {
  it('returns paginated results with correct shape', async () => {
    await seedKey('ibm', 'opus');
    await seedKey('ibm', 'sonnet');
    await seedKey('acme', 'gpt');
    await seedKey('acme', 'gemini');
    await seedKey('zeta', 'mistral');

    const res = await request(app).get('/tenants').set(auth).query({ page: 1, limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(3);
  });

  it('second page returns remaining items', async () => {
    await seedKey('ibm', 'opus');
    await seedKey('ibm', 'sonnet');
    await seedKey('acme', 'gpt');
    await seedKey('acme', 'gemini');
    await seedKey('zeta', 'mistral');

    const res = await request(app).get('/tenants').set(auth).query({ page: 2, limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('filters by tenant', async () => {
    await seedKey('ibm', 'opus');
    await seedKey('acme', 'gpt');

    const res = await request(app).get('/tenants').set(auth).query({ tenant: 'ibm' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].tenant).toBe('ibm');
  });

  it('returns 400 for invalid pagination params', async () => {
    const res = await request(app).get('/tenants').set(auth).query({ page: 0 });
    expect(res.status).toBe(400);
  });

  it('returns an empty page when nothing is stored', async () => {
    const res = await request(app).get('/tenants').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0, totalPages: 0, page: 1, limit: 20 });
  });
});

describe('DELETE /tenants/:tenant/models/:model/key', () => {
  it('deletes an existing key', async () => {
    await seedKey('ibm', 'opus');
    const res = await request(app).delete('/tenants/ibm/models/opus/key').set(auth);
    expect(res.status).toBe(204);

    const list = await request(app).get('/tenants').set(auth);
    expect(list.body.total).toBe(0);
  });

  it('returns 404 for an unknown key', async () => {
    const res = await request(app).delete('/tenants/ibm/models/nope/key').set(auth);
    expect(res.status).toBe(404);
  });
});
