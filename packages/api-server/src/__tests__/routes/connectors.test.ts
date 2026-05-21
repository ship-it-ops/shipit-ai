import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import { GitHubAppService } from '../../services/github-app-service.js';
import { GitHubAppManifestService } from '../../services/github-app-manifest-service.js';
import { makeTestConfig } from '../test-config.js';

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
    org: 'acme-corp',
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
    expect(body.org).toBe('acme-corp');
    // Defaults from Zod should be filled in
    expect(body.schedule).toBe('*/15 * * * *');
    expect(body.scope.cappedAt).toBe(100);
    // No App override unless caller asked for one — verifies the registry
    // doesn't materialize an empty `app: {}` that would leak into YAML.
    expect(body.app).toBeUndefined();
    // Strong ETag wrapped in quotes per RFC 7232
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it('POST /api/connectors persists an App override when supplied', async () => {
    // Use a different id so we don't collide with the previous test.
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        ...validPayload,
        id: 'github-test-override',
        app: { id: '999999', privateKeyPath: '/etc/shipit/dev-app.pem' },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.app).toEqual({ id: '999999', privateKeyPath: '/etc/shipit/dev-app.pem' });

    // Clean up so the rest of the suite sees a single connector.
    await server.inject({ method: 'DELETE', url: '/api/connectors/github-test-override' });
  });

  it('PATCH /api/connectors/:id with app:null clears the override', async () => {
    // First add an override.
    await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        ...validPayload,
        id: 'github-clear-test',
        app: { id: '777', privateKeyPath: '/tmp/foo.pem' },
      },
    });
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github-clear-test' });
    expect(get.json().app).toEqual({ id: '777', privateKeyPath: '/tmp/foo.pem' });

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
      payload: { id: 'gh-2', type: 'github', name: 'X', org: 'acme' },
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

  it('reports PRIVATE_KEY_UNREADABLE when the override path does not exist', async () => {
    // Full override but the file doesn't exist — proves the resolver
    // actually used the override (otherwise it'd return APP_NOT_CONFIGURED
    // for the empty global App).
    const response = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: {
        installationId: '12345',
        app: { id: '777', privateKeyPath: '/this/path/does/not/exist.pem' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('PRIVATE_KEY_UNREADABLE');
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

  it('PUT persists the global App and writes YAML', async () => {
    const get = await server.inject({ method: 'GET', url: '/api/connectors/github/app' });
    const etag = get.headers.etag as string;

    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      headers: { 'if-match': etag },
      payload: { id: '12345', privateKeyPath: '/etc/shipit/keys/app.pem' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.id).toBe('12345');
    expect(body.privateKeyPath).toBe('/etc/shipit/keys/app.pem');

    // Verify it landed in YAML. The file was missing before — the
    // service must create it from scratch.
    const written = readFileSync(join(tmpDir, 'shipit.config.local.yaml'), 'utf-8');
    expect(written).toMatch(/id:\s*['"]?12345/);
    expect(written).toContain('/etc/shipit/keys/app.pem');
  });

  it('PUT returns 400 when fields are missing', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      payload: { id: '12345' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT returns 409 on stale If-Match', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/connectors/github/app',
      headers: { 'if-match': '"deadbeef"' },
      payload: { id: '12345', privateKeyPath: '/etc/shipit/keys/app.pem' },
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

  it('GET /manifest substitutes hook URL and redirect URL from config + request', async () => {
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
    // Static fields from the template flow through untouched.
    expect(body.name).toBe('ShipIt-AI Test');
    expect(body.default_permissions).toEqual({ contents: 'read' });
  });

  it('POST /manifest/state issues a fresh token each call', async () => {
    const a = await server.inject({ method: 'POST', url: '/api/connectors/github/manifest/state' });
    const b = await server.inject({ method: 'POST', url: '/api/connectors/github/manifest/state' });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().state).toMatch(/^[a-f0-9]{48}$/);
    expect(b.json().state).toMatch(/^[a-f0-9]{48}$/);
    expect(a.json().state).not.toBe(b.json().state);
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
    // Issue a state via the real endpoint so the manifest service holds
    // it in memory the same way it would for a real flow.
    const stateRes = await server.inject({
      method: 'POST',
      url: '/api/connectors/github/manifest/state',
    });
    const state = stateRes.json().state as string;

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
    const stateRes = await server.inject({
      method: 'POST',
      url: '/api/connectors/github/manifest/state',
    });
    const state = stateRes.json().state as string;

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
});
