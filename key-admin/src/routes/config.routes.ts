import { Router } from 'express';
import { ConfigController } from '../controllers/config.controller.js';

export function createConfigRouter(controller: ConfigController): Router {
  const router = Router();
  router.post('/generate', controller.generate);
  router.post('/apply', controller.apply);
  return router;
}
