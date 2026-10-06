/**
 * Neo4j-BACKED integration test for how a caller-written query is run: the
 * executor behind the Query Playground and the graph_query MCP tool
 * (runReadOnlyQuery in @shipit-ai/mcp-server, reached here through
 * CypherQueryService).
 *
 * Every query below is handed straight to the service, past the text check the
 * route applies first. That is the point: these are the protections that do
 * not depend on reading the query right, and only a real database can show
 * that they hold.
 *
 * Gated on NEO4J_TEST_URI. Isolated/scratch DB — wipes the graph per test. Runs
 * in the CI `integration` job (serial; see the shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { CypherQueryService } from '../../services/cypher-query-service.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';

// Two ranges multiplied out: a read with far more rows than any timeout here
// lets it produce.
const SLOW_READ = 'UNWIND range(1, 100000) AS a UNWIND range(1, 100000) AS b RETURN count(*) AS c';

// The same amount of work inside a single row. The database ends a query that
// is past its timeout between rows, so this one it carries on with.
const SLOW_ROW =
  'RETURN reduce(a = 0, x IN range(1, 20000) | a + reduce(b = 0, y IN range(1, 20000) | b + x + y)) AS s';

describe.skipIf(!URI)('CypherQueryService — integration', () => {
  let driver: Driver;

  const service = (limits: { timeoutMs?: number; rowLimit?: number } = {}) =>
    new CypherQueryService(driver, { timeoutMs: 5_000, rowLimit: 100, ...limits });

  /** Runs outside the service, with a session that may write. */
  const direct = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try {
      return (await session.run(cypher, params)).records;
    } finally {
      await session.close();
    }
  };

  beforeAll(() => {
    driver = neo4j.driver(URI!, neo4j.auth.basic(USER, PASSWORD));
  });

  afterEach(async () => {
    await direct('MATCH (n) DETACH DELETE n');
  });

  afterAll(async () => {
    await driver.close();
  });

  it('runs a read and returns plain values', async () => {
    await direct(
      `CREATE (:Repository {name: 'api', stars: 7})
       CREATE (:Repository {name: 'web', stars: 3})`,
    );
    const result = await service().execute(
      'MATCH (r:Repository) WHERE r.stars > $min RETURN r.name AS name, r.stars AS stars, r AS repo ORDER BY name',
      { min: 1 },
    );
    expect(result.columns).toEqual(['name', 'stars', 'repo']);
    expect(result.rows).toEqual([
      {
        name: 'api',
        stars: 7,
        repo: { _kind: 'node', labels: ['Repository'], properties: { name: 'api', stars: 7 } },
      },
      {
        name: 'web',
        stars: 3,
        repo: { _kind: 'node', labels: ['Repository'], properties: { name: 'web', stars: 3 } },
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.withheld).toBe(0);
  });

  it('returns nothing, and no error, for EXPLAIN', async () => {
    const result = await service().execute('EXPLAIN MATCH (n) RETURN n');
    expect(result.rows).toEqual([]);
  });

  describe('writes', () => {
    it('the database refuses a write that reaches it, and nothing is stored', async () => {
      await expect(service().execute('CREATE (:Scratch {made: true})')).rejects.toMatchObject({
        name: 'ReadOnlyQueryError',
        kind: 'write_refused',
      });
      const [row] = await direct('MATCH (s:Scratch) RETURN count(s) AS made');
      expect(row!.get('made').toNumber()).toBe(0);
    });

    it('leaves existing data as it was', async () => {
      await direct(`CREATE (:Repository {name: 'api', tier: 1})`);
      await expect(
        service().execute('MATCH (r:Repository) SET r.tier = 9 RETURN r'),
      ).rejects.toMatchObject({ kind: 'write_refused' });
      await expect(service().execute('MATCH (r:Repository) DETACH DELETE r')).rejects.toMatchObject(
        {
          kind: 'write_refused',
        },
      );
      const [row] = await direct('MATCH (r:Repository) RETURN r.tier AS tier');
      expect(row!.get('tier').toNumber()).toBe(1);
    });
  });

  describe('the row limit', () => {
    it('holds whatever LIMIT the query carries', async () => {
      const result = await service({ rowLimit: 5 }).execute(
        'UNWIND range(1, 1000) AS i RETURN i LIMIT 500',
      );
      expect(result.rows).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);
      expect(result.truncated).toBe(true);
      expect(result.rowLimit).toBe(5);
    });

    it('holds when the query has no LIMIT, without reading the rest', async () => {
      const started = Date.now();
      const result = await service({ rowLimit: 5 }).execute(
        'UNWIND range(1, 50000000) AS i RETURN i',
      );
      expect(result.rows).toHaveLength(5);
      expect(result.truncated).toBe(true);
      // Fifty million rows would take far longer than this to read.
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('refuses a single row that holds too many values', async () => {
      await expect(service().execute('RETURN range(1, 300000) AS big')).rejects.toMatchObject({
        name: 'ReadOnlyQueryError',
        kind: 'too_large',
      });
    });

    it('does not call a result of exactly the limit cut short', async () => {
      const result = await service({ rowLimit: 5 }).execute('UNWIND range(1, 5) AS i RETURN i');
      expect(result.rows).toHaveLength(5);
      expect(result.truncated).toBe(false);
    });
  });

  describe('the timeout', () => {
    it('ends a query that runs too long', async () => {
      const started = Date.now();
      await expect(service({ timeoutMs: 300 }).execute(SLOW_READ)).rejects.toMatchObject({
        name: 'ReadOnlyQueryError',
        kind: 'timeout',
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('answers the caller at the timeout when the work sits inside one row', async () => {
      const started = Date.now();
      await expect(service({ timeoutMs: 300 }).execute(SLOW_ROW)).rejects.toMatchObject({
        name: 'ReadOnlyQueryError',
        kind: 'timeout',
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('leaves the service able to run the next query', async () => {
      await service({ timeoutMs: 300 })
        .execute(SLOW_READ)
        .catch(() => {});
      const result = await service().execute('RETURN 1 AS one');
      expect(result.rows).toEqual([{ one: 1 }]);
    });
  });

  describe('internal nodes', () => {
    const seed = () =>
      direct(
        `CREATE (:_AccessToken {id: 't1', ownerEmail: 'someone@example.com'})
         CREATE (r:Repository {name: 'api'})
         CREATE (:_LinkingKey {linking_key: 'lk'})-[:POINTS_AT]->(r)`,
      );

    it('are withheld from the rows, and counted', async () => {
      await seed();
      const result = await service().execute('MATCH (n) RETURN n');
      const kept = result.rows.filter((row) => row.n !== null);
      expect(kept).toEqual([
        { n: { _kind: 'node', labels: ['Repository'], properties: { name: 'api' } } },
      ]);
      expect(result.rows).toHaveLength(3);
      expect(result.withheld).toBe(2);
    });

    it('are withheld inside a list', async () => {
      await seed();
      const result = await service().execute('MATCH (n) RETURN collect(n) AS everything');
      const everything = result.rows[0]!.everything as unknown[];
      expect(everything).toHaveLength(3);
      expect(everything.filter((n) => n !== null)).toHaveLength(1);
      expect(result.withheld).toBe(2);
    });

    it('take a path that passes through one with them', async () => {
      await seed();
      const result = await service().execute(
        'MATCH p = (a)-[:POINTS_AT]->(b) RETURN p, b.name AS name',
      );
      expect(result.rows).toEqual([{ p: null, name: 'api' }]);
      expect(result.withheld).toBe(1);
    });
  });
});
