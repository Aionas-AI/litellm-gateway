import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../lib/errors';

/**
 * Bearer-token auth. Compares SHA-256 digests with timingSafeEqual so
 * comparison time does not leak how many prefix bytes matched.
 */
export function createAuthMiddleware(adminToken: string) {
  const expected = createHash('sha256').update(adminToken).digest();
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      next(new UnauthorizedError('Missing bearer token'));
      return;
    }
    const actual = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(expected, actual)) {
      next(new UnauthorizedError('Invalid token'));
      return;
    }
    next();
  };
}
