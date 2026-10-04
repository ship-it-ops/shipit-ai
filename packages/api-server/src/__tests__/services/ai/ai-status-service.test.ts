import { describe, it, expect } from 'vitest';
import { EXPECTED_SCHEMA_VERSION, type Db } from '@shipit-ai/agents';
import {
  AiStatusService,
  RUNNER_HEARTBEAT_KEY,
  type AiStatus,
} from '../../../services/ai/ai-status-service.js';
import { makeTestConfig } from '../../test-config.js';

const ai = () => makeTestConfig().ai;

/** A Db whose only query is answered by `answer` (a value or a thrown error). */
function dbAnswering(answer: () => { rows: unknown[] }): Db {
  const query = async () => ({ ...answer(), rowCount: null });
  return {
    query: query as Db['query'],
    tx: async (fn) => fn({ query: query as Db['query'] }),
    withClient: async (fn) => fn({ query: query as Db['query'] }),
  };
}

const migrated = dbAnswering(() => ({ rows: [{ version: EXPECTED_SCHEMA_VERSION }] }));
const aliveRedis = { get: async (key: string) => (key === RUNNER_HEARTBEAT_KEY ? '1' : null) };
const silentRedis = { get: async () => null };

const check = (status: AiStatus, name: string) => status.checks.find((c) => c.name === name)!;

describe('AiStatusService', () => {
  it('is fully available when every prerequisite is met', async () => {
    const service = new AiStatusService({
      config: ai(),
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    });
    const status = await service.status();
    expect(status.available).toBe(true);
    expect(status.definitionsAvailable).toBe(true);
    expect(status.checks.map((c) => c.name)).toEqual([
      'enabled',
      'database',
      'schema',
      'models',
      'runner',
    ]);
  });

  it('allows definitions but not runs when only the runner is missing', async () => {
    const service = new AiStatusService({
      config: ai(),
      db: migrated,
      redis: silentRedis,
      cacheMs: 0,
    });
    const status = await service.status();
    expect(status.definitionsAvailable).toBe(true);
    expect(status.available).toBe(false);
    expect(check(status, 'runner').ok).toBe(false);
  });

  it('is off when ai.enabled is false, even with everything else in place', async () => {
    const config = { ...ai(), enabled: false };
    const status = await new AiStatusService({
      config,
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(status.definitionsAvailable).toBe(false);
    expect(check(status, 'enabled').ok).toBe(false);
  });

  it('reports a missing database without trying to query one', async () => {
    const status = await new AiStatusService({
      config: ai(),
      db: null,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'database')).toMatchObject({ ok: false });
    expect(check(status, 'schema').ok).toBe(false);
    expect(status.definitionsAvailable).toBe(false);
  });

  it('distinguishes "connected but never migrated" from "unreachable"', async () => {
    const neverMigrated = dbAnswering(() => {
      throw Object.assign(new Error('relation "schema_migrations" does not exist'), {
        code: '42P01',
      });
    });
    const status = await new AiStatusService({
      config: ai(),
      db: neverMigrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'database').ok).toBe(true);
    expect(check(status, 'schema').ok).toBe(false);
    expect(check(status, 'schema').detail).toContain(EXPECTED_SCHEMA_VERSION);
  });

  it('fails the schema check when the table exists but is empty', async () => {
    const empty = dbAnswering(() => ({ rows: [{ version: null }] }));
    const status = await new AiStatusService({
      config: ai(),
      db: empty,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'database').ok).toBe(true);
    expect(check(status, 'schema').ok).toBe(false);
  });

  it('fails the schema check when the database is behind this build', async () => {
    const behind = dbAnswering(() => ({ rows: [{ version: '0000' }] }));
    const status = await new AiStatusService({
      config: ai(),
      db: behind,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'schema')).toMatchObject({ ok: false });
    expect(check(status, 'schema').detail).toContain('0000');
  });

  it('accepts a database that is ahead of this build', async () => {
    const ahead = dbAnswering(() => ({ rows: [{ version: '9999' }] }));
    const status = await new AiStatusService({
      config: ai(),
      db: ahead,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'schema').ok).toBe(true);
  });

  it('never puts the driver error in a detail a user can read', async () => {
    const logged: string[] = [];
    const unreachable = dbAnswering(() => {
      throw new Error('connect ECONNREFUSED 10.20.30.40:5432');
    });
    const status = await new AiStatusService({
      config: ai(),
      db: unreachable,
      redis: aliveRedis,
      cacheMs: 0,
      log: (m) => logged.push(m),
    }).status();
    expect(check(status, 'database').ok).toBe(false);
    expect(JSON.stringify(status)).not.toContain('10.20.30.40');
    expect(logged.join('\n')).toContain('10.20.30.40');
  });

  it('fails the models check with no Vertex project or no models', async () => {
    const noProject = { ...ai(), vertex: { project: '', location: 'global' } };
    const noModels = { ...ai(), models: [] };
    const a = await new AiStatusService({
      config: noProject,
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    const b = await new AiStatusService({
      config: noModels,
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(a, 'models').ok).toBe(false);
    expect(check(b, 'models').ok).toBe(false);
    expect(a.definitionsAvailable).toBe(true);
  });

  it('survives Redis throwing during the runner check', async () => {
    const broken = {
      get: async () => {
        throw new Error('OOM command not allowed');
      },
    };
    const status = await new AiStatusService({
      config: ai(),
      db: migrated,
      redis: broken,
      cacheMs: 0,
    }).status();
    expect(check(status, 'runner').ok).toBe(false);
    expect(status.definitionsAvailable).toBe(true);
  });

  // A Redis that is down queues commands instead of failing them, so a read
  // never settles. Without a bound, every agents route would hang with it.
  it('gives up on a runner check that does not answer', async () => {
    const service = new AiStatusService({
      config: ai(),
      db: migrated,
      redis: { get: () => new Promise<string | null>(() => {}) },
      cacheMs: 0,
      runnerCheckTimeoutMs: 20,
    });
    const started = Date.now();
    const status = await service.status();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(status.available).toBe(false);
    expect(status.definitionsAvailable).toBe(true);
    expect(check(status, 'runner')).toMatchObject({
      ok: false,
      detail: 'The agent runner could not be checked.',
    });
  });

  it('reuses a computed status inside the cache window, then recomputes', async () => {
    let calls = 0;
    let clock = 1_000;
    const counting = dbAnswering(() => {
      calls += 1;
      return { rows: [{ version: EXPECTED_SCHEMA_VERSION }] };
    });
    const service = new AiStatusService({
      config: ai(),
      db: counting,
      redis: aliveRedis,
      cacheMs: 5_000,
      now: () => clock,
    });
    await service.status();
    clock += 4_999;
    await service.status();
    expect(calls).toBe(1);
    clock += 2;
    await service.status();
    expect(calls).toBe(2);
  });
});
