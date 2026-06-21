import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config, GitHubConnectorConfig } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import { InMemoryConnectorRunStore } from '../../services/connector-run-store.js';
import { ConnectorAppStore } from '../../services/connector-app-store.js';
import { SettingsService } from '../../services/settings-service.js';
import { SetupService } from '../../services/setup-service.js';
import type { LogicalSecret, SecretStore } from '../../secrets/types.js';
import type { WebhookRefetchPort } from '../../routes/webhooks.js';
import { makeTestConfig } from '../test-config.js';

const APP_ID = '12345';
const DEV_ADMIN_EMAIL = 'dev@shipit.local'; // require-auth dev-fallback principal

function fakeStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: 'gsm',
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name: LogicalSecret, value: string) => {
      values.set(name, value);
    },
  };
}

function makeConnector(overrides: Partial<GitHubConnectorConfig> = {}): GitHubConnectorConfig {
  return {
    id: 'conn-acme',
    type: 'github',
    enabled: true,
    name: 'Acme',
    installationId: '99887766',
    org: 'acme',
    app: {},
    schedule: '*/15 * * * *',
    scope: {
      repos: { include: ['**'], exclude: [] },
      teams: { include: ['**'], exclude: [] },
      cappedAt: 100,
      cappedAcknowledged: false,
    },
    entities: { repositories: true, teams: true, pipelines: true, codeowners: true },
    lastRuns: [],
    ...overrides,
  } as GitHubConnectorConfig;
}

function configWithGlobalApp(): Config {
  const config = makeTestConfig();
  config.connectors.github.app.id = APP_ID;
  return config;
}

function fakeRefetch(): WebhookRefetchPort & {
  recorded: Map<string, { event: string; deliveryId: string; ts: string }>;
} {
  const recorded = new Map<string, { event: string; deliveryId: string; ts: string }>();
  return {
    recorded,
    markDeliverySeen: async () => true,
    releaseDelivery: async () => {},
    enqueue: async () => {},
    recordVerifiedDelivery: async (rec) =>
      void recorded.set(rec.connectorId, {
        event: rec.event,
        deliveryId: rec.deliveryId,
        ts: rec.ts,
      }),
    getLastVerifiedDelivery: async (connectorId) => recorded.get(connectorId) ?? null,
  };
}

interface Harness {
  server: FastifyInstance;
  store: SecretStore & { values: Map<string, string> };
  keyDir: string;
  refetch: ReturnType<typeof fakeRefetch>;
  config: Config;
}

// Auth-disabled server → require-auth synthesizes the dev-fallback admin
// principal (role 'admin', email dev@shipit.local), so the handlers run as an
// admin. Mirrors config-export.test.ts's dev-fallback admin case.
async function makeHarness(opts: { config?: Config; connectors?: GitHubConnectorConfig[] } = {}) {
  const keyDir = mkdtempSync(join(tmpdir(), 'shipit-portal-settings-'));
  const config = opts.config ?? configWithGlobalApp();
  const store = fakeStore();
  const refetch = fakeRefetch();
  const registry = new ConnectorRegistry({
    localConfigPath: join(keyDir, 'connectors.yaml'),
    initial: opts.connectors ?? [makeConnector()],
    runStore: new InMemoryConnectorRunStore(),
  });
  const connectorAppStore = new ConnectorAppStore({ store, keyDir });
  const settingsService = new SettingsService({
    secretStore: store,
    globalApp: config.connectors.github.app,
    registry,
    connectorAppStore,
    webhookRefetch: refetch,
  });
  const setupService = new SetupService({ secretStore: store, env: process.env });
  const server = await createServer({
    config,
    connectorRegistry: registry,
    settingsService,
    setupService,
    webhookRefetch: refetch,
  });
  await server.ready();
  return { server, store, keyDir, refetch, config } satisfies Harness;
}

describe('admin /api/settings — admin-gating (member role → 403 everywhere)', () => {
  // Reuse config-export's pattern: an auth-enabled server with an OIDC mock so
  // we can log in a non-admin (member) and assert every endpoint 403s.
  const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';
  let server: FastifyInstance;
  let redis: Redis;
  let cookie: string;
  let keyDir: string;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    keyDir = mkdtempSync(join(tmpdir(), 'shipit-portal-settings-gate-'));
    const base = configWithGlobalApp();
    const config: Config = {
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
            github: { ...base.accessControl.auth.providers.github, enabled: false },
          },
          admins: ['admin@example.com'],
          session: { ...base.accessControl.auth.session, secure: false },
        },
      },
    };
    redis = new RedisMock() as unknown as Redis;
    const oidc = {
      nextUserInfo: { sub: 'member-sub', email: 'member@example.com', displayName: 'Member' },
      async startAuthorization() {
        return { url: 'https://idp/authorize', state: 'oidc-state-stub', codeVerifier: 'v' };
      },
      async exchange() {
        return this.nextUserInfo;
      },
    };
    const store = fakeStore();
    const registry = new ConnectorRegistry({
      localConfigPath: join(keyDir, 'connectors.yaml'),
      initial: [makeConnector()],
      runStore: new InMemoryConnectorRunStore(),
    });
    server = await createServer({
      config,
      redis,
      oidcProvider: oidc as never,
      connectorRegistry: registry,
      settingsService: new SettingsService({
        secretStore: store,
        globalApp: config.connectors.github.app,
        registry,
        connectorAppStore: new ConnectorAppStore({ store, keyDir }),
      }),
      setupService: new SetupService({ secretStore: store, env: {} }),
    });
    await server.ready();

    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=oidc-state-stub',
    });
    const setCookie = callback.headers['set-cookie'];
    const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    cookie = list.map((c) => c.split(';')[0]).join('; ');
  });

  afterAll(async () => {
    await server.close();
    rmSync(keyDir, { recursive: true, force: true });
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  const cases: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string; body?: unknown }> = [
    { method: 'GET', url: '/api/settings' },
    { method: 'POST', url: '/api/settings/webhooks/conn-acme/setup' },
    { method: 'POST', url: '/api/settings/webhooks/conn-acme/rotate' },
    { method: 'PUT', url: '/api/settings/oauth', body: { clientId: 'a', clientSecret: 'b' } },
    { method: 'PUT', url: '/api/settings/admins', body: { emails: ['x@example.com'] } },
    { method: 'PUT', url: '/api/settings/allowlist', body: { emails: ['x@example.com'] } },
  ];

  for (const c of cases) {
    it(`${c.method} ${c.url} → 403 for a member`, async () => {
      const res = await server.inject({
        method: c.method,
        url: c.url,
        headers: { cookie },
        payload: c.body as never,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });
  }
});

describe('admin /api/settings — admin happy paths (dev-fallback admin)', () => {
  let h: Harness;

  beforeEach(async () => {
    delete process.env.SHIPIT_AUTH_ALLOWLIST;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.keyDir, { recursive: true, force: true });
    delete process.env.SHIPIT_AUTH_ALLOWLIST;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  it('GET / returns the settings snapshot shape', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.webhookUrl).toBe('http://localhost:3001/api/webhooks/github');
    expect(Array.isArray(body.webhooks)).toBe(true);
    expect(body.webhooks[0]).toMatchObject({
      connectorId: 'conn-acme',
      appId: APP_ID,
      org: 'acme',
      secretConfigured: false,
      lastVerifiedDelivery: null,
    });
    expect(body.oauth).toEqual({ configured: false });
    expect(Array.isArray(body.admins)).toBe(true);
    expect(Array.isArray(body.allowlist)).toBe(true);
  });

  it('POST /webhooks/:id/setup returns a secret + url + steps and persists (global App → GSM)', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/api/settings/webhooks/conn-acme/setup',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.webhookUrl).toBe('http://localhost:3001/api/webhooks/github');
    expect(body.steps.some((s: string) => s.includes(body.secret))).toBe(true);
    // Global App path writes the github-webhook-secret container + env.
    expect(h.store.values.get('github-webhook-secret')).toBe(body.secret);
    expect(process.env.GITHUB_WEBHOOK_SECRET).toBe(body.secret);
  });

  it('POST /webhooks/:id/rotate persists a per-App sidecar for an App-overridden connector', async () => {
    await h.server.close();
    h = await makeHarness({
      connectors: [makeConnector({ app: { id: '99999' } as GitHubConnectorConfig['app'] })],
    });
    const res = await h.server.inject({
      method: 'POST',
      url: '/api/settings/webhooks/conn-acme/rotate',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const sidecar = readFileSync(join(h.keyDir, 'github-app-99999.webhook-secret'), 'utf-8').trim();
    expect(sidecar).toBe(body.secret);
    // Per-org path never touches the global secret.
    expect(h.store.values.get('github-webhook-secret')).toBeUndefined();
  });

  it('PUT /oauth succeeds and persists client id/secret', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/oauth',
      payload: { clientId: 'client-id-1', clientSecret: 'client-secret-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.store.values.get('github-oauth-client-id')).toBe('client-id-1');
    expect(h.store.values.get('github-oauth-client-secret')).toBe('client-secret-1');
  });

  it('PUT /oauth maps InvalidOAuthClientError → 400', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/oauth',
      payload: { clientId: '', clientSecret: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_OAUTH_CLIENT');
  });

  it('PUT /admins succeeds when the caller keeps their own email', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/admins',
      payload: { emails: [DEV_ADMIN_EMAIL, 'other@example.com'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.admins).toContain(DEV_ADMIN_EMAIL);
    expect(h.store.values.get('auth-admin-emails')).toBe(`${DEV_ADMIN_EMAIL},other@example.com`);
  });

  it('PUT /admins blocks self-lockout → 422', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/admins',
      payload: { emails: ['someone-else@example.com'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SELF_LOCKOUT');
  });

  it('PUT /admins maps InvalidAdminEmailError → 400', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/admins',
      payload: { emails: [DEV_ADMIN_EMAIL, 'not-an-email'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ADMIN_EMAIL');
  });

  it('PUT /allowlist succeeds (proves auth-allow-list-emails is now writable)', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/allowlist',
      payload: { emails: [DEV_ADMIN_EMAIL, 'teammate@example.com'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.emails).toEqual([DEV_ADMIN_EMAIL, 'teammate@example.com']);
    expect(h.store.values.get('auth-allow-list-emails')).toBe(
      `${DEV_ADMIN_EMAIL},teammate@example.com`,
    );
  });

  // No self-lockout guardrail on the allow-list: admins bypass it
  // (routes/auth.ts), so an admin can curate it WITHOUT their own email.
  it('PUT /allowlist allows an admin to omit their own email (admins bypass the allow-list)', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/allowlist',
      payload: { emails: ['only-others@example.com'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emails).toEqual(['only-others@example.com']);
  });

  it('PUT /allowlist rejects an invalid email → 400', async () => {
    const res = await h.server.inject({
      method: 'PUT',
      url: '/api/settings/allowlist',
      payload: { emails: ['not-an-email'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ALLOWLIST_EMAIL');
  });
});
