import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app';
import { createInMemoryTenantKeyStore, TenantKeyStore } from '../dal/tenantKey.store';
import { Reloader } from '../lib/reloader';
import { createLogger } from '../lib/logger';

const ADMIN_TOKEN = 'test-admin-token';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

const BASE_CONFIG = `
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/eu.anthropic.claude-sonnet-4-6
      aws_region_name: eu-north-1
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
`;

function buildApp(store: TenantKeyStore, reloader: Reloader, dir: string) {
  return createApp({
    store,
    reloader,
    adminToken: ADMIN_TOKEN,
    baseConfigPath: path.join(dir, 'config.yaml'),
    runtimeConfigPath: path.join(dir, 'runtime', 'config.yaml'),
    logger: createLogger(),
  });
}

let app: ReturnType<typeof createApp>;
let store: TenantKeyStore;
let reloadCalls: number;
let tmpDir: string;

beforeEach(() => {
  store = createInMemoryTenantKeyStore();
  reloadCalls = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-manager-test-'));
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), BASE_CONFIG);
  const reloader: Reloader = {
    async reload() {
      reloadCalls += 1;
      return true;
    },
  };
  app = buildApp(store, reloader, tmpDir);
});

const validBody = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  apiKey: 'sk-ant-test-key-123',
};

describe('auth', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/tenant-keys');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('returns 401 with a wrong token', async () => {
    const res = await request(app).get('/tenant-keys').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('healthz is open', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });
});

describe('PUT /tenant-keys/:tenant/:alias', () => {
  it('creates a key and returns 201 with meta only (no apiKey)', async () => {
    const res = await request(app).put('/tenant-keys/ibm/opus').set(AUTH).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.tenant).toBe('ibm');
    expect(res.body.alias).toBe('opus');
    expect(res.body.provider).toBe('anthropic');
    expect(res.body.apiKey).toBeUndefined();
  });

  it('updates an existing key and returns 200', async () => {
    await request(app).put('/tenant-keys/ibm/opus').set(AUTH).send(validBody);
    const res = await request(app)
      .put('/tenant-keys/ibm/opus')
      .set(AUTH)
      .send({ ...validBody, apiKey: 'sk-ant-rotated-key-456' });
    expect(res.status).toBe(200);
    const stored = await store.findByTenantAlias('ibm', 'opus');
    expect(stored?.apiKey).toBe('sk-ant-rotated-key-456');
  });

  it('returns 400 for a missing apiKey', async () => {
    const res = await request(app)
      .put('/tenant-keys/ibm/opus')
      .set(AUTH)
      .send({ provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for an invalid tenant name', async () => {
    const res = await request(app).put('/tenant-keys/IBM!/opus').set(AUTH).send(validBody);
    expect(res.status).toBe(400);
  });
});

describe('GET /tenant-keys/:tenant/:alias', () => {
  it('returns meta without the key material', async () => {
    await request(app).put('/tenant-keys/ibm/opus').set(AUTH).send(validBody);
    const res = await request(app).get('/tenant-keys/ibm/opus').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('claude-opus-4-8');
    expect(res.body.apiKey).toBeUndefined();
  });

  it('returns 404 for an unknown tenant/alias', async () => {
    const res = await request(app).get('/tenant-keys/nobody/none').set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('GET /tenant-keys (pagination)', () => {
  beforeEach(async () => {
    const tenants = ['t1', 't2', 't3', 't4', 't5'];
    await Promise.all(
      tenants.map((t) => request(app).put(`/tenant-keys/${t}/opus`).set(AUTH).send(validBody)),
    );
  });

  it('returns paginated results with correct shape', async () => {
    const res = await request(app).get('/tenant-keys').set(AUTH).query({ page: 1, limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(3);
  });

  it('second page returns remaining items', async () => {
    const res = await request(app).get('/tenant-keys').set(AUTH).query({ page: 2, limit: 3 });
    expect(res.body.data).toHaveLength(2);
  });

  it('returns 400 for invalid pagination params', async () => {
    const res = await request(app).get('/tenant-keys').set(AUTH).query({ page: 0 });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /tenant-keys/:tenant/:alias', () => {
  it('deletes and returns 204', async () => {
    await request(app).put('/tenant-keys/ibm/opus').set(AUTH).send(validBody);
    const res = await request(app).delete('/tenant-keys/ibm/opus').set(AUTH);
    expect(res.status).toBe(204);
    expect(await store.findByTenantAlias('ibm', 'opus')).toBeUndefined();
  });

  it('returns 404 when nothing to delete', async () => {
    const res = await request(app).delete('/tenant-keys/ibm/opus').set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('config generation and apply', () => {
  it('preview merges base config with tenant entries', async () => {
    await request(app).put('/tenant-keys/ibm/opus').set(AUTH).send(validBody);
    const res = await request(app).get('/config/preview').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers['x-tenant-models']).toBe('1');
    expect(res.text).toContain('model_name: claude-sonnet');
    expect(res.text).toContain('model_name: ibm-opus');
    expect(res.text).toContain('anthropic/claude-opus-4-8');
    expect(res.text).toContain('sk-ant-test-key-123');
  });

  it('apply writes the runtime config and triggers a reload', async () => {
    await request(app).put('/tenant-keys/ibm/opus').set(AUTH).send(validBody);
    const res = await request(app).post('/config/apply').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.tenantModels).toBe(1);
    expect(res.body.reloaded).toBe(true);
    expect(reloadCalls).toBe(1);
    const written = fs.readFileSync(path.join(tmpDir, 'runtime', 'config.yaml'), 'utf8');
    expect(written).toContain('ibm-opus');
    expect(written).toContain('master_key: os.environ/LITELLM_MASTER_KEY');
  });

  it('bedrock entries carry the region', async () => {
    await request(app).put('/tenant-keys/acme/sonnet').set(AUTH).send({
      provider: 'bedrock',
      model: 'eu.anthropic.claude-sonnet-4-6',
      apiKey: 'ak-secret-1',
      region: 'eu-north-1',
    });
    const res = await request(app).get('/config/preview').set(AUTH);
    expect(res.text).toContain('aws_region_name: eu-north-1');
  });
});
