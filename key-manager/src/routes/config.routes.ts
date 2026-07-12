import { Router } from 'express';
import { ConfigController } from '../controllers/config.controller';

export function createConfigRouter(controller: ConfigController): Router {
  const router = Router();
  router.get('/preview', controller.preview);
  router.post('/apply', controller.apply);
  return router;
}
