import { describe, it, expect } from 'vitest';
import { KnowledgeHarness } from '../harness.js';
import { createFixtureKnowledgeConnector, type FixtureSeed } from '../fixture.js';
import type {
  ChangeBatch,
  KnowledgeRunMode,
  KnowledgeSink,
  PruneOptions,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '../types.js';

// A sink that remembers everything in memory, the way the tests want to read it.
class MemorySink implements KnowledgeSink {
  containers = new Map<string, SelectedContainer>();
  principals: SourcePrincipal[] = [];
  stored: Array<{ container: string; batch: ChangeBatch }> = [];
  pruned: Array<{ container: string; presentIds: string[]; options?: PruneOptions }> = [];
  visited: Array<{ container: string; mode: KnowledgeRunMode }> = [];
  selectedModes: Array<KnowledgeRunMode | undefined> = [];
  failSelected: Error | null = null;
  docs = new Map<string, Set<string>>(); // container → external ids present
  failStoreOn: string | null = null; // container externalId whose storeBatch throws

  select(container: SourceContainer, checkpoint: string | null = null): void {
    this.containers.set(container.externalId, { ...container, checkpoint });
  }
  async upsertContainers(containers: SourceContainer[]): Promise<void> {
    const seen = new Set(containers.map((c) => c.externalId));
    for (const c of containers) {
      const existing = this.containers.get(c.externalId);
      this.containers.set(c.externalId, { ...c, checkpoint: existing?.checkpoint ?? null });
    }
    for (const id of [...this.containers.keys()]) if (!seen.has(id)) this.containers.delete(id);
  }
  async upsertPrincipals(principals: SourcePrincipal[]): Promise<void> {
    this.principals.push(...principals);
  }
  async selectedContainers(mode?: KnowledgeRunMode): Promise<SelectedContainer[]> {
    if (this.failSelected) throw this.failSelected;
    this.selectedModes.push(mode);
    return [...this.containers.values()];
  }
  async markVisited(container: SelectedContainer, mode: KnowledgeRunMode): Promise<void> {
    this.visited.push({ container: container.externalId, mode });
  }
  async storeBatch(container: SelectedContainer, batch: ChangeBatch) {
    if (this.failStoreOn === container.externalId) throw new Error('disk full');
    this.stored.push({ container: container.externalId, batch });
    const ids = this.docs.get(container.externalId) ?? new Set<string>();
    for (const d of batch.documents) ids.add(d.externalId);
    for (const d of batch.deletedExternalIds) ids.delete(d);
    this.docs.set(container.externalId, ids);
    const current = this.containers.get(container.externalId)!;
    if (batch.checkpoint !== null) {
      this.containers.set(container.externalId, { ...current, checkpoint: batch.checkpoint });
    }
    return { changed: batch.documents.length, deleted: batch.deletedExternalIds.length };
  }
  async pruneMissing(
    container: SelectedContainer,
    presentIds: string[],
    options?: PruneOptions,
  ): Promise<number> {
    this.pruned.push({ container: container.externalId, presentIds, options });
    const ids = this.docs.get(container.externalId) ?? new Set<string>();
    let n = 0;
    for (const id of [...ids]) {
      if (!presentIds.includes(id)) {
        ids.delete(id);
        n++;
      }
    }
    return n;
  }
}

const config = { id: 'fx-1', type: 'fixture', credentials: {}, scope: {} };

function seed(): FixtureSeed {
  return {
    containers: [
      { externalId: 'C1', kind: 'channel', name: 'general', visibility: 'open', archived: false },
      { externalId: 'C2', kind: 'channel', name: 'ops', visibility: 'open', archived: false },
    ],
    principals: [
      {
        externalId: 'U1',
        kind: 'user',
        displayName: 'Ada',
        email: 'ada@example.com',
        active: true,
      },
    ],
    documents: {
      C1: [
        doc('C1', 'd1', '2026-01-01T00:00:00Z'),
        doc('C1', 'd2', '2026-01-02T00:00:00Z'),
        doc('C1', 'd3', '2026-01-03T00:00:00Z'),
      ],
      C2: [doc('C2', 'e1', '2026-01-01T00:00:00Z')],
    },
    batchSize: 2,
  };
}

function doc(container: string, id: string, at: string) {
  return {
    externalId: `${container}/${id}`,
    kind: 'slack_thread' as const,
    title: id,
    url: `https://example.test/${container}/${id}`,
    segments: [{ key: 'm1', text: `hello from ${id}`, at }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    participantExternalIds: ['U1'],
    attributes: {},
    restricted: false,
  };
}

function harness(
  connector: ReturnType<typeof createFixtureKnowledgeConnector>,
  sink: KnowledgeSink,
  budgetMs = 60_000,
  now?: () => number,
) {
  return new KnowledgeHarness(connector, sink, config, { historyDays: 365, budgetMs, now });
}

describe('KnowledgeHarness poll', () => {
  it('stores every batch of every selected container and reports success', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('success');
    expect(result.documentsSynced).toBe(4);
    expect(result.containersProcessed).toBe(2);
    // C1 has 3 docs at batch size 2 → 2 batches; C2 → 1 batch.
    expect(sink.stored.map((s) => s.container)).toEqual(['C1', 'C1', 'C2']);
  });

  it('resumes from the stored checkpoint instead of refetching', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    // Pretend the first batch of C1 (d1, d2) was stored by an earlier, interrupted run.
    sink.select(seed().containers[0]!, '2026-01-02T00:00:00Z');

    const result = await harness(connector, sink).run('poll');

    expect(result.documentsSynced).toBe(1);
    expect(sink.stored[0]!.batch.documents.map((d) => d.externalId)).toEqual(['C1/d3']);
  });

  it('stops when the time budget is spent and says so', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    let t = 0;
    const clock = () => (t += 40_000); // every look at the clock costs 40 s

    const result = await harness(connector, sink, 50_000, clock).run('poll');

    expect(result.budgetExhausted).toBe(true);
    expect(result.status).toBe('success'); // nothing failed; the next run continues
    expect(sink.stored.length).toBeLessThan(3);

    // The next run picks up from the committed checkpoint and fetches the rest.
    const second = await harness(connector, sink).run('poll');
    expect(second.budgetExhausted).toBe(false);
    const ids = sink.stored.flatMap((s) => s.batch.documents.map((d) => d.externalId));
    expect([...ids].sort()).toEqual(['C1/d1', 'C1/d2', 'C1/d3', 'C2/e1']);
    expect(new Set(ids).size).toBe(ids.length); // nothing fetched twice
  });

  it('marks every finished container visited, with or without changes', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    await harness(connector, sink).run('poll');
    sink.visited = [];

    await harness(connector, sink).run('poll'); // nothing new upstream: no batch is stored

    expect(sink.selectedModes).toEqual(['poll', 'poll']);
    expect(sink.visited).toEqual([
      { container: 'C1', mode: 'poll' },
      { container: 'C2', mode: 'poll' },
    ]);
  });

  it('carries batch notes to the result without failing the run', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      fetchNotes: { C1: ['issues_permission_missing'] },
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('success');
    expect(result.authFailed).toBe(false);
    expect(result.notes).toEqual(['issues_permission_missing']); // once, not once per batch
  });

  it('hands the connector the run deadline and the abort signal', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    const controller = new AbortController();

    await new KnowledgeHarness(connector, sink, config, {
      historyDays: 365,
      budgetMs: 60_000,
      now: () => 1_000,
      signal: controller.signal,
    }).run('poll');

    expect(connector.calls.fetchOptions[0]).toMatchObject({ deadline: 61_000 });
    expect(connector.calls.fetchOptions[0]!.signal).toBe(controller.signal);
  });

  it('stops between batches once the signal is aborted', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    const controller = new AbortController();
    const original = sink.storeBatch.bind(sink);
    sink.storeBatch = async (container, batch) => {
      const stored = await original(container, batch);
      controller.abort();
      return stored;
    };

    const result = await new KnowledgeHarness(connector, sink, config, {
      historyDays: 365,
      budgetMs: 60_000,
      signal: controller.signal,
    }).run('poll');

    expect(sink.stored).toHaveLength(1);
    expect(result.budgetExhausted).toBe(true);
    expect(sink.visited).toEqual([]); // C1 was not finished
  });

  it('reports a failed run instead of throwing when the sink cannot list containers', async () => {
    const sink = new MemorySink();
    sink.failSelected = new Error('connection refused');
    const connector = createFixtureKnowledgeConnector(seed());

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('failed');
    expect(result.errors[0]).toContain('connection refused');
  });

  it('survives a connector that throws a non-error value', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      fetchErrors: { C1: null as unknown as Error },
    });
    connector.fetchChanges = async function* (container) {
      if (container.externalId === 'C1') throw null;
      yield { documents: [], deletedExternalIds: [], checkpoint: null };
    };
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('partial');
    expect(result.errors[0]).toContain('C1');
  });

  it('isolates a failing container and reports partial', async () => {
    const sink = new MemorySink();
    sink.failStoreOn = 'C1';
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('partial');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('C1');
    expect(sink.stored.map((s) => s.container)).toEqual(['C2']);
  });

  it('reports failed with authFailed when authentication is refused', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({ ...seed(), authError: 'token revoked' });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('failed');
    expect(result.authFailed).toBe(true);
    expect(sink.stored).toHaveLength(0);
  });

  it('marks authFailed when a fetch answers 403 and keeps the other containers', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      fetchErrors: { C1: Object.assign(new Error('forbidden'), { status: 403 }) },
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.authFailed).toBe(true);
    expect(result.status).toBe('partial');
    expect(sink.stored.map((s) => s.container)).toEqual(['C2']);
  });
});

describe('KnowledgeHarness reconcile', () => {
  it('refreshes containers and principals, then prunes by the id listing', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    await harness(connector, sink).run('poll');
    // Upstream deleted C1/d2 after the poll.
    connector.deleteDocument('C1', 'C1/d2');

    const result = await harness(connector, sink).run('reconcile');

    expect(result.status).toBe('success');
    expect(sink.principals.map((p) => p.externalId)).toEqual(['U1']);
    expect(sink.pruned.find((p) => p.container === 'C1')!.presentIds).toEqual(['C1/d1', 'C1/d3']);
    expect(result.documentsDeleted).toBe(1);
    expect(sink.selectedModes.at(-1)).toBe('reconcile');
    expect(sink.visited.filter((v) => v.mode === 'reconcile').map((v) => v.container)).toEqual([
      'C1',
      'C2',
    ]);
  });

  it('refreshes the container list before reading the selection', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());

    await harness(connector, sink).run('reconcile');

    expect([...sink.containers.keys()]).toEqual(['C1', 'C2']);
  });

  it('scopes the prune to the time the listing started', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    sink.select(seed().containers[0]!);

    await harness(connector, sink, 60_000, () => Date.parse('2026-02-01T00:00:00Z')).run(
      'reconcile',
    );

    expect(sink.pruned[0]!.options).toEqual({ listedAt: '2026-02-01T00:00:00.000Z' });
  });

  it('prunes only the kinds the listing covers', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      prunableKinds: ['github_issue'],
    });
    sink.select(seed().containers[0]!);

    await harness(connector, sink).run('reconcile');

    expect(sink.pruned[0]!.options).toMatchObject({ kinds: ['github_issue'] });
  });

  it('never lists or prunes when the connector covers no kind', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({ ...seed(), prunableKinds: [] });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('reconcile');

    expect(result.status).toBe('success');
    expect(connector.calls.listDocumentIds).toBe(0);
    expect(sink.pruned).toEqual([]);
  });

  it('abandons a listing that outlives the budget without pruning', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed()); // C1 lists in two pages
    sink.select(seed().containers[0]!);
    let t = 0;
    const clock = () => (t += 20_000);

    const result = await harness(connector, sink, 70_000, clock).run('reconcile');

    expect(result.budgetExhausted).toBe(true);
    expect(sink.pruned).toEqual([]);
    expect(sink.visited).toEqual([]);
  });

  it('does not prune when the id listing throws after its first page', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      listIdErrors: { C1: new Error('rate limited') },
    });
    for (const c of seed().containers) sink.select(c);
    await harness(connector, sink).run('poll');

    const result = await harness(connector, sink).run('reconcile');

    expect(result.status).toBe('partial');
    expect(connector.calls.listedPages.C1).toBe(1); // one page arrived before the failure
    expect(sink.pruned.map((p) => p.container)).toEqual(['C2']);
    expect(sink.docs.get('C1')!.size).toBe(3);
  });

  it('keeps the container list when listing containers throws midway', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      listContainersError: new Error('boom'),
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('reconcile');

    expect(result.errors[0]).toContain('boom');
    expect([...sink.containers.keys()]).toEqual(['C1', 'C2']);
  });

  it('reconcile batches never move the poll checkpoint', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      reconcileBatches: {
        C1: [
          {
            documents: [doc('C1', 'd9', '2026-01-09T00:00:00Z')],
            deletedExternalIds: [],
            checkpoint: 'rescan-cursor',
          },
        ],
      },
    });
    sink.select(seed().containers[0]!, 'poll-cursor');

    await harness(connector, sink).run('reconcile');

    const stored = sink.stored.find((s) => s.batch.documents[0]?.externalId === 'C1/d9')!;
    expect(stored.batch.checkpoint).toBeNull();
    expect(sink.containers.get('C1')!.checkpoint).toBe('poll-cursor');
  });

  it('runs the connector reconcile hook when present', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      reconcileBatches: {
        C1: [
          {
            documents: [doc('C1', 'd9', '2026-01-09T00:00:00Z')],
            deletedExternalIds: [],
            checkpoint: 'kept',
          },
        ],
      },
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('reconcile');

    expect(result.documentsSynced).toBe(1);
    expect(sink.stored.some((s) => s.batch.documents[0]?.externalId === 'C1/d9')).toBe(true);
  });
});
