import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BASE_FILENAME = 'shipit.config.yaml';
const LOCAL_FILENAME = 'shipit.config.local.yaml';

export interface ConfigPaths {
  repoRoot: string;
  basePath: string;
  localPath: string;
}

// Mirrors packages/shared/src/config/find-root.ts. Inlined here for the same
// reason next.config.mjs duplicates the YAML loader — turbo runs packages in
// parallel and shared may not be on disk when the web-ui process starts.
export function findConfigPaths(startDir: string = process.cwd()): ConfigPaths {
  const envOverride = process.env.SHIPIT_CONFIG;
  if (envOverride) {
    const basePath = resolve(envOverride);
    const repoRoot = dirname(basePath);
    return { repoRoot, basePath, localPath: join(repoRoot, LOCAL_FILENAME) };
  }

  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, BASE_FILENAME);
    if (existsSync(candidate)) {
      return { repoRoot: dir, basePath: candidate, localPath: join(dir, LOCAL_FILENAME) };
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
