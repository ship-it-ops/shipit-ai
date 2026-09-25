import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureKeyDir } from '../../secrets/key-dir.js';

describe('ensureKeyDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shipit-key-dir-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the directory as 0700', () => {
    const dir = join(root, 'keys');
    ensureKeyDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  // mkdirSync's `mode` applies only at creation and is umask-masked, so a key
  // dir that already exists world-readable used to stay that way.
  it('tightens a pre-existing directory that is too permissive', () => {
    const dir = join(root, 'loose');
    mkdirSync(dir, { recursive: true });
    ensureKeyDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('is idempotent and leaves an already-correct directory alone', () => {
    const dir = join(root, 'keys');
    ensureKeyDir(dir);
    ensureKeyDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
