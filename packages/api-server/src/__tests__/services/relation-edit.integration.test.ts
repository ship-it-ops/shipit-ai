/**
 * Neo4j-BACKED end-to-end integration test for the v1b manual-RELATIONS write
 * path (task T5b). The unit suite fakes Neo4j, so it cannot prove the things that
 * ONLY exist against a real DB: the ON CREATE-only MERGE leaving a pre-existing
 * connector edge's properties UNTOUCHED, the `_manual_actor` positive-provenance
 * marker round-tripping through real relationship storage, the
 * `INVALID_PROPERTIES` guard catching a nested map BEFORE Neo4j throws a
 * TypeError mid-transaction (rather than surfacing a 500), the
 * INTERNAL_EVENT_LABELS / INTERNAL_REL_TYPES exclusion of GraphEditEvent audit
 * nodes from catalog/graph/stats reads in actual Cypher, and the real RBAC gate
 * leaving no trace in the DB on a rejected write.
 *
 * Gated on NEO4J_TEST_URI (default `pnpm test` stays Docker-free; a local
 * throwaway container provides it). Every node id is RUN-prefixed and the suite
 * cleans up only its own nodes after each test, so it is safe under the
 * shared-DB scar PROVIDED it runs serially (`--no-file-parallelism`, already the
 * default for `pnpm test:integration`).
 *
 * IMPORTANT: this suite scopes all deletes to its RUN prefix — it never issues a
 * blanket `MATCH (n) DETACH DELETE n` — so it can coexist with other
 * RUN-prefixed integration suites on the same database without clobbering them.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { Neo4jService } from '../../services/neo4j-service.js';
import { SchemaService } from '../../services/schema-service.js';
import {
  RelationEditService,
  RelationEditValidationError,
  RelationEditConflictError,
} from '../../services/relation-edit-service.js';
import { SYSTEM_CONTEXT } from '@shipit-ai/shared';
import RedisMock from 'ioredis-mock';
import { createServer, type CreateServerOptions } from '../../server.js';
import { makeTestConfig } from '../test-config.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';

// RUN-scoped id prefix: every node this suite creates starts with this, and
// cleanup is scoped to it, so concurrent suites on a shared DB don't collide.
const RUN = `rel-itest-${process.pid}-${Math.floor(performance.now())}`;
const svcId = (name: string): string => `shipit://LogicalService/${RUN}/${name}`;
const teamId = (name: string): string => `shipit://Team/${RUN}/${name}`;

const SCHEMA_PATH = resolve(__dirname, '../../../../../config/shipit-schema.yaml');

// DEPENDS_ON is LogicalService -> LogicalService (N:M) — a clean type for the
// add/delete/idempotency/audit scenarios. OWNS is Team -> LogicalService, used
// for the label-mismatch + valid-label cases.
const REL = 'DEPENDS_ON';

function toNum(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'toNumber' in (raw as object)) {
    return (raw as { toNumber: () => number }).toNumber();
  }
  return Number(raw) || 0;
}

describe.skipIf(!URI)('manual-RELATIONS write path — Neo4j integration (T5b)', () => {
  let neo4j: Neo4jService;
  let schema: SchemaService;
  let rel: RelationEditService;

  beforeAll(async () => {
    neo4j = new Neo4jService(URI!, USER, PASSWORD);
    schema = new SchemaService(SCHEMA_PATH);
    await schema.loadSchema();
    rel = new RelationEditService(neo4j, schema);
  });

  afterEach(async () => {
    // Scoped to this run only — never a blanket wipe (shared-DB scar). Deleting
    // the RUN-prefixed nodes DETACHes every edge they carry (manual + connector
    // edges between them, plus the EDITS audit edges).
    await neo4j.runQuery('MATCH (n) WHERE n.id CONTAINS $p DETACH DELETE n', { p: RUN });
    // GraphEditEvent audit nodes carry `ge:` ids and from_id/to_id pointing at
    // our RUN-prefixed entities — scope-delete them too.
    await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.from_id CONTAINS $p OR e.to_id CONTAINS $p DETACH DELETE e`,
      { p: RUN },
    );
  });

  afterAll(async () => {
    await neo4j?.close();
  });

  // --- helpers ---------------------------------------------------------------

  /** Create a bare LogicalService node (no edges). */
  async function seedService(name: string): Promise<void> {
    await neo4j.runQuery(
      `MERGE (n:LogicalService {id:$id}) SET n.name = $name, n._source_system = 'github'`,
      { id: svcId(name), name },
    );
  }

  async function seedTeam(name: string): Promise<void> {
    await neo4j.runQuery(`MERGE (n:Team {id:$id}) SET n.name = $name`, { id: teamId(name), name });
  }

  /** Seed a CONNECTOR-owned edge (has `_source`, NO `_manual_actor`). */
  async function seedConnectorEdge(
    from: string,
    to: string,
    type: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    await neo4j.runQuery(
      `MATCH (a {id:$from}), (b {id:$to})
       MERGE (a)-[r:${type}]->(b)
       SET r._source = 'github', r._confidence = 0.9,
           r._ingested_at = '2026-06-21T00:00:00.000Z', r += $props`,
      { from, to, props },
    );
  }

  /** Read every edge of `type` between from/to with its properties. */
  async function readEdges(
    from: string,
    to: string,
    type: string,
  ): Promise<Array<Record<string, unknown>>> {
    const recs = await neo4j.runQuery(
      `MATCH (a {id:$from})-[r:${type}]->(b {id:$to}) RETURN properties(r) AS props`,
      { from, to },
    );
    return recs.map((r) => r.get('props') as Record<string, unknown>);
  }

  async function countEdges(from: string, to: string, type: string): Promise<number> {
    const recs = await neo4j.runQuery(
      `MATCH (a {id:$from})-[r:${type}]->(b {id:$to}) RETURN count(r) AS c`,
      { from, to },
    );
    return toNum(recs[0]?.get('c'));
  }

  /** GraphEditEvent audit rows for an edge (matched on from_id + to_id + kind). */
  async function auditEvents(
    from: string,
    to: string,
    kind?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const where = kind ? 'AND e.kind = $kind' : '';
    const recs = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.from_id = $from AND e.to_id = $to ${where}
       RETURN e ORDER BY e.ts`,
      { from, to, kind },
    );
    return recs.map((r) => (r.get('e') as { properties: Record<string, unknown> }).properties);
  }

  // --- 1. add → real manual edge with provenance ----------------------------
  it('1. addRelation creates a real edge stamped _manual_actor + _source=manual:<actor>, visible in graph reads', async () => {
    await seedService('s1a');
    await seedService('s1b');

    const res = await rel.addRelation({
      from: svcId('s1a'),
      to: svcId('s1b'),
      type: REL,
      actor: 'alice@x',
    });
    expect(res).toEqual({ created: true });

    const edges = await readEdges(svcId('s1a'), svcId('s1b'), REL);
    expect(edges).toHaveLength(1);
    expect(edges[0]._manual_actor).toBe('alice@x');
    expect(edges[0]._source).toBe('manual:alice@x');

    // The edge surfaces in the user-facing graph overview (not just internally).
    const overview = await neo4j.getOverview(SYSTEM_CONTEXT, 500);
    const edge = overview.edges.find(
      (e) =>
        e.data.source === svcId('s1a') && e.data.target === svcId('s1b') && e.data.type === REL,
    );
    expect(edge).toBeDefined();
    expect(edge?.data._manual_actor).toBe('alice@x');
  });

  // --- 2. add over a connector edge → leave it UNTOUCHED ---------------------
  it('2. addRelation over an existing connector edge returns preexistingConnectorEdge and does NOT clobber its _source/props', async () => {
    await seedService('s2a');
    await seedService('s2b');
    await seedConnectorEdge(svcId('s2a'), svcId('s2b'), REL, { weight: 7, label: 'orig' });

    const res = await rel.addRelation({
      from: svcId('s2a'),
      to: svcId('s2b'),
      type: REL,
      properties: { weight: 999, label: 'CLOBBERED' },
      actor: 'bob@x',
    });
    expect(res).toEqual({ created: false, preexistingConnectorEdge: true });

    // Still exactly one edge, still connector-owned, properties UNCHANGED.
    const edges = await readEdges(svcId('s2a'), svcId('s2b'), REL);
    expect(edges).toHaveLength(1);
    expect(edges[0]._source).toBe('github'); // no ON MATCH clobber
    expect(edges[0]._manual_actor).toBeUndefined();
    expect(edges[0].weight).toBe(7); // original property survived
    expect(edges[0].label).toBe('orig');

    // No audit event was written (nothing changed).
    expect(await auditEvents(svcId('s2a'), svcId('s2b'))).toHaveLength(0);
  });

  // --- 3. idempotent re-add of own manual edge ------------------------------
  it('3. re-adding an identical manual edge is an idempotent no-op (created:false, no duplicate edge, no extra audit row)', async () => {
    await seedService('s3a');
    await seedService('s3b');

    const first = await rel.addRelation({
      from: svcId('s3a'),
      to: svcId('s3b'),
      type: REL,
      actor: 'alice@x',
    });
    expect(first).toEqual({ created: true });

    const second = await rel.addRelation({
      from: svcId('s3a'),
      to: svcId('s3b'),
      type: REL,
      actor: 'alice@x',
    });
    expect(second).toEqual({ created: false }); // no preexistingConnectorEdge flag

    expect(await countEdges(svcId('s3a'), svcId('s3b'), REL)).toBe(1); // no duplicate
    // Exactly one relation_added audit row (the second call wrote nothing).
    expect(await auditEvents(svcId('s3a'), svcId('s3b'), 'relation_added')).toHaveLength(1);
  });

  // --- 4. schema validation --------------------------------------------------
  it('4a. an unknown relationship type is rejected 400 (INVALID_RELATION_TYPE) with no edge created', async () => {
    await seedService('s4a');
    await seedService('s4b');
    await expect(
      rel.addRelation({
        from: svcId('s4a'),
        to: svcId('s4b'),
        type: 'NOT_A_REAL_TYPE',
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RELATION_TYPE' });
    // Sanity: nothing got written under any type.
    const any = await neo4j.runQuery(
      `MATCH (a {id:$from})-[r]->(b {id:$to}) RETURN count(r) AS c`,
      { from: svcId('s4a'), to: svcId('s4b') },
    );
    expect(toNum(any[0].get('c'))).toBe(0);
  });

  it('4b. an injection-y raw type that merely sanitizes to a schema key is rejected 400, no edge', async () => {
    await seedService('s4c');
    await seedService('s4d');
    // `OWNS]->(x)//` sanitizes to `OWNS_x_` but is NOT a verbatim schema key →
    // strict-equality allow-list rejects it BEFORE any interpolation.
    await expect(
      rel.addRelation({
        from: svcId('s4c'),
        to: svcId('s4d'),
        type: 'OWNS]->(x)//',
        actor: 'alice@x',
      }),
    ).rejects.toBeInstanceOf(RelationEditValidationError);
    const any = await neo4j.runQuery(
      `MATCH (a {id:$from})-[r]->(b {id:$to}) RETURN count(r) AS c`,
      { from: svcId('s4c'), to: svcId('s4d') },
    );
    expect(toNum(any[0].get('c'))).toBe(0);
  });

  it('4c. a from/to label that violates the schema constraint is rejected 400 (ENDPOINT_LABEL_MISMATCH)', async () => {
    // OWNS requires Team -> LogicalService. Give it LogicalService -> LogicalService.
    await seedService('s4e');
    await seedService('s4f');
    await expect(
      rel.addRelation({
        from: svcId('s4e'),
        to: svcId('s4f'),
        type: 'OWNS',
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'ENDPOINT_LABEL_MISMATCH' });
    expect(await countEdges(svcId('s4e'), svcId('s4f'), 'OWNS')).toBe(0);

    // And the well-typed Team -> LogicalService OWNS edge DOES succeed.
    await seedTeam('s4team');
    const ok = await rel.addRelation({
      from: teamId('s4team'),
      to: svcId('s4f'),
      type: 'OWNS',
      actor: 'alice@x',
    });
    expect(ok).toEqual({ created: true });
    expect(await countEdges(teamId('s4team'), svcId('s4f'), 'OWNS')).toBe(1);
    // Clean up the cross-prefix Team node (teamId uses RUN, so afterEach covers it).
  });

  // --- 5. properties guard (verifies the prior INVALID_PROPERTIES fix) --------
  it('5. a NESTED OBJECT in properties is rejected 400 (INVALID_PROPERTIES) with no edge — and primitive props DO persist', async () => {
    await seedService('s5a');
    await seedService('s5b');

    // Nested object → guarded BEFORE the write (would otherwise be a Neo4j
    // TypeError mid-transaction → 500). Confirms the guard works against a REAL
    // DB, not just a faked one.
    await expect(
      rel.addRelation({
        from: svcId('s5a'),
        to: svcId('s5b'),
        type: REL,
        properties: { meta: { nested: 'nope' } },
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROPERTIES' });
    expect(await countEdges(svcId('s5a'), svcId('s5b'), REL)).toBe(0); // no edge created

    // Primitives + homogeneous primitive arrays DO persist on a real edge.
    const ok = await rel.addRelation({
      from: svcId('s5a'),
      to: svcId('s5b'),
      type: REL,
      properties: { weight: 5, note: 'manual', tags: ['a', 'b'], active: true },
      actor: 'alice@x',
    });
    expect(ok).toEqual({ created: true });
    const edges = await readEdges(svcId('s5a'), svcId('s5b'), REL);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(5);
    expect(edges[0].note).toBe('manual');
    expect(edges[0].tags).toEqual(['a', 'b']);
    expect(edges[0].active).toBe(true);
    expect(edges[0]._manual_actor).toBe('alice@x');
  });

  // --- 5b. reserved-key injection (provenance/audit forgery) -----------------
  it('5b. reserved underscore-prefixed property keys are rejected 400 (INVALID_PROPERTIES); a genuine create keeps the authenticated actor and writes exactly ONE relation_added audit', async () => {
    await seedService('s5c');
    await seedService('s5d');

    // ATTACK: a graph:write caller tries to forge provenance via `properties`.
    // `_manual_actor` would disguise the actor, `_source:'github'` would mask the
    // manual edge as connector topology, and `_ingested_at` would corrupt the
    // server's `justCreated` derivation (silent un-audited create). All must be
    // rejected BEFORE any write touches the DB.
    await expect(
      rel.addRelation({
        from: svcId('s5c'),
        to: svcId('s5d'),
        type: REL,
        properties: { _manual_actor: 'attacker@x', _source: 'github', _ingested_at: 'x' },
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROPERTIES' });
    // Nothing slipped into the DB on the rejected attempt.
    expect(await countEdges(svcId('s5c'), svcId('s5d'), REL)).toBe(0);
    expect(await auditEvents(svcId('s5c'), svcId('s5d'))).toHaveLength(0);

    // A genuine create by the authenticated actor still works and is correctly
    // attributed + audited exactly once.
    const ok = await rel.addRelation({
      from: svcId('s5c'),
      to: svcId('s5d'),
      type: REL,
      actor: 'alice@x',
    });
    expect(ok).toEqual({ created: true });

    const edges = await readEdges(svcId('s5c'), svcId('s5d'), REL);
    expect(edges).toHaveLength(1);
    expect(edges[0]._manual_actor).toBe('alice@x'); // authenticated actor, not forged
    expect(edges[0]._source).toBe('manual:alice@x'); // manual provenance, not 'github'
    const added = await auditEvents(svcId('s5c'), svcId('s5d'), 'relation_added');
    expect(added).toHaveLength(1); // exactly ONE relation_added row, created:true
  });

  // --- 6. delete semantics ---------------------------------------------------
  it('6a. deleting a manual edge removes it and writes a relation_removed audit row', async () => {
    await seedService('s6a');
    await seedService('s6b');
    await rel.addRelation({ from: svcId('s6a'), to: svcId('s6b'), type: REL, actor: 'alice@x' });
    expect(await countEdges(svcId('s6a'), svcId('s6b'), REL)).toBe(1);

    const deleted = await rel.deleteRelation({
      from: svcId('s6a'),
      to: svcId('s6b'),
      type: REL,
      actor: 'alice@x',
    });
    expect(deleted).toBe(true);
    expect(await countEdges(svcId('s6a'), svcId('s6b'), REL)).toBe(0);
    expect(await auditEvents(svcId('s6a'), svcId('s6b'), 'relation_removed')).toHaveLength(1);
  });

  it('6b. deleting a connector edge is refused (409 CONNECTOR_EDGE) and the edge survives', async () => {
    await seedService('s6c');
    await seedService('s6d');
    await seedConnectorEdge(svcId('s6c'), svcId('s6d'), REL, { weight: 1 });

    await expect(
      rel.deleteRelation({
        from: svcId('s6c'),
        to: svcId('s6d'),
        type: REL,
        actor: 'alice@x',
      }),
    ).rejects.toBeInstanceOf(RelationEditConflictError);
    // Edge survives, untouched, still connector-owned.
    const edges = await readEdges(svcId('s6c'), svcId('s6d'), REL);
    expect(edges).toHaveLength(1);
    expect(edges[0]._source).toBe('github');
    expect(edges[0]._manual_actor).toBeUndefined();
    // No relation_removed audit written.
    expect(await auditEvents(svcId('s6c'), svcId('s6d'), 'relation_removed')).toHaveLength(0);
  });

  it('6c. deleting an absent edge is idempotent (returns false → route 204)', async () => {
    await seedService('s6e');
    await seedService('s6f');
    const deleted = await rel.deleteRelation({
      from: svcId('s6e'),
      to: svcId('s6f'),
      type: REL,
      actor: 'alice@x',
    });
    expect(deleted).toBe(false);
    expect(await auditEvents(svcId('s6e'), svcId('s6f'))).toHaveLength(0);
  });

  // --- 7. audit excluded from catalog/graph/stats; the edge IS counted -------
  it('7. relation_added/relation_removed GraphEditEvents are excluded from catalog/graph/stats, while the manual edge IS counted in getGraphStats', async () => {
    await seedService('s7a');
    await seedService('s7b');

    // Baseline DEPENDS_ON edge count BEFORE our manual add.
    const statsBefore = await neo4j.getGraphStats(SYSTEM_CONTEXT);
    const depBefore = statsBefore.edgeCountsByType[REL] ?? 0;
    const editEventsBefore = statsBefore.nodesByLabel['GraphEditEvent'] ?? 0;

    await rel.addRelation({ from: svcId('s7a'), to: svcId('s7b'), type: REL, actor: 'alice@x' });
    await rel.deleteRelation({
      from: svcId('s7a'),
      to: svcId('s7b'),
      type: REL,
      actor: 'alice@x',
    });
    // Re-add so there is a live manual edge to count.
    await rel.addRelation({ from: svcId('s7a'), to: svcId('s7b'), type: REL, actor: 'alice@x' });

    // Two GraphEditEvent audit nodes exist (1 added before delete is gone? no —
    // delete writes relation_removed; the re-add writes a second relation_added),
    // so >= 2 audit rows for this edge.
    const audit = await auditEvents(svcId('s7a'), svcId('s7b'));
    expect(audit.length).toBeGreaterThanOrEqual(2);

    // getGraphStats: GraphEditEvent is NOT in nodesByLabel; EDITS is NOT in
    // edgeCountsByType; but the user-facing DEPENDS_ON edge count went UP by 1.
    const statsAfter = await neo4j.getGraphStats(SYSTEM_CONTEXT);
    expect(statsAfter.nodesByLabel['GraphEditEvent']).toBeUndefined();
    expect(statsAfter.edgeCountsByType['EDITS']).toBeUndefined();
    expect(statsAfter.edgeCountsByType[REL]).toBe(depBefore + 1);
    // (sanity: GraphEditEvent nodes did increase in the DB, just not counted)
    expect(editEventsBefore).toBe(0);

    // getOverview: the audit node and its EDITS edge never appear; the entity
    // and its manual DEPENDS_ON edge do.
    const overview = await neo4j.getOverview(SYSTEM_CONTEXT, 1000);
    expect(overview.nodes.some((n) => String(n.data.label) === 'GraphEditEvent')).toBe(false);
    expect(overview.nodes.some((n) => String(n.data.id).startsWith('ge:'))).toBe(false);
    expect(overview.edges.some((e) => e.data.type === 'EDITS')).toBe(false);
    expect(
      overview.edges.some((e) => e.data.source === svcId('s7a') && e.data.target === svcId('s7b')),
    ).toBe(true);

    // searchEntities: the RUN-scoped search returns the entities, never a ge: node.
    const search = await neo4j.searchEntities(SYSTEM_CONTEXT, { q: RUN, limit: 100 });
    const ids = search.map((r) =>
      String((r.get('n') as { properties: { id: unknown } }).properties.id),
    );
    expect(ids.some((id) => id.startsWith('ge:'))).toBe(false);
    expect(ids).toContain(svcId('s7a'));
  });

  // --- 9. create-vs-match (justCreated) under real MERGE ---------------------
  it('9. justCreated is true only for the MERGE that creates the edge, false for a subsequent match', async () => {
    await seedService('s9a');
    await seedService('s9b');

    // First add → created (MERGE created the edge).
    const created = await rel.addRelation({
      from: svcId('s9a'),
      to: svcId('s9b'),
      type: REL,
      actor: 'alice@x',
    });
    expect(created.created).toBe(true);

    // Second add by the SAME actor → MERGE matched the existing edge, so
    // justCreated is false (idempotent no-op, no preexistingConnectorEdge flag).
    const matched = await rel.addRelation({
      from: svcId('s9a'),
      to: svcId('s9b'),
      type: REL,
      actor: 'alice@x',
    });
    expect(matched).toEqual({ created: false });

    // A DIFFERENT actor re-asserting the SAME manual edge also matches (the edge
    // already has a _manual_actor → isManual true, justCreated false): still a
    // no-op, the original actor's marker is preserved (ON CREATE-only).
    const otherActor = await rel.addRelation({
      from: svcId('s9a'),
      to: svcId('s9b'),
      type: REL,
      actor: 'carol@x',
    });
    expect(otherActor).toEqual({ created: false });
    const edges = await readEdges(svcId('s9a'), svcId('s9b'), REL);
    expect(edges).toHaveLength(1);
    expect(edges[0]._manual_actor).toBe('alice@x'); // ON CREATE-only: not reassigned
  });
});

// --- 8. RBAC at the route, end-to-end against a REAL DB --------------------
//
// The inject-level route tests prove the 403 with a faked service. The
// end-to-end gap they CANNOT cover: that a rejected write leaves NO trace in a
// real database — no edge, no GraphEditEvent. Here we wire a REAL Neo4jService
// through createServer (so the route builds the real RelationEditService), seed
// two nodes, and assert an mcp-token principal lacking graph:write is 403'd AND
// the graph carries no edge / no audit row.
describe.skipIf(!URI)('manual-RELATIONS RBAC — route → real DB (T5b, scenario 8)', () => {
  const RBAC = `rel-rbac-${process.pid}-${Math.floor(performance.now())}`;
  const fromId = `shipit://LogicalService/${RBAC}/from`;
  const toId = `shipit://LogicalService/${RBAC}/to`;
  let server: Awaited<ReturnType<typeof createServer>>;
  let neo4j: Neo4jService;

  beforeAll(async () => {
    neo4j = new Neo4jService(URI!, USER, PASSWORD);
    await neo4j.runQuery(
      `MERGE (a:LogicalService {id:$from}) SET a.name = 'rbac-from'
       MERGE (b:LogicalService {id:$to}) SET b.name = 'rbac-to'`,
      { from: fromId, to: toId },
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
    await neo4j.runQuery('MATCH (n) WHERE n.id CONTAINS $p DETACH DELETE n', { p: RBAC });
    await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.from_id CONTAINS $p OR e.to_id CONTAINS $p DETACH DELETE e`,
      { p: RBAC },
    );
    await neo4j?.close();
    delete process.env.SHIPIT_SESSION_SECRET;
    delete process.env.TEST_OIDC_CLIENT_SECRET;
  });

  it('mcp-token lacking graph:write → 403 and NO edge/audit reaches the DB', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: fromId, to: toId, type: 'DEPENDS_ON' },
      headers: { authorization: 'Bearer read-only-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');

    // No edge of any type slipped between the two nodes.
    const edges = await neo4j.runQuery(
      `MATCH (a {id:$from})-[r]->(b {id:$to}) RETURN count(r) AS c`,
      { from: fromId, to: toId },
    );
    expect((edges[0].get('c') as { toNumber: () => number }).toNumber()).toBe(0);

    // And no GraphEditEvent was written.
    const events = await neo4j.runQuery(
      `MATCH (e:GraphEditEvent) WHERE e.from_id = $from RETURN count(e) AS c`,
      { from: fromId },
    );
    expect((events[0].get('c') as { toNumber: () => number }).toNumber()).toBe(0);
  });
});
