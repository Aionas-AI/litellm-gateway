import { Router } from 'express';
import { TenantKeyController } from '../controllers/tenantKey.controller.js';

export function createTenantKeyRouter(controller: TenantKeyController): Router {
  const router = Router();
  router.put('/:tenant/models/:model/key', controller.upsert);
  router.get('/', controller.list);
  router.delete('/:tenant/models/:model/key', controller.remove);
  return router;
}
