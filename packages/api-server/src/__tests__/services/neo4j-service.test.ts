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
