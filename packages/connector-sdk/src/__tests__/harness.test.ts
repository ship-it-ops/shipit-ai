import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanonicalEntity, EventBusClient } from '@shipit-ai/shared';
import type { ShipItConnector, ConnectorConfig, ConnectorManifest } from '../interface.js';
import { ConnectorHarness } from '../harness.js';
import { SyncState } from '../sync-state.js';
import { dryRun } from '../dry-run.js';

// --- Mock connector ---

function createMockEntity(name: string): CanonicalEntity {
  return {
    nodes: [
      {
        id: `shipit://repository/default/${name}`,
        label: 'Repository',
        properties: { name },
        _claims: [
          {
            property_key: 'name',
            value: name,
            source: 'mock',
            source_id: `mock://org/${name}`,
            ingested_at: new Date().toISOString(),
            confidence: 0.9,
            evidence: null,
          },
        ],
        _source_system: 'mock',
        _source_org: 'mock/org',
        _source_id: `mock://org/${name}`,
        _last_synced: new Date().toISOString(),
        _event_version: 1,
      },
    ],
    edges: [
      {
        type: 'OWNED_BY',
        from: `shipit://repository/default/${name}`,
        to: 'shipit://team/default/platform',
        _source: 'mock',
        _confidence: 0.9,
        _ingested_at: new Date().toISOString(),
      },
    ],
  };
}

function createMockConnector(overrides: Partial<ShipItConnector> = {}): ShipItConnector {
  const manifest: ConnectorManifest = {
    name: 'mock',
    version: '1.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: ['Repository'],
  };

  return {
    manifest,
    authenticate: vi.fn().mockResolvedValue({ success: true }),
    discover: vi.fn().mockResolvedValue({
      entity_types: ['Repository'],
      total_entities: { Repository: 2 },
    }),
    fetch: vi.fn().mockResolvedValue({
      entities: [{ name: 'repo-1' }, { name: 'repo-2' }],
      has_more: false,
    }),
    normalize: vi.fn().mockReturnValue(createMockEntity('repo-1')),
    sync: vi.fn().mockResolvedValue({
      status: 'success' as const,
      entities_synced: 2,
      errors: [],
      duration_ms: 100,
    }),
    ...overrides,
  };
}

function createMockEventBus(): EventBusClient {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    replay: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const defaultConfig: ConnectorConfig = {
  id: 'mock-connector-1',
  type: 'mock',
  credentials: { token: 'test-token' },
  scope: { org: 'test-org' },
};

// --- Tests ---

describe('ConnectorHarness', () => {
  let connector: ShipItConnector;
  let eventBus: EventBusClient;
  let harness: ConnectorHarness;

  beforeEach(() => {
    connector = createMockConnector();
    eventBus = createMockEventBus();
    harness = new ConnectorHarness(connector, eventBus, defaultConfig);
  });

  it('starts in IDLE state', () => {
    expect(harness.syncState).toBe(SyncState.IDLE);
  });

  it('calls discover -> fetch -> normalize in sequence during runSync', async () => {
    const callOrder: string[] = [];
    connector.authenticate = vi.fn().mockImplementation(async () => {
      callOrder.push('authenticate');
      return { success: true };
    });
    connector.discover = vi.fn().mockImplementation(async () => {
      callOrder.push('discover');
      return { entity_types: ['Repository'], total_entities: { Repository: 1 } };
    });
    connector.fetch = vi.fn().mockImplementation(async () => {
      callOrder.push('fetch');
      return { entities: [{ name: 'repo-1' }], has_more: false };
    });
    connector.normalize = vi.fn().mockImplementation(() => {
      callOrder.push('normalize');
      return createMockEntity('repo-1');
    });

    await harness.runSync('full');

    expect(callOrder).toEqual(['authenticate', 'discover', 'fetch', 'normalize']);
  });

  it('auto-publishes normalize() output to Event Bus', async () => {
    const result = await harness.runSync('full');

    expect(result.status).toBe('success');
    expect(eventBus.publish).toHaveBeenCalledTimes(1);

    const publishCall = vi.mocked(eventBus.publish).mock.calls[0];
    expect(publishCall[1]).toBe('mock-connector-1');
    const published = publishCall[0];
    expect(published).toHaveLength(1);
    expect(published[0].nodes).toHaveLength(1);
    expect(published[0].nodes[0].label).toBe('Repository');
    expect(published[0].edges).toHaveLength(1);
    expect(published[0].edges[0].type).toBe('OWNED_BY');
  });

  it('handles pagination with cursor', async () => {
    let callCount = 0;
    connector.fetch = vi.fn().mockImplementation(async (_type: string, cursor?: string) => {
      callCount++;
      if (!cursor) {
        return { entities: [{ name: 'repo-1' }], cursor: 'page2', has_more: true };
      }
      return { entities: [{ name: 'repo-2' }], has_more: false };
    });

    await harness.runSync('full');

    expect(callCount).toBe(2);
    expect(eventBus.publish).toHaveBeenCalledTimes(2);
  });

  it('returns failed status when authentication fails', async () => {
    connector.authenticate = vi.fn().mockResolvedValue({
      success: false,
      error: 'Invalid token',
    });

    const result = await harness.runSync('full');

    expect(result.status).toBe('failed');
    expect(result.errors).toContain('Invalid token');
    expect(harness.syncState).toBe(SyncState.FAILED);
  });

  it('returns partial status when some entity types fail', async () => {
    connector.discover = vi.fn().mockResolvedValue({
      entity_types: ['Repository', 'Team'],
      total_entities: { Repository: 1, Team: 1 },
    });
    let fetchCount = 0;
    connector.fetch = vi.fn().mockImplementation(async (entityType: string) => {
      fetchCount++;
      if (entityType === 'Team') {
        throw new Error('Team fetch failed');
      }
      return { entities: [{ name: 'repo-1' }], has_more: false };
    });

    const result = await harness.runSync('full');

    expect(result.status).toBe('partial');
    expect(result.entities_synced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(harness.syncState).toBe(SyncState.DEGRADED);
  });

  it('transitions to IDLE on successful sync', async () => {
    await harness.runSync('full');
    expect(harness.syncState).toBe(SyncState.IDLE);
  });
});

describe('dryRun', () => {
  it('does NOT publish to the Event Bus', async () => {
    const connector = createMockConnector();
    const eventBus = createMockEventBus();

    const result = await dryRun(connector, defaultConfig);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(result.sample_nodes).toHaveLength(1);
    expect(result.sample_edges).toHaveLength(1);
    expect(result.summary.total_nodes).toBe(1);
    expect(result.summary.total_edges).toBe(1);
    expect(result.summary.nodes_by_type).toEqual({ Repository: 1 });
    expect(result.summary.edges_by_type).toEqual({ OWNED_BY: 1 });
    expect(result.summary.entity_types_discovered).toEqual(['Repository']);
  });

  it('limits sample to 50 nodes and 20 edges', async () => {
    const manyNodes = Array.from({ length: 60 }, (_, i) => ({
      id: `shipit://repository/default/repo-${i}`,
      label: 'Repository',
      properties: { name: `repo-${i}` },
      _claims: [],
      _source_system: 'mock',
      _source_org: 'mock/org',
      _source_id: `mock://org/repo-${i}`,
      _last_synced: new Date().toISOString(),
      _event_version: 1,
    }));
    const manyEdges = Array.from({ length: 30 }, (_, i) => ({
      type: 'OWNED_BY',
      from: `shipit://repository/default/repo-${i}`,
      to: 'shipit://team/default/platform',
      _source: 'mock',
      _confidence: 0.9,
      _ingested_at: new Date().toISOString(),
    }));

    const connector = createMockConnector({
      normalize: vi.fn().mockReturnValue({ nodes: manyNodes, edges: manyEdges }),
    });

    const result = await dryRun(connector, defaultConfig);

    expect(result.sample_nodes).toHaveLength(50);
    expect(result.sample_edges).toHaveLength(20);
    expect(result.summary.total_nodes).toBe(60);
    expect(result.summary.total_edges).toBe(30);
  });

  it('throws on authentication failure', async () => {
    const connector = createMockConnector({
      authenticate: vi.fn().mockResolvedValue({
        success: false,
        error: 'Bad credentials',
      }),
    });

    await expect(dryRun(connector, defaultConfig)).rejects.toThrow(
      'Authentication failed: Bad credentials',
    );
  });
});
