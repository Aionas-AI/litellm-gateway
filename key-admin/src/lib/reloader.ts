import Dockerode from 'dockerode';

export interface LitellmReloader {
  /** Restart the LiteLLM container so it re-reads the generated config. */
  reload(): Promise<void>;
}

export function createDockerReloader(containerName: string): LitellmReloader {
  return {
    async reload(): Promise<void> {
      const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
      await docker.getContainer(containerName).restart({ t: 10 });
    },
  };
}
