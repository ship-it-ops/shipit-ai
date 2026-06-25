import { describe, it, expect, beforeEach } from 'vitest';
import type { PropertyClaim } from '@shipit-ai/shared';
import { getSourceReliability, pickManualOverride } from '@shipit-ai/shared';
import { ReconciliationService } from '../../services/reconciliation-service.js';

const MANUAL_RELIABILITY = getSourceReliability('manual').reliability;

// In-memory Neo4j stand-in for the reconciliation merge path. It models exactly
// the queries `confirmMerge` issues:
//   - getCandidate's read (`MATCH (c:ReconciliationCandidate ...) RETURN c, a, b`)
//   - the locked claims read on survivor + loser (`SET n._claims_rev ... RETURN n`)
//   - the survivor `_claims` write
//   - the audit re-point (`MATCH (loser)<-[r:EDITS|VERIFIES]-(e) ... CREATE (e)-[...]->(survivor) DELETE r`)
//   - the MergeEvent CREATE + soft-delete SET
// Anything else is a no-op, mirroring the other service fakes in this suite.
interface FakeNode {
  properties: Record<string, unknown>;
  labels: string[];
}
interface AuditRel {
  type: 'EDITS' | 'VERIFIES';
  eventId: string;
  nodeId: string; // the node the event currently points at
}

class FakeNeo4j {
  nodes = new Map<string, FakeNode>();
  audits: AuditRel[] = [];
  mergeEvents: Record<string, unknown>[] = [];

  seedNode(
    id: string,
    label: string,
    claims: PropertyClaim[],
    extra: Record<string, unknown> = {},
  ) {
    this.nodes.set(id, {
      properties: { id, name: id.split('/').pop(), _claims: claims, ...extra },
      labels: [label],
    });
  }

  seedCandidate(opts: { id: string; leftId: string; rightId: string; status?: string }) {
    this.nodes.set(opts.id, {
      properties: {
        id: opts.id,
        status: opts.status ?? 'pending',
        label: 'Repository',
        confidence: 0.9,
        createdAt: '2026-06-24T00:00:00Z',
        reviewedAt: null,
        reviewedBy: null,
        _left: opts.leftId,
        _right: opts.rightId,
      },
      labels: ['ReconciliationCandidate'],
    });
  }

  seedAudit(rel: AuditRel) {
    this.audits.push(rel);
  }

  claimsOf(id: string): PropertyClaim[] {
    const raw = this.nodes.get(id)?.properties._claims;
    if (Array.isArray(raw)) return raw as PropertyClaim[];
    if (typeof raw === 'string') return JSON.parse(raw) as PropertyClaim[];
    return [];
  }

  async runQuery(cypher: string, params: Record<string, unknown> = {}) {
    // getCandidate: returns c, a, b for a candidate id.
    if (
      cypher.includes('(c:ReconciliationCandidate {id: $id})') &&
      cypher.includes('RETURN c, a, b')
    ) {
      const c = this.nodes.get(params.id as string);
      if (!c) return [];
      const a = this.nodes.get(c.properties._left as string)!;
      const b = this.nodes.get(c.properties._right as string)!;
      return [
        {
          get: (k: string) => (k === 'c' ? c : k === 'a' ? a : k === 'b' ? b : undefined),
        },
      ];
    }
    // splitMerge: read the merge provenance recorded at confirm time.
    if (
      cypher.includes('MATCH (m:MergeEvent {id: $id})') &&
      cypher.includes('RETURN m.survivorId')
    ) {
      const m = this.mergeEvents.find((e) => e.mergeId === params.id);
      if (!m) return [];
      return [
        {
          get: (k: string) =>
            k === 'survivor'
              ? m.survivor
              : k === 'loser'
                ? m.loser
                : k === 'migratedClaims'
                  ? m.migratedClaims
                  : k === 'repointedAuditIds'
                    ? m.repointedAuditIds
                    : k === 'reversedAt'
                      ? (m.reversedAt ?? null)
                      : undefined,
        },
      ];
    }
    return [];
  }

  // A tx whose `run` returns { records } and understands the merge transaction's
  // queries. State mutations are applied directly to the fake's maps/arrays.
  async runInWriteTransaction<T>(
    work: (tx: {
      run: (c: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>;
    }) => Promise<T>,
  ): Promise<T> {
    const run = async (cypher: string, p: Record<string, unknown> = {}) => ({
      records: this.txRun(cypher, p),
    });
    return work({ run });
  }

  private txRun(cypher: string, p: Record<string, unknown>): unknown[] {
    // Locked read of a node's claims (bumps _claims_rev).
    if (cypher.includes('SET n._claims_rev') && cypher.includes('RETURN n')) {
      const node = this.nodes.get(p.id as string);
      if (!node) return [];
      node.properties._claims_rev = (Number(node.properties._claims_rev) || 0) + 1;
      return [
        { get: (k: string) => (k === 'n' ? node : k === 'labels' ? node.labels : undefined) },
      ];
    }
    // Survivor claims write.
    if (cypher.includes('SET n._claims') && cypher.includes('$claims')) {
      const node = this.nodes.get(p.id as string);
      if (node) node.properties._claims = p.claims;
      return [];
    }
    // splitMerge: send specific audit edges back from survivor to loser (by event id).
    if ((cypher.includes(':EDITS') || cypher.includes(':VERIFIES')) && cypher.includes('$ids')) {
      const relType = cypher.includes(':VERIFIES') ? 'VERIFIES' : 'EDITS';
      const ids = (p.ids as string[]) ?? [];
      for (const a of this.audits) {
        if (a.nodeId === (p.survivor as string) && a.type === relType && ids.includes(a.eventId)) {
          a.nodeId = p.loser as string;
        }
      }
      return [];
    }
    // confirmMerge: re-point audit relationships from loser to survivor; returns e.id per moved edge.
    if (cypher.includes(':EDITS') || cypher.includes(':VERIFIES')) {
      const relType = cypher.includes(':VERIFIES') ? 'VERIFIES' : 'EDITS';
      const movedIds: string[] = [];
      for (const a of this.audits) {
        if (a.nodeId === (p.loser as string) && a.type === relType) {
          a.nodeId = p.survivor as string;
          movedIds.push(a.eventId);
        }
      }
      return movedIds.map((id) => ({ get: (k: string) => (k === 'id' ? id : undefined) }));
    }
    // splitMerge: restore the loser + mark the MergeEvent reversed.
    if (cypher.includes('reversedAt')) {
      const m = this.mergeEvents.find((e) => e.mergeId === p.id);
      if (m) {
        m.reversedAt = '2026-06-24T00:00:00Z';
        m.reversedBy = p.actor;
        const l = this.nodes.get(m.loser as string);
        if (l) {
          l.properties._deleted = false;
          delete l.properties._merged_into;
          delete l.properties._merged_at;
        }
      }
      return [];
    }
    // confirmMerge: MergeEvent CREATE + soft-delete.
    if (cypher.includes('CREATE (m:MergeEvent')) {
      this.mergeEvents.push({ ...p });
      const loser = this.nodes.get(p.loser as string);
      if (loser) {
        loser.properties._deleted = true;
        loser.properties._merged_into = p.survivor;
      }
      return [];
    }
    return [];
  }
}

function claim(over: Partial<PropertyClaim>): PropertyClaim {
  return {
    property_key: 'tier',
    value: 'gold',
    source: 'github',
    source_id: 'github://org/api',
    ingested_at: '2026-06-01T00:00:00Z',
    confidence: 0.9,
    evidence: null,
    ...over,
  };
}

function manualClaim(actor: string, over: Partial<PropertyClaim> = {}): PropertyClaim {
  return claim({
    source: `manual:${actor}`,
    source_id: `manual://#tier`,
    confidence: MANUAL_RELIABILITY,
    ...over,
  });
}

describe('ReconciliationService — manual-edit migration on merge (T-merge)', () => {
  let fake: FakeNeo4j;
  let service: ReconciliationService;
  const SURVIVOR = 'shipit://repository/default/org/api';
  const LOSER = 'shipit://repository/default/org/api-dup';
  const CAND = 'rc:1';

  beforeEach(() => {
    fake = new FakeNeo4j();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ReconciliationService(fake as any, 0.7);
  });

  // pickSurvivor: equal tier → older _last_synced wins; give the survivor the
  // older sync so it is deterministically chosen as the merge survivor.
  function seedPair(survivorClaims: PropertyClaim[], loserClaims: PropertyClaim[]) {
    fake.seedNode(SURVIVOR, 'Repository', survivorClaims, { _last_synced: '2026-01-01T00:00:00Z' });
    fake.seedNode(LOSER, 'Repository', loserClaims, { _last_synced: '2026-05-01T00:00:00Z' });
    fake.seedCandidate({ id: CAND, leftId: SURVIVOR, rightId: LOSER });
  }

  it('migrates a manual override from the loser onto the survivor and the survivor resolves to it', async () => {
    // Loser carries a human override on `tier`; survivor only has a connector claim.
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);

    await service.confirmMerge(CAND, 'admin@x');

    const survivorClaims = fake.claimsOf(SURVIVOR);
    const migrated = survivorClaims.find((c) => c.source === 'manual:alice');
    expect(migrated, 'manual claim should be migrated to survivor').toBeDefined();
    expect(migrated!.value).toBe('platinum');

    // The survivor's resolved winner for `tier` reflects the manual override.
    const group = survivorClaims.filter((c) => c.property_key === 'tier');
    expect(pickManualOverride(group)!.value).toBe('platinum');
  });

  it('re-points the loser GraphEditEvent [:EDITS] relationship at the survivor', async () => {
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);
    fake.seedAudit({ type: 'EDITS', eventId: 'ge:1', nodeId: LOSER });

    await service.confirmMerge(CAND, 'admin@x');

    const audit = fake.audits.find((a) => a.eventId === 'ge:1')!;
    expect(audit.nodeId, 'EDITS should now point at the survivor').toBe(SURVIVOR);
  });

  it('re-points a VERIFIES relationship and migrates verified claims too', async () => {
    seedPair(
      [claim({ value: 'silver' })],
      [claim({ source: 'verified:bob', source_id: 'verified://#tier', value: 'bronze' })],
    );
    fake.seedAudit({ type: 'VERIFIES', eventId: 've:1', nodeId: LOSER });

    await service.confirmMerge(CAND, 'admin@x');

    const survivorClaims = fake.claimsOf(SURVIVOR);
    expect(survivorClaims.find((c) => c.source === 'verified:bob')).toBeDefined();
    const audit = fake.audits.find((a) => a.eventId === 've:1')!;
    expect(audit.nodeId).toBe(SURVIVOR);
  });

  it('does not migrate plain connector claims (only human attestations move)', async () => {
    seedPair(
      [claim({ value: 'silver' })],
      [claim({ source: 'datadog', source_id: 'datadog://x', value: 'noise' })],
    );

    await service.confirmMerge(CAND, 'admin@x');

    const survivorClaims = fake.claimsOf(SURVIVOR);
    expect(survivorClaims.find((c) => c.source === 'datadog')).toBeUndefined();
  });

  it('does not duplicate a claim already present on the survivor (merge by source/source_id/property)', async () => {
    const shared = manualClaim('alice', { value: 'platinum' });
    seedPair([shared], [shared]);

    await service.confirmMerge(CAND, 'admin@x');

    const survivorClaims = fake.claimsOf(SURVIVOR);
    const manual = survivorClaims.filter((c) => c.source === 'manual:alice');
    expect(manual).toHaveLength(1);
  });

  it('bumps the survivor _claims_rev (honors the lock authority)', async () => {
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);
    const before = Number(fake.nodes.get(SURVIVOR)!.properties._claims_rev) || 0;

    await service.confirmMerge(CAND, 'admin@x');

    const after = Number(fake.nodes.get(SURVIVOR)!.properties._claims_rev) || 0;
    expect(after).toBeGreaterThan(before);
  });

  it('still soft-deletes the loser (migration is additive)', async () => {
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);

    await service.confirmMerge(CAND, 'admin@x');

    expect(fake.nodes.get(LOSER)!.properties._deleted).toBe(true);
    expect(fake.nodes.get(LOSER)!.properties._merged_into).toBe(SURVIVOR);
  });
});

describe('ReconciliationService — splitMerge reverses the migration (un-merge)', () => {
  let fake: FakeNeo4j;
  let service: ReconciliationService;
  const SURVIVOR = 'shipit://repository/default/org/api';
  const LOSER = 'shipit://repository/default/org/api-dup';
  const CAND = 'rc:1';

  beforeEach(() => {
    fake = new FakeNeo4j();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ReconciliationService(fake as any, 0.7);
  });

  function seedPair(survivorClaims: PropertyClaim[], loserClaims: PropertyClaim[]) {
    fake.seedNode(SURVIVOR, 'Repository', survivorClaims, { _last_synced: '2026-01-01T00:00:00Z' });
    fake.seedNode(LOSER, 'Repository', loserClaims, { _last_synced: '2026-05-01T00:00:00Z' });
    fake.seedCandidate({ id: CAND, leftId: SURVIVOR, rightId: LOSER });
  }

  it('removes the migrated manual claim from the survivor and restores the loser', async () => {
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);
    fake.seedAudit({ type: 'EDITS', eventId: 'ge:1', nodeId: LOSER });
    const merge = await service.confirmMerge(CAND, 'admin@x');
    // sanity: confirm migrated the claim + re-pointed the audit edge
    expect(fake.claimsOf(SURVIVOR).find((c) => c.source === 'manual:alice')).toBeDefined();
    expect(fake.audits.find((a) => a.eventId === 'ge:1')!.nodeId).toBe(SURVIVOR);

    await service.splitMerge(merge.id, 'admin@x');

    expect(
      fake.claimsOf(SURVIVOR).find((c) => c.source === 'manual:alice'),
      'migrated claim removed from survivor',
    ).toBeUndefined();
    expect(
      fake.audits.find((a) => a.eventId === 'ge:1')!.nodeId,
      'EDITS edge sent back to the loser',
    ).toBe(LOSER);
    expect(fake.nodes.get(LOSER)!.properties._deleted, 'loser restored').toBe(false);
  });

  it('round-trips a verified claim + VERIFIES edge', async () => {
    seedPair(
      [claim({ value: 'silver' })],
      [claim({ source: 'verified:bob', source_id: 'verified://#tier', value: 'bronze' })],
    );
    fake.seedAudit({ type: 'VERIFIES', eventId: 've:1', nodeId: LOSER });
    const merge = await service.confirmMerge(CAND, 'admin@x');

    await service.splitMerge(merge.id, 'admin@x');

    expect(fake.claimsOf(SURVIVOR).find((c) => c.source === 'verified:bob')).toBeUndefined();
    expect(fake.audits.find((a) => a.eventId === 've:1')!.nodeId).toBe(LOSER);
  });

  it('leaves a claim the survivor independently owns untouched', async () => {
    const carol = claim({
      property_key: 'name',
      source: 'manual:carol',
      source_id: 'manual://survivor#name',
      value: 'API Service',
    });
    seedPair([claim({ value: 'silver' }), carol], [manualClaim('alice', { value: 'platinum' })]);
    const merge = await service.confirmMerge(CAND, 'admin@x');

    await service.splitMerge(merge.id, 'admin@x');

    const survivorClaims = fake.claimsOf(SURVIVOR);
    expect(
      survivorClaims.find((c) => c.source === 'manual:alice'),
      'migrated claim removed',
    ).toBeUndefined();
    expect(
      survivorClaims.find((c) => c.source === 'manual:carol'),
      'survivor-owned claim kept',
    ).toBeDefined();
  });

  it('a merge that migrated nothing just restores the loser (no throw)', async () => {
    seedPair(
      [claim({ value: 'silver' })],
      [claim({ source: 'datadog', source_id: 'datadog://x', value: 'noise' })],
    );
    const merge = await service.confirmMerge(CAND, 'admin@x');

    await expect(service.splitMerge(merge.id, 'admin@x')).resolves.toBeUndefined();
    expect(fake.nodes.get(LOSER)!.properties._deleted).toBe(false);
  });

  it('is safe to split twice (idempotent)', async () => {
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);
    const merge = await service.confirmMerge(CAND, 'admin@x');

    await service.splitMerge(merge.id, 'admin@x');
    await expect(service.splitMerge(merge.id, 'admin@x')).resolves.toBeUndefined();

    expect(fake.claimsOf(SURVIVOR).find((c) => c.source === 'manual:alice')).toBeUndefined();
  });

  it('a survivor re-edit of a migrated property (new survivor-scoped source_id) survives split', async () => {
    // Pins the cross-service invariant: removal matches the recorded identity
    // triple (loser-scoped source_id). manual-edit-service REPLACES a re-edit by
    // (source, property_key) and writes a SURVIVOR-scoped source_id, so the
    // migrated loser-scoped claim is gone and the re-edit has a different identity
    // → split must NOT drop the survivor's freshly re-attested value.
    seedPair([claim({ value: 'silver' })], [manualClaim('alice', { value: 'platinum' })]);
    const merge = await service.confirmMerge(CAND, 'admin@x');
    // Simulate the post-merge manual re-edit on the survivor.
    fake.nodes.get(SURVIVOR)!.properties._claims = [
      claim({ value: 'silver' }),
      claim({
        source: 'manual:alice',
        source_id: 'manual://survivor#tier',
        value: 'gold-reedited',
      }),
    ];

    await service.splitMerge(merge.id, 'admin@x');

    const reedited = fake.claimsOf(SURVIVOR).find((c) => c.source === 'manual:alice');
    expect(reedited, 're-edited survivor claim survives split').toBeDefined();
    expect(reedited!.value).toBe('gold-reedited');
  });
});
