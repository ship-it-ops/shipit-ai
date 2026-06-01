import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { GitHubProvider, GitHubUserInfo } from '../../services/auth/github-provider.js';
import { GitHubAccessDeniedError } from '../../services/auth/github-provider.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

function buildAuthConfig(overrides: Partial<Config['accessControl']['auth']> = {}): Config {
  const base = makeTestConfig();
  return {
    ...base,
    accessControl: {
      ...base.accessControl,
      auth: {
        ...base.accessControl.auth,
        enabled: true,
        providers: {
          oidc: {
            ...base.accessControl.auth.providers.oidc,
            enabled: true,
            issuerUrl: 'https://idp.example.com',
            clientId: 'oidc-test-client',
            clientSecretEnv: 'TEST_OIDC_CLIENT_SECRET',
            displayName: 'Example IdP',
          },
          github: {
            ...base.accessControl.auth.providers.github,
            enabled: true,
            clientId: 'gh-test-client',
            clientSecretEnv: 'TEST_GITHUB_CLIENT_SECRET',
            displayName: 'GitHub',
          },
        },
        admins: ['admin@example.com'],
        allowList: [],
        session: { ...base.accessControl.auth.session, secure: false },
        ...overrides,
      },
    },
  };
}

// Mock OIDC provider that captures the exchange call without hitting a real
// IdP. Tests configure the userinfo it should return via `nextUserInfo`.
function buildMockOidcProvider(): OidcProvider & {
  nextUserInfo: { sub: string; email: string; displayName: string };
  startCalls: number;
  exchangeCalls: Array<{ state: string; verifier: string }>;
} {
  const mock = {
    nextUserInfo: { sub: 'sub-default', email: 'user@example.com', displayName: 'User' },
    startCalls: 0,
    exchangeCalls: [] as Array<{ state: string; verifier: string }>,
    async startAuthorization() {
      this.startCalls += 1;
      return {
        url: 'https://idp.example.com/authorize?stub=1',
        state: 'oidc-state-stub',
        codeVerifier: 'oidc-verifier-stub',
      };
    },
    async exchange(_url: URL, state: string, verifier: string) {
      this.exchangeCalls.push({ state, verifier });
      return this.nextUserInfo;
    },
  };
  return mock as unknown as OidcProvider & typeof mock;
}

function buildMockGitHubProvider(): GitHubProvider & {
  nextUserInfo: GitHubUserInfo;
  nextError?: Error;
  startCalls: number;
  exchangeCalls: string[];
} {
  const mock = {
    nextUserInfo: {
      sub: 'gh-123',
      email: 'gh-user@example.com',
      displayName: 'GH User',
      login: 'gh-user',
    } as GitHubUserInfo,
    nextError: undefined as Error | undefined,
    startCalls: 0,
    exchangeCalls: [] as string[],
    startAuthorization() {
      this.startCalls += 1;
      return {
        url: 'https://github.com/login/oauth/authorize?stub=1',
        state: 'gh-state-stub',
      };
    },
    async exchange(code: string) {
      this.exchangeCalls.push(code);
      if (this.nextError) throw this.nextError;
      return this.nextUserInfo;
    },
  };
  return mock as unknown as GitHubProvider & typeof mock;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(';')[0]).join('; ');
}

describe('/api/auth — auth disabled', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer({ config: makeTestConfig() });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/auth/providers returns an empty provider list', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providers: [] });
  });

  it('GET /api/auth/login/oidc 404s when auth is disabled', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    // With auth disabled the route plugin only registers /providers, so
    // unknown paths fall through to the default 404 handler.
    expect(response.statusCode).toBe(404);
  });
});

describe('/api/auth — auth enabled', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let oidc: ReturnType<typeof buildMockOidcProvider>;
  let github: ReturnType<typeof buildMockGitHubProvider>;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    oidc = buildMockOidcProvider();
    github = buildMockGitHubProvider();
    server = await createServer({
      config: buildAuthConfig(),
      redis,
      oidcProvider: oidc,
      githubProvider: github,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('GET /api/auth/providers returns enabled providers with display names', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        { id: 'oidc', displayName: 'Example IdP' },
        { id: 'github', displayName: 'GitHub' },
      ],
    });
  });

  it('GET /api/auth/login/oidc redirects to the IdP and persists state', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://idp.example.com/authorize?stub=1');
    expect(oidc.startCalls).toBeGreaterThan(0);
    const stored = await redis.get('shipit:auth-state:oidc-state-stub');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.provider).toBe('oidc');
    expect(parsed.codeVerifier).toBe('oidc-verifier-stub');
  });

  it('GET /api/auth/login/unknown 404s with PROVIDER_NOT_FOUND', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/auth/login/unknown' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('GET /api/auth/callback/oidc completes login and sets a session cookie', async () => {
    oidc.nextUserInfo = {
      sub: 'admin-sub-1',
      email: 'admin@example.com',
      displayName: 'Admin User',
    };

    const login = await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    expect(login.statusCode).toBe(302);

    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=oidc-code&state=oidc-state-stub',
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    expect(callback.headers['set-cookie']).toBeDefined();
    expect(oidc.exchangeCalls).toHaveLength(1);
  });

  it('GET /api/auth/me returns 401 before login', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('GET /api/auth/me returns the principal after a successful login', async () => {
    oidc.nextUserInfo = {
      sub: 'admin-sub-2',
      email: 'admin@example.com',
      displayName: 'Admin User',
    };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=oidc-code&state=oidc-state-stub',
    });
    const cookie = cookieHeader(callback.headers['set-cookie']);

    const me = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.email).toBe('admin@example.com');
    expect(body.user.role).toBe('admin');
    expect(body.user.provider).toBe('oidc');
    expect(body.user.id).toBe('oidc:admin-sub-2');
    expect(body.user.capabilities).toEqual(['*']);
    expect(body.org).toBe('default');
  });

  it('POST /api/auth/logout destroys the session', async () => {
    oidc.nextUserInfo = {
      sub: 'admin-sub-3',
      email: 'admin@example.com',
      displayName: 'Admin User',
    };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=oidc-code&state=oidc-state-stub',
    });
    const cookie = cookieHeader(callback.headers['set-cookie']);

    const logout = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    const me = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it('callback assigns the member role to a non-admin email', async () => {
    oidc.nextUserInfo = {
      sub: 'member-sub',
      email: 'someone-else@example.com',
      displayName: 'Member',
    };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=oidc-code&state=oidc-state-stub',
    });
    const cookie = cookieHeader(callback.headers['set-cookie']);

    const me = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    const body = me.json();
    expect(body.user.role).toBe('member');
    expect(body.user.capabilities).toEqual(['graph:read', 'catalog:read']);
  });

  it('callback rejects with INVALID_STATE on an unknown state value', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=oidc-code&state=does-not-exist',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_STATE');
  });

  it('callback rejects with INVALID_STATE when state was minted for a different provider', async () => {
    await server.inject({ method: 'GET', url: '/api/auth/login/github' });
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=gh-state-stub',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_STATE');
  });

  it('callback surfaces an IDP_ERROR when the IdP returns ?error', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?error=access_denied&error_description=User%20said%20no',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('IDP_ERROR');
  });

  it('callback surfaces ACCESS_DENIED when the GitHub provider rejects org membership', async () => {
    github.nextError = new GitHubAccessDeniedError('Not in allowed org');
    await server.inject({ method: 'GET', url: '/api/auth/login/github' });
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/github?code=gh-code&state=gh-state-stub',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCESS_DENIED');
    github.nextError = undefined;
  });
});

describe('/api/auth — allow-list enforcement', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let oidc: ReturnType<typeof buildMockOidcProvider>;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    oidc = buildMockOidcProvider();
    const config = buildAuthConfig({ allowList: ['allowed@example.com'] });
    // Single-provider focus; disabling github keeps the test free of a
    // second clientSecretEnv requirement.
    config.accessControl.auth.providers.github.enabled = false;
    server = await createServer({
      config,
      redis,
      oidcProvider: oidc,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('rejects an email that is not on the allow-list', async () => {
    oidc.nextUserInfo = {
      sub: 'denied',
      email: 'someone-else@example.com',
      displayName: 'Denied',
    };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=oidc-state-stub',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('NOT_ALLOWLISTED');
  });

  it('admits an email that is on the allow-list', async () => {
    oidc.nextUserInfo = {
      sub: 'allowed',
      email: 'allowed@example.com',
      displayName: 'Allowed',
    };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=oidc-state-stub',
    });
    expect(response.statusCode).toBe(302);
  });
});
