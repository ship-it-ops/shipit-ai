import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { SetupService } from '../../services/setup-service.js';
import type { LogicalSecret, SecretStore } from '../../secrets/types.js';
import { makeTestConfig } from '../test-config.js';

const SESSION_SECRET = 's'.repeat(32);

// In-memory gsm-shaped store — trivially satisfies the SecretStore
// interface; the wizard only needs read/write over a Map.
function fakeGsmStore(initial: Partial<Record<LogicalSecret, string>> = {}): SecretStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    kind: 'gsm',
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => {
      values.set(name, value);
    },
  };
}

// The committed fresh-deploy config: auth on, no providers, no admins.
function freshDeployConfig(): Config {
  const config = makeTestConfig();
  config.accessControl.auth.enabled = true;
  return config;
}

describe('setup mode server', () => {
  let server: FastifyInstance;
  let store: ReturnType<typeof fakeGsmStore>;
  let env: NodeJS.ProcessEnv;
  let exitSpy: Mock<(code: number) => void>;

  beforeAll(async () => {
    store = fakeGsmStore();
    env = { SHIPIT_SESSION_SECRET: SESSION_SECRET } as NodeJS.ProcessEnv;
    exitSpy = vi.fn<(code: number) => void>();
    const config = freshDeployConfig();
    const setupService = new SetupService({
      secretStore: store,
      env,
      loadFreshConfig: () => {
        // Mirror production: complete() re-loads the committed YAML (still
        // safe-by-default) and relies on the derivation overlay.
        return freshDeployConfig();
      },
      exit: exitSpy,
    });
    // REGRESSION: boots with auth.enabled=true but NO redis and NO
    // session/provider construction — setup mode must not require them.
    server = await createServer({ config, setupMode: true, setupService });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/health returns 200 with mode "setup" (k8s readiness)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('setup');
  });

  it('401s non-setup routes with code SETUP_MODE — including the normal public list', async () => {
    for (const url of [
      '/api/connectors',
      '/api/auth/providers',
      '/api/auth/me',
      '/api/mcp/info',
      '/api/schema',
    ]) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code, url).toBe('SETUP_MODE');
    }
  });

  it('lets the GitHub App manifest flow through with an admin setup principal', async () => {
    // 503/4xx from the handler is fine — the point is the request reached
    // the route instead of being 401d by the middleware.
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest',
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('reports gate progress on GET /api/setup/status', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: 'setup',
      gates: {
        oauthClientPresent: false,
        adminConfigured: false,
        sessionSecretPresent: true,
        allowedOriginsConfigured: true,
      },
      ready: false,
    });
  });

  it('rejects malformed admin emails', async () => {
    for (const email of ['not-an-email', 'missing@tld', '', 42]) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { email },
      });
      expect(res.statusCode, String(email)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_EMAIL');
    }
  });

  it('persists the admin email to the store and env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { email: 'admin@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.values.get('auth-admin-emails')).toBe('admin@example.com');
    expect(env.SHIPIT_AUTH_ADMINS).toBe('admin@example.com');
  });

  it('409s /complete while gates are missing, listing what remains', async () => {
    // Admin is set (previous test); the OAuth client is still missing.
    const res = await server.inject({ method: 'POST', url: '/api/setup/complete' });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('SETUP_INCOMPLETE');
    expect(body.error.missing).toEqual(['provider']);
    expect(exitSpy).not.toHaveBeenCalled();
    // A failed complete must NOT latch the deployment as set up.
    expect(store.values.has('setup-completed')).toBe(false);
  });

  it('rejects an OAuth client missing id or secret', async () => {
    for (const payload of [
      { clientId: '', clientSecret: 'x' },
      { clientId: 'Iv1.abc', clientSecret: '' },
      { clientId: 'Iv1.abc' },
      {},
    ]) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/setup/oauth',
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_OAUTH_CLIENT');
    }
    // Nothing persisted → the gate stays closed.
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
  });

  it('persists the OAuth client id/secret to the store and env (trimmed)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/setup/oauth',
      payload: { clientId: '  Ov23liABC  ', clientSecret: '  s3cret  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(store.values.get('github-oauth-client-id')).toBe('Ov23liABC');
    expect(store.values.get('github-oauth-client-secret')).toBe('s3cret');
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBe('Ov23liABC');
    expect(env.GITHUB_OAUTH_CLIENT_SECRET).toBe('s3cret');
  });

  it('completes once the wizard persisted everything, then schedules the restart', async () => {
    // Admin (earlier test) + OAuth client (POST /api/setup/oauth above) are
    // now both persisted → every gate is satisfied.
    const status = await server.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json().ready).toBe(true);

    vi.useFakeTimers();
    try {
      const res = await server.inject({ method: 'POST', url: '/api/setup/complete' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // One-way latch persisted so a later boot never reopens the wizard
      // for this deployment (PR #59 review SC2).
      expect(store.values.get('setup-completed')).toBe('true');
      expect(exitSpy).not.toHaveBeenCalled(); // reply flushes first
      vi.advanceTimersByTime(300);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setup routes outside setup mode', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const store = fakeGsmStore();
    const env = {} as NodeJS.ProcessEnv;
    // Auth disabled — the dev-fallback principal lets requests through, so
    // we exercise the handlers' own active-mode guards.
    server = await createServer({
      config: makeTestConfig(),
      setupService: new SetupService({ secretStore: store, env }),
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/health reports mode "active"', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/health' });
    expect(res.json().mode).toBe('active');
  });

  it('GET /api/setup/status still works (post-restart wizard poll)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('active');
  });

  it('409s the mutating routes with SETUP_NOT_ACTIVE', async () => {
    const admin = await server.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { email: 'late@example.com' },
    });
    expect(admin.statusCode).toBe(409);
    expect(admin.json().error.code).toBe('SETUP_NOT_ACTIVE');

    const oauth = await server.inject({
      method: 'POST',
      url: '/api/setup/oauth',
      payload: { clientId: 'Iv1.abc', clientSecret: 'late' },
    });
    expect(oauth.statusCode).toBe(409);
    expect(oauth.json().error.code).toBe('SETUP_NOT_ACTIVE');

    const complete = await server.inject({ method: 'POST', url: '/api/setup/complete' });
    expect(complete.statusCode).toBe(409);
    expect(complete.json().error.code).toBe('SETUP_NOT_ACTIVE');
  });
});

describe('setup routes without a SetupService', () => {
  it('returns 503 SETUP_DISABLED', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    try {
      const res = await server.inject({ method: 'GET', url: '/api/setup/status' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('SETUP_DISABLED');
    } finally {
      await server.close();
    }
  });
});
