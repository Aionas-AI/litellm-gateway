import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../lib/errors';
import { SessionSigner } from '../lib/session';
import { digestEquals, sha256, SESSION_COOKIE } from '../middleware/auth';
import { loginSchema } from '../schemas/login.schema';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export interface AuthControllerOptions {
  username: string;
  password: string;
  sessions: SessionSigner;
}

export function createAuthController(opts: AuthControllerOptions) {
  const expectedUser = sha256(opts.username);
  const expectedPass = sha256(opts.password);

  return {
    login(req: Request, res: Response, next: NextFunction): void {
      try {
        const { username, password } = loginSchema.parse(req.body);
        const userOk = digestEquals(expectedUser, username);
        const passOk = digestEquals(expectedPass, password);
        if (!userOk || !passOk) throw new UnauthorizedError('Invalid username or password');
        const token = opts.sessions.issue(SESSION_TTL_MS);
        res
          .cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: req.secure || req.header('x-forwarded-proto') === 'https',
            sameSite: 'strict',
            path: '/',
            maxAge: SESSION_TTL_MS,
          })
          .status(200)
          .json({ status: 'ok' });
      } catch (err) {
        next(err);
      }
    },

    logout(_req: Request, res: Response, next: NextFunction): void {
      try {
        res.clearCookie(SESSION_COOKIE, { path: '/' }).status(200).json({ status: 'ok' });
      } catch (err) {
        next(err);
      }
    },

    me(_req: Request, res: Response, next: NextFunction): void {
      try {
        res.status(200).json({ status: 'ok' });
      } catch (err) {
        next(err);
      }
    },
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
