import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionSigner {
  issue(ttlMs: number): string;
  verify(token: string): boolean;
}

/** Stateless HMAC-signed session tokens: `<expiryMillis>.<signature>`. */
export function createSessionSigner(secret: string): SessionSigner {
  const sign = (payload: string) =>
    createHmac('sha256', secret).update(payload).digest('base64url');

  return {
    issue(ttlMs) {
      const exp = String(Date.now() + ttlMs);
      return `${exp}.${sign(exp)}`;
    },
    verify(token) {
      const dot = token.lastIndexOf('.');
      if (dot <= 0) return false;
      const exp = token.slice(0, dot);
      const sig = Buffer.from(token.slice(dot + 1));
      const expected = Buffer.from(sign(exp));
      if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
      return Number(exp) > Date.now();
    },
  };
}
