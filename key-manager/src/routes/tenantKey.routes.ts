import { Router } from 'express';
import { TenantKeyController } from '../controllers/tenantKey.controller';

export function createTenantKeyRouter(controller: TenantKeyController): Router {
  const router = Router();
  router.get('/', controller.list);
  router.put('/:tenant/:alias', controller.upsert);
  router.get('/:tenant/:alias', controller.getMeta);
  router.delete('/:tenant/:alias', controller.remove);
  return router;
}
