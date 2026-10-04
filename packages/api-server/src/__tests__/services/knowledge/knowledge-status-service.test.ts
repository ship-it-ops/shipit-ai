import { describe, it, expect } from 'vitest';
import type { Db } from '@shipit-ai/agents';
import {
  KnowledgeStatusService,
  WORKER_HEARTBEAT_KEY,
  type KnowledgeStatus,
} from '../../../services/knowledge/knowledge-status-service.js';
import { makeTestConfig } from '../../test-config.js';

const cfg = makeTestConfig();

function dbAnswering(answer: (sql: string) => { rows: unknown[] } | Error): Db {
  const query = async (sql: string) => {
    const a = answer(sql);
    if (a instanceof Error) throw a;
    return { rows: a.rows as never[], rowCount: a.rows.length };
  };
  const client = { query } as never;
  return {
    query,
    tx: async (fn: (c: never) => Promise<unknown>) => fn(client),
    withClient: async (fn: (c: never) => Promise<unknown>) => fn(client),
  } as unknown as Db;
}

const healthyDb = dbAnswering((sql) => {
  if (sql.includes('schema_migrations')) return { rows: [{ version: '0002' }] };
  if (sql.includes('pg_extension')) return { rows: [{ extversion: '0.8.7' }] };
  return { rows: [] };
});
const redisWith = (beat: string | null) => ({
  get: async (key: string) => (key === WORKER_HEARTBEAT_KEY ? beat : null),
});
const check = (s: KnowledgeStatus, name: string) => s.checks.find((c) => c.name === name)!;

function service(overrides: Partial<ConstructorParameters<typeof KnowledgeStatusService>[0]> = {}) {
  return new KnowledgeStatusService({
    knowledge: cfg.knowledge,
    ai: { ...cfg.ai, database: { url: 'postgres://x' } },
    db: healthyDb,
    store: null,
    redis: redisWith('2026-10-03T00:00:00Z'),
    cacheMs: 0,
    ...overrides,
  });
}

describe('KnowledgeStatusService', () => {
  it('is available when every check passes', async () => {
    const s = await service().status();
    expect(s.available).toBe(true);
    expect(s.ingestionAvailable).toBe(true);
    expect(s.checks.map((c) => c.name)).toEqual([
      'enabled',
      'database',
      'schema',
      'extension',
      'embedding',
      'worker',
    ]);
  });

  it('names the master switch', async () => {
    const s = await service({ knowledge: { ...cfg.knowledge, enabled: false } }).status();
    expect(s.available).toBe(false);
    expect(check(s, 'enabled').detail).toContain('knowledge.enabled');
  });

  it('reports no database without leaking a URL or driver message', async () => {
    const s = await service({ db: null, ai: { ...cfg.ai, database: { url: '' } } }).status();
    expect(check(s, 'database').ok).toBe(false);
    expect(check(s, 'schema').ok).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/postgres:\/\//);
  });

  it('reports an unreachable database as not reachable, without the driver text', async () => {
    const s = await service({
      db: dbAnswering(() => new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    }).status();
    expect(check(s, 'database')).toEqual({
      name: 'database',
      ok: false,
      detail: 'The database is not reachable.',
    });
    expect(JSON.stringify(s)).not.toContain('10.0.0.5');
  });

  it('names the missing migration versions', async () => {
    const behind = dbAnswering((sql) =>
      sql.includes('schema_migrations') ? { rows: [] } : { rows: [{ extversion: '0.8.7' }] },
    );
    const s = await service({ db: behind }).status();
    expect(check(s, 'schema').ok).toBe(false);
    expect(check(s, 'schema').detail).toContain('0002');
    expect(s.ingestionAvailable).toBe(false);
  });

  it('reports the missing extension with the bootstrap hint', async () => {
    const noExt = dbAnswering((sql) =>
      sql.includes('pg_extension') ? { rows: [] } : { rows: [{ version: '0002' }] },
    );
    const s = await service({ db: noExt }).status();
    expect(check(s, 'extension').ok).toBe(false);
    expect(check(s, 'extension').detail).toContain('pgvector');
  });

  it('needs a Vertex project and the right dimension', async () => {
    const noProject = await service({
      ai: {
        ...cfg.ai,
        database: { url: 'postgres://x' },
        vertex: { project: '', location: 'global' },
      },
    }).status();
    expect(check(noProject, 'embedding').detail).toContain('ai.vertex.project');
    const wrongDims = await service({
      knowledge: { ...cfg.knowledge, embedding: { model: 'm', dimensions: 1536 } },
    }).status();
    expect(check(wrongDims, 'embedding').detail).toContain('768');
  });

  it('needs a worker heartbeat for available, not for ingestion', async () => {
    const s = await service({ redis: redisWith(null) }).status();
    expect(check(s, 'worker').ok).toBe(false);
    expect(s.available).toBe(false);
    expect(s.ingestionAvailable).toBe(true);
  });

  it('includes document counts when a store is wired', async () => {
    const store = { countsByIndexStatus: async () => ({ indexed: 10, pending: 2 }) };
    const s = await service({ store: store as never }).status();
    expect(s.counts).toEqual({ indexed: 10, pending: 2 });
  });

  it('caches for cacheMs', async () => {
    let calls = 0;
    const counting = dbAnswering((sql) => {
      calls += 1;
      return sql.includes('pg_extension')
        ? { rows: [{ extversion: '1' }] }
        : { rows: [{ version: '0002' }] };
    });
    let t = 0;
    const s = service({ db: counting, cacheMs: 5000, now: () => t });
    await s.status();
    await s.status();
    expect(calls).toBe(2); // one schema query + one extension query, once
    t = 6000;
    await s.status();
    expect(calls).toBe(4);
  });
});
