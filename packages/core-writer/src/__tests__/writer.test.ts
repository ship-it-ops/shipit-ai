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
    writeNode: vi.fn().mockResolvedValue(undefined),
    writeEdge: vi.fn().mockResolvedValue(undefined),
    getExistingClaims: vi.fn().mockResolvedValue([]),
    touchLastSynced: vi.fn().mockResolvedValue(undefined),
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
      .mockResolvedValueOnce(undefined) // first node succeeds
      .mockRejectedValueOnce(new Error('Write failed')) // second fails
      .mockResolvedValueOnce(undefined); // third succeeds

    const event = makeEnvelope([makeNode('repo-a'), makeNode('repo-b'), makeNode('repo-c')], []);

    const result = await writer.processEvent(event);
    expect(result.nodesWritten).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Write failed');
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
