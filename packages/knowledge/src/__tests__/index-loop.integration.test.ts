import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { KnowledgeHarness, createFixtureKnowledgeConnector } from '@shipit-ai/connector-sdk';
import { DATABASE_TEST_URL, createMigratedTestDatabase, type TestDatabase } from './test-db.js';
import { KnowledgeStore } from '../store.js';
import { PostgresKnowledgeSink } from '../sink.js';
import { FakeEmbedder, type Embedder } from '../embedder.js';
import { IndexLoop } from '../index-loop.js';
import { INDEX_VERSION } from '../schema-version.js';
import { toPgVector } from '../vector.js';

const config = { id: 'fx-1', type: 'fixture', credentials: {}, scope: {} };
const container = {
  externalId: 'C1',
  kind: 'channel' as const,
  name: 'general',
  visibility: 'open' as const,
  archived: false,
};

function doc(id: string, text: string, at: string) {
  return {
    externalId: id,
    kind: 'slack_thread' as const,
    title: id,
    url: `https://e/${id}`,
    segments: [{ key: '1', authorName: 'Ada', at, text }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    participantExternalIds: [],
    attributes: {},
    restricted: false,
  };
}

describe.skipIf(!DATABASE_TEST_URL)('harness → sink → loop end to end', () => {
  let database: TestDatabase;
  let store: KnowledgeStore;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = new KnowledgeStore(database.db);
  });
  afterAll(async () => {
    await database?.drop();
  });
  beforeEach(async () => {
    await database.db.query(
      'TRUNCATE knowledge_chunks, knowledge_documents, knowledge_principals, knowledge_containers',
    );
  });

  function loopWith(embedder: Embedder, log: string[] = []) {
    return new IndexLoop({
      store,
      pipeline: {
        store,
        embedder,
        chunking: { chunkTokens: 600, maxChunkTokens: 800 },
        indexVersion: INDEX_VERSION,
        containerNameOf: async () => 'general',
      },
      batchSize: 16,
      concurrency: 4,
      log: (l) => log.push(l),
    });
  }

  it('indexes everything the harness stored and makes it searchable', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [container],
      documents: {
        C1: [
          doc('t1', 'payments api outage postmortem', '2026-01-01T00:00:00Z'),
          doc('t2', 'lunch menu for friday', '2026-01-02T00:00:00Z'),
        ],
      },
    });
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    const run = await new KnowledgeHarness(connector, sink, config, {
      historyDays: 0,
      budgetMs: 60_000,
    }).run('poll');
    expect(run.status).toBe('success');

    const embedder = new FakeEmbedder(768);
    const stats = await loopWith(embedder).runOnce();
    expect(stats).toEqual({
      claimed: 2,
      indexed: 2,
      unchanged: 0,
      skipped: 0,
      superseded: 0,
      failed: 0,
    });
    expect(await store.countsByIndexStatus()).toEqual({ indexed: 2 });

    const q = toPgVector(await embedder.embedQuery('payments api outage'));
    const { rows } = await database.db.query<{ external_id: string }>(
      `SELECT d.external_id FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        ORDER BY c.embedding <=> $1::halfvec LIMIT 1`,
      [q],
    );
    expect(rows[0]!.external_id).toBe('t1');

    // Nothing left to claim; a second pass is a no-op.
    expect((await loopWith(embedder).runOnce()).claimed).toBe(0);
  });

  it('a failing document does not stop the batch, and is retried later', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [container],
      documents: {
        C1: [
          doc('ok', 'fine', '2026-01-01T00:00:00Z'),
          doc('bad', 'EXPLODE', '2026-01-02T00:00:00Z'),
        ],
      },
    });
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    await new KnowledgeHarness(connector, sink, config, { historyDays: 0, budgetMs: 60_000 }).run(
      'poll',
    );

    const flaky: Embedder = {
      model: 'flaky',
      dimensions: 768,
      async embedDocuments(texts) {
        if (texts.some((t) => t.includes('EXPLODE'))) {
          throw Object.assign(new Error('bad request'), { status: 400 });
        }
        return new FakeEmbedder(768).embedDocuments(texts);
      },
      async embedQuery(text) {
        return new FakeEmbedder(768).embedQuery(text);
      },
    };
    const log: string[] = [];
    const stats = await loopWith(flaky, log).runOnce();
    expect(stats.indexed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(log[0]).toContain('bad');
    expect(await store.countsByIndexStatus()).toEqual({ indexed: 1, failed: 1 });

    // Within the backoff: nothing is reclaimed.
    expect((await loopWith(flaky).runOnce()).claimed).toBe(0);
    // After it: the failed one comes back.
    await database.db.query(
      `UPDATE knowledge_documents SET index_claimed_at = now() - interval '1 day' WHERE index_status = 'failed'`,
    );
    expect((await loopWith(flaky).runOnce()).claimed).toBe(1);
  });

  it('an edited document is re-indexed with one embedding call for the changed chunk', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [container],
      documents: { C1: [doc('t1', 'first version', '2026-01-01T00:00:00Z')] },
    });
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    const harness = new KnowledgeHarness(connector, sink, config, {
      historyDays: 0,
      budgetMs: 60_000,
    });
    await harness.run('poll');
    const embedder = new FakeEmbedder(768);
    await loopWith(embedder).runOnce();

    connector.putDocument('C1', doc('t1', 'second version', '2026-01-03T00:00:00Z'));
    await harness.run('poll');
    embedder.calls = 0;
    const stats = await loopWith(embedder).runOnce();
    expect(stats.indexed).toBe(1);
    expect(embedder.calls).toBe(1);
    const { rows } = await database.db.query<{ text: string }>(`SELECT text FROM knowledge_chunks`);
    expect(rows.map((r) => r.text).join()).toContain('second version');
  });

  it('a document deleted upstream and restored unchanged is indexed again', async () => {
    const original = doc('t1', 'the deploy runbook', '2026-01-01T00:00:00Z');
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    // Read afresh before every batch: the sink refuses a batch whose container
    // does not hold the checkpoint that is stored.
    const current = async () => (await sink.selectedContainers())[0]!;
    const embedder = new FakeEmbedder(768);
    const chunks = async () => (await database.db.query(`SELECT 1 FROM knowledge_chunks`)).rows;

    await sink.storeBatch(await current(), {
      documents: [original],
      deletedExternalIds: [],
      checkpoint: 'a',
    });
    await loopWith(embedder).runOnce();
    expect(await chunks()).toHaveLength(1);

    await sink.storeBatch(await current(), {
      documents: [],
      deletedExternalIds: ['t1'],
      checkpoint: 'b',
    });
    expect(await chunks()).toHaveLength(0);

    await sink.storeBatch(await current(), {
      documents: [original],
      deletedExternalIds: [],
      checkpoint: 'c',
    });
    const stats = await loopWith(embedder).runOnce();
    expect(stats.indexed).toBe(1);
    expect(await chunks()).toHaveLength(1);
  });

  it('a document edited down to nothing loses the chunks of its old text', async () => {
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    // Read afresh before every batch: the sink refuses a batch whose container
    // does not hold the checkpoint that is stored.
    const current = async () => (await sink.selectedContainers())[0]!;
    const original = doc('t1', 'a paragraph someone later removes', '2026-01-01T00:00:00Z');

    await sink.storeBatch(await current(), {
      documents: [original],
      deletedExternalIds: [],
      checkpoint: 'a',
    });
    await loopWith(new FakeEmbedder(768)).runOnce();
    await sink.storeBatch(await current(), {
      documents: [{ ...original, segments: [] }],
      deletedExternalIds: [],
      checkpoint: 'b',
    });
    const stats = await loopWith(new FakeEmbedder(768)).runOnce();

    expect(stats.skipped).toBe(1);
    expect((await database.db.query(`SELECT 1 FROM knowledge_chunks`)).rows).toHaveLength(0);
  });
});
