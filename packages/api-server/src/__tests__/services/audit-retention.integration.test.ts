/**
 * Neo4j-BACKED integration test for the GraphEditEvent audit-retention cleanup
 * (AuditRetentionService). The unit suite (audit-retention-service.test.ts) fakes
 * Neo4j and compares `ts` as ISO strings, so it cannot prove the one thing that
 * only exists against a real DB: the `WHERE e.ts < datetime($cutoff)` predicate
 * comparing a real Neo4j DATETIME (written by `datetime()`) against a bound
 * datetime parameter, and DETACH DELETE removing the `[:EDITS]` edge with it.
 *
 * Gated on NEO4J_TEST_URI (default `pnpm test` stays Docker-free; CI's
 * `integration` job and a local throwaway container provide it). Every node id
 * is RUN-prefixed and cleanup is scoped to it, so it coexists with other
 * RUN-prefixed integration suites on a shared DB PROVIDED it runs serially
 * (`--no-file-parallelism`, the default for `pnpm test:integration`). It never
 * issues a blanket `MATCH (n) DETACH DELETE n` (shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Neo4jService } from '../../services/neo4j-service.js';
import { AuditRetentionService } from '../../services/audit-retention-service.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';

const RUN = `audit-ret-itest-${process.pid}-${Math.floor(performance.now())}`;
const idFor = (name: string): string => `shipit://LogicalService/${RUN}/${name}`;
const FIXED_NOW = new Date('2026-06-24T00:00:00.000Z');
const daysAgo = (n: number): string =>
  new Date(FIXED_NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe.skipIf(!URI)('audit-retention cleanup — Neo4j integration', () => {
  let neo4j: Neo4jService;
  let service: AuditRetentionService;

  // Seed a GraphEditEvent with an explicit `ts` (datetime) anchored to an entity
  // via [:EDITS], exactly as recordEvent does — so the cleanup's DETACH DELETE
  // is exercised against a real edge.
  async function seedEvent(eventId: string, entityName: string, ts: string): Promise<void> {
    await neo4j.runQuery(
      `MERGE (n:LogicalService {id: $entityId})
       CREATE (e:GraphEditEvent { id: $eventId, entity_id: $entityId, ts: datetime($ts) })
       CREATE (e)-[:EDITS]->(n)`,
      { eventId, entityId: idFor(entityName), ts },
    );
  }

  async function countEvents(): Promise<{ ids: string[] }> {
    const recs = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.entity_id STARTS WITH $p RETURN e.id AS id ORDER BY id`,
      { p: idFor('') },
    );
    return { ids: recs.map((r) => r.get('id') as string) };
  }

  async function editsEdgeCount(): Promise<number> {
    const recs = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent)-[r:EDITS]->(n) WHERE e.entity_id STARTS WITH $p RETURN count(r) AS c`,
      { p: idFor('') },
    );
    const raw = recs[0]?.get('c');
    return typeof raw === 'object' && raw && 'low' in raw
      ? Number((raw as { low: number }).low)
      : Number(raw);
  }

  beforeAll(async () => {
    neo4j = new Neo4jService(URI!, USER, PASSWORD);
    service = new AuditRetentionService(neo4j, {
      retentionDays: 90,
      now: () => FIXED_NOW,
      batchSize: 100,
    });
  });

  afterEach(async () => {
    await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.entity_id STARTS WITH $p DETACH DELETE e`,
      { p: idFor('') },
    );
    await neo4j.runQuery('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: idFor('') });
  });

  afterAll(async () => {
    await neo4j?.close();
  });

  it('deletes only the old GraphEditEvent (and its EDITS edge), keeping the recent one', async () => {
    await seedEvent(`ge:${RUN}-old`, 'svc-old', daysAgo(120));
    await seedEvent(`ge:${RUN}-recent`, 'svc-recent', daysAgo(10));

    expect((await countEvents()).ids).toHaveLength(2);
    expect(await editsEdgeCount()).toBe(2);

    const deleted = await service.cleanup();

    expect(deleted).toBe(1);
    const after = await countEvents();
    expect(after.ids).toEqual([`ge:${RUN}-recent`]);
    // The old event's [:EDITS] edge went with it; only the recent one remains.
    expect(await editsEdgeCount()).toBe(1);
  });

  it('loops across batches to drain a backlog larger than one batch', async () => {
    const small = new AuditRetentionService(neo4j, {
      retentionDays: 90,
      now: () => FIXED_NOW,
      batchSize: 10,
    });
    for (let i = 0; i < 25; i++) await seedEvent(`ge:${RUN}-b${i}`, `svc-b${i}`, daysAgo(100 + i));

    const deleted = await small.cleanup();

    expect(deleted).toBe(25);
    expect((await countEvents()).ids).toHaveLength(0);
  });
});
