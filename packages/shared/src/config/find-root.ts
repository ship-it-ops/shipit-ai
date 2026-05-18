import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BASE_FILENAME = 'shipit.config.yaml';
const LOCAL_FILENAME = 'shipit.config.local.yaml';

export interface ConfigPaths {
  basePath: string;
  localPath: string;
}

export function findConfigPaths(startDir: string = process.cwd()): ConfigPaths {
  const envOverride = process.env.SHIPIT_CONFIG;
  if (envOverride) {
    const basePath = resolve(envOverride);
    return { basePath, localPath: join(dirname(basePath), LOCAL_FILENAME) };
  }

  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, BASE_FILENAME);
    if (existsSync(candidate)) {
      return { basePath: candidate, localPath: join(dir, LOCAL_FILENAME) };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find ${BASE_FILENAME} walking up from ${startDir}. ` +
          `Run from inside the repo, or set SHIPIT_CONFIG to an explicit path.`,
      );
    }
    dir = parent;
  }
}
