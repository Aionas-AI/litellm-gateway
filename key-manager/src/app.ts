import express from 'express';
import { LiteLLMAdminClient, createLiteLLMAdminClient } from './clients/litellm.client';
import { createAuthController } from './controllers/auth.controller';
import { createEnrollmentController } from './controllers/enrollment.controller';
import { createEnrollmentTokenSigner, EnrollmentTokenSigner } from './lib/enrollmentToken';
import { createErrorHandler } from './lib/errors';
import { createLogger, Logger } from './lib/logger';
import { createSessionSigner } from './lib/session';
import { createAuthMiddleware } from './middleware/auth';
import { createEnrollmentAuthMiddleware } from './middleware/enrollmentAuth';
import { createAuthRouter } from './routes/auth.routes';
import { createEnrollmentAdminRouter, createEnrollmentRouter } from './routes/enrollment.routes';
import { createLegacyConfigRouter, createLegacyTenantKeyRouter } from './routes/legacy.routes';
import { createEnrollmentService } from './services/enrollment.service';

export interface AppDeps {
  litellmClient?: LiteLLMAdminClient;
  enrollmentSigner?: EnrollmentTokenSigner;
  logger?: Logger;
  adminToken?: string;
  loginUser?: string;
  loginPassword?: string;
  gatewayBaseUrl?: string;
  allowedCustomApiBaseHosts?: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function createApp(deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger();
  const adminToken = deps.adminToken ?? requireEnv('KEY_MANAGER_ADMIN_TOKEN');
  const loginUser = deps.loginUser ?? requireEnv('KEYADMIN_USER');
  const loginPassword = deps.loginPassword ?? requireEnv('KEYADMIN_PASSWORD');
  const gatewayBaseUrl = deps.gatewayBaseUrl ?? requireEnv('PUBLIC_GATEWAY_URL');
  const signer =
    deps.enrollmentSigner ??
    createEnrollmentTokenSigner(requireEnv('KEY_MANAGER_ENROLLMENT_SIGNING_KEY'));
  const litellmClient =
    deps.litellmClient ??
    createLiteLLMAdminClient({
      baseUrl: process.env.LITELLM_INTERNAL_URL ?? 'http://litellm:4000',
      masterKey: requireEnv('LITELLM_MASTER_KEY'),
      timeoutMs: Number(process.env.LITELLM_ADMIN_TIMEOUT_MS ?? 10_000),
    });

  const enrollmentService = createEnrollmentService({
    client: litellmClient,
    gatewayBaseUrl,
    allowedCustomApiBaseHosts:
      deps.allowedCustomApiBaseHosts ?? csvEnv('ALLOWED_CUSTOM_API_BASE_HOSTS'),
  });
  const enrollmentController = createEnrollmentController({ service: enrollmentService, signer });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', provisioning: 'dynamic' });
  });

  const sessions = createSessionSigner(`${adminToken}:session`);
  const adminAuth = createAuthMiddleware(adminToken, sessions);
  const enrollmentAuth = createEnrollmentAuthMiddleware(signer);

  app.use(
    '/auth',
    createAuthRouter(
      createAuthController({ username: loginUser, password: loginPassword, sessions }),
      adminAuth,
    ),
  );
  app.use('/enrollments', createEnrollmentRouter(enrollmentController, enrollmentAuth));
  app.use('/admin/enrollments', adminAuth, createEnrollmentAdminRouter(enrollmentController));

  // Explicit compatibility responses keep old automation from restarting the proxy.
  app.use('/tenant-keys', adminAuth, createLegacyTenantKeyRouter());
  app.use('/config', adminAuth, createLegacyConfigRouter());

  app.use(createErrorHandler(logger));
  return app;
}
