import { z } from 'zod';
import { supportedClients } from '../types';

const identityToken = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@-]+$/, 'contains unsupported characters');

const nameToken = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must start alphanumeric and use lowercase safe characters');

const MAX_DURATION_MINUTES = 365 * 24 * 60;
const MINUTES_PER_UNIT: Record<string, number> = { m: 1, h: 60, d: 24 * 60 };

const duration = z
  .string()
  .regex(/^\d+[mhd]$/, 'must be a LiteLLM duration such as 30d')
  .refine((value) => {
    const amount = Number(value.slice(0, -1));
    const minutes = amount * MINUTES_PER_UNIT[value.slice(-1)];
    return minutes >= 1 && minutes <= MAX_DURATION_MINUTES;
  }, 'must be between 1m and 365d');

export const enrollmentTokenRequestSchema = z.object({
  tenantId: identityToken,
  userId: identityToken,
  expiresInMinutes: z.coerce.number().int().min(1).max(60).default(15),
});

export const enrollmentClientSchema = z.object({
  clientId: z.enum(supportedClients),
  duration: duration.optional().default('90d'),
  maxBudget: z.number().positive().max(1_000_000).optional(),
});

export const enrollmentRequestSchema = z
  .object({
    credentialId: nameToken,
    provider: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'must be a LiteLLM provider prefix'),
    model: z.string().min(1).max(240),
    modelAlias: nameToken,
    apiKey: z.string().min(8).max(4096),
    apiBase: z.string().url().optional(),
    region: z.string().min(1).max(64).optional(),
    deviceId: nameToken,
    clients: z.array(enrollmentClientSchema).min(1).max(8),
  })
  .superRefine((input, ctx) => {
    const uniqueClients = new Set(input.clients.map((client) => client.clientId));
    if (uniqueClients.size !== input.clients.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clients'],
        message: 'clientId values must be unique',
      });
    }
  });

export const adminEnrollmentRequestSchema = z.object({
  tenantId: identityToken,
  userId: identityToken,
  enrollment: enrollmentRequestSchema,
});

export const managedModelParamsSchema = z.object({
  modelId: z.string().min(1).max(128),
});

export type EnrollmentTokenRequest = z.infer<typeof enrollmentTokenRequestSchema>;
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;
export type AdminEnrollmentRequest = z.infer<typeof adminEnrollmentRequestSchema>;
