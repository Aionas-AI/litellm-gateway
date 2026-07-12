import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Logger } from './logger';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export function createErrorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.flatten() });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  };
}
