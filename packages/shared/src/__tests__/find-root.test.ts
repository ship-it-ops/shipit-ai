/**
 * Unit tests for findConfigPaths (cheap follow-up flagged by the integration-
 * test roadmap deep-dive — previously no test). This drives where every process
 * loads its config from at boot: the SHIPIT_CONFIG override, the walk-up search
 * for shipit.config.yaml, and the "ran from the wrong directory" failure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { findConfigPaths } from '../config/find-root.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'shipit-findroot-'));
  dirs.push(d);
  return d;
}

describe('findConfigPaths', () => {
  const savedEnv = process.env.SHIPIT_CONFIG;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SHIPIT_CONFIG;
    else process.env.SHIPIT_CONFIG = savedEnv;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  describe('SHIPIT_CONFIG override', () => {
    it('resolves the override to an absolute base path with the sibling local path', () => {
      process.env.SHIPIT_CONFIG = './some/dir/shipit.config.yaml';
      const paths = findConfigPaths('/unused/start');
      expect(paths.basePath).toBe(resolve('./some/dir/shipit.config.yaml'));
      // The local file is the override's SIBLING, not relative to startDir.
      expect(paths.localPath).toBe(
        join(dirname(resolve('./some/dir/shipit.config.yaml')), 'shipit.config.local.yaml'),
      );
    });

    it('honors the override even when the file does not exist (no existence check on the override path)', () => {
      process.env.SHIPIT_CONFIG = '/nonexistent/shipit.config.yaml';
      const paths = findConfigPaths();
      expect(paths.basePath).toBe('/nonexistent/shipit.config.yaml');
      expect(paths.localPath).toBe('/nonexistent/shipit.config.local.yaml');
    });
  });

  describe('walk-up search', () => {
    it('finds shipit.config.yaml in the start directory', () => {
      delete process.env.SHIPIT_CONFIG;
      const root = tmp();
      writeFileSync(join(root, 'shipit.config.yaml'), 'x: 1', 'utf-8');

      const paths = findConfigPaths(root);
      expect(paths.basePath).toBe(join(root, 'shipit.config.yaml'));
      expect(paths.localPath).toBe(join(root, 'shipit.config.local.yaml'));
    });

    it('walks UP from a nested start directory to the ancestor holding the config', () => {
      delete process.env.SHIPIT_CONFIG;
      const root = tmp();
      writeFileSync(join(root, 'shipit.config.yaml'), 'x: 1', 'utf-8');
      const nested = join(root, 'packages', 'api-server', 'src');
      mkdirSync(nested, { recursive: true });

      const paths = findConfigPaths(nested);
      // Resolves to the ANCESTOR's config + local sibling, not anything under nested.
      expect(paths.basePath).toBe(join(root, 'shipit.config.yaml'));
      expect(paths.localPath).toBe(join(root, 'shipit.config.local.yaml'));
    });

    it('throws an actionable error when no config exists walking up to the filesystem root', () => {
      delete process.env.SHIPIT_CONFIG;
      const empty = tmp(); // a tmp dir with no shipit.config.yaml above it that we control
      expect(() => findConfigPaths(empty)).toThrow(/Could not find shipit\.config\.yaml/);
      // The message points the operator at the two ways out.
      expect(() => findConfigPaths(empty)).toThrow(/SHIPIT_CONFIG/);
    });
  });
});
