import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type {
  AccessTokenWithPlaintext,
  AccessTokenMetadata,
  TokenService,
  ValidatedToken,
} from '../../services/auth/token-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

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
          oidc: {
            ...base.accessControl.auth.providers.oidc,
            enabled: true,
            issuerUrl: 'https://idp.example.com',
            clientId: 'test-client',
            clientSecretEnv: 'TEST_OIDC_CLIENT_SECRET',
            displayName: 'Test IdP',
          },
          github: { ...base.accessControl.auth.providers.github, enabled: false },
        },
        admins: ['admin@example.com'],
        session: { ...base.accessControl.auth.session, secure: false },
      },
    },
  };
}

const mockOidcProvider = {
  startAuthorization: async () => ({
    url: 'https://idp.example.com/authorize',
    state: 'state-stub',
    codeVerifier: 'verifier-stub',
  }),
  exchange: async () => ({
    sub: 'admin-sub',
    email: 'admin@example.com',
    displayName: 'Admin',
  }),
} as unknown as OidcProvider;

// In-memory TokenService stub keyed by plaintext for predictable lookups.
function buildMockTokenService(): TokenService & {
  rows: Map<string, AccessTokenWithPlaintext>;
  validationCalls: string[];
} {
  const rows = new Map<string, AccessTokenWithPlaintext>();
  let counter = 0;
  const validationCalls: string[] = [];
  const mock = {
    rows,
    validationCalls,
    async create(args: {
      name: string;
      ownerEmail: string;
      scopes: ReadonlyArray<string>;
    }): Promise<AccessTokenWithPlaintext> {
      counter += 1;
      const id = `tok${counter}`;
      const plaintext = `shipit_pat_${id}.secret`;
      const record: AccessTokenWithPlaintext = {
        id,
        name: args.name,
        ownerEmail: args.ownerEmail.toLowerCase(),
        scopes: args.scopes,
        createdAt: new Date(2026, 0, counter).toISOString(),
        lastUsedAt: null,
        revoked: false,
        plaintext,
      };
      rows.set(plaintext, record);
      return record;
    },
    async listForOwner(ownerEmail: string): Promise<ReadonlyArray<AccessTokenMetadata>> {
      const owner = ownerEmail.toLowerCase();
      return [...rows.values()]
        .filter((r) => r.ownerEmail === owner)
        .map((r) => ({
          id: r.id,
          name: r.name,
          ownerEmail: r.ownerEmail,
          scopes: r.scopes,
          createdAt: r.createdAt,
          lastUsedAt: r.lastUsedAt,
          revoked: r.revoked,
        }));
    },
    async revoke(id: string, ownerEmail: string): Promise<boolean> {
      const owner = ownerEmail.toLowerCase();
      for (const row of rows.values()) {
        if (row.id === id && row.ownerEmail === owner) {
          row.revoked = true;
          return true;
        }
      }
      return false;
    },
    async validate(plaintext: string): Promise<ValidatedToken | null> {
      validationCalls.push(plaintext);
      const row = rows.get(plaintext);
      if (!row || row.revoked) return null;
      return { id: row.id, ownerEmail: row.ownerEmail, scopes: row.scopes };
    },
  };
  return mock as unknown as TokenService & typeof mock;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function login(server: FastifyInstance): Promise<string> {
  await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
  const callback = await server.inject({
    method: 'GET',
    url: '/api/auth/callback/oidc?code=any&state=state-stub',
  });
  return cookieHeader(callback.headers['set-cookie']);
}

describe('/api/tokens', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let tokens: ReturnType<typeof buildMockTokenService>;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    tokens = buildMockTokenService();
    server = await createServer({
      config: buildAuthConfig(),
      redis,
      oidcProvider: mockOidcProvider,
      tokenService: tokens,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('rejects token creation without a session', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'unauthed', scopes: ['mcp:invoke'] },
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('mints a token, returns plaintext exactly once, and lists it for the owner', async () => {
    const cookie = await login(server);

    const created = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'CI bot', scopes: ['mcp:invoke'] },
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.token).toMatch(/^shipit_pat_/);
    expect(body.name).toBe('CI bot');
    expect(body.scopes).toEqual(['mcp:invoke']);
    expect(body.id).toBeDefined();

    const list = await server.inject({
      method: 'GET',
      url: '/api/tokens',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(listBody.tokens).toHaveLength(1);
    expect(listBody.tokens[0].name).toBe('CI bot');
    // The list MUST NOT expose plaintext.
    expect(listBody.tokens[0].token).toBeUndefined();
  });

  it('rejects empty token names', async () => {
    const cookie = await login(server);
    const response = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: '   ' },
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_NAME');
  });

  it('rejects unknown scopes', async () => {
    const cookie = await login(server);
    const response = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'bad', scopes: ['admin:everything'] },
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('UNKNOWN_SCOPE');
  });

  it('allows the owner to revoke their own token', async () => {
    const cookie = await login(server);
    const created = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'to-revoke' },
      headers: { 'content-type': 'application/json', cookie },
    });
    const { id } = created.json();

    const revoked = await server.inject({
      method: 'DELETE',
      url: `/api/tokens/${id}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(204);
  });

  it('returns 404 when revoking a token id that does not exist for the caller', async () => {
    const cookie = await login(server);
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/tokens/nonsense-id',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('TOKEN_NOT_FOUND');
  });
});

describe('require-auth Bearer token validation', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let tokens: ReturnType<typeof buildMockTokenService>;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    tokens = buildMockTokenService();
    server = await createServer({
      config: buildAuthConfig(),
      redis,
      oidcProvider: mockOidcProvider,
      tokenService: tokens,
    });
    server.get('/_probe/me', async (request) => ({ principal: request.ctx.user }));
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  it('rejects an unknown bearer token with TOKEN_INVALID', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/_probe/me',
      headers: { authorization: 'Bearer shipit_pat_unknown.secret' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('TOKEN_INVALID');
  });

  it('accepts a freshly-minted token and builds an mcp-token principal', async () => {
    const cookie = await login(server);
    const created = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'mcp', scopes: ['mcp:invoke'] },
      headers: { 'content-type': 'application/json', cookie },
    });
    const plaintext = created.json().token as string;

    const probe = await server.inject({
      method: 'GET',
      url: '/_probe/me',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(probe.statusCode).toBe(200);
    const body = probe.json();
    expect(body.principal.provider).toBe('mcp-token');
    expect(body.principal.email).toBe('admin@example.com');
    expect(body.principal.capabilities).toEqual(['mcp:invoke']);
    expect(body.principal.id).toMatch(/^token:/);
  });

  it('rejects a revoked token even with the original plaintext', async () => {
    const cookie = await login(server);
    const created = await server.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'revoked' },
      headers: { 'content-type': 'application/json', cookie },
    });
    const plaintext = created.json().token as string;
    const id = created.json().id as string;

    await server.inject({
      method: 'DELETE',
      url: `/api/tokens/${id}`,
      headers: { cookie },
    });

    const probe = await server.inject({
      method: 'GET',
      url: '/_probe/me',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(probe.statusCode).toBe(401);
    expect(probe.json().error.code).toBe('TOKEN_INVALID');
  });
});
