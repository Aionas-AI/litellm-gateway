import { NextFunction, Request, Response } from 'express';
import { ConfigService } from '../services/config.service.js';

export function createConfigController(svc: ConfigService) {
  return {
    async generate(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const result = await svc.generate();
        res.status(200).json(result);
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
