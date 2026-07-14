import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  LiteLLMAdminClient,
  LiteLLMModelInput,
  LiteLLMModelRecord,
  LiteLLMVirtualKeyInput,
} from '../clients/litellm.client';
import { createApp } from '../app';
import { createEnrollmentTokenSigner, EnrollmentTokenSigner } from '../lib/enrollmentToken';
import { createLogger } from '../lib/logger';

const ADMIN_TOKEN = 'test-admin-token';
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const LOGIN = { username: 'admin', password: 'correct-horse' };

class FakeLiteLLMClient implements LiteLLMAdminClient {
  readonly models = new Map<string, LiteLLMModelRecord>();

  readonly generatedKeys: LiteLLMVirtualKeyInput[] = [];

  readonly deletedKeys: string[][] = [];

  readonly deletedModels: string[] = [];

  failClientId?: string;

  async getModel(modelId: string) {
    return this.models.get(modelId);
  }

  async listModels() {
    return Array.from(this.models.values());
  }

  async createModel(input: LiteLLMModelInput) {
    const modelId = String(input.model_info.id);
    const record = { ...input, model_id: modelId };
    this.models.set(modelId, record);
    return record;
  }

  async updateModel(modelId: string, input: Partial<LiteLLMModelInput>) {
    const current = this.models.get(modelId);
    if (!current) throw new Error('missing model');
    const record = { ...current, ...input, model_id: modelId } as LiteLLMModelRecord;
    this.models.set(modelId, record);
    return record;
  }

  async deleteModel(modelId: string) {
    this.models.delete(modelId);
    this.deletedModels.push(modelId);
  }

  async generateKey(input: LiteLLMVirtualKeyInput) {
    const clientId = String(input.metadata.aionas_client_id);
    if (clientId === this.failClientId) throw new Error('key generation failed');
    this.generatedKeys.push(input);
    return { key: `sk-generated-${this.generatedKeys.length}`, key_alias: input.key_alias };
  }

  async deleteKeys(keys: string[]) {
    this.deletedKeys.push(keys);
  }
}

const enrollmentBody = {
  credentialId: 'personal-anthropic',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  modelAlias: 'claude-opus',
  apiKey: 'sk-ant-provider-secret',
  deviceId: 'macbook-pro',
  clients: [
    { clientId: 'claude-code', duration: '30d', maxBudget: 50 },
    { clientId: 'codex', duration: '30d' },
  ],
};

let fake: FakeLiteLLMClient;
let signer: EnrollmentTokenSigner;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  fake = new FakeLiteLLMClient();
  signer = createEnrollmentTokenSigner('test-enrollment-signing-key-32-bytes');
  app = createApp({
    litellmClient: fake,
    enrollmentSigner: signer,
    adminToken: ADMIN_TOKEN,
    loginUser: LOGIN.username,
    loginPassword: LOGIN.password,
    gatewayBaseUrl: 'https://gateway.example.com',
    logger: createLogger(),
  });
});

function tokenFor(tenantId = 'tenant-a', userId = 'user-1') {
  return signer.issue(tenantId, userId, 60_000).token;
}

describe('admin and enrollment authentication', () => {
  it('refuses a weak enrollment signing key', () => {
    expect(() => createEnrollmentTokenSigner('too-short')).toThrow(/at least 32 bytes/);
  });

  it('keeps healthz public and marks dynamic provisioning', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.provisioning).toBe('dynamic');
  });

  it('requires admin auth to mint a scoped enrollment token', async () => {
    expect(
      (await request(app).post('/admin/enrollments/tokens').send({ tenantId: 't', userId: 'u' }))
        .status,
    ).toBe(401);
    const res = await request(app)
      .post('/admin/enrollments/tokens')
      .set(AUTH)
      .send({ tenantId: 'tenant-a', userId: 'user-1', expiresInMinutes: 10 });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^aionas_enroll_/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects missing and tampered enrollment tokens', async () => {
    expect((await request(app).post('/enrollments').send(enrollmentBody)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/enrollments')
          .set('Authorization', `Bearer ${tokenFor()}tampered`)
          .send(enrollmentBody)
      ).status,
    ).toBe(401);
  });
});

describe('dynamic BYOK provisioning', () => {
  it('creates a DB model and one restricted virtual key per client without exposing the provider key', async () => {
    const res = await request(app)
      .post('/enrollments')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send(enrollmentBody);

    expect(res.status).toBe(201);
    expect(res.body.modelCreated).toBe(true);
    expect(res.body.modelAlias).toBe('claude-opus');
    expect(res.body.gatewayBaseUrl).toBe('https://gateway.example.com');
    expect(res.body.clients).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain(enrollmentBody.apiKey);
    expect(res.headers['cache-control']).toBe('no-store');

    expect(fake.generatedKeys).toHaveLength(2);
    fake.generatedKeys.forEach((key) => {
      const target = String(key.metadata.aionas_internal_model);
      expect(key.models).toEqual(['claude-opus', target]);
      expect(key.aliases).toEqual({ 'claude-opus': target });
      expect(key.models).not.toHaveLength(0);
      expect(key.key_type).toBe('llm_api');
      expect(key.metadata.aionas_tenant_id).toBe('tenant-a');
      expect(key.metadata.aionas_user_id).toBe('user-1');
    });
  });

  it('updates the deterministic model on provider-key rotation instead of creating a duplicate', async () => {
    const auth = { Authorization: `Bearer ${tokenFor()}` };
    const first = await request(app).post('/enrollments').set(auth).send(enrollmentBody);
    const second = await request(app)
      .post('/enrollments')
      .set(auth)
      .send({ ...enrollmentBody, apiKey: 'sk-ant-rotated-provider-secret' });

    expect(first.body.internalModelId).toBe(second.body.internalModelId);
    expect(second.body.modelCreated).toBe(false);
    expect(fake.models.size).toBe(1);
    const stored = fake.models.get(first.body.internalModelId);
    expect(stored?.litellm_params?.api_key).toBe('sk-ant-rotated-provider-secret');
  });

  it('isolates users that request the same public model alias', async () => {
    const userA = await request(app)
      .post('/enrollments')
      .set('Authorization', `Bearer ${tokenFor('tenant-a', 'user-a')}`)
      .send(enrollmentBody);
    const userB = await request(app)
      .post('/enrollments')
      .set('Authorization', `Bearer ${tokenFor('tenant-a', 'user-b')}`)
      .send(enrollmentBody);

    expect(userA.body.internalModelId).not.toBe(userB.body.internalModelId);
    const userATarget = fake.generatedKeys[0].aliases['claude-opus'];
    const userBTarget = fake.generatedKeys[2].aliases['claude-opus'];
    expect(userATarget).not.toBe(userBTarget);
    expect(fake.generatedKeys[0].models).not.toContain(userBTarget);
  });

  it('rolls back newly-created keys and model when any client key fails', async () => {
    fake.failClientId = 'codex';
    const res = await request(app)
      .post('/enrollments')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send(enrollmentBody);

    expect(res.status).toBe(502);
    expect(fake.deletedKeys).toEqual([['sk-generated-1']]);
    expect(fake.deletedModels).toHaveLength(1);
    expect(fake.models.size).toBe(0);
  });

  it('denies custom apiBase unless the hostname is allowlisted', async () => {
    const res = await request(app)
      .post('/enrollments')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ ...enrollmentBody, apiBase: 'https://localhost.example/v1' });
    expect(res.status).toBe(403);
  });
});

describe('admin inventory and migration compatibility', () => {
  it('lists and deletes only Aionas-managed models', async () => {
    await request(app)
      .post('/enrollments')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send(enrollmentBody);
    fake.models.set('unmanaged', {
      model_id: 'unmanaged',
      model_name: 'shared',
      model_info: { id: 'unmanaged' },
    });

    const list = await request(app).get('/admin/enrollments/models').set(AUTH);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].tenantId).toBe('tenant-a');

    const remove = await request(app)
      .delete(`/admin/enrollments/models/${list.body.data[0].modelId}`)
      .set(AUTH);
    expect(remove.status).toBe(204);
    expect(fake.models.has('unmanaged')).toBe(true);
  });

  it('never renders secrets in preview and turns apply into a no-restart no-op', async () => {
    const preview = await request(app).get('/config/preview').set(AUTH);
    expect(preview.status).toBe(410);
    expect(JSON.stringify(preview.body)).not.toContain(enrollmentBody.apiKey);

    const apply = await request(app).post('/config/apply').set(AUTH);
    expect(apply.status).toBe(200);
    expect(apply.body.reloaded).toBe(false);
    expect(apply.body.dynamic).toBe(true);
  });
});
