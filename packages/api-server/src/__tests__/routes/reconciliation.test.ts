// Route tests for the reconciliation MUTATING endpoints (PR review fixes #1/#2).
//
// These cover the two security findings:
//   #1 authz gate — every mutating route sits behind requireCapability('graph:write')
//      (mirrors routes/claims.ts manualWriteGate). A principal lacking the cap is 403'd;
//      an unauthenticated request is 401'd at the boundary. Read-only routes stay open.
//   #2 non-forgeable actor — the audit actor is the authenticated principal
//      (ctx.user.email via actorOf), NOT a client-supplied `?actor=` query param.
//
// Unit/inject-level: the ReconciliationService methods are spied on the prototype
// (real Neo4j lives in the integration suite). A `getDriver`-only fake satisfies
// the registration-time wiring of the sibling claims/query routes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { ReconciliationService } from '../../services/reconciliation-service.js';
import type { Neo4jService } from '../../services/neo4j-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const fakeNeo4j = {
  getDriver: () => ({}),
} as unknown as Neo4jService;

// --- Auth-disabled server: dev-fallback admin principal holds '*', so the
//     capability gate passes and we exercise the non-forgeable-actor behavior.
describe('reconciliation routes — non-forgeable actor (auth disabled, admin principal)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer({ config: makeTestConfig(), neo4jService: fakeNeo4j });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  it('confirm uses the authenticated principal as actor, ignoring ?actor=', async () => {
    const spy = vi.spyOn(ReconciliationService.prototype, 'confirmMerge').mockResolvedValue({
      id: 'me:1',
      sourceId: 'b',
      targetId: 'a',
      sourceName: 'b',
      targetName: 'a',
      actor: 'dev@shipit.local',
      timestamp: new Date().toISOString(),
      method: 'fuzzy',
      confidence: 0.9,
    });
    const res = await server.inject({
      method: 'POST',
      // A forged ?actor= must be IGNORED — the actor comes from the principal.
      url: '/api/reconciliation/candidates/rc%3A1/confirm?actor=attacker%40evil.com',
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('rc:1', 'dev@shipit.local');
    spy.mockRestore();
  });

  it('reject uses the authenticated principal as actor, ignoring ?actor=', async () => {
    const spy = vi.spyOn(ReconciliationService.prototype, 'reject').mockResolvedValue(undefined);
    const res = await server.inject({
      method: 'POST',
      url: '/api/reconciliation/candidates/rc%3A1/reject?actor=attacker%40evil.com',
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('rc:1', 'dev@shipit.local');
    spy.mockRestore();
  });
});

// --- Capability gating with auth ENABLED. An mcp-token principal whose scopes
//     lack graph:write must be 403'd; unauthenticated requests 401 at the boundary.
function buildAuthConfig(): Config {
  const base = makeTestConfig();
  return {
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
            clientSecretEnv: 'TEST_OIDC_CLIENT_SECRET',
            displayName: 'Example IdP',
          },
        },
        admins: ['admin@example.com'],
        allowList: [],
        session: { ...base.accessControl.auth.session, secure: false },
      },
    },
  };
}

function buildMockOidcProvider(): OidcProvider & {
  nextUserInfo: { sub: string; email: string; displayName: string };
} {
  const mock = {
    nextUserInfo: { sub: 'sub-default', email: 'member@example.com', displayName: 'Member' },
    async startAuthorization() {
      return {
        url: 'https://idp.example.com/authorize?stub=1',
        state: 'oidc-state-stub',
        codeVerifier: 'oidc-verifier-stub',
      };
    },
    async exchange() {
      return mock.nextUserInfo;
    },
  };
  return mock as unknown as OidcProvider & typeof mock;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(';')[0]).join('; ');
}

describe('reconciliation routes — capability gating (auth enabled)', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let oidc: ReturnType<typeof buildMockOidcProvider>;

  const tokenService = {
    validate: async (plaintext: string) => {
      if (plaintext === 'read-token') {
        return { id: 'tok1', ownerEmail: 'bot@example.com', scopes: ['catalog:read'] };
      }
      return null;
    },
  } as unknown as TokenService;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    oidc = buildMockOidcProvider();
    server = await createServer({
      config: buildAuthConfig(),
      redis,
      oidcProvider: oidc,
      tokenService,
      neo4jService: fakeNeo4j,
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
    vi.restoreAllMocks();
  });

  async function loginAs(email: string, displayName: string): Promise<string> {
    oidc.nextUserInfo = { sub: `sub-${email}`, email, displayName };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=oidc-state-stub',
    });
    return cookieHeader(callback.headers['set-cookie']);
  }

  const MUTATING = [
    { method: 'POST' as const, url: '/api/reconciliation/candidates/rc%3A1/confirm' },
    { method: 'POST' as const, url: '/api/reconciliation/candidates/rc%3A1/reject' },
    { method: 'POST' as const, url: '/api/reconciliation/candidates/rc%3A1/distinct' },
    { method: 'POST' as const, url: '/api/reconciliation/scan' },
    { method: 'POST' as const, url: '/api/reconciliation/reset-pending' },
    { method: 'POST' as const, url: '/api/reconciliation/merges/me%3A1/split' },
  ];

  for (const route of MUTATING) {
    it(`${route.method} ${route.url} → 401 when unauthenticated`, async () => {
      const res = await server.inject({ method: route.method, url: route.url });
      expect(res.statusCode).toBe(401);
    });

    it(`${route.method} ${route.url} → 403 for a token principal lacking graph:write`, async () => {
      const res = await server.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: 'Bearer read-token' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });
  }

  it('GET /candidates (read-only) is NOT capability-gated — reachable by a read-only token', async () => {
    const spy = vi.spyOn(ReconciliationService.prototype, 'listCandidates').mockResolvedValue([]);
    const res = await server.inject({
      method: 'GET',
      url: '/api/reconciliation/candidates',
      headers: { authorization: 'Bearer read-token' },
    });
    expect(res.statusCode).toBe(200);
    spy.mockRestore();
  });

  it('an admin (holds graph:write via *) passes the gate', async () => {
    const spy = vi.spyOn(ReconciliationService.prototype, 'reject').mockResolvedValue(undefined);
    const cookie = await loginAs('admin@example.com', 'Admin');
    const res = await server.inject({
      method: 'POST',
      url: '/api/reconciliation/candidates/rc%3A1/reject',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('rc:1', 'admin@example.com');
    spy.mockRestore();
  });
});
