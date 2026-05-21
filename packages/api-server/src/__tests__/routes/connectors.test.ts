import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import { GitHubAppService } from '../../services/github-app-service.js';
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
