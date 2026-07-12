import { z } from 'zod';

const nameToken = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'must be lowercase alphanumeric with dashes, max 63 chars, starting alphanumeric',
  );

export const tenantModelParamsSchema = z.object({
  tenant: nameToken,
  alias: nameToken,
});

export const upsertKeySchema = z.object({
  provider: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'must be a LiteLLM provider prefix, e.g. openai, anthropic, gemini'),
  model: z.string().min(1).max(200),
  apiKey: z.string().min(8).max(4096),
  region: z.string().min(1).max(64).optional(),
  apiBase: z.string().url().optional(),
});

export type UpsertKeyInput = z.infer<typeof upsertKeySchema>;
