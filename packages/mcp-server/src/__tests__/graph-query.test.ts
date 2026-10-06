import { describe, it, expect } from 'vitest';
import { registerGraphQuery } from '../tools/graph-query.js';
import { ReadOnlyQueryError } from '../cypher/read-only-query.js';
import type { McpServerConfig } from '../config.js';
import { createMockNeo4jClient } from './helpers/mock-neo4j.js';
import { captureTool, toolPayload } from './helpers/capture-tool.js';

const CONFIG = {
  rateLimits: { graphQueryPerDay: 100, rowLimit: 100, hopLimit: 6, queryTimeoutMs: 10_000 },
} as McpServerConfig;

type Payload = {
  error?: { code: string; message: string };
  data?: { rows: unknown[]; row_count: number };
  _meta?: { truncated: boolean; warnings?: string[] };
};

function graphQuery(neo4j = createMockNeo4jClient(), config = CONFIG, now?: () => Date) {
  const handler = captureTool(
    registerGraphQuery as never,
    neo4j as never,
    config as never,
    (now ? { now } : undefined) as never,
  );
  const run = async (query: string, params?: Record<string, unknown>): Promise<Payload> =>
    toolPayload(await handler({ query, params, compact: false })) as Payload;
  /** A call that arrived over HTTP with a token: the transport passes its scopes along. */
  const runAs = async (owner: string, scopes: string[], query = 'RETURN 1 AS one') =>
    toolPayload(
      await handler(
        { query, compact: false },
        { authInfo: { token: '', clientId: owner, scopes } },
      ),
    ) as Payload;
  return { neo4j, run, runAs };
}

describe('graph_query', () => {
  describe('what it refuses before anything reaches the database', () => {
    it.each([
      ['a write', 'MATCH (n) SET n.name = "new"'],
      ['an import', 'LOAD CSV FROM "file.csv" AS row RETURN row'],
      ['a procedure that is not on the list', 'CALL some.other.procedure()'],
      ['a namespaced function that is not on the list', 'RETURN some.namespace.fn(1)'],
      [
        'a subquery in its own transactions',
        'MATCH (n) CALL { WITH n RETURN n AS m } IN TRANSACTIONS RETURN m',
      ],
      ['an internal label', 'MATCH (t:_AccessToken) RETURN t'],
      ['an empty query', '   '],
    ])('%s', async (_what, query) => {
      const { neo4j, run } = graphQuery();
      const payload = await run(query);
      expect(payload.error?.code).toBe('INVALID_PARAMETER');
      expect(neo4j.runReadOnlyQuery).not.toHaveBeenCalled();
      expect(neo4j.runCypher).not.toHaveBeenCalled();
    });

    it('tells the caller what was refused', async () => {
      const payload = await graphQuery().run('MATCH (n) DETACH DELETE n');
      expect(payload.error?.message).toContain('DETACH');
    });

    it('a variable-length pattern past the hop limit', async () => {
      const { neo4j, run } = graphQuery();
      const payload = await run('MATCH (n)-[*1..10]->(m) RETURN n, m');
      expect(payload.error?.code).toBe('HOP_LIMIT_EXCEEDED');
      expect(neo4j.runReadOnlyQuery).not.toHaveBeenCalled();
    });

    it('any pattern past the hop limit, when the query has several', async () => {
      const payload = await graphQuery().run('MATCH (a)-[*1..3]->(b)-[*1..8]->(c) RETURN a, b, c');
      expect(payload.error?.code).toBe('HOP_LIMIT_EXCEEDED');
    });

    it.each([
      'MATCH (a)-[*]->(b) RETURN b',
      'MATCH (a)-[:DEPENDS_ON*]->(b) RETURN b',
      'MATCH (a)-[r:DEPENDS_ON * 2..]->(b) RETURN b',
      'MATCH (a)-[*2.. {weight: 1}]->(b) RETURN b',
      'MATCH path = shortestPath((a)-[*]-(b)) RETURN path',
      'MATCH ((a)-[:DEPENDS_ON]->(b)){1,50} RETURN b',
      'MATCH ((a)-[:DEPENDS_ON]->(b)){3,} RETURN b',
      'MATCH ((a)-[:DEPENDS_ON]->(b)){,10} RETURN b',
      // The postfix quantifiers of a quantified path pattern, and the
      // quantifiers of a single relationship.
      'MATCH ((a)-[:DEPENDS_ON]->(b))+ RETURN count(*)',
      'MATCH (s) ((a)-->(b))* (t) RETURN s, t',
      'MATCH (a)-[:DEPENDS_ON]->{1,50}(b) RETURN b',
      'MATCH (a)-[:DEPENDS_ON]->+(b) RETURN b',
      'MATCH (a)-->*(b) RETURN b',
      'MATCH (a)<-[:DEPENDS_ON]-{2,}(b) RETURN b',
      'MATCH (a)--{,9}(b) RETURN b',
    ])('a pattern with no upper bound, or one past the limit: %s', async (query) => {
      const { neo4j, run } = graphQuery();
      const payload = await run(query);
      expect(payload.error?.code).toBe('HOP_LIMIT_EXCEEDED');
      expect(payload.error?.message).toContain('6');
      expect(neo4j.runReadOnlyQuery).not.toHaveBeenCalled();
    });
  });

  it('decides the hop limit in time proportional to the query', async () => {
    const nested = 'MATCH ' + '('.repeat(20_000) + '(a)-->(b)' + ')*'.repeat(20_000) + ' RETURN a';
    const started = performance.now();
    const payload = await graphQuery().run(nested);
    expect(payload.error?.code).toBe('HOP_LIMIT_EXCEEDED');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  describe('what it runs', () => {
    it('a read, as written, with the configured timeout and row limit', async () => {
      const { neo4j, run } = graphQuery();
      await run('MATCH (s:LogicalService) WHERE s.name = $name RETURN s LIMIT 5000', {
        name: 'config-service',
      });
      expect(neo4j.runReadOnlyQuery).toHaveBeenCalledWith(
        'MATCH (s:LogicalService) WHERE s.name = $name RETURN s LIMIT 5000',
        { name: 'config-service' },
        { timeoutMs: 10_000, rowLimit: 100 },
      );
    });

    it('a read without parameters', async () => {
      const { neo4j, run } = graphQuery();
      await run('MATCH (n) RETURN n');
      expect(neo4j.runReadOnlyQuery).toHaveBeenCalledWith(
        'MATCH (n) RETURN n',
        {},
        { timeoutMs: 10_000, rowLimit: 100 },
      );
    });

    it('a query whose strings and names happen to contain a write word', async () => {
      const { neo4j, run } = graphQuery();
      const payload = await run("MATCH (n {name: 'CREATE'}) RETURN n.createdAt AS created");
      expect(payload.error).toBeUndefined();
      expect(neo4j.runReadOnlyQuery).toHaveBeenCalledTimes(1);
    });

    it.each([
      'MATCH (n)-[*1..5]->(m) RETURN n, m',
      'MATCH (n)-[*..6]->(m) RETURN n, m',
      'MATCH (n)-[r:DEPENDS_ON*3]->(m) RETURN n, m',
      'MATCH path = shortestPath((a)-[*..6]-(b)) RETURN path',
      'MATCH ((a)-[:DEPENDS_ON]->(b)){1,6} RETURN b',
      'MATCH ((a)-[:DEPENDS_ON]->(b)){2} RETURN b',
      'MATCH (a)-[:DEPENDS_ON]->{1,6}(b) RETURN b',
      'MATCH (a)-->{3}(b) RETURN b',
      // Not patterns: a string, arithmetic, a list comprehension.
      "MATCH (n) WHERE n.note = 'see [*] and [*2..]' RETURN n",
      'RETURN (1 + 2) * 3 AS a, [x IN [1, 2] | x * 2] AS b, [1, 2] * 3 AS c',
      'MATCH (n) RETURN (n.a + n.b) * (n.c) AS p, (1) + (2) AS q, round((count(*) * 100.0) / 3) AS r',
    ])('a bounded pattern within the hop limit, or no pattern at all: %s', async (query) => {
      const { neo4j, run } = graphQuery();
      const payload = await run(query);
      expect(payload.error).toBeUndefined();
      expect(neo4j.runReadOnlyQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('what it returns', () => {
    it('the rows and how many there are', async () => {
      const { neo4j, run } = graphQuery();
      neo4j.runReadOnlyQuery.mockResolvedValue({
        columns: ['dependency'],
        rows: [{ dependency: 'auth-service' }, { dependency: 'db-proxy' }],
        truncated: false,
        withheld: 0,
      });
      const payload = await run('MATCH (d) RETURN d.name AS dependency');
      expect(payload.data).toEqual({
        rows: [{ dependency: 'auth-service' }, { dependency: 'db-proxy' }],
        row_count: 2,
      });
      expect(payload._meta?.truncated).toBe(false);
      expect(payload._meta?.warnings).toBeUndefined();
    });

    it('a warning when the result was cut short at the row limit', async () => {
      const { neo4j, run } = graphQuery();
      neo4j.runReadOnlyQuery.mockResolvedValue({
        columns: ['n'],
        rows: [{ n: 1 }],
        truncated: true,
        withheld: 0,
      });
      const payload = await run('MATCH (n) RETURN n');
      expect(payload._meta?.truncated).toBe(true);
      expect(payload._meta?.warnings).toEqual(['Results truncated to 100 rows']);
    });

    it('a warning when internal nodes were withheld', async () => {
      const { neo4j, run } = graphQuery();
      neo4j.runReadOnlyQuery.mockResolvedValue({
        columns: ['n'],
        rows: [{ n: null }, { n: null }],
        truncated: false,
        withheld: 2,
      });
      const payload = await run('MATCH (n) RETURN n');
      expect(payload._meta?.truncated).toBe(false);
      expect(payload._meta?.warnings).toEqual([
        '2 values withheld: internal nodes are not available to graph_query',
      ]);
    });
  });

  // Over HTTP every call carries a token (packages/mcp-server/src/index.ts
  // puts its owner and scopes on the request). Over stdio, and in-process in
  // the agent runner, there is none: that is the operator's own trust.
  describe('who may call it over HTTP', () => {
    it('refuses a token without the graph:query scope, before anything runs', async () => {
      const { neo4j, runAs } = graphQuery();
      const payload = await runAs('someone@example.com', ['mcp:invoke', 'graph:read']);
      expect(payload.error?.code).toBe('RBAC_DENIED');
      expect(payload.error?.message).toContain('graph:query');
      expect(neo4j.runReadOnlyQuery).not.toHaveBeenCalled();
    });

    it('runs for a token with the scope', async () => {
      const { neo4j, runAs } = graphQuery();
      const payload = await runAs('someone@example.com', ['mcp:invoke', 'graph:query']);
      expect(payload.error).toBeUndefined();
      expect(neo4j.runReadOnlyQuery).toHaveBeenCalledTimes(1);
    });

    it('runs without a token, as over stdio', async () => {
      const { neo4j, run } = graphQuery();
      const payload = await run('RETURN 1 AS one');
      expect(payload.error).toBeUndefined();
      expect(neo4j.runReadOnlyQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('how many calls a token owner gets per day', () => {
    const twoPerDay = {
      rateLimits: { ...CONFIG.rateLimits, graphQueryPerDay: 2 },
    } as McpServerConfig;
    const SCOPES = ['mcp:invoke', 'graph:query'];

    it('refuses the call after the budget, and counts each owner by itself', async () => {
      const { runAs } = graphQuery(createMockNeo4jClient(), twoPerDay);
      expect((await runAs('a@example.com', SCOPES)).error).toBeUndefined();
      expect((await runAs('a@example.com', SCOPES)).error).toBeUndefined();
      const third = await runAs('a@example.com', SCOPES);
      expect(third.error?.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(third.error?.message).toContain('2');
      expect((await runAs('b@example.com', SCOPES)).error).toBeUndefined();
    });

    it('starts afresh with the next UTC day', async () => {
      let now = new Date('2026-10-05T23:59:30Z');
      const { runAs } = graphQuery(createMockNeo4jClient(), twoPerDay, () => now);
      await runAs('a@example.com', SCOPES);
      await runAs('a@example.com', SCOPES);
      expect((await runAs('a@example.com', SCOPES)).error?.code).toBe('RATE_LIMIT_EXCEEDED');
      now = new Date('2026-10-06T00:00:30Z');
      expect((await runAs('a@example.com', SCOPES)).error).toBeUndefined();
    });

    it('does not count a call the checks refuse', async () => {
      const { runAs } = graphQuery(createMockNeo4jClient(), twoPerDay);
      for (let i = 0; i < 4; i++) {
        const refused = await runAs('a@example.com', SCOPES, 'MATCH (n) SET n.x = 1');
        expect(refused.error?.code).toBe('INVALID_PARAMETER');
      }
      expect((await runAs('a@example.com', SCOPES)).error).toBeUndefined();
    });

    it('does not count calls that carry no token', async () => {
      const { run } = graphQuery(createMockNeo4jClient(), twoPerDay);
      for (let i = 0; i < 5; i++) expect((await run('RETURN 1 AS one')).error).toBeUndefined();
    });
  });

  describe('how it reports a failure', () => {
    it.each([
      ['busy', 'SERVER_BUSY'],
      ['too_large', 'ROW_LIMIT_EXCEEDED'],
      ['timeout', 'QUERY_TIMEOUT'],
      ['write_refused', 'INVALID_PARAMETER'],
      ['failed', 'INTERNAL_ERROR'],
    ] as const)('%s as %s', async (kind, code) => {
      const { neo4j, run } = graphQuery();
      neo4j.runReadOnlyQuery.mockRejectedValue(new ReadOnlyQueryError(kind, 'what went wrong'));
      const payload = await run('MATCH (n) RETURN n');
      expect(payload.error?.code).toBe(code);
    });

    it("with the database's message when the query itself is wrong", async () => {
      const { neo4j, run } = graphQuery();
      neo4j.runReadOnlyQuery.mockRejectedValue(
        new ReadOnlyQueryError('failed', "Invalid input 'RETRN'"),
      );
      const payload = await run('MATCH (n) RETRN n');
      expect(payload.error?.message).toContain("Invalid input 'RETRN'");
    });
  });
});
