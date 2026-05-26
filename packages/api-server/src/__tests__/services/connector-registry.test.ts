import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConnectorRegistry } from '../../services/connector-registry.js';

// These tests pin behavior the routes depend on; the routes' own tests
// exercise the HTTP surface, this file targets the registry contract
// directly so the (otherwise easy-to-miss) persistence invariants are
// explicit.

describe('ConnectorRegistry — persist() write serialization', () => {
  let tmpDir: string;
  let yamlPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-registry-persist-'));
    yamlPath = join(tmpDir, 'shipit.config.local.yaml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Without serialization, two concurrent writers each read the same
  // YAML, each serialize their own snapshot of the in-memory state, and
  // each rename — last writer silently wins. This test fires N parallel
  // mutations and asserts the final YAML reflects all of them.
  it('serializes concurrent create() calls so every connector lands in YAML', async () => {
    const registry = new ConnectorRegistry({ localConfigPath: yamlPath, initial: [] });

    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        registry.create({
          id: `gh-concurrent-${i}`,
          type: 'github',
          name: `Concurrent ${i}`,
          installationId: String(1000 + i),
          org: `org-${i}`,
        }),
      ),
    );

    const yaml = parseYaml(readFileSync(yamlPath, 'utf-8')) as {
      connectors: { instances: Array<{ id: string }> };
    };
    const ids = yaml.connectors.instances.map((c) => c.id).sort();
    const expected = Array.from({ length: N }, (_, i) => `gh-concurrent-${i}`).sort();
    expect(ids).toEqual(expected);
  });

  // Same scenario but mixed mutation kinds — create followed by update
  // calls that race. Update changes propagate alongside the creates.
  it('serializes interleaved create + update calls', async () => {
    const registry = new ConnectorRegistry({ localConfigPath: yamlPath, initial: [] });

    // Seed one connector so we have something to update.
    await registry.create({
      id: 'gh-base',
      type: 'github',
      name: 'Base',
      installationId: '1',
      org: 'base-org',
    });

    await Promise.all([
      registry.create({
        id: 'gh-new-1',
        type: 'github',
        name: 'New 1',
        installationId: '2',
        org: 'new-1',
      }),
      registry.update('gh-base', { name: 'Base (renamed)' }, undefined),
      registry.create({
        id: 'gh-new-2',
        type: 'github',
        name: 'New 2',
        installationId: '3',
        org: 'new-2',
      }),
      registry.update('gh-base', { enabled: false }, undefined),
    ]);

    const yaml = parseYaml(readFileSync(yamlPath, 'utf-8')) as {
      connectors: { instances: Array<{ id: string; name: string; enabled: boolean }> };
    };
    const byId = Object.fromEntries(yaml.connectors.instances.map((c) => [c.id, c]));
    // Every create's row exists, the last update's effects win.
    expect(Object.keys(byId).sort()).toEqual(['gh-base', 'gh-new-1', 'gh-new-2']);
    expect(byId['gh-base'].name).toBe('Base (renamed)');
    expect(byId['gh-base'].enabled).toBe(false);
  });
});
