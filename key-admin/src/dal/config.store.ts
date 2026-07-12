import { readFile, writeFile } from 'node:fs/promises';

export interface ConfigStore {
  /** Read the committed base config (models paid by us, general settings). */
  readBase(): Promise<string>;
  /**
   * Overwrite the generated config in place. Must truncate-write (not rename)
   * so the Docker bind mount of the file keeps pointing at the same inode.
   */
  writeGenerated(yamlText: string): Promise<void>;
  generatedPath(): string;
}

export function createFileConfigStore(basePath: string, generatedPath: string): ConfigStore {
  return {
    readBase: () => readFile(basePath, 'utf8'),
    writeGenerated: (yamlText) => writeFile(generatedPath, yamlText, 'utf8'),
    generatedPath: () => generatedPath,
  };
}
