import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import { GitHubAppService } from '../../services/github-app-service.js';
import { GitHubAppManifestService } from '../../services/github-app-manifest-service.js';
import { makeTestConfig } from '../test-config.js';

// Partial mock of the connector-github package so the installations
// endpoint can be exercised without real GitHub network calls. The
// override applies to the whole file but only stubs createAppJWTOctokit
// — the rest of the package keeps its real implementation, so the probe
// tests that legitimately use authenticateGitHubApp are unaffected.
vi.mock('@shipit-ai/connector-github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shipit-ai/connector-github')>();
  return {
    ...actual,
    createAppJWTOctokit: vi.fn(),
  };
});
import { createAppJWTOctokit } from '@shipit-ai/connector-github';

// One server, one registry, fresh per top-level describe so the ETag-flow
// assertions and CRUD assertions don't tangle. We bind the registry to a
// throwaway tmp directory so the persist() call doesn't touch the real repo.
describe('Connector routes (CRUD + ETag)', () => {
  let server: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-conn-routes-'));
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    server = await createServer({ connectorRegistry: registry, config: makeTestConfig() });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const validPayload = {
    id: 'github-test',
    type: 'github' as const,
    name: 'Test GitHub',
    installationId: '12345',
    org: 'shipitops',
    enabled: true,
  };

  it('GET /api/connectors returns empty array initially', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/connectors' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('POST /api/connectors creates a connector and returns ETag', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: validPayload,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe('github-test');
    expect(body.type).toBe('github');
    expect(body.org).toBe('shipitops');
    // Defaults from Zod should be filled in
    expect(body.schedule).toBe('*/15 * * * *');
    expect(body.scope.cappedAt).toBe(100);
    // No App override unless caller asked for one — verifies the registry
    // doesn't materialize an empty `app: {}` that would leak into YAML.
    expect(body.app).toBeUndefined();
    // Strong ETag wrapped in quotes per RFC 7232
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  // Routes reject privateKeyPath that resolves outside the allowed keys
  // directory (defense-in-depth — same allowlist the probe uses). Use a
  // path inside `~/.shipit/keys` for happy-path tests; the file doesn't
  // need to exist because CRUD never reads it, only persists the string.
  const allowedOverridePath = join(homedir(), '.shipit', 'keys', 'override-test.pem');

  it('POST /api/connectors persists an App override when supplied', async () => {
    // Use a different id so we don't collide with the previous test.
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        ...validPayload,
        id: 'github-test-override',
        app: { id: '999999', privateKeyPath: allowedOverridePath },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.app).toEqual({ id: '999999', privateKeyPath: allowedOverridePath });

    // Clean up so the rest of the suite sees a single connector.
    await server.inject({ method: 'DELETE', url: '/api/connectors/github-test-override' });
  });

  it('POST /api/connectors rejects override paths outside the allowed dir', async () => {
    // Defense-in-depth guard mirrors the probe — an admin write must not
    // be able to point the scheduler at /etc/passwd or similar.
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        ...validPayload,
        id: 'github-bad-path',
        app: { id: '999999', privateKeyPath: '/etc/passwd' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PRIVATE_KEY_PATH_NOT_ALLOWED');
  });

  it('PATCH /api/connectors/:id with app:null clears the override', async () => {
    // First add an override.
    await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        ...validPayload,
        id: 'github-clear-test',
        app: { id: '777', privateKeyPath: allowedOverridePath },
      },
    });
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github-clear-test' });
    expect(get.json().app).toEqual({ id: '777', privateKeyPath: allowedOverridePath });

    const etag = get.headers.etag as string;
    const cleared = await server.inject({
      method: 'PATCH',
      url: '/api/connectors/github-clear-test',
      headers: { 'if-match': etag },
      payload: { app: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().app).toBeUndefined();

    await server.inject({ method: 'DELETE', url: '/api/connectors/github-clear-test' });
  });

  it('PATCH /api/connectors/:id rejects an override path outside the allowed dir', async () => {
    // Seed a connector to PATCH against.
    await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: { ...validPayload, id: 'github-patch-bad' },
    });
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github-patch-bad' });
    const etag = get.headers.etag as string;

    const res = await server.inject({
      method: 'PATCH',
      url: '/api/connectors/github-patch-bad',
      headers: { 'if-match': etag },
      payload: { app: { id: '777', privateKeyPath: '/etc/passwd' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRIVATE_KEY_PATH_NOT_ALLOWED');

    await server.inject({ method: 'DELETE', url: '/api/connectors/github-patch-bad' });
  });

  it('POST /api/connectors returns 400 without required fields', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: { id: 'broken' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /api/connectors returns 400 for missing installationId', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: { id: 'gh-2', type: 'github', name: 'X', org: 'shipitops' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('installationId');
  });

  it('POST /api/connectors returns 409 for duplicate id', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: validPayload,
    });
    expect(response.statusCode).toBe(409);
  });

  it('GET /api/connectors/:id returns ETag header', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/connectors/github-test' });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe('github-test');
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it('GET /api/connectors/:id returns 404 for unknown', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/connectors/nope' });
    expect(response.statusCode).toBe(404);
  });

  it('PATCH /api/connectors/:id with matching If-Match succeeds', async () => {
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github-test' });
    const etag = get.headers.etag as string;
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/connectors/github-test',
      headers: { 'if-match': etag },
      payload: { name: 'Test GitHub (renamed)' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Test GitHub (renamed)');
    // ETag rotates after the change
    expect(response.headers.etag).not.toBe(etag);
  });

  it('PATCH /api/connectors/:id with stale If-Match returns 409', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/connectors/github-test',
      headers: { 'if-match': '"deadbeef"' },
      payload: { name: 'Should not apply' },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(body.serverHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('POST /api/connectors/:id/sync triggers sync via the runner', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/github-test/sync',
      payload: { mode: 'full' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().connectorId).toBe('github-test');
  });

  it('GET /api/connectors/:id/status returns runtime status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/connectors/github-test/status',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().connectorId).toBe('github-test');
  });

  it('GET /api/connectors/:id/runs returns the run history', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/connectors/github-test/runs',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().connectorId).toBe('github-test');
    expect(Array.isArray(response.json().runs)).toBe(true);
  });

  it('DELETE /api/connectors/:id removes the connector', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/connectors/github-test',
    });
    expect(response.statusCode).toBe(204);

    const listResponse = await server.inject({ method: 'GET', url: '/api/connectors' });
    expect(listResponse.json()).toEqual([]);
  });

  it('DELETE /api/connectors/:id returns 404 for unknown', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/api/connectors/nope' });
    expect(response.statusCode).toBe(404);
  });
});

describe('Connector probe endpoint', () => {
  let server: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-conn-probe-'));
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    // No app config set — probe should surface APP_NOT_CONFIGURED instead
    // of crashing. We exercise just that branch here because hitting the
    // real GitHub API requires fixtures/mocking that belong in P0.8.
    server = await createServer({ connectorRegistry: registry, config: makeTestConfig() });
    await server.ready();
  });

  it('returns APP_NOT_CONFIGURED when GitHub App id / key are absent', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: { installationId: '12345' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('APP_NOT_CONFIGURED');
  });

  it('returns VALIDATION_ERROR when installationId is missing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
  });

  it('reports APP_NOT_CONFIGURED when the override is incomplete', async () => {
    // Override is "active" because at least one field is provided, but
    // privateKeyPath is missing — resolver should fall back to global,
    // which is also empty, so the full chain produces APP_NOT_CONFIGURED.
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: {
        installationId: '12345',
        app: { id: '777' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('APP_NOT_CONFIGURED');
  });

  it('reports PRIVATE_KEY_PATH_NOT_ALLOWED when override path is outside the allowed dir', async () => {
    // CodeQL js/path-injection mitigation: probes can't read arbitrary
    // files via the override. Any path outside SHIPIT_GITHUB_APP_KEY_DIR
    // (default ~/.shipit/keys) gets rejected before fs touches it.
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: {
        installationId: '12345',
        app: { id: '777', privateKeyPath: '/etc/passwd' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('PRIVATE_KEY_PATH_NOT_ALLOWED');
  });

  it('reports PRIVATE_KEY_UNREADABLE when an allowed override path does not exist', async () => {
    // Full override pointing INSIDE the allowed dir but at a file that
    // doesn't exist. Proves the resolver actually used the override
    // (otherwise it'd return APP_NOT_CONFIGURED for the empty global App)
    // AND that the error message no longer echoes the user-supplied path
    // back (information-disclosure hardening from the same security pass).
    const allowedButMissing = join(homedir(), '.shipit', 'keys', 'definitely-does-not-exist.pem');
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: {
        installationId: '12345',
        app: { id: '777', privateKeyPath: allowedButMissing },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('PRIVATE_KEY_UNREADABLE');
    // The response intentionally does NOT include the path or the raw
    // fs error — operator-side log line carries those.
    expect(response.json().message).not.toContain(allowedButMissing);
  });

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// The global App endpoint backs the wizard's first-run choice between
// "use a shared App" and "use a per-org override". Without it the wizard
// has no way to know whether a shared App is already configured.
describe('Global GitHub App endpoint', () => {
  let server: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-app-route-'));
    // Build a config with an empty global App so the service starts in
    // "not configured" state — the wizard's first-run scenario.
    const config = makeTestConfig();
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    const githubAppService = new GitHubAppService({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      appConfig: config.connectors.github.app,
    });
    server = await createServer({ connectorRegistry: registry, githubAppService, config });
    await server.ready();
  });

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET reports not configured initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/connectors/github/app' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.id).toBeNull();
    expect(res.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  // PUT /github/app pins privateKeyPath to the allowed keys dir, same
  // allowlist the probe + per-connector overrides use. Tests use a path
  // inside ~/.shipit/keys — the file doesn't need to exist because the
  // route only persists the string, never reads it.
  const allowedAppPath = join(homedir(), '.shipit', 'keys', 'global-app-test.pem');

  it('PUT persists the global App and writes YAML', async () => {
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github/app' });
    const etag = get.headers.etag as string;

    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      headers: { 'if-match': etag },
      payload: { id: '12345', privateKeyPath: allowedAppPath },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.id).toBe('12345');
    expect(body.privateKeyPath).toBe(allowedAppPath);

    // Verify it landed in YAML. The file was missing before — the
    // service must create it from scratch.
    const written = readFileSync(join(tmpDir, 'shipit.config.local.yaml'), 'utf-8');
    expect(written).toMatch(/id:\s*['"]?12345/);
    expect(written).toContain(allowedAppPath);
  });

  it('PUT returns 400 when fields are missing', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      payload: { id: '12345' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT rejects privateKeyPath outside the allowed dir', async () => {
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github/app' });
    const etag = get.headers.etag as string;
    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      headers: { 'if-match': etag },
      payload: { id: '12345', privateKeyPath: '/etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRIVATE_KEY_PATH_NOT_ALLOWED');
  });

  it('PUT returns 409 on stale If-Match', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      headers: { 'if-match': '"deadbeef"' },
      payload: { id: '12345', privateKeyPath: allowedAppPath },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('returns 503 when the service is not decorated', async () => {
    // Build a separate server with no githubAppService — endpoints
    // should fail soft so an admin without a config can still see CRUD.
    const cleanRegistry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'no-service.yaml'),
      initial: [],
    });
    const cleanServer = await createServer({
      connectorRegistry: cleanRegistry,
      config: makeTestConfig(),
    });
    await cleanServer.ready();
    const res = await cleanServer.inject({ method: 'GET', url: '/api/connectors/github/app' });
    expect(res.statusCode).toBe(503);
    await cleanServer.close();
  });
});

// Installations picker endpoint. Mocks the App-JWT Octokit factory so
// the suite never hits the real GitHub API; the assertions focus on the
// shape the wizard depends on (appSlug, installUrl, usedByConnectorId
// cross-reference, error codes for non-configured and upstream-failure
// paths).
describe('GitHub App installations endpoint', () => {
  let server: FastifyInstance;
  let tmpDir: string;
  let pemPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-installs-'));
    // Real on-disk PEM so the endpoint doesn't short-circuit on
    // PRIVATE_KEY_UNREADABLE — contents are never validated because the
    // Octokit factory is mocked.
    pemPath = join(tmpDir, 'app.pem');
    writeFileSync(pemPath, '-----BEGIN RSA PRIVATE KEY-----\nDUMMY\n-----END\n', 'utf-8');
    vi.mocked(createAppJWTOctokit).mockReset();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function buildServer(opts: {
    configured: boolean;
    instances?: Array<{ id: string; installationId: string }>;
  }): Promise<FastifyInstance> {
    const config = makeTestConfig();
    if (opts.configured) {
      config.connectors.github.app.id = '12345';
      config.connectors.github.app.privateKeyPath = pemPath;
    }
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, `${Math.random().toString(36).slice(2)}.yaml`),
      initial: [],
    });
    const appService = new GitHubAppService({
      localConfigPath: join(tmpDir, 'app.yaml'),
      appConfig: config.connectors.github.app,
    });
    const s = await createServer({
      connectorRegistry: registry,
      githubAppService: appService,
      config,
    });
    await s.ready();
    // Seed connectors through POST so Zod fills in defaults (schedule,
    // scope, entities) — the route's own contract for adding instances.
    for (const inst of opts.instances ?? []) {
      const res = await s.inject({
        method: 'POST',
        url: '/api/connectors',
        payload: {
          id: inst.id,
          type: 'github',
          name: inst.id,
          installationId: inst.installationId,
          org: inst.id,
        },
      });
      if (res.statusCode !== 201) throw new Error(`seed failed: ${res.body}`);
    }
    return s;
  }

  it('returns 404 NO_APP_CONFIGURED when the global App is empty', async () => {
    server = await buildServer({ configured: false });
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/installations',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_APP_CONFIGURED');
    await server.close();
  });

  it('returns 200 with installations + usedByConnectorId for matching instances', async () => {
    // One existing connector for org A (installation 111). The endpoint
    // should mark that installation as "Already used by github-org-a"
    // and leave org B (installation 222) free to claim.
    vi.mocked(createAppJWTOctokit).mockReturnValueOnce({
      rest: {
        apps: {
          getAuthenticated: vi.fn().mockResolvedValue({
            data: {
              slug: 'shipit-ai-test',
              name: 'ShipIt-AI Test',
              // Org-owned Apps return the SETTINGS URL here, not the
              // public install URL. Appending "/installations/new" to
              // this would land users on the existing installation in
              // ship-it-ops instead of the install picker — the bug
              // this fix exists to prevent.
              html_url: 'https://github.com/organizations/ship-it-ops/settings/apps/shipit-ai-test',
            },
          }),
          listInstallations: vi.fn().mockResolvedValue({
            data: [
              {
                id: 111,
                target_type: 'Organization',
                repository_selection: 'all',
                account: {
                  login: 'org-a',
                  type: 'Organization',
                  avatar_url: 'https://example/a.png',
                },
              },
              {
                id: 222,
                target_type: 'Organization',
                repository_selection: 'selected',
                account: {
                  login: 'org-b',
                  type: 'Organization',
                  avatar_url: 'https://example/b.png',
                },
              },
            ],
          }),
        },
      },
    } as never);

    server = await buildServer({
      configured: true,
      instances: [{ id: 'github-org-a', installationId: '111' }],
    });
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/installations',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appSlug).toBe('shipit-ai-test');
    expect(body.installUrl).toBe('https://github.com/apps/shipit-ai-test/installations/new');
    expect(body.installations).toHaveLength(2);
    const orgA = body.installations.find((i: { id: number }) => i.id === 111);
    const orgB = body.installations.find((i: { id: number }) => i.id === 222);
    expect(orgA.usedByConnectorId).toBe('github-org-a');
    expect(orgA.account.login).toBe('org-a');
    expect(orgB.usedByConnectorId).toBeNull();
    expect(orgB.repositorySelection).toBe('selected');
    await server.close();
  });

  it('returns 502 GITHUB_API_ERROR when the App-JWT call rejects', async () => {
    vi.mocked(createAppJWTOctokit).mockReturnValueOnce({
      rest: {
        apps: {
          getAuthenticated: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 })),
          listInstallations: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as never);

    server = await buildServer({ configured: true });
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/installations',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('GITHUB_API_ERROR');
    expect(res.json().error.message).toContain('rate limited');
    await server.close();
  });
});

// GitHub App manifest flow. Covers the dynamic manifest endpoint, the
// state-token CSRF handshake, and the callback exchange. The exchange
// network call is mocked so the suite stays hermetic.
describe('GitHub App manifest flow', () => {
  let server: FastifyInstance;
  let tmpDir: string;
  let keyDir: string;
  let appService: GitHubAppService;
  let manifestService: GitHubAppManifestService;
  // Captured per-test so individual tests can override the response.
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-manifest-'));
    keyDir = join(tmpDir, 'keys');
    // Write a minimal manifest template into the tmpdir so the service
    // doesn't depend on the repo's real one.
    const tmplPath = join(tmpDir, 'manifest.json');
    writeFileSync(
      tmplPath,
      JSON.stringify({
        name: 'ShipIt-AI Test',
        url: 'https://example.invalid',
        default_permissions: { contents: 'read' },
        default_events: ['push'],
        hook_attributes: { url: 'PLACEHOLDER', active: true },
        redirect_url: 'PLACEHOLDER',
      }),
      'utf-8',
    );

    const config = makeTestConfig();
    // Set a webhookPublicUrl so the manifest endpoint has a non-default
    // value to substitute — proves the substitution is reading config,
    // not hardcoding.
    config.connectors.github.app.webhookPublicUrl = 'https://example.test/hooks';

    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    appService = new GitHubAppService({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      appConfig: config.connectors.github.app,
    });
    fetchMock = vi.fn();
    manifestService = new GitHubAppManifestService({
      templatePath: tmplPath,
      appService,
      keyDir,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    server = await createServer({
      connectorRegistry: registry,
      githubAppService: appService,
      githubAppManifestService: manifestService,
      config,
    });
    await server.ready();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Pulls the `state=` value out of the launch endpoint's HTML form action.
  // Mirrors how the wizard implicitly receives the state: the user's
  // browser hits /launch and the embedded form already carries the state
  // that the callback will validate.
  async function issueStateViaLaunch(owner?: string): Promise<string> {
    const url = owner
      ? `/api/connectors/github/manifest/launch?owner=${encodeURIComponent(owner)}`
      : '/api/connectors/github/manifest/launch';
    const res = await server.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const match = res.body.match(/action="[^"]*state=([a-f0-9]+)"/);
    expect(match, 'launch HTML must contain action="…state=…"').toBeTruthy();
    return match![1];
  }

  it('GET /manifest returns inspectable JSON with hook + redirect URLs', async () => {
    // Debug-only endpoint; not the path GitHub actually consumes. Useful
    // for an admin to curl and audit the manifest the wizard sends.
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest',
      headers: { host: 'shipit.local:3001', 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hook_attributes.url).toBe('https://example.test/hooks');
    expect(body.redirect_url).toBe(
      'https://shipit.local:3001/api/connectors/github/app-manifest-callback',
    );
    // Without callback_urls the created App can't serve OAuth sign-in —
    // GitHub errors with "This GitHub App must be configured with a
    // callback URL" on the first login attempt (portal-demo, 2026-06-12).
    expect(body.callback_urls).toEqual(['https://shipit.local:3001/api/auth/callback/github']);
    // Static fields from the template flow through untouched.
    expect(body.name).toBe('ShipIt-AI Test');
    expect(body.default_permissions).toEqual({ contents: 'read' });
  });

  it('GET /manifest/launch returns auto-submitting HTML form posting to github.com', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest/launch',
      headers: { host: 'shipit.local:3001' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Personal-account URL when owner not specified.
    expect(res.body).toMatch(
      /action="https:\/\/github\.com\/settings\/apps\/new\?state=[a-f0-9]+"/,
    );
    // Form is POST and uses the documented field name.
    expect(res.body).toMatch(/method="POST"/);
    expect(res.body).toMatch(/name="manifest"/);
    // Auto-submit happens via script — without this the page wouldn't
    // submit and the user would be stuck on our launch URL.
    expect(res.body).toContain('form.submit()');
  });

  it('GET /manifest/launch routes to org URL when owner is supplied', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest/launch?owner=shipitops',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(
      /action="https:\/\/github\.com\/organizations\/shipitops\/settings\/apps\/new\?state=[a-f0-9]+"/,
    );
  });

  it('GET /manifest/launch rejects malformed owner values', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest/launch?owner=not%20a%20valid%20login',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid owner');
  });

  it('GET /manifest strips hook_attributes AND default_events together when webhook URL is localhost', async () => {
    // GitHub rejects "events subscribed without a valid hook URL" as
    // "Hook url cannot be blank". The service must therefore drop both
    // when the webhook URL is non-public — they're a coupled pair.
    // Rebuild the server with a localhost webhook URL to exercise that
    // branch.
    const localConfig = makeTestConfig();
    localConfig.connectors.github.app.webhookPublicUrl =
      'http://localhost:3001/api/webhooks/github';
    const localAppService = new GitHubAppService({
      localConfigPath: join(tmpDir, 'localhost.local.yaml'),
      appConfig: localConfig.connectors.github.app,
    });
    const localManifestService = new GitHubAppManifestService({
      templatePath: join(tmpDir, 'manifest.json'),
      appService: localAppService,
      keyDir,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const localServer = await createServer({
      connectorRegistry: new ConnectorRegistry({
        localConfigPath: join(tmpDir, 'localhost.local.yaml'),
        initial: [],
      }),
      githubAppService: localAppService,
      githubAppManifestService: localManifestService,
      config: localConfig,
    });
    await localServer.ready();

    const res = await localServer.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hook_attributes).toBeUndefined();
    // Events must also be gone — otherwise GitHub returns
    // "Hook url cannot be blank" / "Hook is invalid".
    expect(body.default_events).toBeUndefined();
    // Permissions still flow through; the App is creatable, just
    // without webhook + events wired.
    expect(body.default_permissions).toBeDefined();
    expect(body._warnings?.webhookOmitted).toBe(true);
    expect(body._warnings?.reason).toContain('localhost');
    await localServer.close();
  });

  it('GET /manifest/launch shows a warning banner and holds auto-submit when webhook is localhost', async () => {
    const localConfig = makeTestConfig();
    localConfig.connectors.github.app.webhookPublicUrl =
      'http://127.0.0.1:3001/api/webhooks/github';
    const localAppService = new GitHubAppService({
      localConfigPath: join(tmpDir, 'lh.yaml'),
      appConfig: localConfig.connectors.github.app,
    });
    const localManifestService = new GitHubAppManifestService({
      templatePath: join(tmpDir, 'manifest.json'),
      appService: localAppService,
      keyDir,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const localServer = await createServer({
      connectorRegistry: new ConnectorRegistry({
        localConfigPath: join(tmpDir, 'lh.yaml'),
        initial: [],
      }),
      githubAppService: localAppService,
      githubAppManifestService: localManifestService,
      config: localConfig,
    });
    await localServer.ready();

    const res = await localServer.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest/launch',
    });
    expect(res.statusCode).toBe(200);
    // The warning copy + the held-back script behaviour together prove
    // the user gets a chance to opt out rather than being silently
    // bounced to GitHub with a broken manifest.
    expect(res.body).toContain('Webhooks and event subscriptions will be skipped');
    expect(res.body).toContain('127.0.0.1');
    expect(res.body).toContain('var holdSubmit = true');
    expect(res.body).toContain('continue-btn');
    await localServer.close();
  });

  it('callback rejects missing code', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/app-manifest-callback?state=abc',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Missing code');
  });

  it('callback rejects unknown state token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/app-manifest-callback?code=xyz&state=neverissued',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid or expired state token');
  });

  it('callback exchanges code, writes PEM with 0600, persists App', async () => {
    // State is now issued as a side-effect of the launch endpoint —
    // mirrors the real flow where the user's browser fetches /launch
    // and GitHub later echoes the state back on the callback.
    const state = await issueStateViaLaunch();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 4242,
          name: 'ShipIt-AI Test',
          html_url: 'https://github.com/apps/shipit-ai-test',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nDUMMY\n-----END RSA PRIVATE KEY-----\n',
          webhook_secret: 'whsec_dummy',
          client_id: 'Iv1.dummy',
          client_secret: 'dummysecret',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const res = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/app-manifest-callback?code=goodcode&state=${state}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('App &quot;ShipIt-AI Test&quot; created');

    // PEM file landed at the expected path with strict perms.
    const expectedKey = join(keyDir, 'github-app-4242.pem');
    const pemContents = readFileSync(expectedKey, 'utf-8');
    expect(pemContents).toContain('BEGIN RSA PRIVATE KEY');
    expect(statSync(expectedKey).mode & 0o777).toBe(0o600);

    // Webhook secret sidecar.
    const secretPath = join(keyDir, 'github-app-4242.webhook-secret');
    expect(readFileSync(secretPath, 'utf-8').trim()).toBe('whsec_dummy');
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);

    // GitHubAppService picked it up — the global config now points at
    // the freshly-written key.
    const status = appService.status();
    expect(status.configured).toBe(true);
    expect(status.id).toBe('4242');
    expect(status.privateKeyPath).toBe(expectedKey);
  });

  it('state token is single-use', async () => {
    const state = await issueStateViaLaunch();

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 1,
          name: 'X',
          html_url: 'https://github.com/apps/x',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nA\n-----END RSA PRIVATE KEY-----\n',
          webhook_secret: 's',
        }),
        { status: 200 },
      ),
    );

    const first = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/app-manifest-callback?code=c1&state=${state}`,
    });
    expect(first.statusCode).toBe(200);

    // Second attempt with the same state should be rejected — proves
    // the state was consumed and not just stored.
    const second = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/app-manifest-callback?code=c2&state=${state}`,
    });
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('Invalid or expired state token');
  });

  // ── target='instance' (per-org) flow ───────────────────────────────
  // The per-org card on Step 1 of the wizard launches the manifest with
  // target=instance&nonce=<uuid>. The callback must NOT write to the
  // global App slot — it stashes credentials in the pending map keyed
  // by the nonce, and the wizard polls /pending-instance/:nonce to
  // claim them and attach them to the connector instance.
  async function issueInstanceStateViaLaunch(nonce: string, owner?: string): Promise<string> {
    const qs = new URLSearchParams({ target: 'instance', nonce });
    if (owner) qs.set('owner', owner);
    const res = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/manifest/launch?${qs.toString()}`,
    });
    expect(res.statusCode).toBe(200);
    const match = res.body.match(/action="[^"]*state=([a-f0-9]+)"/);
    expect(match, 'launch HTML must contain action="…state=…"').toBeTruthy();
    return match![1];
  }

  it('launch rejects target=instance without a nonce', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest/launch?target=instance',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Missing nonce');
  });

  it('callback with target=instance leaves global App unchanged and stashes pending creds', async () => {
    const nonce = 'wizard-uuid-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const state = await issueInstanceStateViaLaunch(nonce, 'shipitops');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 7777,
          name: 'ShipIt-AI (shipitops)',
          slug: 'shipit-ai-shipitops',
          html_url: 'https://github.com/apps/shipit-ai-shipitops',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nINSTANCE-DUMMY\n-----END RSA PRIVATE KEY-----\n',
          webhook_secret: 'whsec_instance',
        }),
        { status: 200 },
      ),
    );

    const cb = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/app-manifest-callback?code=instcode&state=${state}`,
    });
    expect(cb.statusCode).toBe(200);
    // Success-page copy is tailored to the wizard's polling — the body
    // should tell the user the wizard will auto-fill, not that the
    // global App is now configured.
    expect(cb.body).toContain('per-org override fields');
    expect(cb.body).not.toContain('shared GitHub App is now configured');

    // Global App slot was NOT touched. This is the core invariant.
    expect(appService.status().configured).toBe(false);

    // Wizard claims the credentials via the nonce.
    const claim = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/manifest/pending-instance/${encodeURIComponent(nonce)}`,
    });
    expect(claim.statusCode).toBe(200);
    const body = claim.json();
    expect(body.appId).toBe('7777');
    expect(body.appName).toBe('ShipIt-AI (shipitops)');
    expect(body.privateKeyPath).toContain('github-app-7777.pem');
    expect(body.installUrl).toBe('https://github.com/apps/shipit-ai-shipitops');

    // PEM was still written to disk (the per-org override needs a file
    // path on the server, just like the shared App does).
    const pemContents = readFileSync(body.privateKeyPath, 'utf-8');
    expect(pemContents).toContain('INSTANCE-DUMMY');
    expect(statSync(body.privateKeyPath).mode & 0o777).toBe(0o600);
  });

  it('pending-instance claim is single-use; second GET returns 404', async () => {
    const nonce = 'second-test-nonce-123456789012';
    const state = await issueInstanceStateViaLaunch(nonce);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 8,
          name: 'X',
          slug: 'x',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nA\n-----END\n',
          webhook_secret: 's',
        }),
        { status: 200 },
      ),
    );
    await server.inject({
      method: 'GET',
      url: `/api/connectors/github/app-manifest-callback?code=c&state=${state}`,
    });
    const first = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/manifest/pending-instance/${nonce}`,
    });
    expect(first.statusCode).toBe(200);
    const second = await server.inject({
      method: 'GET',
      url: `/api/connectors/github/manifest/pending-instance/${nonce}`,
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('NOT_READY');
  });

  it('pending-instance returns 404 before the callback fires', async () => {
    // Polling signal: wizard hammers this endpoint while the user is
    // in the GitHub tab. 404 means "not ready yet, keep polling".
    const res = await server.inject({
      method: 'GET',
      url: '/api/connectors/github/manifest/pending-instance/never-issued',
    });
    expect(res.statusCode).toBe(404);
  });
});
