/**
 * Integration test for the full pipeline:
 * Connector -> normalize -> Event Bus -> Core Writer -> Graph
 *
 * Uses mocked Neo4j (no Docker required) but exercises the real
 * connector SDK harness, GitHub normalizers, and core writer logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CanonicalEntity, EventBusClient, EventEnvelope } from '@shipit-ai/shared';
import { buildCanonicalId, buildScopedCanonicalId } from '@shipit-ai/shared';

const ORG = 'shipitops';
import { CoreWriter, type NodeWriter } from '../writer.js';
import { InMemoryLinkingKeyIndex } from '../identity/linking-key-index.js';
import { InMemoryIdempotencyChecker } from '../idempotency.js';
import { DEFAULT_CONFIG } from '../config.js';

// --- Simulated GitHub connector output ---

function createGitHubNormalizedOutput(): CanonicalEntity {
  const now = new Date().toISOString();
  return {
    nodes: [
      {
        id: buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
        label: 'Repository',
        properties: {
          name: 'graph-api',
          url: 'https://github.com/shipitops/graph-api',
          default_branch: 'main',
          visibility: 'private',
          language: 'TypeScript',
        },
        _claims: [
          {
            property_key: 'name',
            value: 'graph-api',
            source: 'github',
            source_id: 'github://shipitops/graph-api',
            ingested_at: now,
            confidence: 0.9,
            evidence: null,
          },
          {
            property_key: 'language',
            value: 'TypeScript',
            source: 'github',
            source_id: 'github://shipitops/graph-api',
            ingested_at: now,
            confidence: 0.9,
            evidence: null,
          },
        ],
        _source_system: 'github',
        _source_org: 'github/shipitops',
        _source_id: 'github://shipitops/graph-api',
        _last_synced: now,
        _event_version: 1,
      },
      {
        id: buildScopedCanonicalId('Team', 'default', ORG, 'platform'),
        label: 'Team',
        properties: { name: 'Platform Team', slug: 'platform' },
        _claims: [
          {
            property_key: 'name',
            value: 'Platform Team',
            source: 'github',
            source_id: 'github://shipitops/team/platform',
            ingested_at: now,
            confidence: 0.9,
            evidence: null,
          },
        ],
        _source_system: 'github',
        _source_org: 'github/shipitops',
        _source_id: 'github://shipitops/team/platform',
        _last_synced: now,
        _event_version: 1,
      },
      {
        id: buildCanonicalId('Person', 'default', 'alice'),
        label: 'Person',
        properties: { login: 'alice', url: 'https://github.com/alice' },
        _claims: [
          {
            property_key: 'login',
            value: 'alice',
            source: 'github',
            source_id: 'github://shipitops/user/alice',
            ingested_at: now,
            confidence: 0.9,
            evidence: null,
          },
        ],
        _source_system: 'github',
        _source_org: 'github/shipitops',
        _source_id: 'github://shipitops/user/alice',
        _last_synced: now,
        _event_version: 1,
      },
    ],
    edges: [
      {
        type: 'MEMBER_OF',
        from: buildCanonicalId('Person', 'default', 'alice'),
        to: buildScopedCanonicalId('Team', 'default', ORG, 'platform'),
        _source: 'github',
        _confidence: 0.9,
        _ingested_at: now,
      },
      {
        type: 'CODEOWNER_OF',
        from: buildScopedCanonicalId('Team', 'default', ORG, 'platform'),
        to: buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
        properties: { pattern: '*' },
        _source: 'github',
        _confidence: 0.95,
        _ingested_at: now,
      },
    ],
  };
}

function makeEnvelope(payload: CanonicalEntity, connectorId: string): EventEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    connector_id: connectorId,
    idempotency_key: `${connectorId}:batch:1`,
    payload,
  };
}

describe('Integration: GitHub connector output -> Core Writer', () => {
  let writtenNodes: Map<string, { node: unknown; claims: unknown; effectiveProps: unknown }>;
  let writtenEdges: Array<{ type: string; from: string; to: string }>;
  let nodeWriter: NodeWriter;
  let writer: CoreWriter;

  beforeEach(() => {
    writtenNodes = new Map();
    writtenEdges = [];

    nodeWriter = {
      writeNode: vi.fn().mockImplementation(async (node, claims, effectiveProps) => {
        writtenNodes.set(node.id, { node, claims, effectiveProps });
        return { written: true };
      }),
      writeEdge: vi.fn().mockImplementation(async (edge) => {
        writtenEdges.push({ type: edge.type, from: edge.from, to: edge.to });
      }),
      getExistingClaims: vi.fn().mockResolvedValue([]),
      touchLastSynced: vi.fn().mockResolvedValue(undefined),
    };

    const linkingKeyIndex = new InMemoryLinkingKeyIndex();
    const idempotency = new InMemoryIdempotencyChecker();

    writer = new CoreWriter(nodeWriter, linkingKeyIndex, idempotency, DEFAULT_CONFIG);
  });

  it('processes GitHub connector output end-to-end', async () => {
    const normalized = createGitHubNormalizedOutput();
    const event = makeEnvelope(normalized, 'github-shipitops');

    const result = await writer.processEvent(event);

    expect(result.nodesWritten).toBe(3);
    expect(result.edgesWritten).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('creates Repository, Team, and Person nodes', async () => {
    const normalized = createGitHubNormalizedOutput();
    const event = makeEnvelope(normalized, 'github-shipitops');

    await writer.processEvent(event);

    expect(
      writtenNodes.has(buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api')),
    ).toBe(true);
    expect(writtenNodes.has(buildScopedCanonicalId('Team', 'default', ORG, 'platform'))).toBe(true);
    expect(writtenNodes.has(buildCanonicalId('Person', 'default', 'alice'))).toBe(true);
  });

  it('creates MEMBER_OF and CODEOWNER_OF edges', async () => {
    const normalized = createGitHubNormalizedOutput();
    const event = makeEnvelope(normalized, 'github-shipitops');

    await writer.processEvent(event);

    const memberOfEdge = writtenEdges.find((e) => e.type === 'MEMBER_OF');
    expect(memberOfEdge).toBeDefined();
    expect(memberOfEdge!.from).toBe(buildCanonicalId('Person', 'default', 'alice'));
    expect(memberOfEdge!.to).toBe(buildScopedCanonicalId('Team', 'default', ORG, 'platform'));

    const codeownerEdge = writtenEdges.find((e) => e.type === 'CODEOWNER_OF');
    expect(codeownerEdge).toBeDefined();
    expect(codeownerEdge!.from).toBe(buildScopedCanonicalId('Team', 'default', ORG, 'platform'));
    expect(codeownerEdge!.to).toBe(
      buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
    );
  });

  it('resolves effective properties from claims', async () => {
    const normalized = createGitHubNormalizedOutput();
    const event = makeEnvelope(normalized, 'github-shipitops');

    await writer.processEvent(event);

    const repoEntry = writtenNodes.get(
      buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
    );
    expect(repoEntry).toBeDefined();
    expect(repoEntry!.effectiveProps).toHaveProperty('name', 'graph-api');
    expect(repoEntry!.effectiveProps).toHaveProperty('language', 'TypeScript');
  });

  it('deduplicates on re-processing the same event', async () => {
    const normalized = createGitHubNormalizedOutput();
    const event = makeEnvelope(normalized, 'github-shipitops');

    await writer.processEvent(event);
    const result2 = await writer.processEvent(event);

    expect(result2.duplicatesSkipped).toBe(3);
    expect(result2.nodesWritten).toBe(0);
    // writeNode should only have been called 3 times total (first processing)
    expect(nodeWriter.writeNode).toHaveBeenCalledTimes(3);
  });

  it('merges Backstage claims with GitHub claims on same entity', async () => {
    // First: GitHub provides the repo
    const githubOutput = createGitHubNormalizedOutput();
    const githubEvent = makeEnvelope(githubOutput, 'github-shipitops');
    await writer.processEvent(githubEvent);

    // Simulate existing claims returned from "Neo4j" for the repo node
    const existingGithubClaims = githubOutput.nodes[0]._claims;
    vi.mocked(nodeWriter.getExistingClaims).mockResolvedValue(existingGithubClaims);

    // Second: Backstage provides tier claim for the same repo
    const backstageOutput: CanonicalEntity = {
      nodes: [
        {
          id: buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
          label: 'Repository',
          properties: { name: 'graph-api', tier: 1 },
          _claims: [
            {
              property_key: 'tier',
              value: 1,
              source: 'backstage',
              source_id: 'backstage://default/component/graph-api',
              ingested_at: new Date().toISOString(),
              confidence: 0.95,
              evidence: 'catalog-info.yaml',
            },
          ],
          _source_system: 'backstage',
          _source_org: 'backstage/default',
          _source_id: 'backstage://default/component/graph-api',
          _last_synced: new Date().toISOString(),
          _event_version: 2,
        },
      ],
      edges: [],
    };
    const backstageEvent = makeEnvelope(backstageOutput, 'backstage-default');
    await writer.processEvent(backstageEvent);

    // Verify the merged claims include both sources
    const repoWriteCall = vi
      .mocked(nodeWriter.writeNode)
      .mock.calls.find(
        (call) =>
          call[0].id === buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api') &&
          call[0]._source_system === 'backstage',
      );
    expect(repoWriteCall).toBeDefined();
    const mergedClaims = repoWriteCall![1];
    const sources = new Set(mergedClaims.map((c) => c.source));
    expect(sources.has('github')).toBe(true);
    expect(sources.has('backstage')).toBe(true);

    // Effective properties should include tier from backstage
    const effectiveProps = repoWriteCall![2] as Record<string, unknown>;
    expect(effectiveProps['tier']).toBe(1);
  });

  it('simulates full E2E: connector -> event bus -> core writer', async () => {
    // Simulate the Event Bus publish/subscribe flow
    const publishedEvents: EventEnvelope[] = [];

    const mockEventBus: EventBusClient = {
      publish: vi.fn().mockImplementation(async (entities, connectorId) => {
        for (const entity of entities) {
          publishedEvents.push({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            connector_id: connectorId,
            idempotency_key: `${connectorId}:${entity.nodes[0]?.id ?? 'unknown'}:1`,
            payload: entity,
          });
        }
      }),
      subscribe: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Step 1: Connector produces normalized output and publishes via event bus
    const normalized = createGitHubNormalizedOutput();
    await mockEventBus.publish([normalized], 'github-shipitops');
    expect(publishedEvents).toHaveLength(1);

    // Step 2: Core Writer consumes events
    const result = await writer.processBatch(publishedEvents);

    expect(result.nodesWritten).toBe(3);
    expect(result.edgesWritten).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(writtenNodes.size).toBe(3);
    expect(writtenEdges).toHaveLength(2);
  });
});
