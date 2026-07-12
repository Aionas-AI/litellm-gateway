import { NextFunction, Request, Response } from 'express';
import { ConfigService } from '../services/config.service';

export function createConfigController(svc: ConfigService) {
  return {
    async preview(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { content, tenantModels } = await svc.generate();
        res
          .status(200)
          .type('text/yaml')
          .set('X-Tenant-Models', String(tenantModels))
          .send(content);
      } catch (err) {
        next(err);
      }
    },

    async apply(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const result = await svc.apply();
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}

export type ConfigController = ReturnType<typeof createConfigController>;
