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

  // Same pattern but with a remove() racing concurrent create()s. The
  // wizard's "delete + immediately add a replacement" flow lands on this
  // codepath; without serialization a remove() that reads stale state
  // before the creates persist could resurrect the removed connector.
  it('serializes remove() racing concurrent create() calls', async () => {
    const registry = new ConnectorRegistry({ localConfigPath: yamlPath, initial: [] });

    // Seed a connector we'll remove.
    await registry.create({
      id: 'gh-doomed',
      type: 'github',
      name: 'Doomed',
      installationId: '1',
      org: 'doomed-org',
    });

    await Promise.all([
      registry.create({
        id: 'gh-add-a',
        type: 'github',
        name: 'Add A',
        installationId: '2',
        org: 'add-a-org',
      }),
      registry.remove('gh-doomed', undefined),
      registry.create({
        id: 'gh-add-b',
        type: 'github',
        name: 'Add B',
        installationId: '3',
        org: 'add-b-org',
      }),
    ]);

    const yaml = parseYaml(readFileSync(yamlPath, 'utf-8')) as {
      connectors: { instances: Array<{ id: string }> };
    };
    const ids = yaml.connectors.instances.map((c) => c.id).sort();
    // gh-doomed must not survive; both new connectors must land.
    expect(ids).toEqual(['gh-add-a', 'gh-add-b']);
  });

  // The persistChain absorbs rejections (`.catch(() => {})`) so a single
  // failed write can't poison the chain and block every subsequent
  // persist(). We can't make persist() itself throw without monkey-patching
  // internals, so the proof is indirect: trigger a failure path the
  // registry surfaces synchronously (duplicate id → 409), then confirm a
  // follow-up valid create still completes and lands in YAML.
  it('absorbs a rejected create() so the persistChain keeps draining', async () => {
    const registry = new ConnectorRegistry({ localConfigPath: yamlPath, initial: [] });

    await registry.create({
      id: 'gh-original',
      type: 'github',
      name: 'Original',
      installationId: '1',
      org: 'org-1',
    });

    // Duplicate id → registry rejects before persist(); even so, in flight
    // promises around it should not bring the chain down. Mix valid +
    // rejecting calls in the same Promise.all and assert the valid ones
    // still land.
    const results = await Promise.allSettled([
      registry.create({
        id: 'gh-original',
        type: 'github',
        name: 'Duplicate (should reject)',
        installationId: '99',
        org: 'org-dup',
      }),
      registry.create({
        id: 'gh-after-failure',
        type: 'github',
        name: 'After failure',
        installationId: '2',
        org: 'org-2',
      }),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');

    // The second create's effect must reach YAML — proving the chain
    // didn't lock up on the rejection.
    const yaml = parseYaml(readFileSync(yamlPath, 'utf-8')) as {
      connectors: { instances: Array<{ id: string }> };
    };
    const ids = yaml.connectors.instances.map((c) => c.id).sort();
    expect(ids).toEqual(['gh-after-failure', 'gh-original']);

    // And a fresh create *after* the failure has also fully drained still
    // works — guards against a "first failure poisons future calls" bug.
    await registry.create({
      id: 'gh-fresh',
      type: 'github',
      name: 'Fresh',
      installationId: '3',
      org: 'org-3',
    });
    const yaml2 = parseYaml(readFileSync(yamlPath, 'utf-8')) as {
      connectors: { instances: Array<{ id: string }> };
    };
    expect(yaml2.connectors.instances.map((c) => c.id).sort()).toEqual([
      'gh-after-failure',
      'gh-fresh',
      'gh-original',
    ]);
  });
});
