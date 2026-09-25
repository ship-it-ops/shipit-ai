import { chmodSync, mkdirSync, statSync } from 'node:fs';

/**
 * Create the credential key directory and make sure it is actually 0700.
 *
 * `mkdirSync(dir, { mode: 0o700 })` is not enough on its own: the mode applies
 * only when the directory is created (an existing looser dir keeps its mode),
 * and even then it is masked by the process umask. The explicit chmod closes
 * both gaps. Per-file modes are still set at write time — this is the dir-level
 * layer, so a leftover world-readable key dir cannot expose tomorrow's writes.
 */
export function ensureKeyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch {
    // A chmod we are not allowed to make (foreign owner, read-only mount) must
    // not take the process down: the per-file 0600 writes still stand.
  }
}
