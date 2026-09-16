// Unit-level coverage for Neo4jService query SHAPE — no real Neo4j (the
// integration suite in neo4j-service.integration.test.ts needs a container).
// Here we intercept runQuery to assert getGraphStats excludes the app's internal
// audit/bookkeeping relationship types from the dashboard edgeCount, mirroring
// the existing node-label exclusion.
import { describe, it, expect, vi } from 'vitest';
import { SYSTEM_CONTEXT } from '@shipit-ai/shared';
import { Neo4jService } from '../../services/neo4j-service.js';

function num(n: number) {
  return { toNumber: () => n };
}

describe('Neo4jService.getGraphStats edge-count exclusion (unit)', () => {
  it('excludes internal audit rel types (EDITS/VERIFIES/MERGED/ABSORBED) from edgeCount', async () => {
    // Don't open a real driver connection.
    const svc = Object.create(Neo4jService.prototype) as Neo4jService;

    const seenQueries: string[] = [];
    // The relationship-types query the fake returns must already reflect the
    // Cypher-side WHERE filter (real Neo4j applies it). We assert (a) the query
    // carries the exclusion clause and (b) only the filtered set is summed.
    vi.spyOn(
      svc as unknown as { runQuery: typeof Neo4jService.prototype.runQuery },
      'runQuery',
    ).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (cypher: string) => {
        seenQueries.push(cypher);
        if (cypher.includes('db.labels()')) {
          return [{ get: (k: string) => (k === 'label' ? 'Repository' : num(3)) }] as never;
        }
        if (cypher.includes('db.relationshipTypes()')) {
          // Simulate Neo4j honoring the `WHERE NOT relationshipType IN [...]`
          // clause: internal types are already gone, so only user-facing ones
          // come back. The audit types must NOT be summed into edgeCount.
          return [
            { get: (k: string) => (k === 'relationshipType' ? 'DEPENDS_ON' : num(10)) },
            { get: (k: string) => (k === 'relationshipType' ? 'OWNS' : num(5)) },
          ] as never;
        }
        return [] as never;
      }) as never,
    );

    const stats = await svc.getGraphStats(SYSTEM_CONTEXT);

    // The relationship-types query must carry the internal-type exclusion.
    const relQuery = seenQueries.find((q) => q.includes('db.relationshipTypes()'))!;
    expect(relQuery).toContain('WHERE NOT relationshipType IN');
    for (const t of ['EDITS', 'VERIFIES', 'MERGED', 'ABSORBED']) {
      expect(relQuery).toContain(`'${t}'`);
    }

    // edgeCount sums only the user-facing rel types.
    expect(stats.edgeCount).toBe(15);
    expect(Object.keys(stats.edgeCountsByType)).toEqual(['DEPENDS_ON', 'OWNS']);
    expect(stats.edgeCountsByType).not.toHaveProperty('EDITS');
    expect(stats.edgeCountsByType).not.toHaveProperty('VERIFIES');
  });
});

describe('Neo4jService absent-node filtering (unit)', () => {
  function serviceWithSpy() {
    const svc = Object.create(Neo4jService.prototype) as Neo4jService;
    const seen: string[] = [];
    vi.spyOn(
      svc as unknown as { runQuery: typeof Neo4jService.prototype.runQuery },
      'runQuery',
    ).mockImplementation((async (cypher: string) => {
      seen.push(cypher);
      return [] as never;
    }) as never);
    return { svc, seen };
  }

  it('getOverview excludes absent nodes by default and includes them on request', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getOverview(SYSTEM_CONTEXT, { limit: 10 });
    expect(seen[0]).toContain('n._absent_since IS NULL');
    await svc.getOverview(SYSTEM_CONTEXT, { limit: 10, includeAbsent: true });
    expect(seen[1]).not.toContain('_absent_since');
  });

  it('searchEntities excludes absent nodes by default and includes them on request', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.searchEntities(SYSTEM_CONTEXT, { q: 'api' });
    expect(seen[0]).toContain('n._absent_since IS NULL');
    await svc.searchEntities(SYSTEM_CONTEXT, { q: 'api', includeAbsent: true });
    expect(seen[1]).not.toContain('_absent_since');
  });

  it('getSources and getGraphStats node counts exclude absent nodes by default', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getSources();
    expect(seen[0]).toContain('n._absent_since IS NULL');
    await svc.getGraphStats(SYSTEM_CONTEXT);
    const labelsQuery = seen.find((q) => q.includes('db.labels()'))!;
    expect(labelsQuery).toContain('n._absent_since IS NULL');
  });

  it('getGraphStats edge count filters BOTH endpoints under the same includeAbsent guard', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getGraphStats(SYSTEM_CONTEXT);
    const relQuery = seen.find((q) => q.includes('db.relationshipTypes()'))!;
    // Without this the dashboard reports a node total that excludes swept
    // workloads next to an edge total that still counts their relationships.
    expect(relQuery).toContain('a._absent_since IS NULL');
    expect(relQuery).toContain('b._absent_since IS NULL');

    seen.length = 0;
    await svc.getGraphStats(SYSTEM_CONTEXT, { includeAbsent: true });
    const inclusive = seen.find((q) => q.includes('db.relationshipTypes()'))!;
    expect(inclusive).not.toContain('_absent_since');
    // …and the node count stays consistent with it.
    expect(seen.find((q) => q.includes('db.labels()'))!).not.toContain('_absent_since');
  });

  it('getNeighborhood drops absent nodes and their edges unless includeAbsent', async () => {
    const svc = Object.create(Neo4jService.prototype) as Neo4jService;
    const record = {
      get: (k: string) =>
        k === 'nodes'
          ? [
              { properties: { id: 'a', name: 'a' }, labels: ['Deployment'] },
              {
                properties: { id: 'b', name: 'b', _absent_since: '2026-09-16T10:00:00.000Z' },
                labels: ['Deployment'],
              },
            ]
          : [{ source: 'a', target: 'b', type: 'DEPENDS_ON', props: {} }],
    };
    vi.spyOn(
      svc as unknown as { runQuery: typeof Neo4jService.prototype.runQuery },
      'runQuery',
    ).mockResolvedValue([record] as never);

    const hidden = await svc.getNeighborhood(SYSTEM_CONTEXT, 'a', 1);
    expect(hidden.nodes.map((n) => n.data.id)).toEqual(['a']);
    expect(hidden.edges).toEqual([]);

    const shown = await svc.getNeighborhood(SYSTEM_CONTEXT, 'a', 1, { includeAbsent: true });
    expect(shown.nodes.map((n) => n.data.id)).toEqual(['a', 'b']);
    expect(shown.edges).toHaveLength(1);
  });
});
