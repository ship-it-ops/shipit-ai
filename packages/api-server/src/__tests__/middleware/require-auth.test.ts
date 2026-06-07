import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { AuthPrincipal, Config, RequestContext } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';

// The preHandler is exercised transitively by every route test, but those
// tests don't assert the *shape* of `request.ctx` — they just trust it's
// there. These tests pin the shape and behavior across all four resolution
// branches (auth disabled, auth enabled + public path, auth enabled +
// session, auth enabled + no auth) so a regression in any one branch
// surfaces as a focused failure.

function withProbeRoute(server: FastifyInstance, capture: { ctx?: RequestContext }): void {
  server.get('/_probe/ctx', async (request) => {
    capture.ctx = request.ctx;
    return { ok: true };
  });
}

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

function enableAuth(overrides: Partial<Config['accessControl']['auth']> = {}): Config {
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
            issuerUrl: 'https://example.com',
            clientId: 'test-client',
            clientSecretEnv: 'TEST_OIDC_CLIENT_SECRET',
          },
        },
        admins: ['admin@example.com'],
        // Fastify inject() rides over http, not https, so secure cookies
        // are suppressed by @fastify/session. Production-like deployments
        // keep secure=true (the schema default); only tests opt out.
        session: { ...base.accessControl.auth.session, secure: false },
        ...overrides,
      },
    },
  };
}

// Mock OIDC provider used by require-auth tests — we don't exercise the
// real openid-client flow here, only verify the preHandler enforces
// auth around it.
const mockOidcProvider = {
  startAuthorization: async () => ({
    url: 'https://example.com/authorize?stub',
    state: 'state-stub',
    codeVerifier: 'verifier-stub',
  }),
  exchange: async () => {
    throw new Error('require-auth tests should not reach OIDC exchange');
  },
} as unknown as import('../../services/auth/oidc-provider.js').OidcProvider;

describe('require-auth preHandler — auth disabled', () => {
  describe('with no devUser in config', () => {
    let server: FastifyInstance;
    const captured: { ctx?: RequestContext } = {};

    beforeAll(async () => {
      server = await createServer({ config: makeTestConfig() });
      withProbeRoute(server, captured);
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('synthesizes the dev-fallback principal with wildcard capabilities', async () => {
      await server.inject({ method: 'GET', url: '/_probe/ctx' });
      expect(captured.ctx).toBeDefined();
      expect(captured.ctx?.user.provider).toBe('dev-fallback');
      expect(captured.ctx?.user.email).toBe('dev@shipit.local');
      expect(captured.ctx?.user.role).toBe('admin');
      expect(captured.ctx?.user.capabilities).toEqual(['*']);
      expect(captured.ctx?.org).toBe('default');
      expect(captured.ctx?.capabilities.has('*')).toBe(true);
    });
  });

  describe('with a devUser in config', () => {
    let server: FastifyInstance;
    const captured: { ctx?: RequestContext } = {};

    beforeAll(async () => {
      const config = makeTestConfig({
        frontend: {
          api: { url: 'http://localhost:3001' },
          devUser: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            role: 'Engineer',
            team: 'platform',
            joinedAt: '2026-01-01',
            capabilities: ['graph:read', 'graph:write'],
          },
          integrations: {
            pagerduty: { subdomain: null },
            datadog: { site: null },
            github: { org: null },
            slack: { workspace: null, channelPrefix: 'team-' },
            kubernetes: { consoleUrlTemplate: null },
          },
        },
      });
      server = await createServer({ config });
      withProbeRoute(server, captured);
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('mirrors the configured devUser identity and capabilities into the ctx', async () => {
      await server.inject({ method: 'GET', url: '/_probe/ctx' });
      expect(captured.ctx?.user.email).toBe('ada@example.com');
      expect(captured.ctx?.user.displayName).toBe('Ada Lovelace');
      expect(captured.ctx?.user.capabilities).toEqual(['graph:read', 'graph:write']);
      expect(captured.ctx?.capabilities.has('graph:write')).toBe(true);
      // Without the wildcard, ungranted capabilities stay closed.
      expect(captured.ctx?.capabilities.has('connectors:manage')).toBe(false);
    });
  });
});

describe('require-auth preHandler — auth enabled', () => {
  let server: FastifyInstance;
  let redis: Redis;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    server = await createServer({
      config: enableAuth(),
      redis,
      oidcProvider: mockOidcProvider,
    });
    withProbeRoute(server, {});
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('lets /api/health through without a session', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
  });

  it('lets /api/auth/* through without a session', async () => {
    // The /api/auth/providers route is registered in Stage B4 and is
    // explicitly on the public allow-list because the login page reads
    // it pre-session to know which buttons to render. A 200 response
    // here means both the preHandler bypassed the auth check AND the
    // route ran without a session.
    const response = await server.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(response.statusCode).toBe(200);
  });

  it('lets /api/mcp/info through without a session', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/mcp/info' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a protected route with 401 AUTH_REQUIRED when no session cookie is present', async () => {
    const response = await server.inject({ method: 'GET', url: '/_probe/ctx' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' },
    });
  });

  it('rejects a bearer-token request with TOKEN_AUTH_DISABLED when no TokenService is wired', async () => {
    // This suite mounts createServer without a neo4jService, so the
    // TokenService is never constructed. Bearer-token validation thus
    // fails closed with a 503 — that's the wiring path that matters
    // here; the happy path (valid bearer → mcp-token principal) is
    // covered in routes/tokens.test.ts.
    const response = await server.inject({
      method: 'GET',
      url: '/_probe/ctx',
      headers: { authorization: 'Bearer fake-token-stub' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('TOKEN_AUTH_DISABLED');
  });
});

describe('require-auth preHandler — session-resolved principal', () => {
  let server: FastifyInstance;
  let redis: Redis;
  const captured: { ctx?: RequestContext } = {};

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    server = await createServer({
      config: enableAuth(),
      redis,
      oidcProvider: mockOidcProvider,
    });
    withProbeRoute(server, captured);

    // Helper route that mimics what the Stage B4 OIDC callback will do:
    // populate request.session.principal then redirect / return ok. We hit
    // this first to obtain a session cookie, then exercise the protected
    // probe with that cookie.
    server.post<{ Body: { principal: AuthPrincipal; org?: string } }>(
      '/api/auth/callback/_test-seed',
      async (request, reply) => {
        request.session.principal = request.body.principal;
        request.session.org = request.body.org ?? 'default';
        return reply.send({ ok: true });
      },
    );

    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('rebuilds the RequestContext from the session principal', async () => {
    const adminPrincipal: AuthPrincipal = {
      id: 'subject-123',
      email: 'admin@example.com',
      displayName: 'Admin',
      provider: 'oidc',
      role: 'admin',
      capabilities: ['graph:read', 'graph:write'],
    };

    const seed = await server.inject({
      method: 'POST',
      url: '/api/auth/callback/_test-seed',
      payload: { principal: adminPrincipal, org: 'default' },
      headers: { 'content-type': 'application/json' },
    });
    expect(seed.statusCode).toBe(200);
    const cookie = seed.headers['set-cookie'];
    expect(cookie).toBeDefined();

    const probe = await server.inject({
      method: 'GET',
      url: '/_probe/ctx',
      headers: { cookie: Array.isArray(cookie) ? cookie.join('; ') : (cookie as string) },
    });
    expect(probe.statusCode).toBe(200);
    expect(captured.ctx?.user.email).toBe('admin@example.com');
    expect(captured.ctx?.user.provider).toBe('oidc');
    expect(captured.ctx?.user.role).toBe('admin');
    expect(captured.ctx?.capabilities.has('graph:write')).toBe(true);
    expect(captured.ctx?.capabilities.has('*')).toBe(false);
  });
});

describe('createServer — auth boot-time invariants', () => {
  afterAll(() => {
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('throws when auth.enabled is true and no provider is enabled', async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    const config = enableAuth();
    config.accessControl.auth.providers.oidc.enabled = false;
    config.accessControl.auth.providers.github.enabled = false;
    await expect(
      createServer({ config, redis: new RedisMock() as unknown as Redis }),
    ).rejects.toThrow(/no provider is enabled/);
  });

  it('throws when auth.enabled is true and admins[] is empty', async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    const config = enableAuth({ admins: [] });
    await expect(
      createServer({ config, redis: new RedisMock() as unknown as Redis }),
    ).rejects.toThrow(/admins\[\] is empty/);
  });

  it('throws when auth.enabled is true and accessControl.web.allowedOrigins is empty', async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    const config = enableAuth();
    config.accessControl.web.allowedOrigins = [];
    await expect(
      createServer({ config, redis: new RedisMock() as unknown as Redis }),
    ).rejects.toThrow(/allowedOrigins is empty/);
  });

  it('throws when the session signing secret env var is missing', async () => {
    delete process.env.SHIPIT_SESSION_SECRET;
    const config = enableAuth();
    await expect(
      createServer({ config, redis: new RedisMock() as unknown as Redis }),
    ).rejects.toThrow(/session signing secret/);
  });

  it('throws when the session signing secret is shorter than 32 chars', async () => {
    process.env.SHIPIT_SESSION_SECRET = 'too-short';
    const config = enableAuth();
    await expect(
      createServer({ config, redis: new RedisMock() as unknown as Redis }),
    ).rejects.toThrow(/at least 32 characters/);
  });

  it('throws when auth.enabled is true and no redis client is supplied', async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    const config = enableAuth();
    await expect(createServer({ config })).rejects.toThrow(/redis client is required/);
  });
});
