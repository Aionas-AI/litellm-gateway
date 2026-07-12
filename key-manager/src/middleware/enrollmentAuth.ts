import { NextFunction, Request, Response } from 'express';
import { EnrollmentTokenSigner } from '../lib/enrollmentToken';
import { UnauthorizedError } from '../lib/errors';

export function createEnrollmentAuthMiddleware(signer: EnrollmentTokenSigner) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const authorization = req.header('authorization');
      if (!authorization?.startsWith('Bearer ')) {
        throw new UnauthorizedError('Enrollment token required');
      }
      res.locals.enrollmentPrincipal = signer.verify(authorization.slice('Bearer '.length));
      next();
    } catch (err) {
      next(err);
    }
  };
}
