import { pino } from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  // Provider keys must never end up in logs.
  redact: ['req.headers.authorization', 'apiKey', '*.apiKey'],
});
