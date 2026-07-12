import { timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from './errors.js';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Bearer-token auth for every admin endpoint. The token is a single shared
 * admin credential (set via KEY_ADMIN_TOKEN) compared in constant time.
 */
export function createAuthMiddleware(adminToken: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token || !safeEqual(token, adminToken)) {
      next(new UnauthorizedError('Missing or invalid admin token'));
      return;
    }
    next();
  };
}
