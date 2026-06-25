import { describe, it, expect, beforeEach } from 'vitest';
import type { PropertyClaim } from '@shipit-ai/shared';
import { getSourceReliability } from '@shipit-ai/shared';
import {
  ManualEditService,
  ManualEditValidationError,
  ManualEditNotFoundError,
} from '../../services/manual-edit-service.js';
import { ClaimService } from '../../services/claim-service.js';

const MANUAL_RELIABILITY = getSourceReliability('manual').reliability;

// In-memory Neo4j stand-in understanding the handful of queries the manual-edit /
// claim services issue: the locked read (`SET n._claims_rev ... LIMIT 1`), the
// `_claims` write, the GraphEditEvent CREATE, and the plain entity read.
interface FakeNode {
  properties: Record<string, unknown>;
  labels: string[];
}
class FakeNeo4j {
  nodes = new Map<string, FakeNode>();
  events: Record<string, unknown>[] = [];

  seed(id: string, label: string, claims: PropertyClaim[], extra: Record<string, unknown> = {}) {
    this.nodes.set(id, {
      properties: { id, name: id.split('/').pop(), _claims: claims, ...extra },
      labels: [label],
    });
  }

  async runQuery(cypher: string, params: Record<string, unknown> = {}) {
    if (cypher.includes('CREATE (e:GraphEditEvent')) {
      this.events.push({ ...params });
      return [];
    }
    // Read-back of the current _claims_rev (does NOT bump). Matched before the
    // generic locked-read below since both contain `LIMIT 1`.
    if (cypher.includes('n._claims_rev AS rev')) {
      const node = this.nodes.get(params.id as string);
      if (!node) return [];
      const rev = Number(node.properties._claims_rev) || 0;
      return [{ get: (k: string) => (k === 'rev' ? rev : undefined) }];
    }
    // Locked read bumps _claims_rev; matched before the `SET n._claims` write.
    if (cypher.includes('LIMIT 1')) {
      const node = this.nodes.get(params.id as string);
      if (!node) return [];
      node.properties._claims_rev = (Number(node.properties._claims_rev) || 0) + 1;
      return [record(node)];
    }
    if (cypher.includes('SET n._claims')) {
      const node = this.nodes.get(params.id as string);
      if (node) node.properties._claims = params.claims;
      return [];
    }
    return [];
  }

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

describe('ManualEditService', () => {
  let fake: FakeNeo4j;
  let service: ManualEditService;
  let claims: ClaimService;
  const ID = 'shipit://repository/default/org/api';

  beforeEach(() => {
    fake = new FakeNeo4j();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claims = new ClaimService(fake as any, schemaStub as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ManualEditService(fake as any, claims as any, schemaStub as any);
  });

  function storedClaims(): PropertyClaim[] {
    const raw = fake.nodes.get(ID)!.properties._claims;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as PropertyClaim[]);
  }

  it('setManualClaim creates a manual:<actor> claim with correct source/confidence/value', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    const res = await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'payments-api',
      actor: 'alice@x',
    });

    const manual = storedClaims().find((c) => c.source === 'manual:alice@x');
    expect(manual).toBeDefined();
    expect(manual!.value).toBe('payments-api');
    expect(manual!.confidence).toBe(MANUAL_RELIABILITY);
    expect(manual!.evidence).toBeNull();
    // Manual override wins the read path.
    expect(res.property.effective_value).toBe('payments-api');
    expect(res.claimsRev).toBeGreaterThan(0);
  });

  it('records evidence when supplied', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'payments-api',
      evidence: 'renamed in JIRA-123',
      actor: 'alice@x',
    });
    expect(storedClaims().find((c) => c.source === 'manual:alice@x')!.evidence).toBe(
      'renamed in JIRA-123',
    );
  });

  it('a second set by the same actor REPLACES (not duplicates) the manual claim', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'v1',
      actor: 'alice@x',
    });
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'v2',
      actor: 'alice@x',
    });

    const manuals = storedClaims().filter((c) => c.source === 'manual:alice@x');
    expect(manuals).toHaveLength(1);
    expect(manuals[0].value).toBe('v2');
  });

  it('a different actor adds a SEPARATE manual claim', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'a',
      actor: 'alice@x',
    });
    await service.setManualClaim({ entityId: ID, propertyKey: 'name', value: 'b', actor: 'bob@x' });
    expect(storedClaims().filter((c) => c.source.startsWith('manual:'))).toHaveLength(2);
  });

  it('rejects a non-string value with ManualEditValidationError', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.setManualClaim({
        entityId: ID,
        propertyKey: 'name',
        value: 42 as any,
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ name: 'ManualEditValidationError', code: 'INVALID_VALUE_TYPE' });
    // nothing written
    expect(storedClaims().some((c) => c.source.startsWith('manual:'))).toBe(false);
  });

  it('rejects non-string (non-null) evidence with ManualEditValidationError, before any write', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await expect(
      service.setManualClaim({
        entityId: ID,
        propertyKey: 'name',
        value: 'payments-api',
        // a client could send evidence as an object/array → would otherwise be
        // JSON-serialized into the stored claim, violating the string|null contract.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        evidence: { url: 'http://x' } as any,
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ name: 'ManualEditValidationError', code: 'INVALID_VALUE_TYPE' });
    // nothing written
    expect(storedClaims().some((c) => c.source.startsWith('manual:'))).toBe(false);
  });

  it('accepts null evidence (the contract permits string | null)', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'payments-api',
      evidence: null,
      actor: 'alice@x',
    });
    expect(storedClaims().find((c) => c.source === 'manual:alice@x')!.evidence).toBeNull();
  });

  it('throws ManualEditNotFoundError when the node is missing', async () => {
    await expect(
      service.setManualClaim({
        entityId: 'shipit://nope',
        propertyKey: 'name',
        value: 'x',
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ name: 'ManualEditNotFoundError', code: 'ENTITY_NOT_FOUND' });
  });

  it('prior_value in the audit equals the read-path-resolved value before the edit', async () => {
    // github 'api' is the only claim → prior effective value is 'api'.
    fake.seed(ID, 'Repository', [claim({})]);
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'payments-api',
      actor: 'alice@x',
    });
    const ev = fake.events.find((e) => e.kind === 'manual_set')!;
    expect(ev).toBeDefined();
    expect(ev.priorValue).toBe(JSON.stringify('api'));
    expect(ev.newValue).toBe(JSON.stringify('payments-api'));
    expect(ev.actor).toBe('alice@x');
    expect(ev.propertyKey).toBe('name');
  });

  it('revertManualClaim removes the actor own claim and falls back to next-ranked', async () => {
    fake.seed(ID, 'Repository', [claim({})]); // github 'api'
    await service.setManualClaim({
      entityId: ID,
      propertyKey: 'name',
      value: 'override',
      actor: 'alice@x',
    });
    expect(
      (await service.revertManualClaim({ entityId: ID, propertyKey: 'name', actor: 'alice@x' }))
        .property.effective_value,
    ).toBe('api');
    expect(storedClaims().some((c) => c.source === 'manual:alice@x')).toBe(false);
    expect(fake.events.some((e) => e.kind === 'manual_revert')).toBe(true);
  });

  it('revert with targetActor removes another actor manual claim (admin)', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await service.setManualClaim({ entityId: ID, propertyKey: 'name', value: 'b', actor: 'bob@x' });
    await service.revertManualClaim({
      entityId: ID,
      propertyKey: 'name',
      actor: 'admin@x',
      targetActor: 'bob@x',
    });
    expect(storedClaims().some((c) => c.source === 'manual:bob@x')).toBe(false);
  });

  it('revert with no matching manual claim throws ManualEditNotFoundError (idempotent 204)', async () => {
    fake.seed(ID, 'Repository', [claim({})]);
    await expect(
      service.revertManualClaim({ entityId: ID, propertyKey: 'name', actor: 'alice@x' }),
    ).rejects.toMatchObject({ name: 'ManualEditNotFoundError', code: 'NO_MANUAL_CLAIM' });
  });

  it('revert on a missing node throws ManualEditNotFoundError ENTITY_NOT_FOUND', async () => {
    await expect(
      service.revertManualClaim({ entityId: 'shipit://nope', propertyKey: 'name', actor: 'a' }),
    ).rejects.toMatchObject({ name: 'ManualEditNotFoundError', code: 'ENTITY_NOT_FOUND' });
  });
});

// The deterministic tie-break is enforced in the SHARED resolver (pickManualOverride);
// ManualEditService returns the read-path-resolved property, so we assert the winner is
// stable regardless of `_claims` array order for two same-rank manual claims.
describe('ManualEditService deterministic tie-break', () => {
  const ID = 'shipit://repository/default/org/api';
  let fake: FakeNeo4j;
  let claims: ClaimService;

  function withSchema(strategy: string) {
    return {
      getSchema: () => ({
        node_types: { Repository: { properties: { name: { resolution_strategy: strategy } } } },
      }),
    };
  }

  beforeEach(() => {
    fake = new FakeNeo4j();
  });

  it('two manual claims resolve to the freshest by ingested_at, independent of array order', async () => {
    const older = claim({
      source: 'manual:alice@x',
      value: 'alice',
      ingested_at: '2026-01-01T00:00:00.000Z',
    });
    const newer = claim({
      source: 'manual:bob@x',
      value: 'bob',
      ingested_at: '2026-02-01T00:00:00.000Z',
    });

    // Order A
    fake.seed(ID, 'Repository', [older, newer]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claims = new ClaimService(fake as any, withSchema('MANUAL_OVERRIDE_FIRST') as any);
    const a = await claims.getClaimsForEntity(ID);
    // Order B (reversed)
    fake.seed(ID, 'Repository', [newer, older]);
    const b = await claims.getClaimsForEntity(ID);

    const av = a!.properties.find((p) => p.property_key === 'name')!.effective_value;
    const bv = b!.properties.find((p) => p.property_key === 'name')!.effective_value;
    expect(av).toBe('bob'); // freshest wins
    expect(av).toBe(bv); // and it's stable across array order
  });
});
