import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { parse } from 'yaml';
import { createApp } from '../app.js';
import { ConfigStore } from '../dal/config.store.js';
import { createInMemoryTenantKeyStore } from '../dal/tenantKey.store.memory.js';
import { LitellmReloader } from '../lib/reloader.js';

const ADMIN_TOKEN = 'test-admin-token';
const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

const BASE_YAML = `model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/eu.anthropic.claude-sonnet-4-6
      aws_region_name: eu-north-1
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
`;

interface ParsedConfig {
  model_list: { model_name: string; litellm_params: Record<string, string> }[];
  general_settings: Record<string, unknown>;
}

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

async function seedKey(tenant: string, model: string, litellmModel: string) {
  await request(app)
    .put(`/tenants/${tenant}/models/${model}/key`)
    .set(auth)
    .send({ litellmModel, apiKey: 'sk-test-key-12345678' });
}

describe('POST /config/generate', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/config/generate');
    expect(res.status).toBe(401);
  });

  it('merges base models with tenant models referencing secrets', async () => {
    await seedKey('ibm', 'claude-opus', 'anthropic/claude-opus-4-8');
    await seedKey('acme', 'gpt', 'openai/gpt-5');

    const res = await request(app).post('/config/generate').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.tenantModels).toEqual(['acme-gpt', 'ibm-claude-opus']);

    const config = parse(res.body.yaml) as ParsedConfig;
    const names = config.model_list.map((m) => m.model_name);
    expect(names).toEqual(['claude-sonnet', 'acme-gpt', 'ibm-claude-opus']);

    const ibm = config.model_list.find((m) => m.model_name === 'ibm-claude-opus');
    expect(ibm?.litellm_params['model']).toBe('anthropic/claude-opus-4-8');
    expect(ibm?.litellm_params['api_key']).toBe('os.environ/litellm_tenant_ibm_claude-opus');
  });

  it('never embeds the raw provider key in the yaml', async () => {
    await seedKey('ibm', 'claude-opus', 'anthropic/claude-opus-4-8');
    const res = await request(app).post('/config/generate').set(auth);
    expect(res.body.yaml).not.toContain('sk-test-key');
  });

  it('wires the AWS secret manager settings when tenant keys exist', async () => {
    await seedKey('ibm', 'claude-opus', 'anthropic/claude-opus-4-8');
    const res = await request(app).post('/config/generate').set(auth);

    const config = parse(res.body.yaml) as ParsedConfig;
    expect(config.general_settings['key_management_system']).toBe('aws_secret_manager');
    expect(config.general_settings['key_management_settings']).toEqual({
      access_mode: 'read_only',
      aws_region_name: 'eu-north-1',
      hosted_keys: ['litellm_tenant_ibm_claude-opus'],
    });
    expect(config.general_settings['master_key']).toBe('os.environ/LITELLM_MASTER_KEY');
  });

  it('leaves the base config untouched when no tenant keys exist', async () => {
    const res = await request(app).post('/config/generate').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.tenantModels).toEqual([]);

    const config = parse(res.body.yaml) as ParsedConfig;
    expect(config.model_list.map((m) => m.model_name)).toEqual(['claude-sonnet']);
    expect(config.general_settings['key_management_system']).toBeUndefined();
  });

  it('does not write or reload anything', async () => {
    await request(app).post('/config/generate').set(auth);
    expect(configStore.written).toHaveLength(0);
    expect(reloader.reloads).toHaveLength(0);
  });
});

describe('POST /config/apply', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/config/apply');
    expect(res.status).toBe(401);
  });

  it('writes the generated config and restarts litellm', async () => {
    await seedKey('ibm', 'claude-opus', 'anthropic/claude-opus-4-8');

    const res = await request(app).post('/config/apply').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.tenantModels).toEqual(['ibm-claude-opus']);
    expect(res.body.configPath).toBe('/gateway/config.yaml');

    expect(configStore.written).toHaveLength(1);
    expect(configStore.written[0]).toContain('GENERATED FILE - DO NOT EDIT');
    expect(configStore.written[0]).toContain('ibm-claude-opus');
    expect(reloader.reloads).toHaveLength(1);
  });

  it('returns 500 and does not restart when the config write fails', async () => {
    configStore.writeGenerated = async () => {
      throw new Error('disk full');
    };
    const res = await request(app).post('/config/apply').set(auth);
    expect(res.status).toBe(500);
    expect(reloader.reloads).toHaveLength(0);
  });
});
