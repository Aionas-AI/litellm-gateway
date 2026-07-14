import pino from 'pino';

export function createLogger(): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'apiKey',
        '*.apiKey',
        'err.apiKey',
        'authorization',
        '*.authorization',
        'token',
        '*.token',
        'virtualKey',
        '*.virtualKey',
      ],
      censor: '[redacted]',
    },
  });
}

export type Logger = pino.Logger;
