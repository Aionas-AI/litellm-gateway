import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../lib/errors';
import { SessionSigner } from '../lib/session';

export const SESSION_COOKIE = 'km_session';

export function digestEquals(expected: Buffer, candidate: string): boolean {
  const actual = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.header('cookie');
  if (!header) return undefined;
  const match = header
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([k]) => k === name);
  return match ? match.slice(1).join('=') : undefined;
}

/**
 * Accepts either the admin bearer token (API/CLI clients) or a valid session
 * cookie issued by the login endpoint (browser UI). Token comparison is over
 * SHA-256 digests with timingSafeEqual so timing does not leak prefix matches.
 */
export function createAuthMiddleware(adminToken: string, sessions: SessionSigner) {
  const expected = sha256(adminToken);
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token && digestEquals(expected, token)) {
      next();
      return;
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie && sessions.verify(cookie)) {
      next();
      return;
    }
    next(new UnauthorizedError('Login or bearer token required'));
  };
}
