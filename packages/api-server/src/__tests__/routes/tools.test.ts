import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { MCP_TOOLS } from '@shipit-ai/mcp-server/metadata';
import { createServer } from '../../server.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

describe('GET /api/tools', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer({ config: makeTestConfig() });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });

  it('lists the built-in graph tools agents may use, each with its service and effect', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as {
      tools: Array<{
        id: string;
        service: string;
        effect: string;
        description: string;
        source: string;
      }>;
    };
    // graph_query is withheld from agents (agents: false in the metadata): a
    // caller-written Cypher string is not a tool an agent should be granted.
    const forAgents = MCP_TOOLS.filter((t) => t.agents);
    expect(forAgents.length).toBe(MCP_TOOLS.length - 1);
    expect(tools.map((t) => t.id)).toEqual(forAgents.map((t) => `graph.${t.name}`));
    expect(tools.map((t) => t.id)).not.toContain('graph.graph_query');
    for (const tool of tools) {
      expect(tool).toMatchObject({ service: 'graph', effect: 'read', source: 'builtin' });
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('works with no database: the catalog is not stored anywhere', async () => {
    // This server has no agent store or status service at all.
    expect((await server.inject({ method: 'GET', url: '/api/tools' })).statusCode).toBe(200);
  });
});

describe('GET /api/tools — capability gate (auth enabled)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';
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
    const scopes: Record<string, string[]> = { reader: ['agents:read'], nobody: ['graph:read'] };
    server = await createServer({
      config,
      redis: new RedisMock() as unknown as Redis,
      resolved: makeTestResolved(),
      oidcProvider: {} as OidcProvider,
      tokenService: {
        validate: async (t: string) =>
          scopes[t] ? { id: t, ownerEmail: `${t}@example.com`, scopes: scopes[t] } : null,
      } as unknown as TokenService,
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('needs agents:read', async () => {
    const as = (t: string) => ({ authorization: `Bearer ${t}` });
    expect(
      (await server.inject({ method: 'GET', url: '/api/tools', headers: as('reader') })).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: 'GET', url: '/api/tools', headers: as('nobody') })).statusCode,
    ).toBe(403);
  });
});
