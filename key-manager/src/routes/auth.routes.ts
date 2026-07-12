import { RequestHandler, Router } from 'express';
import { AuthController } from '../controllers/auth.controller';

export function createAuthRouter(controller: AuthController, requireAuth: RequestHandler): Router {
  const router = Router();
  router.post('/login', controller.login);
  router.post('/logout', controller.logout);
  router.get('/me', requireAuth, controller.me);
  return router;
}
