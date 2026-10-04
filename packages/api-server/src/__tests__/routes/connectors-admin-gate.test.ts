import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

// Connector mutations are an administrator's. With auth on, a bearer token is
// always a `member` principal, whatever its scopes, so it stands in for a
// signed-in member here (the same device routes/runs.integration.test.ts uses).
// The admin path is exercised by routes/connectors.test.ts, which runs as the
// dev-fallback admin.
const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const SCOPES: Record<string, string[]> = {
  member: ['graph:read'],
  // Every capability, and still not an admin: the gate is on the role.
  everything: ['*'],
};

function authConfig(): Config {
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

const stubOidc = {
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

describe('connector routes: mutations need an administrator', () => {
  let server: FastifyInstance;
  let tmpDir: string;
  let registry: ConnectorRegistry;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-conn-gate-'));
    registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    await registry.create({
      id: 'gh-1',
      type: 'github',
      name: 'Acme',
      installationId: '1',
      org: 'acme',
    });
    server = await createServer({
      config: authConfig(),
      redis: new RedisMock() as unknown as Redis,
      resolved: makeTestResolved(),
      oidcProvider: stubOidc,
      tokenService,
      connectorRegistry: registry,
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  const as = (who: string) => ({ authorization: `Bearer ${who}` });

  it('lets a member read connectors', async () => {
    const list = await server.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: as('member'),
    });
    expect(list.statusCode).toBe(200);
    const one = await server.inject({
      method: 'GET',
      url: '/api/connectors/gh-1',
      headers: as('member'),
    });
    expect(one.statusCode).toBe(200);
  });

  it.each([
    [
      'POST',
      '/api/connectors',
      { id: 'gh-2', type: 'github', name: 'X', installationId: '2', org: 'x' },
    ],
    ['PATCH', '/api/connectors/gh-1', { name: 'Renamed by a member' }],
    ['PATCH', '/api/connectors/gh-1', { knowledge: { enabled: true } }],
    ['DELETE', '/api/connectors/gh-1', undefined],
    ['POST', '/api/connectors/gh-1/sync', { mode: 'incremental' }],
    // Creating or replacing the GitHub App is a mutation made of GETs: the
    // browser is sent to GitHub and comes back to the callback, which
    // overwrites the App every connector authenticates with.
    ['GET', '/api/connectors/github/manifest/launch', undefined],
    ['GET', '/api/connectors/github/app-manifest-callback?code=c&state=s', undefined],
    ['GET', '/api/connectors/github/manifest/pending-instance/some-nonce', undefined],
    // The knowledge-container mutations live in their own plugin and carry the gate themselves.
    ['POST', '/api/connectors/gh-1/containers/refresh', undefined],
    [
      'PUT',
      '/api/connectors/gh-1/containers/11111111-1111-4111-8111-111111111111',
      { selected: true, acknowledgeVisibility: true },
    ],
  ] as const)('refuses %s %s from a member', async (method, url, payload) => {
    const res = await server.inject({ method, url, headers: as('member'), payload });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('still lets a member read the manifest spec and the App summary', async () => {
    for (const url of ['/api/connectors/github/manifest', '/api/connectors/github/app']) {
      const res = await server.inject({ method: 'GET', url, headers: as('member') });
      expect(res.statusCode, url).not.toBe(403);
    }
  });

  it('lets a member read the containers route (it answers for the layer, not with 403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/gh-1/containers',
      headers: as('member'),
    });
    // No knowledge layer is wired on this server, so the answer is "unavailable".
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('KNOWLEDGE_UNAVAILABLE');
  });

  it('refuses a member even when their token carries every capability', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/connectors/gh-1',
      headers: as('everything'),
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('left the connector exactly as it was', () => {
    const cfg = registry.get('gh-1');
    expect(cfg.name).toBe('Acme');
    expect(cfg.type === 'github' && cfg.knowledge.enabled).toBe(false);
    expect(registry.list().map((c) => c.id)).toEqual(['gh-1']);
  });
});
