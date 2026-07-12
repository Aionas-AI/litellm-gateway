import { RequestHandler, Router } from 'express';
import { EnrollmentController } from '../controllers/enrollment.controller';

export function createEnrollmentRouter(
  controller: EnrollmentController,
  enrollmentAuth: RequestHandler,
): Router {
  const router = Router();
  router.post('/', enrollmentAuth, controller.enroll);
  return router;
}

export function createEnrollmentAdminRouter(controller: EnrollmentController): Router {
  const router = Router();
  router.post('/tokens', controller.issueToken);
  router.post('/', controller.adminEnroll);
  router.get('/models', controller.list);
  router.delete('/models/:modelId', controller.remove);
  return router;
}
