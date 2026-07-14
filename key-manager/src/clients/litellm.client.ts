export interface LiteLLMModelRecord {
  model_id?: string;
  model_name: string;
  litellm_params?: Record<string, unknown>;
  model_info?: Record<string, unknown>;
}

export interface LiteLLMModelInput {
  model_name: string;
  litellm_params: Record<string, unknown>;
  model_info: Record<string, unknown>;
}

export interface LiteLLMVirtualKeyInput {
  key_alias: string;
  models: string[];
  aliases: Record<string, string>;
  user_id: string;
  duration: string;
  max_budget?: number;
  metadata: Record<string, unknown>;
  key_type: 'llm_api';
}

export interface LiteLLMVirtualKeyRecord {
  key: string;
  key_alias?: string;
  token_id?: string;
  expires?: string;
}

export interface LiteLLMAdminClient {
  getModel(modelId: string): Promise<LiteLLMModelRecord | undefined>;
  listModels(): Promise<LiteLLMModelRecord[]>;
  createModel(input: LiteLLMModelInput): Promise<LiteLLMModelRecord>;
  updateModel(modelId: string, input: Partial<LiteLLMModelInput>): Promise<LiteLLMModelRecord>;
  deleteModel(modelId: string): Promise<void>;
  generateKey(input: LiteLLMVirtualKeyInput): Promise<LiteLLMVirtualKeyRecord>;
  deleteKeys(keys: string[]): Promise<void>;
}

export class LiteLLMAdminClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body = '',
  ) {
    super(message);
    this.name = 'LiteLLMAdminClientError';
  }
}

export interface LiteLLMAdminClientOptions {
  baseUrl: string;
  masterKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function responseData(value: unknown): LiteLLMModelRecord[] {
  if (Array.isArray(value)) return value as LiteLLMModelRecord[];
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: LiteLLMModelRecord[] }).data;
  }
  return [];
}

function recordId(record: LiteLLMModelRecord): string | undefined {
  const modelInfoId = record.model_info?.id;
  return record.model_id ?? (typeof modelInfoId === 'string' ? modelInfoId : undefined);
}

export function createLiteLLMAdminClient(opts: LiteLLMAdminClientOptions): LiteLLMAdminClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.masterKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new LiteLLMAdminClientError(
          `LiteLLM ${method} ${path} failed`,
          response.status,
          errorBody.slice(0, 2048),
        );
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof LiteLLMAdminClientError) throw err;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'LiteLLM request timed out'
          : 'LiteLLM request failed';
      throw new LiteLLMAdminClientError(message, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function queryModels(modelId?: string): Promise<LiteLLMModelRecord[]> {
    const query = modelId ? `?litellm_model_id=${encodeURIComponent(modelId)}` : '';
    return responseData(await request<unknown>('GET', `/model/info${query}`));
  }

  return {
    async getModel(modelId) {
      try {
        const records = await queryModels(modelId);
        return records.find((record) => recordId(record) === modelId);
      } catch (err) {
        // LiteLLM reports an unknown model id as 404, or on some versions as
        // a 400 whose body says "not found". Any other 400 is a real error.
        if (err instanceof LiteLLMAdminClientError) {
          if (err.status === 404) return undefined;
          if (err.status === 400 && /not found/i.test(err.body)) return undefined;
        }
        throw err;
      }
    },

    async listModels() {
      return queryModels();
    },

    async createModel(input) {
      return request<LiteLLMModelRecord>('POST', '/model/new', input);
    },

    async updateModel(modelId, input) {
      return request<LiteLLMModelRecord>(
        'PATCH',
        `/model/${encodeURIComponent(modelId)}/update`,
        input,
      );
    },

    async deleteModel(modelId) {
      await request('POST', '/model/delete', { id: modelId });
    },

    async generateKey(input) {
      return request<LiteLLMVirtualKeyRecord>('POST', '/key/generate', input);
    },

    async deleteKeys(keys) {
      if (keys.length > 0) await request('POST', '/key/delete', { keys });
    },
  };
}
