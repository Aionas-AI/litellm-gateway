import { z } from 'zod';

/** Lowercase slug: starts alphanumeric, then alphanumerics/hyphens, max 40 chars. */
const slug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,39}$/,
    'must be a lowercase slug (letters, digits, hyphens; max 40 chars)',
  );

export const tenantKeyParamsSchema = z.object({
  tenant: slug,
  model: slug,
});

export const upsertTenantKeySchema = z.object({
  litellmModel: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w./:-]+$/, 'must be a LiteLLM model id, e.g. anthropic/claude-opus-4-8'),
  apiKey: z.string().min(8).max(4096),
});

export const listKeysQuerySchema = z.object({
  tenant: slug.optional(),
});

export type UpsertTenantKeyBody = z.infer<typeof upsertTenantKeySchema>;
