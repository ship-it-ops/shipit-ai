import { describe, it, expect, beforeEach } from 'vitest';
import { AuditRetentionService } from '../../services/audit-retention-service.js';

// In-memory Neo4j stand-in that understands the single batched delete query the
// AuditRetentionService issues:
//   MATCH (e:GraphEditEvent) WHERE e.ts < $cutoff WITH e LIMIT $batch
//   DETACH DELETE e RETURN count(e) AS deleted
// It models `ts` as an ISO string and `$cutoff` as an ISO string so the unit
// test can assert the cutoff-filtered, batched, looped-until-drained behavior
// without a real DB (real datetime() comparison is covered by the integration
// suite).
interface FakeEvent {
  id: string;
  ts: string; // ISO timestamp
}
class FakeNeo4j {
  events: FakeEvent[] = [];
  // Records every query the service issued, for assertions.
  calls: { cypher: string; params: Record<string, unknown> }[] = [];

  seed(id: string, ts: string) {
    this.events.push({ id, ts });
  }

  async runQuery(cypher: string, params: Record<string, unknown> = {}) {
    this.calls.push({ cypher, params });
    if (cypher.includes('GraphEditEvent') && cypher.includes('DETACH DELETE')) {
      const cutoff = params.cutoff as string;
      const batch = Number(params.batch);
      // Match the Cypher predicate `e.ts < $cutoff`, oldest-first, up to $batch.
      const due = this.events
        .filter((e) => e.ts < cutoff)
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(0, batch);
      const ids = new Set(due.map((e) => e.id));
      this.events = this.events.filter((e) => !ids.has(e.id));
      return [{ get: (k: string) => (k === 'deleted' ? due.length : undefined) }];
    }
    return [];
  }
}

const FIXED_NOW = new Date('2026-06-24T00:00:00.000Z');
const daysAgo = (n: number): string =>
  new Date(FIXED_NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('AuditRetentionService', () => {
  let fake: FakeNeo4j;

  beforeEach(() => {
    fake = new FakeNeo4j();
  });

  function make(retentionDays: number, batch?: number, maxIterations?: number) {
    return new AuditRetentionService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      { retentionDays, now: () => FIXED_NOW, batchSize: batch, maxIterations },
    );
  }

  it('deletes only GraphEditEvent nodes older than the cutoff (now - retentionDays)', async () => {
    fake.seed('ge:old1', daysAgo(120));
    fake.seed('ge:old2', daysAgo(91));
    fake.seed('ge:recent', daysAgo(10));

    const deleted = await make(90).cleanup();

    expect(deleted).toBe(2);
    expect(fake.events.map((e) => e.id)).toEqual(['ge:recent']);
  });

  it('issues a cutoff-filtered, batched DETACH DELETE against GraphEditEvent', async () => {
    fake.seed('ge:old', daysAgo(200));
    await make(90, 500).cleanup();

    const deleteCall = fake.calls.find((c) => c.cypher.includes('DETACH DELETE'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.cypher).toContain('GraphEditEvent');
    expect(deleteCall!.cypher).toContain('e.ts < datetime($cutoff)');
    expect(deleteCall!.cypher).toContain('LIMIT $batch');
    // Marshalled as a Neo4j INTEGER (LIMIT rejects floats); coerce to compare.
    expect(Number(deleteCall!.params.batch)).toBe(500);
    // Cutoff is now - 90d, passed as a bound parameter (not interpolated).
    expect(deleteCall!.params.cutoff).toBe(daysAgo(90));
  });

  it('respects the configured retention window', async () => {
    fake.seed('ge:d40', daysAgo(40));
    fake.seed('ge:d20', daysAgo(20));

    // 30-day window: only the 40-day-old event is past the cutoff.
    const deleted = await make(30).cleanup();

    expect(deleted).toBe(1);
    expect(fake.events.map((e) => e.id)).toEqual(['ge:d20']);
  });

  it('loops until the backlog is drained (multiple batches)', async () => {
    for (let i = 0; i < 250; i++) fake.seed(`ge:${i}`, daysAgo(100 + i));

    const deleted = await make(90, 100).cleanup();

    expect(deleted).toBe(250);
    expect(fake.events).toHaveLength(0);
    // 250 due / 100 batch → passes return 100, 100, 50; the third pass deletes
    // fewer than a full batch, so the loop stops without a 4th no-op query.
    const deleteCalls = fake.calls.filter((c) => c.cypher.includes('DETACH DELETE'));
    expect(deleteCalls).toHaveLength(3);
  });

  it('caps iterations defensively and does not loop forever', async () => {
    for (let i = 0; i < 1000; i++) fake.seed(`ge:${i}`, daysAgo(100 + i));

    // batch 10, cap 5 iterations → at most 50 deleted, then it stops.
    const deleted = await make(90, 10, 5).cleanup();

    expect(deleted).toBe(50);
    const deleteCalls = fake.calls.filter((c) => c.cypher.includes('DETACH DELETE'));
    expect(deleteCalls).toHaveLength(5);
    // 950 left undeleted — proves the cap fired rather than draining everything.
    expect(fake.events).toHaveLength(950);
  });

  it('is a no-op when retention is disabled (retentionDays = 0)', async () => {
    fake.seed('ge:ancient', daysAgo(10_000));

    const deleted = await make(0).cleanup();

    expect(deleted).toBe(0);
    expect(fake.calls).toHaveLength(0); // never touched the DB
    expect(fake.events).toHaveLength(1);
    expect(make(0).enabled).toBe(false);
  });
});
