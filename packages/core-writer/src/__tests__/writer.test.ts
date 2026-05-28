import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanonicalNode, CanonicalEdge, EventEnvelope } from '@shipit-ai/shared';
import { CoreWriter, type NodeWriter } from '../writer.js';
import { InMemoryLinkingKeyIndex } from '../identity/linking-key-index.js';
import { InMemoryIdempotencyChecker } from '../idempotency.js';
import { DEFAULT_CONFIG } from '../config.js';

function makeNode(name: string): CanonicalNode {
  return {
    id: `shipit://repository/default/org/${name}`,
    label: 'Repository',
    properties: { name },
    _claims: [
      {
        property_key: 'name',
        value: name,
        source: 'github',
        source_id: `github://org/${name}`,
        ingested_at: '2026-02-28T10:00:00Z',
        confidence: 0.9,
        evidence: null,
      },
    ],
    _source_system: 'github',
    _source_org: 'github/org',
    _source_id: `github://org/${name}`,
    _last_synced: '2026-02-28T10:00:00Z',
    _event_version: 1,
  };
}

function makeEdge(from: string, to: string): CanonicalEdge {
  return {
    type: 'DEPENDS_ON',
    from: `shipit://repository/default/org/${from}`,
    to: `shipit://repository/default/org/${to}`,
    _source: 'github',
    _confidence: 0.9,
    _ingested_at: '2026-02-28T10:00:00Z',
  };
}

function makeEnvelope(nodes: CanonicalNode[], edges: CanonicalEdge[]): EventEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    connector_id: 'github-org',
    idempotency_key: `github-org:${nodes[0]?.id ?? 'edge'}:1`,
    payload: { nodes, edges },
  };
}

function createMockNodeWriter(): NodeWriter {
  return {
    writeNode: vi.fn().mockResolvedValue({ written: true }),
    writeEdge: vi.fn().mockResolvedValue(undefined),
    getExistingClaims: vi.fn().mockResolvedValue([]),
    touchLastSynced: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Stateful NodeWriter double that emulates the atomic in-Cypher freshness guard +
 * conditional touch, so tests can exercise out-of-order / intra-batch ordering that
 * a stateless mock cannot (audit test-strategist-006). `writeNode` rejects when a
 * strictly-newer comparable version is already stored; `touchLastSynced` only advances.
 */
function createStatefulNodeWriter(): NodeWriter & {
  store: Map<string, { version: number | string; lastSynced: string }>;
} {
  const store = new Map<string, { version: number | string; lastSynced: string }>();
  return {
    store,
    writeNode: vi.fn(async (node) => {
      const existing = store.get(node.id);
      const comparable = typeof node._event_version === 'number';
      if (
        existing &&
        comparable &&
        typeof existing.version === 'number' &&
        existing.version > (node._event_version as number)
      ) {
        return { written: false };
      }
      store.set(node.id, { version: node._event_version, lastSynced: node._last_synced });
      return { written: true };
    }),
    writeEdge: vi.fn().mockResolvedValue(undefined),
    getExistingClaims: vi.fn().mockResolvedValue([]),
    touchLastSynced: vi.fn(async (nodeId: string, lastSynced: string) => {
      const existing = store.get(nodeId);
      if (existing && lastSynced > existing.lastSynced) existing.lastSynced = lastSynced;
    }),
  };
}

describe('CoreWriter', () => {
  let writer: CoreWriter;
  let nodeWriter: NodeWriter;
  let linkingKeyIndex: InMemoryLinkingKeyIndex;
  let idempotency: InMemoryIdempotencyChecker;

  beforeEach(() => {
    nodeWriter = createMockNodeWriter();
    linkingKeyIndex = new InMemoryLinkingKeyIndex();
    idempotency = new InMemoryIdempotencyChecker();
    writer = new CoreWriter(nodeWriter, linkingKeyIndex, idempotency, DEFAULT_CONFIG);
  });

  it('writes nodes and edges from an event', async () => {
    const event = makeEnvelope([makeNode('repo-a')], [makeEdge('repo-a', 'repo-b')]);

    const result = await writer.processEvent(event);

    expect(result.nodesWritten).toBe(1);
    expect(result.edgesWritten).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(nodeWriter.writeNode).toHaveBeenCalledTimes(1);
    expect(nodeWriter.writeEdge).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate events via idempotency check', async () => {
    const event = makeEnvelope([makeNode('repo-a')], []);

    const result1 = await writer.processEvent(event);
    expect(result1.nodesWritten).toBe(1);

    const result2 = await writer.processEvent(event);
    expect(result2.nodesWritten).toBe(0);
    expect(result2.duplicatesSkipped).toBe(1);

    // writeNode should only have been called once
    expect(nodeWriter.writeNode).toHaveBeenCalledTimes(1);
  });

  it('refreshes _last_synced on an idempotent skip without re-writing the node', async () => {
    const first = makeEnvelope([makeNode('repo-a')], []);
    await writer.processEvent(first);

    // Same entity, same _event_version (dedup hit), but a newer sync time —
    // i.e. the connector re-confirmed an unchanged entity on a later run.
    const resynced = makeNode('repo-a');
    resynced._last_synced = '2026-06-16T12:00:00Z';
    const result = await writer.processEvent(makeEnvelope([resynced], []));

    expect(result.duplicatesSkipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    // Content write is skipped...
    expect(nodeWriter.writeNode).toHaveBeenCalledTimes(1);
    // ...but the freshness timestamp is bumped on the resolved canonical id.
    expect(nodeWriter.touchLastSynced).toHaveBeenCalledWith(
      'shipit://repository/default/org/repo-a',
      '2026-06-16T12:00:00Z',
    );
  });

  it('resolves claims and passes effective properties to writer', async () => {
    const event = makeEnvelope([makeNode('repo-a')], []);

    await writer.processEvent(event);

    const writeCall = vi.mocked(nodeWriter.writeNode).mock.calls[0];
    // Third arg is effectiveProperties
    const effectiveProps = writeCall[2];
    expect(effectiveProps).toHaveProperty('name', 'repo-a');
  });

  it('merges existing claims with incoming claims', async () => {
    vi.mocked(nodeWriter.getExistingClaims).mockResolvedValue([
      {
        property_key: 'tier',
        value: 1,
        source: 'backstage',
        source_id: 'backstage://default/component/repo-a',
        ingested_at: '2026-02-27T10:00:00Z',
        confidence: 0.95,
        evidence: null,
      },
    ]);

    const event = makeEnvelope([makeNode('repo-a')], []);
    await writer.processEvent(event);

    const writeCall = vi.mocked(nodeWriter.writeNode).mock.calls[0];
    const mergedClaims = writeCall[1];
    // Should have existing backstage claim + incoming github claim
    expect(mergedClaims.length).toBeGreaterThanOrEqual(2);
    expect(mergedClaims.some((c) => c.source === 'backstage')).toBe(true);
    expect(mergedClaims.some((c) => c.source === 'github')).toBe(true);
  });

  it('handles multiple nodes in a single event', async () => {
    const event = makeEnvelope([makeNode('repo-a'), makeNode('repo-b'), makeNode('repo-c')], []);

    const result = await writer.processEvent(event);
    expect(result.nodesWritten).toBe(3);
    expect(nodeWriter.writeNode).toHaveBeenCalledTimes(3);
  });

  it('processes a batch of events', async () => {
    const events = [
      makeEnvelope([makeNode('repo-1')], []),
      makeEnvelope([makeNode('repo-2')], []),
      makeEnvelope([makeNode('repo-3')], []),
    ];

    const result = await writer.processBatch(events);
    expect(result.nodesWritten).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it('reports errors without stopping batch processing', async () => {
    vi.mocked(nodeWriter.writeNode)
      .mockResolvedValueOnce({ written: true }) // first node succeeds
      .mockRejectedValueOnce(new Error('Write failed')) // second fails
      .mockResolvedValueOnce({ written: true }); // third succeeds

    const event = makeEnvelope([makeNode('repo-a'), makeNode('repo-b'), makeNode('repo-c')], []);

    const result = await writer.processEvent(event);
    expect(result.nodesWritten).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Write failed');
  });

  describe('freshness guard (Cut B)', () => {
    const EPOCH_OLD = 1_718_000_000_000;
    const EPOCH_NEW = 1_719_000_000_000;

    function versionedNode(
      name: string,
      version: number | string,
      lastSynced: string,
    ): CanonicalNode {
      const n = makeNode(name);
      n._event_version = version;
      n._last_synced = lastSynced;
      // make content differ from the default so the content-hash dedup key differs
      n.properties.rev = String(version);
      return n;
    }

    it('writes a newer delivery and skips a strictly-older one (criterion 3)', async () => {
      const stateful = createStatefulNodeWriter();
      writer = new CoreWriter(
        stateful,
        linkingKeyIndex,
        new InMemoryIdempotencyChecker(),
        DEFAULT_CONFIG,
      );

      const r1 = await writer.processEvent(
        makeEnvelope([versionedNode('repo-a', EPOCH_NEW, '2026-06-21T00:00:00Z')], []),
      );
      expect(r1.nodesWritten).toBe(1);

      const r2 = await writer.processEvent(
        makeEnvelope([versionedNode('repo-a', EPOCH_OLD, '2026-06-10T00:00:00Z')], []),
      );
      expect(r2.nodesWritten).toBe(0);
      expect(r2.freshnessSkipped).toBe(1);
      // stored version + last_synced stay at the newer values (no backward move)
      const stored = stateful.store.get('shipit://repository/default/org/repo-a');
      expect(stored?.version).toBe(EPOCH_NEW);
      expect(stored?.lastSynced).toBe('2026-06-21T00:00:00Z');
    });

    it('writes an equal-version delivery whose content differs (passed content dedup)', async () => {
      const stateful = createStatefulNodeWriter();
      writer = new CoreWriter(
        stateful,
        linkingKeyIndex,
        new InMemoryIdempotencyChecker(),
        DEFAULT_CONFIG,
      );

      await writer.processEvent(
        makeEnvelope([versionedNode('p', EPOCH_NEW, '2026-06-21T00:00:00Z')], []),
      );
      const changed = versionedNode('p', EPOCH_NEW, '2026-06-22T00:00:00Z');
      changed.properties.status = 'completed'; // same version, new content
      const r = await writer.processEvent(makeEnvelope([changed], []));
      expect(r.nodesWritten).toBe(1);
      expect(r.freshnessSkipped).toBe(0);
    });

    it('skips an intra-batch older delivery for the same node (stateful, atomic guard)', async () => {
      const stateful = createStatefulNodeWriter();
      writer = new CoreWriter(
        stateful,
        linkingKeyIndex,
        new InMemoryIdempotencyChecker(),
        DEFAULT_CONFIG,
      );

      const result = await writer.processBatch([
        makeEnvelope([versionedNode('repo-b', EPOCH_NEW, '2026-06-21T00:00:00Z')], []),
        makeEnvelope([versionedNode('repo-b', EPOCH_OLD, '2026-06-10T00:00:00Z')], []),
      ]);
      expect(result.nodesWritten).toBe(1);
      expect(result.freshnessSkipped).toBe(1);
      expect(stateful.store.get('shipit://repository/default/org/repo-b')?.version).toBe(EPOCH_NEW);
    });

    it('legacy stored version 1 accepts an incoming epoch (no wedge, criterion 5)', async () => {
      const stateful = createStatefulNodeWriter();
      stateful.store.set('shipit://repository/default/org/repo-c', {
        version: 1,
        lastSynced: '2026-01-01T00:00:00Z',
      });
      writer = new CoreWriter(
        stateful,
        linkingKeyIndex,
        new InMemoryIdempotencyChecker(),
        DEFAULT_CONFIG,
      );
      const r = await writer.processEvent(
        makeEnvelope([versionedNode('repo-c', EPOCH_NEW, '2026-06-21T00:00:00Z')], []),
      );
      expect(r.nodesWritten).toBe(1);
    });

    it('content-hash (incomparable) versions always write — last-writer-wins for hashless entities', async () => {
      const stateful = createStatefulNodeWriter();
      writer = new CoreWriter(
        stateful,
        linkingKeyIndex,
        new InMemoryIdempotencyChecker(),
        DEFAULT_CONFIG,
      );
      await writer.processEvent(
        makeEnvelope([versionedNode('t', 'ch_aaa', '2026-06-21T00:00:00Z')], []),
      );
      const r = await writer.processEvent(
        makeEnvelope([versionedNode('t', 'ch_bbb', '2026-06-10T00:00:00Z')], []),
      );
      expect(r.nodesWritten).toBe(1);
      expect(r.freshnessSkipped).toBe(0);
    });
  });

  it('stamps the envelope connector_id onto the written node as _source_connector_id', async () => {
    // Normalizers don't know the connector instance ID; only the runner does.
    // The writer is the seam where envelope-level connector identity gets
    // attached to the node so downstream UI can filter by connector instance.
    const event = makeEnvelope([makeNode('repo-a')], []);

    await writer.processEvent(event);

    const writeCall = vi.mocked(nodeWriter.writeNode).mock.calls[0];
    const writtenNode = writeCall[0];
    expect(writtenNode._source_connector_id).toBe(event.connector_id);
  });

  it('reconciles identity and uses existing canonical ID for merge', async () => {
    // Pre-register a linking key pointing to an existing node
    const existingId = 'shipit://repository/default/org/payments-api';
    const linkingKey = 'github://org/payments-api';
    await linkingKeyIndex.register(existingId, linkingKey);

    const node = makeNode('payments-api');
    const event = makeEnvelope([node], []);

    await writer.processEvent(event);

    const writeCall = vi.mocked(nodeWriter.writeNode).mock.calls[0];
    const writtenNode = writeCall[0];
    expect(writtenNode.id).toBe(existingId);
  });
});
