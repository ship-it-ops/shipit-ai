/**
 * Neo4j-BACKED integration test for the api-server read path (Neo4jService).
 *
 * These methods run APOC (`apoc.path.subgraphAll` with a relationshipFilter) and
 * application-layer `_`-internal-label exclusion — neither is exercisable by the
 * mocked unit suite, and a real ownership-traversal bug (blast radius walked OWNS
 * but not CODEOWNER_OF) already shipped to prod invisible to mocks
 * (docs/agent/investigations/team-ownership-invisible-owns-and-blast-radius.md).
 *
 * Gated on NEO4J_TEST_URI; REQUIRES APOC (CI Neo4j service sets NEO4J_PLUGINS).
 * Isolated/scratch DB — wipes the graph per test. Runs in the CI `integration`
 * job (serial; see the shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { SYSTEM_CONTEXT } from '@shipit-ai/shared';
import { Neo4jService } from '../../services/neo4j-service.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';

const ID = {
  team: 'shipit://Team/default/acme/platform',
  owned: 'shipit://Repository/default/acme/owned',
  codeowned: 'shipit://Repository/default/acme/codeowned',
  dependent: 'shipit://Repository/default/acme/dependent',
  unrelated: 'shipit://Repository/default/acme/unrelated',
};

describe.skipIf(!URI)('Neo4jService read path — integration (APOC)', () => {
  let svc: Neo4jService;

  beforeAll(() => {
    svc = new Neo4jService(URI!, USER, PASSWORD);
  });

  afterEach(async () => {
    await svc.runQuery('MATCH (n) DETACH DELETE n');
  });

  afterAll(async () => {
    await svc.close();
  });

  // Graph:
  //   (team)-[:OWNS]->(owned)
  //   (team)-[:CODEOWNER_OF]->(codeowned)
  //   (dependent)-[:DEPENDS_ON]->(owned)
  //   (unrelated)            -- no path
  //   (:_LinkingKey)         -- internal, must be excluded from user-facing reads
  const seed = () =>
    svc.runQuery(
      `CREATE (t:Team {id:$team, name:'platform'})
       CREATE (o:Repository {id:$owned, name:'owned'})
       CREATE (c:Repository {id:$codeowned, name:'codeowned'})
       CREATE (d:Repository {id:$dependent, name:'dependent'})
       CREATE (u:Repository {id:$unrelated, name:'unrelated'})
       CREATE (t)-[:OWNS]->(o)
       CREATE (t)-[:CODEOWNER_OF]->(c)
       CREATE (d)-[:DEPENDS_ON]->(o)
       CREATE (:_LinkingKey {linking_key:'lk', canonical_id:$owned})`,
      ID,
    );

  const idset = (r: { nodes: Array<{ data: { id: unknown } }> }) =>
    new Set(r.nodes.map((n) => String(n.data.id)));

  describe('getBlastRadius (APOC relationshipFilter)', () => {
    it('from a Team reaches BOTH owned (OWNS) and codeowned (CODEOWNER_OF) repos', async () => {
      await seed();
      const ids = idset(await svc.getBlastRadius(SYSTEM_CONTEXT, ID.team, 3));
      // The fix added CODEOWNER_OF: a codeowned-only repo must be in the radius.
      expect(ids.has(ID.owned)).toBe(true);
      expect(ids.has(ID.codeowned)).toBe(true);
      // transitive: owned has an inbound DEPENDS_ON dependent → also reached
      expect(ids.has(ID.dependent)).toBe(true);
      expect(ids.has(ID.unrelated)).toBe(false);
    });

    it('from a service reaches inbound DEPENDS_ON dependents', async () => {
      await seed();
      const ids = idset(await svc.getBlastRadius(SYSTEM_CONTEXT, ID.owned, 3));
      expect(ids.has(ID.dependent)).toBe(true);
      expect(ids.has(ID.unrelated)).toBe(false);
    });
  });

  describe('internal-label exclusion', () => {
    it('getGraphStats counts only user-facing labels (no _LinkingKey)', async () => {
      await seed();
      const stats = await svc.getGraphStats(SYSTEM_CONTEXT);
      expect(Object.keys(stats.nodesByLabel)).toEqual(
        expect.arrayContaining(['Team', 'Repository']),
      );
      expect(Object.keys(stats.nodesByLabel).some((l) => l.startsWith('_'))).toBe(false);
      expect(stats.nodeCount).toBe(5); // 1 Team + 4 Repository; _LinkingKey excluded
    });

    it('getOverview omits internal nodes', async () => {
      await seed();
      const overview = await svc.getOverview(SYSTEM_CONTEXT, 100);
      const ids = idset(overview);
      expect(ids.has(ID.team)).toBe(true);
      expect([...ids].some((id) => id.includes('_LinkingKey') || id === 'lk')).toBe(false);
      expect(overview.nodes).toHaveLength(5);
    });
  });

  describe('searchEntities', () => {
    it('finds by free-text and excludes internal nodes', async () => {
      await seed();
      const results = await svc.searchEntities(SYSTEM_CONTEXT, { q: 'owned', limit: 25 });
      const names = results.map((r) =>
        String((r.get('n') as { properties: { id: unknown } }).properties.id),
      );
      expect(names).toContain(ID.owned);
      expect(names).toContain(ID.codeowned);
      expect(names.every((id) => !id.includes('lk'))).toBe(true);
    });
  });

  // Regression: audit/event nodes (VerificationEvent `ve:…`, MergeEvent /
  // ReconciliationCandidate `rc:…`) predate the `_`-label convention, so the
  // prefix-only exclusion let them leak into the catalog as nameless "Service"
  // rows with no env/tier/owner. They must be filtered from every user-facing read.
  describe('audit-node exclusion (ve:/rc: events must not surface as entities)', () => {
    const seedWithAudit = () =>
      svc.runQuery(
        `CREATE (s:Repository {id:$owned, name:'owned'})
         CREATE (:VerificationEvent {id:'ve:test-verify', entityId:$owned, property_key:'tier', kind:'verify', actor:'alice'})
         CREATE (:MergeEvent {id:'rc:test-merge'})
         CREATE (:ReconciliationCandidate {id:'rc:test-candidate'})`,
        ID,
      );

    const isAuditId = (id: string) => id.startsWith('ve:') || id.startsWith('rc:');

    it('getOverview omits VerificationEvent / MergeEvent / ReconciliationCandidate nodes', async () => {
      await seedWithAudit();
      const ids = idset(await svc.getOverview(SYSTEM_CONTEXT, 100));
      expect(ids.has(ID.owned)).toBe(true);
      expect([...ids].some(isAuditId)).toBe(false);
    });

    it('searchEntities never returns audit nodes (even when the id matches the query)', async () => {
      await seedWithAudit();
      const results = await svc.searchEntities(SYSTEM_CONTEXT, { q: 'test', limit: 25 });
      const ids = results.map((r) =>
        String((r.get('n') as { properties: { id: unknown } }).properties.id),
      );
      expect(ids.every((id) => !isAuditId(id))).toBe(true);
    });

    it('getGraphStats does not count audit labels', async () => {
      await seedWithAudit();
      const stats = await svc.getGraphStats(SYSTEM_CONTEXT);
      expect(Object.keys(stats.nodesByLabel)).not.toEqual(
        expect.arrayContaining(['VerificationEvent', 'MergeEvent', 'ReconciliationCandidate']),
      );
      expect(stats.nodeCount).toBe(1); // only the Repository; 3 audit nodes excluded
    });

    it('getNeighborhood drops the [:VERIFIES]-linked audit node and its edge', async () => {
      // The neighborhood traversal has no relationship filter, so an entity's
      // inbound VerificationEvent is reachable and must be filtered in code.
      await svc.runQuery(
        `CREATE (s:Repository {id:$owned, name:'owned'})
         CREATE (v:VerificationEvent {id:'ve:nbr', entityId:$owned})
         CREATE (v)-[:VERIFIES]->(s)`,
        ID,
      );
      const result = await svc.getNeighborhood(SYSTEM_CONTEXT, ID.owned, 2);
      expect(result.nodes.map((n) => String(n.data.id))).toEqual([ID.owned]);
      expect(result.edges.some((e) => e.data.type === 'VERIFIES')).toBe(false);
    });
  });
});
