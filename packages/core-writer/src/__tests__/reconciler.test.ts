import { describe, it, expect, beforeEach } from 'vitest';
import type { CanonicalNode } from '@shipit-ai/shared';
import { IdentityReconciler } from '../identity/reconciler.js';
import { InMemoryLinkingKeyIndex } from '../identity/linking-key-index.js';

function makeNode(overrides: Partial<CanonicalNode> = {}): CanonicalNode {
  return {
    id: 'shipit://repository/default/shipitops/graph-api',
    label: 'Repository',
    properties: { name: 'graph-api' },
    _claims: [],
    _source_system: 'github',
    _source_org: 'github/shipitops',
    _source_id: 'github://shipitops/graph-api',
    _last_synced: '2026-02-28T10:00:00Z',
    _event_version: 1,
    ...overrides,
  };
}

describe('IdentityReconciler', () => {
  let index: InMemoryLinkingKeyIndex;
  let reconciler: IdentityReconciler;

  beforeEach(() => {
    index = new InMemoryLinkingKeyIndex();
    reconciler = new IdentityReconciler(index);
  });

  it('creates a new entity when no match exists', async () => {
    const node = makeNode();
    const result = await reconciler.reconcile(node);

    expect(result.action).toBe('create');
    expect(result.canonicalId).toBe(node.id);
  });

  it('registers linking key on create', async () => {
    const node = makeNode();
    await reconciler.reconcile(node);

    const lookupResult = await index.lookupByLinkingKey(node._source_id);
    expect(lookupResult).toBe(node.id);
  });

  it('merges via primary key match', async () => {
    const node = makeNode();
    // Pre-register the canonical ID
    await index.register(node.id, node._source_id);

    const result = await reconciler.reconcile(node);
    expect(result.action).toBe('merge');
    expect(result.matchMethod).toBe('primary_key');
    expect(result.canonicalId).toBe(node.id);
  });

  it('merges via linking key match', async () => {
    const existingId = 'shipit://repository/default/shipitops/graph-api';
    const linkingKey = 'github://shipitops/graph-api';
    await index.register(existingId, linkingKey);

    // New node with same linking key but different canonical ID
    const node = makeNode({
      id: 'shipit://repository/default/shipitops/graph-api-new',
      _source_id: linkingKey,
    });

    const result = await reconciler.reconcile(node);
    expect(result.action).toBe('merge');
    expect(result.matchMethod).toBe('linking_key');
    expect(result.canonicalId).toBe(existingId);
  });

  it('creates separate entities for different linking keys', async () => {
    const node1 = makeNode({
      id: 'shipit://repository/default/org/repo-a',
      _source_id: 'github://org/repo-a',
    });
    const node2 = makeNode({
      id: 'shipit://repository/default/org/repo-b',
      _source_id: 'github://org/repo-b',
    });

    const result1 = await reconciler.reconcile(node1);
    const result2 = await reconciler.reconcile(node2);

    expect(result1.action).toBe('create');
    expect(result2.action).toBe('create');
    expect(result1.canonicalId).not.toBe(result2.canonicalId);
  });

  it('keeps cross-org repos with identical names as distinct entities', async () => {
    // Regression guard for the canonical-ID org-namespacing fix: before the
    // change, `shipitops/infra` and `cargocloud/infra` collapsed onto a single
    // `shipit://repository/default/infra` node — pre-rename this case used
    // `acme-corp` + `contoso` (see git history).
    // `shipit://repository/default/infra` node.
    const shipitopsInfra = makeNode({
      id: 'shipit://repository/default/shipitops/infra',
      _source_org: 'github/shipitops',
      _source_id: 'github://shipitops/infra',
    });
    const cargocloudInfra = makeNode({
      id: 'shipit://repository/default/cargocloud/infra',
      _source_org: 'github/cargocloud',
      _source_id: 'github://cargocloud/infra',
    });

    const r1 = await reconciler.reconcile(shipitopsInfra);
    const r2 = await reconciler.reconcile(cargocloudInfra);

    expect(r1.action).toBe('create');
    expect(r2.action).toBe('create');
    expect(r1.canonicalId).not.toBe(r2.canonicalId);
  });
});
