/**
 * Neo4j-BACKED end-to-end integration test for the v1a manual-edit write path
 * (task T5a). The unit suite (manual-edit-service.test.ts, manual-claims.test.ts)
 * fakes Neo4j, so it cannot prove the things that ONLY exist against a real DB:
 * the `_claims_rev` compare-and-set interleave between api-server and core-writer
 * (the T0 blocker fix), real claim resolution through the schema strategy, the
 * INTERNAL_EVENT_LABELS exclusion in actual Cypher, the contradicted-event
 * dedup, and the reconciliation claim-migration + audit re-point.
 *
 * Gated on NEO4J_TEST_URI (default `pnpm test` stays Docker-free; CI's
 * `integration` job and a local throwaway container provide it). Every node id is
 * RUN-prefixed and the suite cleans up only its own nodes after each test, so it
 * is safe under the shared-DB scar PROVIDED it runs serially
 * (`--no-file-parallelism`, already the default for `pnpm test:integration`).
 *
 * IMPORTANT: this suite scopes all deletes to its RUN prefix — it never issues a
 * blanket `MATCH (n) DETACH DELETE n` — so it can coexist with other RUN-prefixed
 * integration suites on the same database without clobbering them.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { resolve } from 'node:path';
import type { ManagedTransaction } from 'neo4j-driver';
import type { PropertyClaim } from '@shipit-ai/shared';
import { Neo4jService } from '../../services/neo4j-service.js';
import { SchemaService } from '../../services/schema-service.js';
import { ClaimService } from '../../services/claim-service.js';
import { ManualEditService } from '../../services/manual-edit-service.js';
import { VerificationService } from '../../services/verification-service.js';
import { ReconciliationService } from '../../services/reconciliation-service.js';
import { SYSTEM_CONTEXT } from '@shipit-ai/shared';
import RedisMock from 'ioredis-mock';
import { createServer, type CreateServerOptions } from '../../server.js';
import { makeTestConfig } from '../test-config.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';

// RUN-scoped id prefix: every node this suite creates starts with this, and
// cleanup is scoped to it, so concurrent suites on a shared DB don't collide.
const RUN = `me-itest-${process.pid}-${Math.floor(performance.now())}`;
const idFor = (name: string): string => `shipit://LogicalService/${RUN}/${name}`;

const SCHEMA_PATH = resolve(__dirname, '../../../../../config/shipit-schema.yaml');

// `LogicalService.tier` resolves with MANUAL_OVERRIDE_FIRST, so a manual claim
// wins over a connector claim — the property we exercise for set/revert/tie-break.
const PROP = 'tier';

const EPOCH = 1_719_000_000_000;

function connectorClaim(value: unknown, ingestedAt = '2026-06-21T00:00:00.000Z'): PropertyClaim {
  return {
    property_key: PROP,
    value,
    source: 'github',
    source_id: 'github://itest/x',
    ingested_at: ingestedAt,
    confidence: 0.9,
    evidence: null,
  };
}

/**
 * The PRODUCTION `_claims_rev` compare-and-set merge Cypher, copied VERBATIM from
 * core-writer's `mergeNode` (packages/core-writer/src/neo4j/queries.ts) — the
 * connector write path. We inline it rather than importing `@shipit-ai/core-writer`
 * to avoid adding a cross-package dependency to api-server just for a test; the
 * core-writer side of the CAS is itself proven by core-writer's
 * claims-rev-cas.integration.test.ts (T0). Here it stands in for a connector
 * resync so we can assert the api-server-authored manual claim SURVIVES one.
 */
const MERGE_NODE_CYPHER = `
  MERGE (n:LogicalService {id: $id})
  WITH n, coalesce(
    $comparable AND n._event_version IS NOT NULL AND n._event_version > $incoming,
    false
  ) AS reject
  WITH n, reject,
    (NOT reject AND coalesce(n._claims_rev, 0) <> $expectedClaimsRev) AS claimsConflict
  FOREACH (_ IN CASE WHEN reject THEN [] ELSE [1] END |
    SET n += $properties,
        n._last_synced = $lastSynced,
        n._source_system = $sourceSystem,
        n._event_version = $eventVersion
  )
  FOREACH (_ IN CASE WHEN (NOT reject AND NOT claimsConflict) THEN [1] ELSE [] END |
    SET n += $effectiveProps,
        n._claims = $claims,
        n._claims_rev = coalesce(n._claims_rev, 0) + 1
  )
  RETURN (NOT reject) AS written,
         (NOT reject AND NOT claimsConflict) AS claimsWritten,
         claimsConflict
`;

interface MergeResult {
  written: boolean;
  claimsWritten: boolean;
  claimsConflict: boolean;
}

describe.skipIf(!URI)('manual-edit write path — Neo4j integration (T5a)', () => {
  let neo4j: Neo4jService;
  let schema: SchemaService;
  let manual: ManualEditService;
  let verification: VerificationService;
  let reconciliation: ReconciliationService;

  /** Run the production connector-merge CAS query for one node. */
  async function connectorMerge(
    name: string,
    claims: PropertyClaim[],
    opts: { expectedRev: number; eventVersion?: number },
  ): Promise<MergeResult> {
    return neo4j.runInWriteTransaction(async (tx: ManagedTransaction) => {
      const res = await tx.run(MERGE_NODE_CYPHER, {
        id: idFor(name),
        comparable: true,
        incoming: opts.eventVersion ?? EPOCH,
        expectedClaimsRev: opts.expectedRev,
        properties: { name },
        effectiveProps: { [PROP]: claims[0]?.value ?? null },
        claims: JSON.stringify(claims),
        lastSynced: '2026-06-21T00:00:00Z',
        sourceSystem: 'github',
        eventVersion: opts.eventVersion ?? EPOCH,
      });
      const rec = res.records[0];
      return {
        written: rec?.get('written') === true,
        claimsWritten: rec?.get('claimsWritten') === true,
        claimsConflict: rec?.get('claimsConflict') === true,
      };
    });
  }

  beforeAll(async () => {
    neo4j = new Neo4jService(URI!, USER, PASSWORD);
    schema = new SchemaService(SCHEMA_PATH);
    await schema.loadSchema();
    manual = new ManualEditService(neo4j, new ClaimService(neo4j, schema), schema);
    verification = new VerificationService(neo4j);
    reconciliation = new ReconciliationService(neo4j, 0.85);
  });

  afterEach(async () => {
    // Scoped to this run only — never a blanket wipe (shared-DB scar).
    await neo4j.runQuery('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: idFor('') });
    // GraphEditEvent / VerificationEvent / MergeEvent nodes are id-prefixed
    // ge:/ve:/me: and linked to RUN nodes; the DETACH above drops the edges, but
    // the event nodes themselves carry an entity_id we can scope-delete.
    await neo4j.runQuery(
      `MATCH (e) WHERE (e:GraphEditEvent OR e:VerificationEvent)
         AND e.entity_id STARTS WITH $p DETACH DELETE e`,
      { p: idFor('') },
    );
    await neo4j.runQuery(
      `MATCH (v:VerificationEvent) WHERE v.entityId STARTS WITH $p DETACH DELETE v`,
      { p: idFor('') },
    );
    await neo4j.runQuery(
      `MATCH (m:MergeEvent) WHERE m.survivorId STARTS WITH $p OR m.loserId STARTS WITH $p
         DETACH DELETE m`,
      { p: idFor('') },
    );
    await neo4j.runQuery(
      `MATCH (c:ReconciliationCandidate) WHERE c.id STARTS WITH $p DETACH DELETE c`,
      { p: RUN },
    );
  });

  afterAll(async () => {
    await neo4j?.close();
  });

  // --- helpers ---------------------------------------------------------------

  /** Seed a LogicalService node carrying the given connector claims (rev → 1). */
  async function seed(name: string, claims: PropertyClaim[]): Promise<void> {
    await connectorMerge(name, claims, { expectedRev: 0 });
  }

  /** Read the resolved `tier` claims back through the api-server read path. */
  async function effectiveTier(id: string): Promise<unknown> {
    const claimSvc = new ClaimService(neo4j, schema);
    const result = await claimSvc.getClaimsForEntity(id);
    const prop = result?.properties.find((p) => p.property_key === PROP);
    return prop?.effective_value;
  }

  /** Read `_claims` + `_claims_rev` straight off the node. */
  async function readClaims(id: string): Promise<{ claims: PropertyClaim[]; claimsRev: number }> {
    const recs = await neo4j.runQuery(
      'MATCH (n {id:$id}) RETURN n._claims AS claims, n._claims_rev AS rev',
      { id },
    );
    if (recs.length === 0) return { claims: [], claimsRev: 0 };
    const raw = recs[0].get('claims');
    const rev = recs[0].get('rev') as { toNumber?: () => number } | number | null;
    const claimsRev = typeof rev === 'object' && rev?.toNumber ? rev.toNumber() : Number(rev) || 0;
    let claims: PropertyClaim[] = [];
    if (typeof raw === 'string') {
      try {
        claims = JSON.parse(raw) as PropertyClaim[];
      } catch {
        claims = [];
      }
    }
    return { claims, claimsRev };
  }

  /** Overwrite a node's `_claims` array directly (simulating a stored snapshot). */
  async function setClaims(id: string, claims: PropertyClaim[]): Promise<void> {
    await neo4j.runQuery('MATCH (n {id:$id}) SET n._claims = $c', {
      id,
      c: JSON.stringify(claims),
    });
  }

  async function graphEditEvents(
    id: string,
    kind?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const where = kind ? 'AND e.kind = $kind' : '';
    const recs = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.entity_id = $id ${where} RETURN e ORDER BY e.ts`,
      { id, kind },
    );
    return recs.map((r) => (r.get('e') as { properties: Record<string, unknown> }).properties);
  }

  // --- 1. set → resolve winner ----------------------------------------------
  it('1. setManualClaim writes a manual:<actor> claim that wins over the connector value', async () => {
    await seed('s1', [connectorClaim('3')]);
    expect(await effectiveTier(idFor('s1'))).toBe('3'); // connector value first

    const res = await manual.setManualClaim({
      entityId: idFor('s1'),
      propertyKey: PROP,
      value: '1',
      actor: 'alice@x',
    });

    expect(res.property.effective_value).toBe('1');
    // The manual claim landed in the stored array alongside the connector claim.
    const { claims } = await readClaims(idFor('s1'));
    expect(claims.map((c) => c.source).sort()).toEqual(['github', 'manual:alice@x']);
    // Read-path resolution agrees the manual value is the effective winner.
    expect(await effectiveTier(idFor('s1'))).toBe('1');
  });

  // --- 2. revert → fallback --------------------------------------------------
  it('2. revertManualClaim removes the manual claim; effective falls back to the connector', async () => {
    await seed('s2', [connectorClaim('3')]);
    await manual.setManualClaim({
      entityId: idFor('s2'),
      propertyKey: PROP,
      value: '1',
      actor: 'alice@x',
    });
    expect(await effectiveTier(idFor('s2'))).toBe('1');

    const res = await manual.revertManualClaim({
      entityId: idFor('s2'),
      propertyKey: PROP,
      actor: 'alice@x',
    });
    expect(res.property.effective_value).toBe('3'); // fell back to the connector

    const { claims } = await readClaims(idFor('s2'));
    expect(claims.map((c) => c.source)).toEqual(['github']);
    expect(await effectiveTier(idFor('s2'))).toBe('3');
  });

  // --- 3. THE BLOCKER: _claims_rev CAS interleave through the api-server path -
  it('3. a manual claim survives a connector resync that read a stale _claims snapshot', async () => {
    // Seed at rev 1 (one connector claim).
    await seed('s3', [connectorClaim('3')]);
    const seeded = await readClaims(idFor('s3'));
    expect(seeded.claimsRev).toBe(1);

    // The connector "reads" _claims at rev 1 (stale snapshot) and intends to
    // overwrite tier with its own value — but a human edit lands FIRST.
    const staleRev = seeded.claimsRev;

    // api-server manual edit commits → bumps _claims_rev to 2 and adds manual:bob.
    await manual.setManualClaim({
      entityId: idFor('s3'),
      propertyKey: PROP,
      value: '1',
      actor: 'bob@x',
    });
    expect((await readClaims(idFor('s3'))).claimsRev).toBe(2);

    // Now the connector resync writes through the production CAS query with the
    // STALE rev it read before the manual edit. A fresher event version lets the
    // freshness guard pass (props refresh), isolating the _claims_rev CAS as the
    // only thing blocking the claims write. The CAS must reject the claims write.
    const result = await connectorMerge('s3', [connectorClaim('99')], {
      expectedRev: staleRev, // = 1, but stored is now 2 → conflict
      eventVersion: EPOCH + 1,
    });
    expect(result.written).toBe(true); // freshness guard passed, props refreshed
    expect(result.claimsConflict).toBe(true);
    expect(result.claimsWritten).toBe(false);

    // The manual claim SURVIVED untouched and still wins.
    const after = await readClaims(idFor('s3'));
    expect(after.claimsRev).toBe(2); // no claims write happened
    expect(after.claims.find((c) => c.source === 'manual:bob@x')?.value).toBe('1');
    expect(await effectiveTier(idFor('s3'))).toBe('1');
  });

  // --- 4. double-submit ------------------------------------------------------
  it('4. two identical setManualClaim calls replace (not duplicate) the claim; each emits one audit row', async () => {
    await seed('s4', [connectorClaim('3')]);
    await manual.setManualClaim({
      entityId: idFor('s4'),
      propertyKey: PROP,
      value: '1',
      actor: 'alice@x',
    });
    await manual.setManualClaim({
      entityId: idFor('s4'),
      propertyKey: PROP,
      value: '1',
      actor: 'alice@x',
    });

    // Exactly one manual:alice claim for this property — the second replaced the first.
    const { claims } = await readClaims(idFor('s4'));
    const manualClaims = claims.filter(
      (c) => c.source === 'manual:alice@x' && c.property_key === PROP,
    );
    expect(manualClaims).toHaveLength(1);

    // Audit: the design records ONE manual_set GraphEditEvent per mutation (no
    // dedup on the write path — each call is an explicit, audited action), so a
    // double-submit yields two manual_set rows. Documented here as expected.
    const events = await graphEditEvents(idFor('s4'), 'manual_set');
    expect(events).toHaveLength(2);
  });

  // --- 5. multi-actor tie-break determinism ----------------------------------
  it('5. two actors set manual claims on the same property → a deterministic winner across reads', async () => {
    await seed('s5', [connectorClaim('3')]);
    await manual.setManualClaim({
      entityId: idFor('s5'),
      propertyKey: PROP,
      value: 'alice-val',
      actor: 'alice@x',
    });
    await manual.setManualClaim({
      entityId: idFor('s5'),
      propertyKey: PROP,
      value: 'bob-val',
      actor: 'bob@x',
    });

    // Both manual claims coexist; the resolved winner must be stable across reads.
    const first = await effectiveTier(idFor('s5'));
    const second = await effectiveTier(idFor('s5'));
    const third = await effectiveTier(idFor('s5'));
    expect(first).toBe(second);
    expect(second).toBe(third);
    // It is one of the two manual values (not the connector value).
    expect(['alice-val', 'bob-val']).toContain(first);

    // Determinism must hold even when the stored claim array order is reversed —
    // the tie-break is on (freshest ingested_at, then source), not array order.
    const { claims } = await readClaims(idFor('s5'));
    await setClaims(idFor('s5'), [...claims].reverse());
    expect(await effectiveTier(idFor('s5'))).toBe(first);
  });

  // --- 6. GraphEditEvent excluded from catalog/graph -------------------------
  it('6. GraphEditEvent audit nodes never appear in getSources / getOverview / search', async () => {
    await seed('s6', [connectorClaim('3')]);
    await manual.setManualClaim({
      entityId: idFor('s6'),
      propertyKey: PROP,
      value: '1',
      actor: 'alice@x',
    });

    // The audit node exists in the graph...
    expect(await graphEditEvents(idFor('s6'), 'manual_set')).toHaveLength(1);

    // ...but is excluded from every user-facing read.
    const overview = await neo4j.getOverview(SYSTEM_CONTEXT, 500);
    expect(overview.nodes.some((n) => String(n.data.label) === 'GraphEditEvent')).toBe(false);
    expect(overview.nodes.some((n) => String(n.data.id).startsWith('ge:'))).toBe(false);
    // The edited entity itself is still present.
    expect(overview.nodes.some((n) => n.data.id === idFor('s6'))).toBe(true);

    const sources = await neo4j.getSources();
    // GraphEditEvent nodes have no _source_system, but assert no ge: leakage anyway.
    expect(sources.every((s) => s.sourceSystem !== 'GraphEditEvent')).toBe(true);

    const search = await neo4j.searchEntities(SYSTEM_CONTEXT, { q: RUN, limit: 100 });
    const ids = search.map((r) =>
      String((r.get('n') as { properties: { id: unknown } }).properties.id),
    );
    expect(ids.some((id) => id.startsWith('ge:'))).toBe(false);
    expect(ids).toContain(idFor('s6'));
  });

  // --- 7. contradicted event -------------------------------------------------
  it('7. a fresher connector value diverging from a manual override surfaces in the review queue and emits one contradicted event (deduped)', async () => {
    await seed('s7', [connectorClaim('3', '2026-06-21T00:00:00.000Z')]);
    await manual.setManualClaim({
      entityId: idFor('s7'),
      propertyKey: PROP,
      value: '1',
      actor: 'alice@x',
    });

    // A connector resync brings a NEWER, DIFFERENT value than the manual override.
    // Write it directly into _claims (a real resync would, but here we add the
    // diverging connector claim with a later ingested_at so the contradiction
    // predicate fires). Use a brand-new connector source_id so it's a distinct claim.
    const { claims } = await readClaims(idFor('s7'));
    const diverging: PropertyClaim = {
      property_key: PROP,
      value: '5',
      source: 'github',
      source_id: 'github://itest/resync',
      ingested_at: '2026-12-01T00:00:00.000Z', // newer than the manual claim
      confidence: 0.9,
      evidence: null,
    };
    // Append the diverging connector claim to whatever is already stored (the
    // original connector claim + the manual override).
    await setClaims(idFor('s7'), [...claims, diverging]);

    // First scan: the divergence surfaces AND a contradicted event is emitted.
    const queue1 = await verification.listReviewQueue(500);
    const myRow = queue1.find((r) => r.entityId === idFor('s7') && r.propertyKey === PROP);
    expect(myRow).toBeDefined();
    expect(myRow?.overrideSource).toBe('manual');
    expect(myRow?.proposedValue).toBe('5');

    const after1 = await graphEditEvents(idFor('s7'), 'contradicted');
    expect(after1).toHaveLength(1);

    // Second scan: still surfaces, but NO new contradicted event (deduped on
    // entity_id + property_key + new_value).
    const queue2 = await verification.listReviewQueue(500);
    expect(queue2.some((r) => r.entityId === idFor('s7'))).toBe(true);
    const after2 = await graphEditEvents(idFor('s7'), 'contradicted');
    expect(after2).toHaveLength(1);
  });

  // --- 8. reconciliation merge migration -------------------------------------
  it('8. merging a node holding a manual override onto a survivor migrates the override and re-points the EDITS edge', async () => {
    // Loser holds the manual override; survivor is the tier-1 record so pickSurvivor
    // keeps it. Both must have the SAME name so they are reconciliation candidates.
    await seed('s8-survivor', [connectorClaim('1')]);
    await seed('s8-loser', [connectorClaim('3')]);
    // Make the survivor win pickSurvivor (lower tier number) and the loser carry a manual claim.
    await neo4j.runQuery('MATCH (n {id:$id}) SET n.tier = 1, n.name = "s8shared"', {
      id: idFor('s8-survivor'),
    });
    await neo4j.runQuery('MATCH (n {id:$id}) SET n.tier = 2, n.name = "s8shared"', {
      id: idFor('s8-loser'),
    });
    await manual.setManualClaim({
      entityId: idFor('s8-loser'),
      propertyKey: PROP,
      value: 'human-only',
      actor: 'carol@x',
    });

    // The loser's manual_set GraphEditEvent currently EDITS the loser.
    const loserEvents = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent)-[:EDITS]->(n {id:$id}) RETURN e.id AS id`,
      { id: idFor('s8-loser') },
    );
    expect(loserEvents.length).toBeGreaterThanOrEqual(1);

    // Build a ReconciliationCandidate (LEFT=survivor, RIGHT=loser) so confirmMerge
    // can run its full migrate + re-point + soft-delete transaction.
    const candId = `${RUN}-cand-1`;
    await neo4j.runQuery(
      `MATCH (a {id:$survivor}), (b {id:$loser})
       CREATE (c:ReconciliationCandidate {
         id:$cid, status:'pending', label:'LogicalService', confidence:0.95,
         scoreName:1.0, scoreNamespace:1.0, scoreTags:0, scoreLabels:1.0, createdAt: datetime()
       })
       CREATE (c)-[:LEFT]->(a)
       CREATE (c)-[:RIGHT]->(b)`,
      { survivor: idFor('s8-survivor'), loser: idFor('s8-loser'), cid: candId },
    );

    const merge = await reconciliation.confirmMerge(candId, 'admin@x');
    expect(merge.targetId).toBe(idFor('s8-survivor')); // survivor survived
    expect(merge.sourceId).toBe(idFor('s8-loser'));

    // The manual override migrated to the survivor and now WINS its resolution.
    const survivorClaims = await readClaims(idFor('s8-survivor'));
    expect(survivorClaims.claims.find((c) => c.source === 'manual:carol@x')?.value).toBe(
      'human-only',
    );
    expect(await effectiveTier(idFor('s8-survivor'))).toBe('human-only');

    // The EDITS audit edge now points at the survivor, not the soft-deleted loser.
    const repointed = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent)-[:EDITS]->(n {id:$id}) RETURN count(e) AS c`,
      { id: idFor('s8-survivor') },
    );
    expect((repointed[0].get('c') as { toNumber: () => number }).toNumber()).toBeGreaterThanOrEqual(
      1,
    );
    const stillOnLoser = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent)-[:EDITS]->(n {id:$id}) RETURN count(e) AS c`,
      { id: idFor('s8-loser') },
    );
    expect((stillOnLoser[0].get('c') as { toNumber: () => number }).toNumber()).toBe(0);
  });
});

// --- 9. RBAC at the route, end-to-end against a REAL DB --------------------
//
// The inject-level route tests (manual-claims.test.ts) prove the 403 with a faked
// service. The end-to-end gap they CANNOT cover: that a rejected write leaves NO
// trace in a real database — no claim, no GraphEditEvent. Here we wire a REAL
// Neo4jService through createServer (so the route builds the real ManualEditService),
// seed a node, and assert an mcp-token principal lacking graph:write is 403'd AND
// the node's claims / audit log are untouched.
describe.skipIf(!URI)('manual-edit RBAC — route → real DB (T5a, scenario 9)', () => {
  const RBAC_ID = `shipit://LogicalService/${RUN}/rbac-target`;
  let server: Awaited<ReturnType<typeof createServer>>;
  let neo4j: Neo4jService;

  beforeAll(async () => {
    neo4j = new Neo4jService(URI!, USER, PASSWORD);
    // Seed a node with a connector claim so a successful write WOULD be observable.
    await neo4j.runQuery(
      `MERGE (n:LogicalService {id:$id})
       SET n.name = 'rbac-target',
           n._claims = $c, n._claims_rev = 1, n._source_system = 'github'`,
      {
        id: RBAC_ID,
        c: JSON.stringify([
          {
            property_key: PROP,
            value: '3',
            source: 'github',
            source_id: 'github://itest/rbac',
            ingested_at: '2026-06-21T00:00:00.000Z',
            confidence: 0.9,
            evidence: null,
          },
        ]),
      },
    );

    const config = makeTestConfig();
    config.accessControl.auth.enabled = true;
    config.accessControl.auth.providers.oidc.enabled = true;
    config.accessControl.auth.providers.oidc.issuerUrl = 'https://idp.example.com';
    config.accessControl.auth.providers.oidc.clientId = 'oidc-test-client';
    config.accessControl.auth.providers.oidc.clientSecretEnv = 'TEST_OIDC_CLIENT_SECRET';
    config.accessControl.auth.admins = ['admin@example.com'];
    config.accessControl.auth.session.secure = false;
    process.env.SHIPIT_SESSION_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';
    process.env.TEST_OIDC_CLIENT_SECRET = 'oidc-secret-stub';

    // mcp-token whose scopes do NOT include graph:write.
    const tokenService = {
      validate: async (plaintext: string) =>
        plaintext === 'read-only-token'
          ? { id: 'tok-ro', ownerEmail: 'bot@example.com', scopes: ['catalog:read'] }
          : null,
    } as unknown as CreateServerOptions['tokenService'];

    server = await createServer({
      config,
      redis: new RedisMock() as never,
      tokenService,
      neo4jService: neo4j,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    await neo4j.runQuery('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: idFor('') });
    await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.entity_id STARTS WITH $p DETACH DELETE e`,
      { p: idFor('') },
    );
    await neo4j?.close();
    delete process.env.SHIPIT_SESSION_SECRET;
    delete process.env.TEST_OIDC_CLIENT_SECRET;
  });

  it('mcp-token lacking graph:write → 403 and NO claim/audit reaches the DB', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/claims/${encodeURIComponent(RBAC_ID)}/${PROP}/manual`,
      payload: { value: 'sneaky-1' },
      headers: { authorization: 'Bearer read-only-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');

    // The node still carries ONLY the connector claim — no manual claim slipped in.
    const recs = await neo4j.runQuery(
      'MATCH (n {id:$id}) RETURN n._claims AS c, n._claims_rev AS r',
      {
        id: RBAC_ID,
      },
    );
    const claims = JSON.parse(String(recs[0].get('c'))) as PropertyClaim[];
    expect(claims.every((c) => !c.source.startsWith('manual:'))).toBe(true);

    // And no GraphEditEvent was written.
    const events = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.entity_id = $id RETURN count(e) AS c`,
      { id: RBAC_ID },
    );
    expect((events[0].get('c') as { toNumber: () => number }).toNumber()).toBe(0);
  });
});
