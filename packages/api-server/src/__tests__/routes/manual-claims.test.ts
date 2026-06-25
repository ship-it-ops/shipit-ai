// Route tests for the manual-edit write path (claims v1a, task T4a).
//
// These are unit/inject-level: the ManualEditService and Neo4j are FAKED (the
// real-Neo4j integration lives in T5a, serial). Coverage:
//   - 200 set returns { property, claimsRev }
//   - 400 non-string value (INVALID_VALUE_TYPE)
//   - 404 missing entity (ENTITY_NOT_FOUND)
//   - 204 revert with nothing to remove (NO_MANUAL_CLAIM, idempotent)
//   - member WITH graph:write succeeds; mcp-token lacking it → 403
//   - anonymous principal → 403 (requireCapability unit + 401 at the boundary)
//   - non-admin supplying ?actor= → 403
//   - kill-switch disabled → 403 FEATURE_DISABLED
//   - principal-keyed rate-limit keyGenerator (unit)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config, ResolvedProperty, RequestContext, AuthPrincipal } from '@shipit-ai/shared';
import { buildCapabilitySet } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { requireCapability } from '../../middleware/require-auth.js';
import { manualWriteRateKey } from '../../routes/claims.js';
import {
  ManualEditValidationError,
  ManualEditNotFoundError,
  type ManualEditResult,
  type SetManualClaimInput,
  type RevertManualClaimInput,
} from '../../services/manual-edit-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';
import type { Neo4jService } from '../../services/neo4j-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

// A Neo4j stand-in: server.ts registers the claims routes and builds the real
// ManualEditService (overwritten with a fake per test). queryRoutes calls
// getDriver() at registration time, so it must exist; nothing here is invoked
// at request time because every handler under test uses the faked service.
const fakeNeo4j = {
  getDriver: () => ({}),
} as unknown as Neo4jService;

function resolvedProperty(value: unknown): ResolvedProperty {
  return {
    property_key: 'team',
    effective_value: value,
    winning_claim: null,
    strategy: 'MANUAL_OVERRIDE_FIRST',
    has_conflict: false,
    claims: [],
    confidence: 1,
    breakdown: { effective: 1, recency: 1, source: 1, corroboration: 1 },
    status: 'unverified',
    needs_review: false,
  } as unknown as ResolvedProperty;
}

/** A fake ManualEditService whose two methods are scripted per test. */
interface FakeService {
  setManualClaim: (input: SetManualClaimInput) => Promise<ManualEditResult>;
  revertManualClaim: (input: RevertManualClaimInput) => Promise<ManualEditResult>;
}

function ctxWith(principal: Partial<AuthPrincipal>): RequestContext {
  const user: AuthPrincipal = {
    id: 'u1',
    email: 'u1@example.com',
    displayName: 'U1',
    provider: 'oidc',
    role: 'member',
    capabilities: [],
    ...principal,
  };
  return {
    user,
    org: 'default',
    capabilities: buildCapabilitySet(user.capabilities),
    requestId: 'req-1',
  };
}

// --- Auth-disabled server: dev-fallback admin principal (holds '*'), so the
//     capability gate + kill-switch pass and we exercise service-error mapping.
describe('manual claims routes — service contract (auth disabled, admin principal)', () => {
  let server: FastifyInstance;
  let fake: FakeService;

  beforeAll(async () => {
    server = await createServer({ config: makeTestConfig(), neo4jService: fakeNeo4j });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    // Default no-op fake; each test overrides the relevant method.
    fake = {
      setManualClaim: async () => ({ property: resolvedProperty('x'), claimsRev: 1 }),
      revertManualClaim: async () => ({ property: resolvedProperty('y'), claimsRev: 2 }),
    };
    (server as unknown as { manualEditService: FakeService }).manualEditService = fake;
  });

  it('POST .../manual → 200 with { property, claimsRev }', async () => {
    let received: SetManualClaimInput | undefined;
    fake.setManualClaim = async (input) => {
      received = input;
      return { property: resolvedProperty('Platform'), claimsRev: 7 };
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 'Platform', evidence: 'slack thread' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      property: resolvedProperty('Platform'),
      claimsRev: 7,
    });
    // actor is the authenticated principal, never client-supplied; entityId is decoded.
    expect(received).toMatchObject({
      entityId: 'repo:1',
      propertyKey: 'team',
      value: 'Platform',
      evidence: 'slack thread',
      actor: 'dev@shipit.local',
    });
  });

  it('POST .../manual → 400 INVALID_VALUE_TYPE for a non-string value', async () => {
    fake.setManualClaim = async () => {
      throw new ManualEditValidationError('Manual claim value must be a string (got number)');
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_VALUE_TYPE');
  });

  it('POST .../manual → 404 ENTITY_NOT_FOUND for a missing entity', async () => {
    fake.setManualClaim = async () => {
      throw new ManualEditNotFoundError('Entity nope not found', 'ENTITY_NOT_FOUND');
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/nope/team/manual',
      payload: { value: 'X' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ENTITY_NOT_FOUND');
  });

  it('DELETE .../manual → 200 with { property, claimsRev }', async () => {
    fake.revertManualClaim = async () => ({ property: resolvedProperty('fallback'), claimsRev: 9 });
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/claims/repo%3A1/team/manual',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ property: resolvedProperty('fallback'), claimsRev: 9 });
  });

  it('DELETE .../manual → 204 when there is nothing to remove (idempotent)', async () => {
    fake.revertManualClaim = async () => {
      throw new ManualEditNotFoundError('No manual:x claim', 'NO_MANUAL_CLAIM');
    };
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/claims/repo%3A1/team/manual',
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('DELETE .../manual?actor= → 200 (admin may target another actor)', async () => {
    let received: RevertManualClaimInput | undefined;
    fake.revertManualClaim = async (input) => {
      received = input;
      return { property: resolvedProperty('fallback'), claimsRev: 3 };
    };
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/claims/repo%3A1/team/manual?actor=other%40example.com',
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ targetActor: 'other@example.com', actor: 'dev@shipit.local' });
  });

  it('503 MANUAL_EDIT_DISABLED when the service is not wired', async () => {
    // The routes are registered (neo4jService present) but the service
    // decoration is cleared — the defensive 503 guard fires.
    const withRoutes = await createServer({ config: makeTestConfig(), neo4jService: fakeNeo4j });
    await withRoutes.ready();
    (withRoutes as unknown as { manualEditService: undefined }).manualEditService = undefined;
    const res = await withRoutes.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 'X' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MANUAL_EDIT_DISABLED');
    await withRoutes.close();
  });
});

// --- Kill-switch: a server with manualWrite.enabled = false 403s with FEATURE_DISABLED.
describe('manual claims routes — kill-switch', () => {
  it('403 FEATURE_DISABLED when accessControl.manualWrite.enabled is false', async () => {
    const config: Config = makeTestConfig();
    config.accessControl.manualWrite.enabled = false;
    const server = await createServer({ config, neo4jService: fakeNeo4j });
    await server.ready();
    (server as unknown as { manualEditService: FakeService }).manualEditService = {
      setManualClaim: async () => ({ property: resolvedProperty('x'), claimsRev: 1 }),
      revertManualClaim: async () => ({ property: resolvedProperty('y'), claimsRev: 2 }),
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 'X' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    await server.close();
  });
});

// --- Capability gating with auth ENABLED (real principals via session / token).
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

describe('manual claims routes — capability gating (auth enabled)', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let oidc: ReturnType<typeof buildMockOidcProvider>;

  // A fake TokenService so the Bearer path produces an mcp-token principal whose
  // capabilities are the token's scopes (NOT graph:write).
  const tokenService = {
    validate: async (plaintext: string) => {
      if (plaintext === 'good-token') {
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
    (server as unknown as { manualEditService: FakeService }).manualEditService = {
      setManualClaim: async () => ({ property: resolvedProperty('ok'), claimsRev: 1 }),
      revertManualClaim: async () => ({ property: resolvedProperty('ok'), claimsRev: 1 }),
    };
  });
  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
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

  it('member WITH graph:write succeeds (200)', async () => {
    const cookie = await loginAs('member@example.com', 'Member');
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 'Platform' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('unauthenticated request → 401 at the auth boundary', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('mcp-token principal lacking graph:write → 403 FORBIDDEN', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/claims/repo%3A1/team/manual',
      payload: { value: 'X' },
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('non-admin member supplying ?actor= → 403 FORBIDDEN', async () => {
    const cookie = await loginAs('member@example.com', 'Member');
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/claims/repo%3A1/team/manual?actor=victim%40example.com',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('admin supplying ?actor= is allowed (200)', async () => {
    const cookie = await loginAs('admin@example.com', 'Admin');
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/claims/repo%3A1/team/manual?actor=victim%40example.com',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });
});

// --- Unit: requireCapability preHandler rejects the anonymous principal and
//     honors the '*' wildcard.
describe('requireCapability preHandler', () => {
  function fakeReply() {
    const captured: { status?: number; body?: unknown } = {};
    const reply = {
      status(code: number) {
        captured.status = code;
        return reply;
      },
      send(body: unknown) {
        captured.body = body;
        return reply;
      },
    };
    return { reply, captured };
  }

  function fakeRequest(ctx: RequestContext): FastifyRequest {
    return {
      ctx,
      url: '/api/claims/repo:1/team/manual',
      log: { warn: () => {} },
    } as unknown as FastifyRequest;
  }

  it('403s the anonymous principal (empty capability set)', async () => {
    const { reply, captured } = fakeReply();
    const anon = ctxWith({ id: 'anonymous', role: 'member', capabilities: [] });
    await requireCapability('graph:write')(fakeRequest(anon), reply as never);
    expect(captured.status).toBe(403);
    expect((captured.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('passes a principal holding the exact capability', async () => {
    const { reply, captured } = fakeReply();
    const member = ctxWith({ capabilities: ['graph:read', 'catalog:read', 'graph:write'] });
    const out = await requireCapability('graph:write')(fakeRequest(member), reply as never);
    expect(out).toBeUndefined();
    expect(captured.status).toBeUndefined();
  });

  it('passes a principal holding the * wildcard', async () => {
    const { reply, captured } = fakeReply();
    const admin = ctxWith({ role: 'admin', capabilities: ['*'] });
    const out = await requireCapability('graph:write')(fakeRequest(admin), reply as never);
    expect(out).toBeUndefined();
    expect(captured.status).toBeUndefined();
  });
});

// --- Unit: the rate-limit keyGenerator keys per principal, not per IP.
describe('manualWriteRateKey (principal-keyed rate limit)', () => {
  function req(user: Partial<AuthPrincipal>, ip = '10.0.0.1'): FastifyRequest {
    return { ctx: ctxWith(user), ip } as unknown as FastifyRequest;
  }

  it('keys on the principal id for a human', () => {
    expect(manualWriteRateKey(req({ id: 'human-123' }))).toBe('human-123');
  });

  it('keys on the token id for an mcp-token principal', () => {
    expect(manualWriteRateKey(req({ id: 'token:abc', provider: 'mcp-token' }))).toBe('token:abc');
  });

  it('two different principals do NOT share a bucket', () => {
    expect(manualWriteRateKey(req({ id: 'a' }))).not.toBe(manualWriteRateKey(req({ id: 'b' })));
  });

  it('falls back to IP for the anonymous principal', () => {
    expect(manualWriteRateKey(req({ id: 'anonymous' }, '203.0.113.5'))).toBe('203.0.113.5');
  });
});
