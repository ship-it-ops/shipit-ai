import { describe, it, expect, beforeEach } from 'vitest';
import {
  KnowledgeRunCutShort,
  createFixtureKnowledgeConnector,
  type KnowledgeConnector,
} from '@shipit-ai/connector-sdk';
import type { ConnectorInstanceConfig, LastRun } from '@shipit-ai/shared';
import {
  KnowledgeSyncScheduler,
  type KnowledgeSyncSchedulerOptions,
} from '../../services/knowledge-sync-scheduler.js';
import type { ConnectorType } from '../../services/connector-types/types.js';

// The unit tests drive `runJob` directly and never open a BullMQ connection:
// `queueFactory` hands back a recording fake.
class FakeQueue {
  schedulers = new Map<string, { pattern: string; data: unknown }>();
  added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  async upsertJobScheduler(id: string, repeat: { pattern: string }, job: { data: unknown }) {
    this.schedulers.set(id, { pattern: repeat.pattern, data: job.data });
  }
  async removeJobScheduler(id: string) {
    return this.schedulers.delete(id);
  }
  async add(name: string, data: unknown, opts: unknown) {
    this.added.push({ name, data, opts });
  }
  on() {
    return this;
  }
  async close() {}
}

const C1 = {
  externalId: 'C1',
  kind: 'channel' as const,
  name: 'general',
  visibility: 'open' as const,
  archived: false,
};
const connectorCfg = {
  id: 'fx-1',
  type: 'fixture',
  enabled: true,
  name: 'Fixture',
  schedule: '*/15 * * * *',
} as unknown as ConnectorInstanceConfig;

function fixtureType(connector: KnowledgeConnector, fail = false): ConnectorType {
  return {
    type: 'fixture',
    pollMode: 'incremental',
    sweepsAbsent: false,
    async buildKnowledge() {
      if (fail) return { ok: false, code: 'NO_TOKEN', message: 'no token on file' };
      return {
        ok: true,
        connector,
        sdkConfig: { id: 'fx-1', type: 'fixture', credentials: {}, scope: {} },
      };
    },
  } as unknown as ConnectorType;
}

function docAt(at: string) {
  return {
    externalId: `d-${at}`,
    kind: 'slack_thread' as const,
    title: 't',
    url: 'https://e/t',
    segments: [{ key: '1', text: 'hello', at }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    participantExternalIds: [],
    attributes: {},
    restricted: false,
  };
}

describe('KnowledgeSyncScheduler', () => {
  let queue: FakeQueue;
  let runs: LastRun[];
  let selected: Array<typeof C1 & { checkpoint: string | null }>;
  let stored: number;
  let upserted: number;
  let principals: number;
  let available: boolean;
  let hasSelection: boolean;
  let upsertedOne: unknown[];

  const registry = {
    get: (id: string) => {
      if (id !== 'fx-1') throw new Error('not found');
      return connectorCfg;
    },
    list: () => [connectorCfg],
    recordRun: async (_id: string, run: LastRun) => void runs.push(run),
  };

  // A store fake that only knows what the scheduler touches through the sink.
  const store = {
    selectedContainers: async () => selected,
    upsertContainers: async (_c: string, list: unknown[]) => void (upserted = list.length),
    upsertContainer: async (_c: string, one: unknown) => void upsertedOne.push(one),
    hasSelection: async () => hasSelection,
    upsertPrincipals: async (_c: string, list: unknown[]) => void (principals += list.length),
    storeBatch: async (_c: string, _container: unknown, batch: { documents: unknown[] }) => {
      stored += batch.documents.length;
      return { changed: batch.documents.length, deleted: 0 };
    },
    pruneMissing: async () => 0,
    markVisited: async () => undefined,
  };

  function scheduler(type: ConnectorType, overrides: Partial<KnowledgeSyncSchedulerOptions> = {}) {
    return new KnowledgeSyncScheduler({
      redisUrl: 'redis://unused:6379',
      registry: registry as never,
      store: store as never,
      buildContext: {} as never,
      budgetMs: 60_000,
      reconcileCron: '0 3 * * *',
      isAvailable: async () => available,
      resolveType: () => type,
      queueFactory: () => queue as never,
      ...overrides,
    });
  }

  beforeEach(() => {
    queue = new FakeQueue();
    runs = [];
    selected = [{ ...C1, checkpoint: null }];
    stored = 0;
    upserted = 0;
    principals = 0;
    available = true;
    hasSelection = true;
    upsertedOne = [];
  });

  it('schedules a poll and a reconcile job per enabled knowledge connector, and removes both on stop', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: { C1: [] } })),
    );
    await s.start(connectorCfg);
    expect([...queue.schedulers.keys()]).toEqual([
      'knowledge~fx-1~poll',
      'knowledge~fx-1~reconcile',
    ]);
    expect(queue.schedulers.get('knowledge~fx-1~poll')!.pattern).toBe('*/15 * * * *');
    expect(queue.schedulers.get('knowledge~fx-1~reconcile')!.pattern).toBe('0 3 * * *');
    await s.stop('fx-1');
    expect(queue.schedulers.size).toBe(0);
  });

  it('does not schedule a type without a knowledge facet, or a disabled connector', async () => {
    const graphOnly = {
      type: 'kubernetes',
      pollMode: 'full',
      sweepsAbsent: true,
      build: async () => ({ ok: false, code: 'x', message: 'x' }),
    } as unknown as ConnectorType;
    const s = scheduler(graphOnly);
    expect(s.handles(connectorCfg)).toBe(false);
    await s.start(connectorCfg);
    await scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    ).start({ ...connectorCfg, enabled: false } as ConnectorInstanceConfig);
    expect(queue.schedulers.size).toBe(0);
  });

  it('runs a poll through the harness and records a knowledge run', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [C1],
      documents: { C1: [docAt('2026-01-01T00:00:00Z'), docAt('2026-01-02T00:00:00Z')] },
    });
    const s = scheduler(fixtureType(connector));
    await s.runJob('fx-1', 'poll');
    expect(stored).toBe(2);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'success',
      entitiesSynced: 2,
      facet: 'knowledge',
      errors: [],
    });
    expect(s.getStatus('fx-1').state).toBe('idle');
  });

  it('backfills as far back as the type says for the instance, 365 days when it does not say', async () => {
    const days = async (type: ConnectorType, connector: KnowledgeConnector) => {
      await scheduler(type).runJob('fx-1', 'poll');
      return (connector as ReturnType<typeof createFixtureKnowledgeConnector>).calls
        .fetchOptions[0]!.historyDays;
    };
    const silent = createFixtureKnowledgeConnector({ containers: [C1], documents: { C1: [] } });
    expect(await days(fixtureType(silent), silent)).toBe(365);

    const told = createFixtureKnowledgeConnector({ containers: [C1], documents: { C1: [] } });
    const type = {
      ...fixtureType(told),
      knowledgeHistoryDays: () => 90,
    } as unknown as ConnectorType;
    expect(await days(type, told)).toBe(90);
  });

  it('records a failed run when the type cannot be built', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} }), true),
    );
    await s.runJob('fx-1', 'poll');
    expect(runs[0]).toMatchObject({ status: 'failed', facet: 'knowledge' });
    expect(runs[0]!.errors[0]).toContain('no token on file');
    expect(s.getStatus('fx-1')).toMatchObject({ state: 'failed' });
  });

  it('records a failed run when building the connector throws', async () => {
    const type = {
      type: 'fixture',
      pollMode: 'incremental',
      sweepsAbsent: false,
      buildKnowledge: async () => {
        throw new Error('secret store unreachable');
      },
    } as unknown as ConnectorType;
    const s = scheduler(type);
    await expect(s.runJob('fx-1', 'poll')).resolves.toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', facet: 'knowledge' });
    expect(runs[0]!.errors[0]).toContain('secret store unreachable');
    expect(s.getStatus('fx-1')).toMatchObject({ state: 'failed' });
  });

  it('records a failed run when the store is unreachable mid-run', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
      {
        store: {
          ...store,
          selectedContainers: async () => {
            throw new Error('connection terminated');
          },
        } as never,
      },
    );
    await s.runJob('fx-1', 'poll');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errors[0]).toContain('connection terminated');
    expect(s.getStatus('fx-1').state).toBe('failed');
  });

  it('puts connector notes on the run record without failing it', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [C1],
      documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
      fetchNotes: { C1: ['issues_permission_missing'] },
    });
    const s = scheduler(fixtureType(connector));
    await s.runJob('fx-1', 'poll');
    expect(runs[0]).toMatchObject({ status: 'success', notes: ['issues_permission_missing'] });
    expect(s.getStatus('fx-1').state).toBe('idle');
  });

  it('hands every run a signal that close() aborts', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [C1],
      documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
    });
    const s = scheduler(fixtureType(connector));
    await s.runJob('fx-1', 'poll');
    const signal = connector.calls.fetchOptions[0]!.signal!;
    expect(signal.aborted).toBe(false);
    await s.close();
    expect(signal.aborted).toBe(true);
  });

  it('marks degraded when authentication fails', async () => {
    const s = scheduler(
      fixtureType(
        createFixtureKnowledgeConnector({ containers: [C1], documents: {}, authError: 'revoked' }),
      ),
    );
    await s.runJob('fx-1', 'poll');
    expect(runs[0]!.status).toBe('failed');
    expect(s.getStatus('fx-1').state).toBe('degraded');
  });

  it('skips the run when the layer is unavailable, recording nothing', async () => {
    available = false;
    const s = scheduler(
      fixtureType(
        createFixtureKnowledgeConnector({
          containers: [C1],
          documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
        }),
      ),
    );
    await s.runJob('fx-1', 'poll');
    expect(stored).toBe(0);
    expect(runs).toHaveLength(0);
    expect(s.getStatus('fx-1').state).toBe('idle');
  });

  it('drops a job for a connector that no longer exists', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    );
    await expect(s.runJob('gone', 'poll')).resolves.toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it('serializes runs for the same connector so a reconcile cannot overlap a poll', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowStore = {
      ...store,
      selectedContainers: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return selected;
      },
    };
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: { C1: [] } })),
      { store: slowStore as never },
    );
    await Promise.all([s.runJob('fx-1', 'poll'), s.runJob('fx-1', 'reconcile')]);
    expect(maxInFlight).toBe(1);
    expect(runs).toHaveLength(2);
  });

  it('enqueues a one-shot job on trigger and reports running', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    );
    const status = await s.trigger(connectorCfg, 'reconcile');
    expect(status.state).toBe('running');
    expect(queue.added[0]).toMatchObject({
      name: 'knowledge-manual',
      data: { connectorId: 'fx-1', mode: 'reconcile' },
    });
    expect(String((queue.added[0]!.opts as { jobId: string }).jobId)).toMatch(
      /^knowledge~fx-1~manual~\d+$/,
    );
  });

  it('does not schedule an instance whose type says knowledge is off for it', async () => {
    const type = {
      ...fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
      knowledgeEnabled: () => false,
    } as unknown as ConnectorType;
    const s = scheduler(type);
    expect(s.handles(connectorCfg)).toBe(false);
    await s.start(connectorCfg);
    expect(queue.schedulers.size).toBe(0);
  });

  it('drops a queued job for an instance that switched knowledge off', async () => {
    const type = {
      ...fixtureType(
        createFixtureKnowledgeConnector({
          containers: [C1],
          documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
        }),
      ),
      knowledgeEnabled: () => false,
    } as unknown as ConnectorType;
    const s = scheduler(type);
    await s.runJob('fx-1', 'poll');
    expect(stored).toBe(0);
    expect(runs).toHaveLength(0);
  });

  it('refreshContainers lists the source and stores the list', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    );
    expect(await s.refreshContainers('fx-1')).toBe(1);
    expect(upserted).toBe(1);
  });

  it('refreshContainers also loads the people, so the first documents find their authors', async () => {
    const s = scheduler(
      fixtureType(
        createFixtureKnowledgeConnector({
          containers: [C1],
          documents: {},
          principals: [
            { externalId: 'U1', kind: 'user', displayName: 'Ada', active: true },
            { externalId: 'U2', kind: 'user', displayName: 'Bob', active: true },
          ],
        }),
      ),
    );
    expect(await s.refreshContainers('fx-1')).toBe(1);
    expect(principals).toBe(2);
  });

  // Names, emails and logins are held only for a connector that has something
  // selected. A refresh made before the first selection lists repositories only.
  it('refreshContainers does not load the people while nothing is selected', async () => {
    hasSelection = false;
    const connector = createFixtureKnowledgeConnector({
      containers: [C1],
      documents: {},
      principals: [{ externalId: 'U1', kind: 'user', displayName: 'Ada', active: true }],
    });
    const s = scheduler(fixtureType(connector));
    expect(await s.refreshContainers('fx-1')).toBe(1);
    expect(principals).toBe(0);
    expect(connector.calls.listPrincipalsOptions).toEqual([]);
  });

  // The refresh runs inside an HTTP request. Without a deadline the connector
  // would sleep through a rate limit for as long as the source says.
  it('refreshContainers gives the listings a short deadline and the shutdown signal', async () => {
    const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
    const s = scheduler(fixtureType(connector));
    const before = Date.now();
    await s.refreshContainers('fx-1');
    for (const options of [
      connector.calls.listContainersOptions[0],
      connector.calls.listPrincipalsOptions[0],
    ]) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.deadline).toBeGreaterThan(before);
      expect(options?.deadline).toBeLessThanOrEqual(Date.now() + 20_000);
    }
  });

  it('refreshContainers says RATE_LIMITED when the source asks to wait past the deadline', async () => {
    const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
    connector.listContainers = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new KnowledgeRunCutShort('rate_limited');
        },
      }),
    });
    await expect(scheduler(fixtureType(connector)).refreshContainers('fx-1')).rejects.toMatchObject(
      { code: 'RATE_LIMITED' },
    );
    expect(upserted).toBe(0);
  });

  describe('refreshContainer', () => {
    const row = { externalId: 'C1', name: 'general' };

    it('asks the source about the one container and stores what it says', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      const asked: unknown[] = [];
      connector.getContainer = async (container, options) => {
        asked.push({ container, options });
        return { ...C1, visibility: 'restricted' };
      };
      const s = scheduler(fixtureType(connector));
      expect(await s.refreshContainer('fx-1', row)).toBe(true);
      expect(upsertedOne).toEqual([{ ...C1, visibility: 'restricted' }]);
      expect(asked).toEqual([
        {
          container: row,
          options: { deadline: expect.any(Number), signal: expect.any(AbortSignal) },
        },
      ]);
      // One request, not a listing of the whole source.
      expect(connector.calls.listContainersOptions).toEqual([]);
      expect(connector.calls.listPrincipalsOptions).toEqual([]);
    });

    it('says when the source no longer has the container, and stores nothing', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      connector.getContainer = async () => null;
      expect(await scheduler(fixtureType(connector)).refreshContainer('fx-1', row)).toBe(false);
      expect(upsertedOne).toEqual([]);
    });

    it('lists the whole source, without the people, for a connector that cannot answer for one', async () => {
      const connector = createFixtureKnowledgeConnector({
        containers: [C1],
        documents: {},
        principals: [{ externalId: 'U1', kind: 'user', displayName: 'Ada', active: true }],
      });
      expect(await scheduler(fixtureType(connector)).refreshContainer('fx-1', row)).toBe(true);
      expect(upserted).toBe(1);
      expect(principals).toBe(0);
    });

    it('says RATE_LIMITED when the source asks to wait past the deadline', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      connector.getContainer = async () => {
        throw new KnowledgeRunCutShort('rate_limited');
      };
      await expect(
        scheduler(fixtureType(connector)).refreshContainer('fx-1', row),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('says why it cannot ask', async () => {
      const revoked = fixtureType(
        createFixtureKnowledgeConnector({ containers: [C1], documents: {}, authError: 'revoked' }),
      );
      await expect(scheduler(revoked).refreshContainer('fx-1', row)).rejects.toMatchObject({
        code: 'AUTH_FAILED',
      });
    });
  });

  it('refreshContainers still answers when the people cannot be listed', async () => {
    const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
    connector.listPrincipals = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('members: 403');
        },
      }),
    });
    const s = scheduler(fixtureType(connector));
    expect(await s.refreshContainers('fx-1')).toBe(1);
    expect(upserted).toBe(1);
  });

  it('refreshContainers says why it cannot run', async () => {
    const off = {
      ...fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
      knowledgeEnabled: () => false,
    } as unknown as ConnectorType;
    await expect(scheduler(off).refreshContainers('fx-1')).rejects.toMatchObject({
      code: 'KNOWLEDGE_NOT_ENABLED',
    });
    const noToken = fixtureType(
      createFixtureKnowledgeConnector({ containers: [C1], documents: {} }),
      true,
    );
    await expect(scheduler(noToken).refreshContainers('fx-1')).rejects.toMatchObject({
      code: 'NO_TOKEN',
    });
    const revoked = fixtureType(
      createFixtureKnowledgeConnector({ containers: [C1], documents: {}, authError: 'revoked' }),
    );
    await expect(scheduler(revoked).refreshContainers('fx-1')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
