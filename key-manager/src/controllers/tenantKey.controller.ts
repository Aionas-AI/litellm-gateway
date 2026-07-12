import { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../lib/errors';
import { paginationSchema } from '../schemas/pagination.schema';
import { tenantModelParamsSchema, upsertKeySchema } from '../schemas/tenantKey.schema';
import { TenantKeyService } from '../services/tenantKey.service';

export function createTenantKeyController(svc: TenantKeyService) {
  return {
    async upsert(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { tenant, alias } = tenantModelParamsSchema.parse(req.params);
        const input = upsertKeySchema.parse(req.body);
        const result = await svc.upsert(tenant, alias, input);
        res.status(result.created ? 201 : 200).json(result.meta);
      } catch (err) {
        next(err);
      }
    },

    async getMeta(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { tenant, alias } = tenantModelParamsSchema.parse(req.params);
        const meta = await svc.getMeta(tenant, alias);
        if (!meta) throw new NotFoundError(`No key for ${tenant}/${alias}`);
        res.status(200).json(meta);
      } catch (err) {
        next(err);
      }
    },

    async list(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { page, limit } = paginationSchema.parse(req.query);
        const result = await svc.list(page, limit);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },

    async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { tenant, alias } = tenantModelParamsSchema.parse(req.params);
        const deleted = await svc.delete(tenant, alias);
        if (!deleted) throw new NotFoundError(`No key for ${tenant}/${alias}`);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  };
}

export type TenantKeyController = ReturnType<typeof createTenantKeyController>;
