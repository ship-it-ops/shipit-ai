import { describe, it, expect, beforeEach } from 'vitest';
import { pickManualOverride, type PropertyClaim } from '@shipit-ai/shared';
import { VerificationService } from '../../services/verification-service.js';
import { ClaimService } from '../../services/claim-service.js';

// Minimal in-memory Neo4j stand-in that understands only the handful of queries
// the claim/verification services issue. Keyed by node id.
interface FakeNode {
  properties: Record<string, unknown>;
  labels: string[];
}
class FakeNeo4j {
  nodes = new Map<string, FakeNode>();
  events: Record<string, unknown>[] = [];
  graphEditEvents: Record<string, unknown>[] = [];

  seed(id: string, label: string, claims: PropertyClaim[], extra: Record<string, unknown> = {}) {
    this.nodes.set(id, {
      properties: { id, name: id.split('/').pop(), _claims: claims, ...extra },
      labels: [label],
    });
  }

  async runQuery(cypher: string, params: Record<string, unknown> = {}) {
    // `LIMIT 1` first: the locked-read (`SET n._claims_rev ... RETURN n ... LIMIT 1`)
    // contains the substring `SET n._claims`, so it must be matched as a read
    // before the claims-write branch.
    if (cypher.includes('LIMIT 1')) {
      const node = this.nodes.get(params.id as string);
      return node ? [record(node)] : [];
    }
    if (cypher.includes('n._claims IS NOT NULL')) {
      // The Cypher predicate is applied in real Neo4j; the fake returns every
      // claim-bearing node and lets the service's app-side loop filter. Mirror
      // that: return all seeded nodes.
      return [...this.nodes.values()].map(record);
    }
    if (cypher.includes('CREATE (v:VerificationEvent')) {
      this.events.push({ ...params });
      return [];
    }
    // Dedup query for already-emitted `contradicted` events.
    if (cypher.includes("GraphEditEvent {kind: 'contradicted'}")) {
      return this.graphEditEvents
        .filter((e) => e.kind === 'contradicted')
        .map((e) => ({
          get: (k: string) =>
            k === 'entityId'
              ? e.entityId
              : k === 'propertyKey'
                ? e.propertyKey
                : k === 'newValue'
                  ? e.newValue
                  : undefined,
        }));
    }
    if (cypher.includes('CREATE (e:GraphEditEvent')) {
      this.graphEditEvents.push({ ...params });
      return [];
    }
    if (cypher.includes('SET n._claims')) {
      const node = this.nodes.get(params.id as string);
      if (node) node.properties._claims = params.claims;
      return [];
    }
    return [];
  }

  // Mirror Neo4jService.runInWriteTransaction: hand `work` a tx whose `run`
  // returns a { records } result (the shape the service reads).
  async runInWriteTransaction<T>(
    work: (tx: {
      run: (c: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>;
    }) => Promise<T>,
  ): Promise<T> {
    return work({
      run: async (cypher: string, p: Record<string, unknown> = {}) => ({
        records: await this.runQuery(cypher, p),
      }),
    });
  }
}
function record(node: FakeNode) {
  return {
    get: (k: string) => (k === 'labels' ? node.labels : k === 'n' ? node : undefined),
  };
}
const schemaStub = { getSchema: () => null };

function claim(over: Partial<PropertyClaim>): PropertyClaim {
  return {
    property_key: 'name',
    value: 'api',
    source: 'github',
    source_id: 'github://org/api',
    ingested_at: new Date().toISOString(),
    confidence: 0.9,
    evidence: null,
    ...over,
  };
}

describe('VerificationService', () => {
  let fake: FakeNeo4j;
  let verification: VerificationService;
  let claims: ClaimService;
  const ID = 'shipit://repository/default/org/api';

  beforeEach(() => {
    fake = new FakeNeo4j();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verification = new VerificationService(fake as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claims = new ClaimService(fake as any, schemaStub as any);
  });

  function storedClaims(): PropertyClaim[] {
    const raw = fake.nodes.get(ID)!.properties._claims;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as PropertyClaim[]);
  }
  async function statusOf(key = 'name') {
    const res = await claims.getClaimsForEntity(ID);
    return res!.properties.find((p) => p.property_key === key)!;
  }

  it('verify appends a verified:<actor> claim + audit event', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await verification.verify(ID, 'name', 'api', 'mohamed@x');

    const verified = storedClaims().find((c) => c.source.startsWith('verified:'));
    expect(verified).toBeDefined();
    expect(verified!.verified_by).toBe('mohamed@x');
    expect(verified!.verified_value).toBe('api');
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0].kind).toBe('verified');
  });

  it('a verified field reads as USER_VERIFIED with floored confidence', async () => {
    fake.seed(ID, 'Repository', [claim({ ingested_at: '2020-01-01T00:00:00Z' })]); // heavily decayed
    await verification.verify(ID, 'name', 'api', 'mohamed@x');
    const prop = await statusOf();
    expect(prop.status).toBe('USER_VERIFIED');
    expect(prop.confidence).toBeGreaterThanOrEqual(0.98);
  });

  it('an agreeing re-sync does not enter the review queue', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await verification.verify(ID, 'name', 'api', 'mohamed@x');
    // connector re-asserts the same value, newer
    const cur = storedClaims();
    cur.push(claim({ ingested_at: new Date(Date.now() + 1000).toISOString() }));
    fake.nodes.get(ID)!.properties._claims = cur;

    expect(await verification.listReviewQueue()).toHaveLength(0);
    expect((await statusOf()).needs_review).toBe(false);
  });

  it('a contradicting re-sync enters the review queue and flags needs_review', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await verification.verify(ID, 'name', 'api', 'mohamed@x');
    const cur = storedClaims();
    cur.push(
      claim({ value: 'api-service', ingested_at: new Date(Date.now() + 1000).toISOString() }),
    );
    fake.nodes.get(ID)!.properties._claims = cur;

    const queue = await verification.listReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].verifiedValue).toBe('api');
    expect(queue[0].proposedValue).toBe('api-service');

    const prop = await statusOf();
    expect(prop.status).toBe('USER_VERIFIED'); // value still pinned to verified
    expect(prop.effective_value).toBe('api');
    expect(prop.needs_review).toBe(true);
  });

  it('resolveReview accept adopts the proposed value', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await verification.verify(ID, 'name', 'api', 'mohamed@x');
    const cur = storedClaims();
    cur.push(
      claim({ value: 'api-service', ingested_at: new Date(Date.now() + 1000).toISOString() }),
    );
    fake.nodes.get(ID)!.properties._claims = cur;

    await verification.resolveReview(ID, 'name', 'accept', 'mohamed@x');
    const verified = storedClaims().find((c) => c.source.startsWith('verified:'))!;
    expect(verified.verified_value).toBe('api-service');
    expect(await verification.listReviewQueue()).toHaveLength(0);
    expect(fake.events.some((e) => e.kind === 'accepted')).toBe(true);
  });

  it('review queue and resolveReview adjudicate the SAME equal-rank manual claim (deterministic, not array order)', async () => {
    // Two equal-rank manual claims on the same property. The shared deterministic
    // resolver (pickManualOverride) breaks the tie on freshest ingested_at, then
    // source — NOT array order. Regression: the old array-order `pickOverride`
    // could surface/adjudicate a DIFFERENT claim than the deterministic winner, so
    // 'accept' could re-pin a non-effective value. Here the array order is
    // DELIBERATELY the opposite of the deterministic winner so a regression would
    // pick `alice` first; the shared resolver must still pick `bob` (freshest).
    const winner = pickManualOverride([
      claim({
        source: 'manual:alice',
        source_id: 'manual://alice',
        value: 'alpha',
        ingested_at: '2026-06-20T00:00:00Z',
      }),
      claim({
        source: 'manual:bob',
        source_id: 'manual://bob',
        value: 'bravo',
        ingested_at: '2026-06-21T00:00:00Z',
      }),
    ])!;
    expect(winner.source).toBe('manual:bob'); // sanity: bob is the deterministic winner
    expect(winner.value).toBe('bravo');

    const alice = claim({
      source: 'manual:alice',
      source_id: 'manual://alice',
      value: 'alpha',
      ingested_at: '2026-06-20T00:00:00Z',
    });
    const bob = claim({
      source: 'manual:bob',
      source_id: 'manual://bob',
      value: 'bravo', // the deterministic winner (freshest manual edit)
      ingested_at: '2026-06-21T00:00:00Z',
    });
    const contradicting = claim({
      source: 'github',
      value: 'connector',
      ingested_at: '2026-06-22T00:00:00Z',
    });
    // alice FIRST so array-order picking would wrongly choose alice.
    fake.seed(ID, 'Repository', [alice, bob, contradicting]);

    const queue = await verification.listReviewQueue();
    expect(queue).toHaveLength(1);
    // The queue surfaces the deterministic winner, not the array-first claim.
    expect(queue[0].verifiedValue).toBe('bravo');
    expect(queue[0].verifiedBy).toBe('bob');

    // 'accept' adopts the proposed value onto that SAME (deterministic) claim.
    await verification.resolveReview(ID, 'name', 'accept', 'mohamed@x');
    expect(storedClaims().find((c) => c.source === 'manual:bob')!.value).toBe('connector');
    // The non-winning manual claim is untouched.
    expect(storedClaims().find((c) => c.source === 'manual:alice')!.value).toBe('alpha');
  });

  it('resolveReview reject re-pins the verified value and clears the queue', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await verification.verify(ID, 'name', 'api', 'mohamed@x');
    const cur = storedClaims();
    cur.push(
      claim({ value: 'api-service', ingested_at: new Date(Date.now() + 1000).toISOString() }),
    );
    fake.nodes.get(ID)!.properties._claims = cur;

    await verification.resolveReview(ID, 'name', 'reject', 'mohamed@x');
    const verified = storedClaims().find((c) => c.source.startsWith('verified:'))!;
    expect(verified.verified_value).toBe('api'); // unchanged
    expect(await verification.listReviewQueue()).toHaveLength(0); // verified_at bumped past the dissenter
    expect(fake.events.some((e) => e.kind === 'rejected')).toBe(true);
  });
});

describe('contradictionKey dedup (no boundary-shift collision)', () => {
  let fake: FakeNeo4j;
  let verification: VerificationService;

  beforeEach(() => {
    fake = new FakeNeo4j();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verification = new VerificationService(fake as any);
  });

  it('emits a distinct contradicted event for two divergences that collide under bare concatenation', async () => {
    // ('ab','c',V) and ('a','bc',V) both bare-concatenate to "abcV" — the old
    // delimiter-free key would dedup the second away and SUPPRESS a real event.
    // JSON.stringify([...]) keeps the segments distinct.
    const contradicting = (v: string) => claim({ value: v, ingested_at: '2026-06-22T00:00:00Z' });
    const manual = (v: string, key: string) =>
      claim({
        property_key: key,
        source: 'manual:alice',
        source_id: `manual://alice#${key}`,
        value: v,
        ingested_at: '2026-06-20T00:00:00Z',
      });

    // Node 'ab' with property 'c'; node 'a' with property 'bc'. Same proposedValue.
    fake.seed('ab', 'Repository', [
      manual('override', 'c'),
      { ...contradicting('drift'), property_key: 'c' },
    ]);
    fake.seed('a', 'Repository', [
      manual('override', 'bc'),
      { ...contradicting('drift'), property_key: 'bc' },
    ]);

    const queue = await verification.listReviewQueue();
    expect(queue).toHaveLength(2);
    // Both divergences must produce their OWN contradicted audit event (not deduped).
    // (`kind` is a Cypher literal, not a param, so match on the recorded entity ids.)
    const emittedFor = fake.graphEditEvents.map((e) => `${e.entityId}|${e.propertyKey}`).sort();
    expect(emittedFor).toEqual(['ab|c', 'a|bc']);
  });
});

describe('ClaimService read-path confidence', () => {
  const ID = 'shipit://repository/default/org/api';
  let fake: FakeNeo4j;
  let claims: ClaimService;
  beforeEach(() => {
    fake = new FakeNeo4j();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claims = new ClaimService(fake as any, schemaStub as any);
  });

  it('CORROBORATED when an independent source agrees', async () => {
    fake.seed(ID, 'Repository', [
      claim({}),
      claim({ source: 'datadog', source_id: 'dd://org/api', confidence: 0.85 }),
    ]);
    const res = await claims.getClaimsForEntity(ID);
    const name = res!.properties.find((p) => p.property_key === 'name')!;
    expect(name.status).toBe('CORROBORATED');
    expect(name.confidence).toBeGreaterThan(0.9);
    expect(name.breakdown.corroboration_sources).toContain('datadog');
  });

  it('DISPUTED when sources disagree', async () => {
    fake.seed(ID, 'Repository', [
      claim({ property_key: 'language', value: 'TypeScript' }),
      claim({
        property_key: 'language',
        value: 'JavaScript',
        source: 'datadog',
        source_id: 'dd://org/api',
        confidence: 0.85,
      }),
    ]);
    const res = await claims.getClaimsForEntity(ID);
    const lang = res!.properties.find((p) => p.property_key === 'language')!;
    expect(lang.status).toBe('DISPUTED');
    expect(lang.has_conflict).toBe(true);
    expect(lang.confidence).toBeCloseTo(0.8, 5);
  });
});
