import { NextFunction, Request, Response } from 'express';
import { paginationSchema } from '../schemas/pagination.schema.js';
import {
  listKeysQuerySchema,
  tenantKeyParamsSchema,
  upsertTenantKeySchema,
} from '../schemas/tenantKey.schema.js';
import { TenantKeyService } from '../services/tenantKey.service.js';

export function createTenantKeyController(svc: TenantKeyService) {
  return {
    async upsert(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { tenant, model } = tenantKeyParamsSchema.parse(req.params);
        const body = upsertTenantKeySchema.parse(req.body);
        const result = await svc.upsert({
          tenant,
          modelAlias: model,
          litellmModel: body.litellmModel,
          apiKey: body.apiKey,
        });
        res.status(result.created ? 201 : 200).json(result.entry);
      } catch (err) {
        next(err);
      }
    },

    async list(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { page, limit } = paginationSchema.parse(req.query);
        const { tenant } = listKeysQuerySchema.parse(req.query);
        const result = await svc.list(page, limit, tenant);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },

    async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { tenant, model } = tenantKeyParamsSchema.parse(req.params);
        await svc.remove(tenant, model);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  };
}

export type TenantKeyController = ReturnType<typeof createTenantKeyController>;
