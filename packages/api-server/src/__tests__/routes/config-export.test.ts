import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { GitHubProvider, GitHubUserInfo } from '../../services/auth/github-provider.js';

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
            enabled: false,
            clientId: '',
            clientSecretEnv: '',
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

function buildMockOidcProvider(): OidcProvider & {
  nextUserInfo: { sub: string; email: string; displayName: string };
} {
  const mock = {
    nextUserInfo: { sub: 'sub-default', email: 'user@example.com', displayName: 'User' },
    async startAuthorization() {
      return {
        url: 'https://idp.example.com/authorize?stub=1',
        state: 'oidc-state-stub',
        codeVerifier: 'oidc-verifier-stub',
      };
    },
    async exchange(_url: URL, _state: string, _verifier: string) {
      return mock.nextUserInfo;
    },
  };
  return mock as unknown as OidcProvider & typeof mock;
}

function buildMockGitHubProvider(): GitHubProvider & {
  nextUserInfo: GitHubUserInfo;
} {
  const mock = {
    nextUserInfo: {
      sub: 'gh-123',
      email: 'gh-user@example.com',
      displayName: 'GH User',
      login: 'gh-user',
    } as GitHubUserInfo,
    startAuthorization() {
      return {
        url: 'https://github.com/login/oauth/authorize?stub=1',
        state: 'gh-state-stub',
      };
    },
    async exchange(_code: string) {
      return mock.nextUserInfo;
    },
  };
  return mock as unknown as GitHubProvider & typeof mock;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(';')[0]).join('; ');
}

describe('GET /api/config/export', () => {
  let server: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-export-route-'));
    writeFileSync(
      join(tmpDir, 'shipit.config.yaml'),
      'backend:\n  api:\n    port: 3001\n',
      'utf-8',
    );
    server = await createServer({
      config: makeTestConfig(),
      configPaths: {
        basePath: join(tmpDir, 'shipit.config.yaml'),
        localPath: join(tmpDir, 'shipit.config.local.yaml'),
      },
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the export as a YAML attachment (dev-fallback principal is admin)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/config/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-yaml');
    expect(res.headers['content-disposition']).toBe('attachment; filename="shipit.config.yaml"');
    expect(res.body).toContain('# Exported from a running ShipIt-AI instance');
    expect(res.body).toContain('port: 3001');
  });

  it('503s when configPaths are not wired', async () => {
    const bare = await createServer({ config: makeTestConfig() });
    await bare.ready();
    const res = await bare.inject({ method: 'GET', url: '/api/config/export' });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});

describe('GET /api/config/export — auth-enabled server', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let oidc: ReturnType<typeof buildMockOidcProvider>;
  let github: ReturnType<typeof buildMockGitHubProvider>;
  let tmpDir: string;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-export-auth-'));
    writeFileSync(
      join(tmpDir, 'shipit.config.yaml'),
      'backend:\n  api:\n    port: 3001\n',
      'utf-8',
    );
    redis = new RedisMock() as unknown as Redis;
    oidc = buildMockOidcProvider();
    github = buildMockGitHubProvider();
    server = await createServer({
      config: buildAuthConfig(),
      redis,
      oidcProvider: oidc,
      githubProvider: github,
      configPaths: {
        basePath: join(tmpDir, 'shipit.config.yaml'),
        localPath: join(tmpDir, 'shipit.config.local.yaml'),
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('401 when no session cookie is sent (unauthenticated)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/config/export' });
    expect(res.statusCode).toBe(401);
  });

  it('403 FORBIDDEN for a logged-in member (non-admin) principal', async () => {
    // Log in as a member (email not in admins list).
    oidc.nextUserInfo = {
      sub: 'member-sub',
      email: 'member@example.com',
      displayName: 'Member',
    };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=oidc-state-stub',
    });
    const cookie = cookieHeader(callback.headers['set-cookie']);

    const res = await server.inject({
      method: 'GET',
      url: '/api/config/export',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
