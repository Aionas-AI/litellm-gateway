import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from './errors';
import { EnrollmentPrincipal } from '../types';

interface EnrollmentTokenPayload {
  v: 1;
  tid: string;
  uid: string;
  jti: string;
  exp: number;
}

export interface EnrollmentTokenSigner {
  issue(tenantId: string, userId: string, ttlMs: number): { token: string; expiresAt: number };
  verify(token: string): EnrollmentPrincipal;
  /** Burn a token after a successful enrollment so it cannot be replayed. */
  markUsed(tokenId: string, expiresAt: number): void;
}

const TOKEN_PREFIX = 'aionas_enroll_';

function encode(payload: EnrollmentTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decode(value: string): EnrollmentTokenPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<EnrollmentTokenPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.tid !== 'string' ||
      typeof parsed.uid !== 'string' ||
      typeof parsed.jti !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      throw new Error('invalid token payload');
    }
    return parsed as EnrollmentTokenPayload;
  } catch {
    throw new UnauthorizedError('Invalid enrollment token');
  }
}

export function createEnrollmentTokenSigner(secret: string): EnrollmentTokenSigner {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Enrollment signing key must be at least 32 bytes');
  }
  const sign = (payload: string) =>
    createHmac('sha256', secret).update(payload).digest('base64url');

  // One-time-use registry: jti -> token expiry. Entries prune themselves once
  // the token would be rejected as expired anyway, so the map stays bounded.
  const usedTokenIds = new Map<string, number>();

  function pruneUsed(now: number): void {
    usedTokenIds.forEach((exp, jti) => {
      if (exp <= now) usedTokenIds.delete(jti);
    });
  }

  return {
    issue(tenantId, userId, ttlMs) {
      const expiresAt = Date.now() + ttlMs;
      const payload = encode({
        v: 1,
        tid: tenantId,
        uid: userId,
        jti: randomUUID(),
        exp: expiresAt,
      });
      return { token: `${TOKEN_PREFIX}${payload}.${sign(payload)}`, expiresAt };
    },

    verify(token) {
      if (!token.startsWith(TOKEN_PREFIX)) throw new UnauthorizedError('Invalid enrollment token');
      const encodedToken = token.slice(TOKEN_PREFIX.length);
      const dot = encodedToken.lastIndexOf('.');
      if (dot <= 0) throw new UnauthorizedError('Invalid enrollment token');
      const payloadText = encodedToken.slice(0, dot);
      const actual = Buffer.from(encodedToken.slice(dot + 1));
      const expected = Buffer.from(sign(payloadText));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new UnauthorizedError('Invalid enrollment token');
      }
      const payload = decode(payloadText);
      const now = Date.now();
      if (payload.exp <= now) throw new UnauthorizedError('Enrollment token expired');
      pruneUsed(now);
      if (usedTokenIds.has(payload.jti)) {
        throw new UnauthorizedError('Enrollment token already used');
      }
      return {
        tenantId: payload.tid,
        userId: payload.uid,
        tokenId: payload.jti,
        expiresAt: payload.exp,
      };
    },

    markUsed(tokenId, expiresAt) {
      pruneUsed(Date.now());
      usedTokenIds.set(tokenId, expiresAt);
    },
  };
}
