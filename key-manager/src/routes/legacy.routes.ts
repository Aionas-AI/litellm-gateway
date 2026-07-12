import { Router } from 'express';

export function createLegacyTenantKeyRouter(): Router {
  const router = Router();
  router.use((_req, res) => {
    res.setHeader('Deprecation', 'true');
    res.status(410).json({
      error:
        'The static tenant-key API was removed. Use POST /enrollments; models become live immediately.',
    });
  });
  return router;
}

export function createLegacyConfigRouter(): Router {
  const router = Router();
  router.get('/preview', (_req, res) => {
    res.setHeader('Deprecation', 'true');
    res.status(410).json({
      error: 'Config preview was removed because provider credentials are stored in LiteLLM DB.',
    });
  });
  router.post('/apply', (_req, res) => {
    res.setHeader('Deprecation', 'true');
    res.status(200).json({
      dynamic: true,
      reloaded: false,
      message: 'No apply or restart is required. Database-backed models are live immediately.',
    });
  });
  return router;
}
