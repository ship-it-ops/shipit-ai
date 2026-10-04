import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import type { KnowledgeStatusService } from '../../services/knowledge/knowledge-status-service.js';
import { KnowledgeRefreshError } from '../../services/knowledge-sync-scheduler.js';

// Same shape as routes/knowledge.test.ts: a test server, server.inject(), and
// the dev-fallback principal, which is an admin.
const ID = '11111111-1111-4111-8111-111111111111';
const container = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  connectorId: 'gh-1',
  externalId: '42',
  kind: 'repository',
  name: 'acme/payments',
  url: 'https://github.com/acme/payments',
  visibility: 'restricted',
  archived: false,
  acl: null,
  selected: false,
  selectedBy: null,
  checkpoint: '{"secret":"cursor"}',
  mappedEntityIds: [],
  lastPolledAt: null,
  lastReconciledAt: null,
  goneAt: null,
  purgeRequestedAt: null,
  visibilityAcknowledgedBy: null,
  documents: 3,
  indexed: 2,
  pending: 1,
  failed: 0,
  restricted: 0,
  ...overrides,
});

const available = {
  status: async () => ({ available: true, ingestionAvailable: true, checks: [] }),
} as unknown as KnowledgeStatusService;
const unavailable = {
  status: async () => ({
    available: false,
    ingestionAvailable: false,
    checks: [{ name: 'database', ok: false, detail: 'No database is configured.' }],
  }),
} as unknown as KnowledgeStatusService;

describe('connector container routes', () => {
  let selections: Array<Record<string, unknown>>;
  let rows: Array<ReturnType<typeof container>>;
  let refresh: () => Promise<number>;
  let refreshes: number;
  let deselected: Array<{ connectorId: string; by: string }>;
  let tmpDir: string;

  beforeEach(() => {
    selections = [];
    rows = [container()];
    refresh = async () => 7;
    refreshes = 0;
    deselected = [];
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-containers-routes-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function server(knowledgeStatus = available): Promise<FastifyInstance> {
    // Seeded the way routes/connectors.test.ts seeds one: through a registry.
    const connectorRegistry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    await connectorRegistry.create({
      id: 'gh-1',
      type: 'github',
      name: 'acme',
      installationId: '1',
      org: 'acme',
    });
    const s = await createServer({
      config: makeTestConfig(),
      connectorRegistry,
      knowledgeStatus,
      knowledgeStore: {
        containersWithCounts: async (_c: string, q?: string) =>
          rows.filter((r) => !q || r.name.includes(q)),
        getContainer: async (_c: string, id: string) => rows.find((r) => r.id === id) ?? null,
        selectContainer: async (_c: string, id: string, input: Record<string, unknown>) =>
          void selections.push({ id, ...input }),
        deselectConnector: async (connectorId: string, by: string) => {
          deselected.push({ connectorId, by });
          return 1;
        },
      } as never,
      knowledgeScheduler: {
        refreshContainers: () => {
          refreshes += 1;
          return refresh();
        },
      } as never,
    });
    await s.ready();
    return s;
  }

  it('lists containers with counts, without the checkpoint or the ACL', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers' });
    expect(res.statusCode).toBe(200);
    expect(res.json().containers).toEqual([
      {
        id: ID,
        externalId: '42',
        kind: 'repository',
        name: 'acme/payments',
        url: 'https://github.com/acme/payments',
        visibility: 'restricted',
        archived: false,
        selected: false,
        visibilityAcknowledged: false,
        purging: false,
        gone: false,
        lastPolledAt: null,
        lastReconciledAt: null,
        documents: 3,
        indexed: 2,
        pending: 1,
        failed: 0,
        restricted: 0,
      },
    ]);
    await s.close();
  });

  it('passes the search text through', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers?q=nope' });
    expect(res.json().containers).toEqual([]);
    await s.close();
  });

  it('answers 404 for a connector that does not exist', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/missing/containers' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await s.close();
  });

  it('answers KNOWLEDGE_UNAVAILABLE with the failing checks', async () => {
    const s = await server(unavailable);
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('KNOWLEDGE_UNAVAILABLE');
    expect(res.json().checks[0].name).toBe('database');
    await s.close();
  });

  it('refuses a restricted container without the acknowledgement', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VISIBILITY_NOT_ACKNOWLEDGED');
    expect(selections).toEqual([]);
    await s.close();
  });

  it('selects a restricted container once acknowledged, recording who did', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true, acknowledgeVisibility: true },
    });
    expect(res.statusCode).toBe(200);
    expect(selections).toEqual([
      { id: ID, selected: true, by: expect.any(String), acknowledged: true },
    ]);
    await s.close();
  });

  it('selects an open container without an acknowledgement, and deselects any', async () => {
    rows = [container({ visibility: 'open' })];
    const s = await server();
    const on = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true },
    });
    expect(on.statusCode).toBe(200);
    const off = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: false },
    });
    expect(off.statusCode).toBe(200);
    expect(selections.map((x) => x.selected)).toEqual([true, false]);
    await s.close();
  });

  it('asks the source again before indexing, unacknowledged, a container the last listing called open', async () => {
    rows = [container({ visibility: 'open' })];
    // Between the last listing and this request the repository was made private.
    refresh = async () => {
      rows = [container({ visibility: 'restricted' })];
      return 1;
    };
    const s = await server();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true },
    });
    expect(refreshes).toBe(1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VISIBILITY_NOT_ACKNOWLEDGED');
    expect(selections).toEqual([]);
    await s.close();
  });

  it('does not ask the source for an acknowledged selection or for a deselect', async () => {
    const s = await server();
    await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true, acknowledgeVisibility: true },
    });
    await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: false },
    });
    expect(refreshes).toBe(0);
    expect(selections.map((x) => x.selected)).toEqual([true, false]);
    await s.close();
  });

  it('does not select unverified when the source cannot be asked', async () => {
    rows = [container({ visibility: 'open' })];
    refresh = async () => {
      throw new KnowledgeRefreshError('AUTH_FAILED', 'GitHub App auth failed');
    };
    const s = await server();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AUTH_FAILED');
    expect(selections).toEqual([]);
    await s.close();
  });

  it('marks a container the source no longer lists', async () => {
    rows = [container({ goneAt: '2026-10-01T00:00:00.000Z', selected: true })];
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers' });
    expect(res.json().containers[0]).toMatchObject({ gone: true, selected: true });
    await s.close();
  });

  it('deleting the connector deselects everything it holds, so the worker purges it', async () => {
    const s = await server();
    const res = await s.inject({ method: 'DELETE', url: '/api/connectors/gh-1' });
    expect(res.statusCode).toBe(204);
    expect(deselected).toEqual([{ connectorId: 'gh-1', by: expect.any(String) }]);
    await s.close();
  });

  it('a refused delete purges nothing', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'DELETE',
      url: '/api/connectors/gh-1',
      headers: { 'if-match': '"deadbeef"' },
    });
    expect(res.statusCode).toBe(409);
    expect(deselected).toEqual([]);
    await s.close();
  });

  it('rejects a body without a boolean `selected` and an id that is not a uuid', async () => {
    const s = await server();
    const bad = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    const notUuid = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/42`,
      payload: { selected: true },
    });
    expect(notUuid.statusCode).toBe(404);
    await s.close();
  });

  it('refreshes the container list and maps a refusal to its code', async () => {
    const s = await server();
    const ok = await s.inject({ method: 'POST', url: '/api/connectors/gh-1/containers/refresh' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ containers: 7 });

    refresh = async () => {
      throw new KnowledgeRefreshError(
        'KNOWLEDGE_NOT_ENABLED',
        'Knowledge is off for this connector.',
      );
    };
    const off = await s.inject({ method: 'POST', url: '/api/connectors/gh-1/containers/refresh' });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('KNOWLEDGE_NOT_ENABLED');

    refresh = async () => {
      throw new KnowledgeRefreshError('AUTH_FAILED', 'GitHub App auth failed');
    };
    const auth = await s.inject({ method: 'POST', url: '/api/connectors/gh-1/containers/refresh' });
    expect(auth.statusCode).toBe(502);
    await s.close();
  });
});
