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
    // Re-point audit relationships from loser to survivor.
    if (
      cypher.includes('EDITS|VERIFIES') ||
      cypher.includes(':EDITS') ||
      cypher.includes(':VERIFIES')
    ) {
      let moved = 0;
      for (const a of this.audits) {
        if (a.nodeId === (p.loser as string)) {
          a.nodeId = p.survivor as string;
          moved++;
        }
      }
      return [{ get: (k: string) => (k === 'moved' ? moved : undefined) }];
    }
    // MergeEvent CREATE + soft-delete.
    if (cypher.includes('MergeEvent')) {
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
