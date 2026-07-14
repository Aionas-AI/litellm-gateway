import { NextFunction, Request, Response } from 'express';
import { EnrollmentTokenSigner } from '../lib/enrollmentToken';
import {
  adminEnrollmentRequestSchema,
  enrollmentRequestSchema,
  enrollmentTokenRequestSchema,
  managedModelParamsSchema,
} from '../schemas/enrollment.schema';
import { EnrollmentService } from '../services/enrollment.service';
import { EnrollmentPrincipal } from '../types';

interface EnrollmentControllerOptions {
  service: EnrollmentService;
  signer: EnrollmentTokenSigner;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

export function createEnrollmentController(opts: EnrollmentControllerOptions) {
  return {
    issueToken(req: Request, res: Response, next: NextFunction): void {
      try {
        const input = enrollmentTokenRequestSchema.parse(req.body);
        const issued = opts.signer.issue(
          input.tenantId,
          input.userId,
          input.expiresInMinutes * 60_000,
        );
        noStore(res);
        res
          .status(201)
          .json({ token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() });
      } catch (err) {
        next(err);
      }
    },

    async enroll(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const principal = res.locals.enrollmentPrincipal as EnrollmentPrincipal;
        const input = enrollmentRequestSchema.parse(req.body);
        const result = await opts.service.provision(principal, input);
        noStore(res);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },

    async adminEnroll(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const input = adminEnrollmentRequestSchema.parse(req.body);
        const principal: EnrollmentPrincipal = {
          tenantId: input.tenantId,
          userId: input.userId,
          tokenId: 'admin-session',
          expiresAt: Date.now() + 60_000,
        };
        const result = await opts.service.provision(principal, input.enrollment);
        noStore(res);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },

    async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        res.status(200).json({ data: await opts.service.listManagedModels() });
      } catch (err) {
        next(err);
      }
    },

    async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { modelId } = managedModelParamsSchema.parse(req.params);
        await opts.service.deleteManagedModel(modelId);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  };
}

export type EnrollmentController = ReturnType<typeof createEnrollmentController>;
