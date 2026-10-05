import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReadOnlyQueryError } from '@shipit-ai/mcp-server/cypher';
import { createServer } from '../../server.js';
import type { Neo4jService } from '../../services/neo4j-service.js';
import { makeTestConfig } from '../test-config.js';

// The service is the route's door to the database. What it does there is
// covered against a real one in cypher-query-service.integration.test.ts.
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../services/cypher-query-service.js', () => ({
  CypherQueryService: class {
    execute = execute;
  },
}));

const RESULT = {
  columns: ['name'],
  rows: [{ name: 'graph-api' }],
  executionTimeMs: 3,
  truncated: false,
  rowLimit: 1000,
  withheld: 0,
};

describe('POST /api/query', () => {
  let server: FastifyInstance;

  const post = (payload: object) => server.inject({ method: 'POST', url: '/api/query', payload });

  beforeAll(async () => {
    const neo4jService = { getDriver: vi.fn().mockReturnValue({}) } as unknown as Neo4jService;
    server = await createServer({ neo4jService, config: makeTestConfig() });
    await server.ready();
  });

  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue(RESULT);
  });

  afterAll(async () => {
    await server.close();
  });

  it('runs a read and returns its result', async () => {
    const response = await post({
      cypher: 'MATCH (s:LogicalService) WHERE s.tier = $tier RETURN s.name AS name',
      params: { tier: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RESULT);
    expect(execute).toHaveBeenCalledWith(
      'MATCH (s:LogicalService) WHERE s.tier = $tier RETURN s.name AS name',
      { tier: 1 },
    );
  });

  it('asks for the query as a string and the parameters as an object', async () => {
    const noString = await post({ cypher: 42 });
    expect(noString.statusCode).toBe(400);
    expect(noString.json().error.code).toBe('VALIDATION_ERROR');

    const noObject = await post({ cypher: 'RETURN 1', params: 'tier=1' });
    expect(noObject.statusCode).toBe(400);
    expect(noObject.json().error.code).toBe('VALIDATION_ERROR');
    expect(execute).not.toHaveBeenCalled();
  });

  describe('what it refuses before anything reaches the database', () => {
    it.each([
      ['a write', 'MATCH (n) SET n.tier = 1', 'WRITE_BLOCKED', 'SET'],
      ['an import', 'LOAD CSV FROM "file.csv" AS row RETURN row', 'WRITE_BLOCKED', 'LOAD'],
      [
        'a procedure that is not on the list',
        'CALL some.other.procedure()',
        'WRITE_BLOCKED',
        'CALL',
      ],
    ])('%s', async (_what, cypher, code, keyword) => {
      const response = await post({ cypher });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code, keyword });
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      ['a namespaced function that is not on the list', 'RETURN some.namespace.fn(1)'],
      ['an internal label', 'MATCH (t:_AccessToken) RETURN t'],
      ['more than one statement', 'RETURN 1 AS x; RETURN 2 AS y'],
      ['an empty query', '  '],
    ])('%s', async (_what, cypher) => {
      const response = await post({ cypher });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(execute).not.toHaveBeenCalled();
    });

    it('says why', async () => {
      const response = await post({ cypher: 'CALL some.other.procedure()' });
      expect(response.json().error.message).toContain('some.other.procedure');
    });
  });

  describe('how it reports a failure', () => {
    it('too many queries running at once as 429 QUERY_BUSY', async () => {
      execute.mockRejectedValue(new ReadOnlyQueryError('busy', 'try again shortly'));
      const response = await post({ cypher: 'MATCH (n) RETURN n' });
      expect(response.statusCode).toBe(429);
      expect(response.json().error).toEqual({ code: 'QUERY_BUSY', message: 'try again shortly' });
    });

    it('a query that ran past its timeout as 504 QUERY_TIMEOUT', async () => {
      execute.mockRejectedValue(new ReadOnlyQueryError('timeout', 'took too long'));
      const response = await post({ cypher: 'MATCH (n) RETURN n' });
      expect(response.statusCode).toBe(504);
      expect(response.json().error).toEqual({ code: 'QUERY_TIMEOUT', message: 'took too long' });
    });

    it('a write the database refused as 400 WRITE_BLOCKED', async () => {
      execute.mockRejectedValue(new ReadOnlyQueryError('write_refused', 'the database said no'));
      const response = await post({ cypher: 'MATCH (n) RETURN n' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({
        code: 'WRITE_BLOCKED',
        message: 'the database said no',
      });
    });

    it("anything else as 400 CYPHER_ERROR with the database's message", async () => {
      execute.mockRejectedValue(new ReadOnlyQueryError('failed', "Invalid input 'RETRN'"));
      const response = await post({ cypher: 'MATCH (n) RETRN n' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({
        code: 'CYPHER_ERROR',
        message: "Invalid input 'RETRN'",
      });
    });
  });
});
