import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether node was started with the module at `moduleUrl` (pass
 * `import.meta.url`), as opposed to that module being imported by another
 * program. Compares real paths, so a symlinked bin and a TypeScript entry run
 * through tsx both count. Matching on the file name (`index.js`) is not enough:
 * the api-server's entry is also `dist/index.js`, and it imports this package.
 */
export function isMainModule(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
