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
  let lives: Array<[string, string]>;
  let lifeError: Error | null;
  // What beginConnectorLife answers: the rows an earlier connector left.
  let lifeCleared: number | null;
  let logged: string[];

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
    beginConnectorLife: async (id: string, bornAt: string) => {
      if (lifeError) throw lifeError;
      lives.push([id, bornAt]);
      return lifeCleared;
    },
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
      log: (line) => void logged.push(line),
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
    lives = [];
    lifeError = null;
    lifeCleared = 0;
    logged = [];
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

  // A connector id can be used again, and a connector deleted while the
  // knowledge layer was off left its rows behind. Before a connector touches
  // the store for the first time, whatever an earlier one with its id left is
  // cleared; the store tells the two apart by the connector's creation time.
  describe('a connector id that is used again', () => {
    const born = { ...connectorCfg, createdAt: '2026-10-05T00:00:00.000Z' };
    const bornRegistry = { ...registry, get: () => born, list: () => [born] } as never;
    const fixture = () =>
      createFixtureKnowledgeConnector({
        containers: [C1],
        documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
      });

    it('is checked before the connector’s first run, once', async () => {
      const s = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await s.runJob('fx-1', 'poll');
      await s.runJob('fx-1', 'poll');
      expect(lives).toEqual([['fx-1', '2026-10-05T00:00:00.000Z']]);
    });

    it('is checked before a refresh made from the API too', async () => {
      const s = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await s.refreshContainers('fx-1');
      expect(lives).toEqual([['fx-1', '2026-10-05T00:00:00.000Z']]);
    });

    // The picker reads and changes the connector's rows without a run or a
    // call to the source: it asks for the check itself.
    it('is checked for a route about to show or change the connector’s containers', async () => {
      const s = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await s.checkLife('fx-1');
      await s.checkLife('fx-1');
      await s.runJob('fx-1', 'poll');
      expect(lives).toEqual([['fx-1', '2026-10-05T00:00:00.000Z']]);

      lifeError = new Error('connection refused');
      const down = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await expect(down.checkLife('fx-1')).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });
    });

    it('says in the log when it cleared what an earlier connector left', async () => {
      lifeCleared = 3;
      const s = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await s.checkLife('fx-1');
      expect(logged.filter((line) => line.includes('fx-1'))).toEqual([
        expect.stringMatching(/cleared 3 rows/),
      ]);

      logged = [];
      lifeCleared = 0; // a new id, or one whose rows went with the delete
      await scheduler(fixtureType(fixture()), { registry: bornRegistry }).checkLife('fx-1');
      lifeCleared = null; // a connector the store already knows
      await scheduler(fixtureType(fixture()), { registry: bornRegistry }).checkLife('fx-1');
      expect(logged).toEqual([]);
    });

    // A delete clears the connector's rows and the record of its life. One
    // that then failed leaves a connector the store no longer knows: it is
    // checked again, which records it again, instead of the first run after a
    // restart finding no record and clearing what was selected since.
    it('is checked again once a delete of the connector was attempted', async () => {
      const s = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await s.runJob('fx-1', 'poll');
      await s.retire('fx-1');
      s.unretire('fx-1');
      await s.runJob('fx-1', 'poll');
      expect(lives).toHaveLength(2);
    });

    it('is not checked while the connector is being deleted', async () => {
      const s = scheduler(fixtureType(fixture()), { registry: bornRegistry });
      await s.retire('fx-1');
      await s.checkLife('fx-1');
      expect(lives).toEqual([]);
    });

    it('is not checked for a connector that has no creation time on record', async () => {
      await scheduler(fixtureType(fixture())).runJob('fx-1', 'poll');
      expect(lives).toEqual([]);
      expect(stored).toBe(1);
    });

    it('fetches nothing while the check cannot be made, and tries again on the next run', async () => {
      lifeError = new Error('connection refused');
      const connector = fixture();
      const s = scheduler(fixtureType(connector), { registry: bornRegistry });
      await s.runJob('fx-1', 'poll');
      expect(stored).toBe(0);
      expect(connector.calls.fetchChanges).toEqual([]);
      expect(runs).toEqual([
        expect.objectContaining({ status: 'failed', errors: ['connection refused'] }),
      ]);
      await expect(s.refreshContainers('fx-1')).rejects.toMatchObject({
        code: 'KNOWLEDGE_UNAVAILABLE',
      });

      lifeError = null;
      await s.runJob('fx-1', 'poll');
      expect(stored).toBe(1);
    });
  });

  // DELETE /api/connectors/:id records the purge of what the connector
  // indexed. A run still fetching would write more after it.
  describe('a connector that is being deleted', () => {
    it('has its run in flight stopped, and gets no new one until the delete is over', async () => {
      const connector = createFixtureKnowledgeConnector({
        containers: [C1],
        documents: { C1: [] },
      });
      let fetching: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (fetching = resolve));
      let aborted = false;
      connector.fetchChanges = (_container, _checkpoint, options) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise((_resolve, reject) => {
              fetching();
              options.signal?.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('This operation was aborted'));
              });
            }),
        }),
      });
      const s = scheduler(fixtureType(connector));
      const run = s.runJob('fx-1', 'poll');
      await started;

      await s.retire('fx-1'); // resolves once the run has ended
      expect(aborted).toBe(true);
      await run;

      const quiet = createFixtureKnowledgeConnector({
        containers: [C1],
        documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
      });
      const again = scheduler(fixtureType(quiet));
      await again.retire('fx-1');
      await again.runJob('fx-1', 'poll');
      expect(quiet.calls.fetchChanges).toEqual([]);
      await expect(again.refreshContainers('fx-1')).rejects.toMatchObject({
        code: 'CONNECTOR_BEING_DELETED',
      });

      // The delete failed after all: the connector works again.
      again.unretire('fx-1');
      await again.runJob('fx-1', 'poll');
      expect(stored).toBe(1);
    });
  });

  // Between the moment a run is let through and the moment it fetches there
  // is a question to the status gate. A delete that begins then must still
  // find the run: one it could not stop would fetch for the whole time budget
  // while the delete, and every later change to the connector, waited.
  it('does not let a run fetch whose connector’s delete began while it was starting', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [C1],
      documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
    });
    let asked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    let open: (ok: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => (open = resolve));
    const s = scheduler(fixtureType(connector), {
      isAvailable: () => {
        asked();
        return gate;
      },
    });
    const run = s.runJob('fx-1', 'poll');
    await reached;

    const retired = s.retire('fx-1');
    open(true);
    await retired;
    await run;
    expect(connector.calls.fetchChanges).toEqual([]);
    expect(stored).toBe(0);
    expect(runs).toEqual([]);
  });

  // A refresh made from the API is not a run. It is tracked while it lasts, so
  // that a delete stops it and waits for it: one left to itself would store
  // what the source answered after the delete had cleared the connector and
  // let its id go, under an id no route can reach.
  describe('a refresh in flight when the connector’s delete begins', () => {
    // A source that takes no notice of the signal it is given, and answers
    // only when `answer` is called.
    function slowSource() {
      let reached: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (reached = resolve));
      let answer: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (answer = resolve));
      const wait = async (): Promise<void> => {
        reached();
        await released;
      };
      return { started, wait, answer: () => answer() };
    }
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    it('is stopped: the source is told, and the delete does not wait for a slow answer', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      let listing: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (listing = resolve));
      let told = false;
      connector.listContainers = (options) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise((_resolve, reject) => {
              listing();
              options?.signal?.addEventListener('abort', () => {
                told = true;
                reject(new Error('This operation was aborted'));
              });
            }),
        }),
      });
      const s = scheduler(fixtureType(connector));
      const refresh = s.refreshContainers('fx-1').catch((err: unknown) => err);
      await started;

      await s.retire('fx-1');
      expect(told).toBe(true);
      expect(await refresh).toMatchObject({ code: 'CONNECTOR_BEING_DELETED' });
      expect(upserted).toBe(0);
    });

    it('stores no list, even when the source answers once the delete is over', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      const source = slowSource();
      connector.listContainers = async function* () {
        await source.wait();
        yield C1;
      };
      const s = scheduler(fixtureType(connector));
      const refresh = s.refreshContainers('fx-1').catch((err: unknown) => err);
      await source.started;

      await s.retire('fx-1'); // the delete begins,
      s.unretire('fx-1'); // and is over
      source.answer();
      expect(await refresh).toMatchObject({ code: 'CONNECTOR_BEING_DELETED' });
      await settle();
      expect(upserted).toBe(0);
    });

    it('stores no single container either', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      const source = slowSource();
      connector.getContainer = async () => {
        await source.wait();
        return { ...C1 };
      };
      const s = scheduler(fixtureType(connector));
      const refresh = s
        .refreshContainer('fx-1', { externalId: 'C1', name: 'general' })
        .catch((err: unknown) => err);
      await source.started;

      await s.retire('fx-1');
      s.unretire('fx-1');
      source.answer();
      expect(await refresh).toMatchObject({ code: 'CONNECTOR_BEING_DELETED' });
      await settle();
      expect(upsertedOne).toEqual([]);
    });

    // The list was stored before the delete began, and the delete clears it.
    // The people still being listed are not stored after it.
    it('stores no people either', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      const source = slowSource();
      connector.listPrincipals = async function* () {
        await source.wait();
        yield { externalId: 'U1', kind: 'user', displayName: 'Ada', active: true };
      };
      const s = scheduler(fixtureType(connector));
      const refresh = s.refreshContainers('fx-1');
      await source.started;

      await s.retire('fx-1');
      s.unretire('fx-1');
      source.answer();
      expect(await refresh).toBe(1);
      await settle();
      expect(principals).toBe(0);
    });

    it('leaves the refreshes of other connectors alone', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      const source = slowSource();
      connector.listContainers = async function* () {
        await source.wait();
        yield C1;
      };
      const s = scheduler(fixtureType(connector));
      const refresh = s.refreshContainers('fx-1');
      await source.started;

      await s.retire('another');
      source.answer();
      expect(await refresh).toBe(1);
      expect(upserted).toBe(1);
    });
  });

  // A refresh is refused at its start, and again before it stores what the
  // source answered: the delete may have begun while the source was asked.
  it('does not store what a source answered after the connector’s delete began', async () => {
    const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
    const holder: { scheduler?: KnowledgeSyncScheduler } = {};
    const list = connector.listContainers.bind(connector);
    connector.listContainers = (options) => {
      void holder.scheduler!.retire('fx-1');
      return list(options);
    };
    const lookup: KnowledgeConnector['getContainer'] = async () => {
      void holder.scheduler!.retire('fx-1');
      return { ...C1 };
    };
    holder.scheduler = scheduler(fixtureType(connector));
    await expect(holder.scheduler.refreshContainers('fx-1')).rejects.toMatchObject({
      code: 'CONNECTOR_BEING_DELETED',
    });
    expect(upserted).toBe(0);

    holder.scheduler.unretire('fx-1');
    connector.getContainer = lookup;
    await expect(
      holder.scheduler.refreshContainer('fx-1', { externalId: 'C1', name: 'general' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_BEING_DELETED' });
    expect(upsertedOne).toEqual([]);
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

  // The deadline bounds a wait the source asks for. A source that simply
  // does not answer is cut off too, later.
  it('refreshContainers gives up on a source that does not answer', async () => {
    const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
    connector.listContainers = (options) => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('This operation was aborted')),
            );
          }),
      }),
    });
    const s = scheduler(fixtureType(connector), { refreshTimeoutMs: 30 });
    await expect(s.refreshContainers('fx-1')).rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' });
    expect(upserted).toBe(0);
  });

  // The time allowed is for the whole refresh. A source that does not answer
  // when asked who is calling holds the request as surely as a listing does.
  it(
    'refreshContainers gives up on a source that does not answer while authenticating',
    { timeout: 2_000 },
    async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      connector.authenticate = () => new Promise(() => undefined);
      const s = scheduler(fixtureType(connector), { refreshTimeoutMs: 30 });
      await expect(s.refreshContainers('fx-1')).rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' });
      expect(upserted).toBe(0);
    },
  );

  describe('refreshContainer', () => {
    const row = { externalId: 'C1', name: 'general' };

    it('says the container is gone when a connector that lists everything no longer lists it', async () => {
      const connector = createFixtureKnowledgeConnector({ containers: [C1], documents: {} });
      const s = scheduler(fixtureType(connector));
      expect(await s.refreshContainer('fx-1', { externalId: 'C9', name: 'archive' })).toBe(false);
      expect(upserted).toBe(1); // the list was still stored
    });

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
