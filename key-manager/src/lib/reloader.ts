import http from 'node:http';
import { Logger } from './logger';

export interface Reloader {
  reload(): Promise<boolean>;
}

export interface DockerReloaderOptions {
  socketPath: string;
  containerName: string;
  logger: Logger;
}

/**
 * Restarts the LiteLLM container through the Docker Engine API over the unix
 * socket, so the generated config file is re-read. No docker CLI needed inside
 * this container — just the socket mount.
 */
export function createDockerReloader(opts: DockerReloaderOptions): Reloader {
  const { socketPath, containerName, logger } = opts;
  return {
    reload(): Promise<boolean> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: `/v1.43/containers/${encodeURIComponent(containerName)}/restart?t=10`,
            method: 'POST',
          },
          (res) => {
            res.resume();
            if (res.statusCode === 204) {
              logger.info({ containerName }, 'LiteLLM container restarted');
              resolve(true);
            } else {
              reject(new Error(`Docker restart failed with status ${res.statusCode}`));
            }
          },
        );
        req.on('error', reject);
        req.end();
      });
    },
  };
}
