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

function graphQuery(neo4j = createMockNeo4jClient()) {
  const handler = captureTool(registerGraphQuery as never, neo4j as never, CONFIG as never);
  const run = async (query: string, params?: Record<string, unknown>): Promise<Payload> =>
    toolPayload(await handler({ query, params, compact: false })) as Payload;
  return { neo4j, run };
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

    it('a variable-length pattern within the hop limit', async () => {
      const { neo4j, run } = graphQuery();
      const payload = await run('MATCH (n)-[*1..5]->(m) RETURN n, m');
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

  describe('how it reports a failure', () => {
    it.each([
      ['busy', 'SERVER_BUSY'],
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
