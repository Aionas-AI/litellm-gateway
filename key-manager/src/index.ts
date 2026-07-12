import { createApp } from './app';
import { createLogger } from './lib/logger';

const logger = createLogger();
const PORT = Number(process.env.PORT ?? 9100);

const app = createApp({ logger });
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'key-manager listening');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.fatal(
      { port: PORT, pid: process.pid },
      `Port ${PORT} is already in use. Kill the process or set a different PORT`,
    );
  } else {
    logger.fatal({ err }, 'Server failed to start');
  }
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
  process.exit(1);
});
