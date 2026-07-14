import { describe, expect, it, vi } from 'vitest';
import { createLiteLLMAdminClient, LiteLLMAdminClientError } from '../clients/litellm.client';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LiteLLM admin client', () => {
  it('maps LiteLLM missing-model 400 to undefined', async () => {
    const fetchImpl = vi.fn(async () => response(400, { error: 'model not found' }));
    const client = createLiteLLMAdminClient({
      baseUrl: 'http://litellm:4000',
      masterKey: 'sk-test',
      fetchImpl,
    });
    await expect(client.getModel('missing')).resolves.toBeUndefined();
  });

  it('does not treat other 400 responses as missing models', async () => {
    const fetchImpl = vi.fn(async () => response(400, { error: 'invalid master key' }));
    const client = createLiteLLMAdminClient({
      baseUrl: 'http://litellm:4000',
      masterKey: 'sk-test',
      fetchImpl,
    });
    await expect(client.getModel('missing')).rejects.toBeInstanceOf(LiteLLMAdminClientError);
  });

  it('does not hide server failures while looking up a model', async () => {
    const fetchImpl = vi.fn(async () => response(500, { error: 'database unavailable' }));
    const client = createLiteLLMAdminClient({
      baseUrl: 'http://litellm:4000',
      masterKey: 'sk-test',
      fetchImpl,
    });
    await expect(client.getModel('missing')).rejects.toBeInstanceOf(LiteLLMAdminClientError);
  });

  it('sends explicit model scopes and aliases to key generation', async () => {
    const fetchImpl = vi.fn(async () => response(200, { key: 'sk-generated' }));
    const client = createLiteLLMAdminClient({
      baseUrl: 'http://litellm:4000/',
      masterKey: 'sk-master',
      fetchImpl,
    });
    const key = await client.generateKey({
      key_alias: 'aionas-codex-test',
      models: ['claude-opus', 'aionas-byok-1'],
      aliases: { 'claude-opus': 'aionas-byok-1' },
      user_id: 'aionas-user',
      duration: '90d',
      metadata: { aionas_managed: true },
      key_type: 'llm_api',
    });
    expect(key.key).toBe('sk-generated');
    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(options?.body))).toMatchObject({
      models: ['claude-opus', 'aionas-byok-1'],
      aliases: { 'claude-opus': 'aionas-byok-1' },
      key_type: 'llm_api',
    });
  });
});
