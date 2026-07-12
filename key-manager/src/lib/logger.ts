import pino from 'pino';

export function createLogger(): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: ['apiKey', '*.apiKey', 'err.apiKey'], censor: '[redacted]' },
  });
}

export type Logger = pino.Logger;
