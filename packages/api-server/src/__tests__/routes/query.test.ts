import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { ReadOnlyQueryError } from '@shipit-ai/mcp-server/cypher';
import { createServer } from '../../server.js';
import type { Neo4jService } from '../../services/neo4j-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';

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

    it('a result with too many values as 400 RESULT_TOO_LARGE', async () => {
      execute.mockRejectedValue(new ReadOnlyQueryError('too_large', 'too many values'));
      const response = await post({ cypher: 'MATCH (n) RETURN n' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({
        code: 'RESULT_TOO_LARGE',
        message: 'too many values',
      });
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

// Raw Cypher reads everything in the graph, the application's own records
// included, so it is for administrators and for tokens they mint with the
// graph:query scope. With auth on, a bearer token is always a member
// principal whose capabilities are its scopes (the device
// connectors-admin-gate.test.ts uses); the administrator path is the
// dev-fallback admin the tests above run as.
describe('POST /api/query: who may run it', () => {
  const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';
  const SCOPES: Record<string, string[]> = {
    member: ['graph:read', 'catalog:read'],
    'raw-query': ['graph:read', 'graph:query'],
  };
  let server: FastifyInstance;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    const base = makeTestConfig();
    const config: Config = {
      ...base,
      accessControl: {
        ...base.accessControl,
        auth: {
          ...base.accessControl.auth,
          enabled: true,
          providers: {
            ...base.accessControl.auth.providers,
            oidc: {
              ...base.accessControl.auth.providers.oidc,
              enabled: true,
              issuerUrl: 'https://idp.example.com',
              clientId: 'oidc-test-client',
              displayName: 'Example IdP',
            },
          },
          admins: ['admin@example.com'],
          allowList: [],
          session: { ...base.accessControl.auth.session, secure: false },
        },
      },
    };
    const oidcProvider = {
      async startAuthorization() {
        return { url: 'https://idp.example.com/authorize', state: 's', codeVerifier: 'v' };
      },
      async exchange() {
        return { sub: 'sub', email: 'member@example.com', displayName: 'Member' };
      },
    } as unknown as OidcProvider;
    const tokenService = {
      validate: async (plaintext: string) =>
        SCOPES[plaintext]
          ? { id: plaintext, ownerEmail: `${plaintext}@example.com`, scopes: SCOPES[plaintext] }
          : null,
    } as unknown as TokenService;
    const neo4jService = { getDriver: vi.fn().mockReturnValue({}) } as unknown as Neo4jService;
    server = await createServer({
      config,
      redis: new RedisMock() as unknown as Redis,
      resolved: makeTestResolved(),
      oidcProvider,
      tokenService,
      neo4jService,
    });
    await server.ready();
  });

  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue(RESULT);
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  const postAs = (who: string) =>
    server.inject({
      method: 'POST',
      url: '/api/query',
      headers: { authorization: `Bearer ${who}` },
      payload: { cypher: 'MATCH (n) RETURN n' },
    });

  it('refuses a member without the graph:query capability, before anything runs', async () => {
    const response = await postAs('member');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs for a token that carries the graph:query scope', async () => {
    const response = await postAs('raw-query');
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
