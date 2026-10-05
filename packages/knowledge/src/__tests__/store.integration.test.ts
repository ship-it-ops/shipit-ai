import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type {
  ChangeBatch,
  KnowledgeDocumentInput,
  SourceContainer,
} from '@shipit-ai/connector-sdk';
import { DATABASE_TEST_URL, createMigratedTestDatabase, type TestDatabase } from './test-db.js';
import { KnowledgeStore } from '../store.js';
import { PostgresKnowledgeSink } from '../sink.js';
import { toPgVector } from '../vector.js';

type Raw = Record<string, unknown>;

// A shape secretlint's recommended preset flags by default (see redaction.test.ts).
const GH_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const C1: SourceContainer = {
  externalId: 'C1',
  kind: 'channel',
  name: 'general',
  visibility: 'open',
  archived: false,
};
const C2: SourceContainer = {
  externalId: 'C2',
  kind: 'channel',
  name: 'ops',
  visibility: 'restricted',
  archived: false,
};

function doc(id: string, text: string, at = '2026-01-01T00:00:00Z'): KnowledgeDocumentInput {
  return {
    externalId: id,
    kind: 'slack_thread',
    title: id,
    url: `https://example.test/${id}`,
    segments: [{ key: 'm1', text, at, authorExternalId: 'U1' }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    authorExternalId: 'U1',
    participantExternalIds: ['U1', 'U9'],
    attributes: { n: 1 },
    restricted: false,
  };
}

const batch = (
  documents: KnowledgeDocumentInput[],
  deletedExternalIds: string[] = [],
  checkpoint = 'cp1',
): ChangeBatch => ({ documents, deletedExternalIds, checkpoint });

// A deterministic 768-dim vector per text so the tests can predict distances.
function vectorFor(text: string): number[] {
  const v = new Array<number>(768).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 768] += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function chunk(seq: number, text: string) {
  return {
    seq,
    segmentKeys: ['m1'],
    url: undefined,
    occurredAt: undefined,
    prefix: 'p',
    text,
    textHash: `hash:${text}`,
    tokenEstimate: 1,
    embedding: toPgVector(vectorFor(text)),
    embeddingModel: 'fake-model',
  };
}

describe.skipIf(!DATABASE_TEST_URL)('KnowledgeStore and PostgresKnowledgeSink', () => {
  let database: TestDatabase;
  let store: KnowledgeStore;
  let sink: PostgresKnowledgeSink;
  const wakes: number[] = [];

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = new KnowledgeStore(database.db);
  });
  afterAll(async () => {
    await database?.drop();
  });
  beforeEach(async () => {
    await database.db.query(
      'TRUNCATE knowledge_chunks, knowledge_documents, knowledge_principals, knowledge_containers, knowledge_state',
    );
    wakes.length = 0;
    sink = new PostgresKnowledgeSink({
      connectorId: 'slack-1',
      store,
      wake: async () => void wakes.push(1),
    });
    await sink.upsertContainers([C1, C2]);
    await sink.upsertPrincipals([
      {
        externalId: 'U1',
        kind: 'user',
        displayName: 'Ada',
        email: 'ada@example.com',
        active: true,
      },
    ]);
    await store.setSelected('slack-1', 'C1', true, 'admin@example.com');
  });

  const selectedC1 = async () =>
    (await sink.selectedContainers()).find((c) => c.externalId === 'C1')!;
  const rowFor = async (externalId: string) =>
    (await store.listContainers('slack-1')).find((c) => c.externalId === externalId)!;
  /** Selects a container that is not open at the source, the way the route does once acknowledged. */
  const selectAcknowledged = async (externalId: string) =>
    store.selectContainer('slack-1', (await rowFor(externalId)).id, {
      selected: true,
      by: 'admin@example.com',
      acknowledged: true,
    });

  describe('containers', () => {
    it('lists only selected, present containers with their checkpoint', async () => {
      const selected = await sink.selectedContainers();
      expect(selected.map((c) => c.externalId)).toEqual(['C1']);
      expect(selected[0]!.checkpoint).toBeNull();
    });

    it('marks containers missing from a complete list as gone, and back when they return', async () => {
      await sink.upsertContainers([C2]);
      expect(await sink.selectedContainers()).toEqual([]);
      await sink.upsertContainers([C1, C2]);
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1']);
      // Selection survived the round trip.
      const rows = await store.listContainers('slack-1');
      expect(rows.find((r) => r.externalId === 'C1')!.selected).toBe(true);
    });

    it('is scoped by connector id', async () => {
      const other = new PostgresKnowledgeSink({ connectorId: 'slack-2', store });
      await other.upsertContainers([C1]);
      expect((await other.selectedContainers()).length).toBe(0);
      expect((await store.listContainers('slack-2')).length).toBe(1);
    });
  });

  describe('storeBatch', () => {
    it('stores documents as pending, maps principals, saves the checkpoint and wakes the worker', async () => {
      const result = await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'hello'), doc('d2', 'world')]),
      );
      expect(result).toEqual({ changed: 2, deleted: 0 });
      expect((await selectedC1()).checkpoint).toBe('cp1');
      expect(wakes).toHaveLength(1);

      const claimed = await store.claimPending(10);
      expect(claimed.map((d) => d.externalId).sort()).toEqual(['d1', 'd2']);
      const d1 = claimed.find((d) => d.externalId === 'd1')!;
      expect(d1.indexStatus).toBe('indexing');
      expect(d1.authorPrincipalId).not.toBeNull();
      // U9 is unknown: not invented, just absent.
      expect(d1.participantPrincipalIds).toHaveLength(1);
      expect(d1.segments[0]!.text).toBe('hello');
    });

    it('storing the same batch twice changes nothing', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello')]));
      await database.db.query(
        `UPDATE knowledge_documents SET index_status = 'indexed', indexed_hash = content_hash`,
      );
      const again = await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'hello')], [], 'cp2'),
      );
      expect(again.changed).toBe(0);
      const { rows } = await database.db.query<{ index_status: string }>(
        `SELECT index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(rows[0]!.index_status).toBe('indexed');
      expect((await selectedC1()).checkpoint).toBe('cp2');
    });

    it('a changed document becomes pending again', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello')]));
      await database.db.query(
        `UPDATE knowledge_documents SET index_status = 'indexed', indexed_hash = content_hash`,
      );
      const result = await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello, edited')]));
      expect(result.changed).toBe(1);
      const { rows } = await database.db.query<{ index_status: string }>(
        `SELECT index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(rows[0]!.index_status).toBe('pending');
    });

    it('redacts before storing and counts it on the document', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', `token ${GH_TOKEN} here`)]));
      const { rows } = await database.db.query<{
        segments: Array<{ text: string }>;
        redactions: number;
      }>(`SELECT segments, redactions FROM knowledge_documents WHERE external_id = 'd1'`);
      expect(rows[0]!.segments[0]!.text).not.toContain(GH_TOKEN);
      expect(rows[0]!.segments[0]!.text).toMatch(/\[redacted:/);
      expect(rows[0]!.redactions).toBe(1);
    });

    it('stores a restricted item as a content-free stub that is never claimed', async () => {
      const restricted = { ...doc('r1', ''), segments: [], restricted: true };
      await sink.storeBatch(await selectedC1(), batch([restricted]));
      const { rows } = await database.db.query<{ index_status: string; restricted: boolean }>(
        `SELECT index_status, restricted FROM knowledge_documents WHERE external_id = 'r1'`,
      );
      expect(rows[0]).toEqual({ index_status: 'skipped', restricted: true });
      expect(await store.claimPending(10)).toEqual([]);
    });

    it('tombstones deletions in the same batch and removes their chunks', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello')]));
      const [d1] = await store.claimPending(10);
      await store.replaceChunks(d1!.id, [chunk(0, 'hello')], {
        indexedHash: d1!.contentHash!,
        indexVersion: 1,
      });
      const result = await sink.storeBatch(await selectedC1(), batch([], ['d1'], 'cp3'));
      expect(result).toEqual({ changed: 0, deleted: 1 });
      const docs = await database.db.query<{
        deleted_at: string | null;
        segments: unknown[];
        index_status: string;
      }>(
        `SELECT deleted_at, segments, index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(docs.rows[0]!.deleted_at).not.toBeNull();
      expect(docs.rows[0]!.segments).toEqual([]);
      expect(docs.rows[0]!.index_status).toBe('skipped');
      const chunks = await database.db.query(`SELECT 1 FROM knowledge_chunks`);
      expect(chunks.rows).toHaveLength(0);
    });

    it('rolls the whole batch back when one row is invalid', async () => {
      const bad = { ...doc('d2', 'x'), kind: 'not-a-kind' as 'slack_thread' };
      await expect(
        sink.storeBatch(await selectedC1(), batch([doc('d1', 'ok'), bad])),
      ).rejects.toThrow();
      const { rows } = await database.db.query(`SELECT 1 FROM knowledge_documents`);
      expect(rows).toHaveLength(0);
      expect((await selectedC1()).checkpoint).toBeNull();
    });
  });

  describe('pruneMissing', () => {
    it('tombstones the rest and removes their chunks', async () => {
      await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'c')]),
      );
      const pruned = await sink.pruneMissing(await selectedC1(), ['d1', 'd3']);
      expect(pruned).toBe(1);
      const { rows } = await database.db.query<{ external_id: string }>(
        `SELECT external_id FROM knowledge_documents WHERE deleted_at IS NOT NULL`,
      );
      expect(rows.map((r) => r.external_id)).toEqual(['d2']);
      // A second prune with the same list deletes nothing more.
      expect(await sink.pruneMissing(await selectedC1(), ['d1', 'd3'])).toBe(0);
    });
  });

  describe('claims and chunks', () => {
    it('reclaims a stale claim and leaves a fresh one alone', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      const first = await store.claimPending(1);
      expect(first).toHaveLength(1);
      // Age the claim past the stale window.
      await database.db.query(
        `UPDATE knowledge_documents SET index_claimed_at = now() - interval '11 minutes' WHERE id = $1`,
        [first[0]!.id],
      );
      const next = await store.claimPending(10);
      expect(next.map((d) => d.externalId).sort()).toEqual(['d1', 'd2']);
      // Both are now freshly claimed: nothing left.
      expect(await store.claimPending(10)).toEqual([]);
    });

    // A long document is embedded a call at a time, and the calls together can
    // outlast the stale window. Each one that comes back renews the claim.
    it('keeps a claim that is still being worked on from going stale', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(1);
      await database.db.query(
        `UPDATE knowledge_documents SET index_claimed_at = now() - interval '11 minutes' WHERE id = $1`,
        [d!.id],
      );
      expect(await store.keepClaim(d!.id, d!.contentHash!)).toBe(true);
      expect(await store.claimPending(10)).toEqual([]);
    });

    it('does not keep a claim on a document the sink has changed or removed since', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      const claimed = await store.claimPending(10);
      const d1 = claimed.find((d) => d.externalId === 'd1')!;
      const d2 = claimed.find((d) => d.externalId === 'd2')!;
      // d1 is edited: its row is pending again, with another content hash.
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a, edited')], [], 'cp2'));
      expect(await store.keepClaim(d1.id, d1.contentHash!)).toBe(false);
      // d2 is deleted at the source.
      await sink.storeBatch(await selectedC1(), batch([], ['d2'], 'cp3'));
      expect(await store.keepClaim(d2.id, d2.contentHash!)).toBe(false);
      expect(await store.keepClaim('99999999-9999-4999-8999-999999999999', 'h')).toBe(false);
    });

    // The edited document is claimed again, by this worker's next batch or by
    // another worker. The row is `indexing` once more, for other content: the
    // first claimant must not renew that claim, nor go on embedding the old text.
    it('does not keep a claim that is now someone else’s, on newer content', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [first] = await store.claimPending(10);
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a, edited')], [], 'cp2'));
      const [second] = await store.claimPending(10);
      expect(second!.id).toBe(first!.id);
      expect(second!.contentHash).not.toBe(first!.contentHash);

      expect(await store.keepClaim(first!.id, first!.contentHash!)).toBe(false);
      expect(await store.keepClaim(second!.id, second!.contentHash!)).toBe(true);
    });

    // The same test replaceChunks makes before it writes, so that a worker
    // stops at the next call for exactly the documents it could not finish.
    it.each([
      ['deleted', `deleted_at = now()`],
      ['restricted', `restricted = true`],
    ])('does not keep a claim on a row that is %s', async (_what, change) => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await database.db.query(`UPDATE knowledge_documents SET ${change} WHERE id = $1`, [d!.id]);
      expect(await store.keepClaim(d!.id, d!.contentHash!)).toBe(false);
      expect(
        await store.replaceChunks(d!.id, [chunk(0, 'alpha')], {
          indexedHash: d!.contentHash!,
          indexVersion: 1,
        }),
      ).toBe(false);
    });

    it('stops retrying after five failures and backs off before that', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      for (let attempt = 1; attempt <= 5; attempt++) {
        const [d] = await store.claimPending(10);
        expect(d, `attempt ${attempt}`).toBeDefined();
        await store.markFailed(d!.id, `boom ${attempt}`);
        // Just failed: not claimable until the backoff passes.
        expect(await store.claimPending(10)).toEqual([]);
        await database.db.query(
          `UPDATE knowledge_documents SET index_claimed_at = now() - interval '2 days'`,
        );
      }
      expect(await store.claimPending(10)).toEqual([]);
      const counts = await store.countsByIndexStatus();
      expect(counts.failed).toBe(1);
    });

    it('replaces chunks, reuses embeddings by text hash and marks the document indexed', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await store.replaceChunks(d!.id, [chunk(0, 'alpha'), chunk(1, 'beta')], {
        indexedHash: d!.contentHash!,
        indexVersion: 1,
      });

      const reusable = await store.existingChunkEmbeddings(d!.id, 'fake-model');
      expect([...reusable.keys()]).toHaveLength(2);

      // The document is edited, re-stored and re-claimed; the re-index keeps one chunk.
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a, edited')], [], 'cp2'));
      const [again] = await store.claimPending(10);
      expect(again!.id).toBe(d!.id);
      const written = await store.replaceChunks(again!.id, [chunk(0, 'beta')], {
        indexedHash: again!.contentHash!,
        indexVersion: 1,
      });
      expect(written).toBe(true);
      const { rows } = await database.db.query<{ text: string; embedding: string }>(
        `SELECT text, embedding::text AS embedding FROM knowledge_chunks ORDER BY seq`,
      );
      expect(rows.map((r) => r.text)).toEqual(['beta']);
      // halfvec stores 16-bit floats, so compare with tolerance, not as text.
      const stored = JSON.parse(rows[0]!.embedding) as number[];
      const expected = vectorFor('beta');
      expect(stored).toHaveLength(768);
      for (let i = 0; i < 768; i++) expect(stored[i]).toBeCloseTo(expected[i]!, 2);

      const after = await store.getDocument(d!.id);
      expect(after!.indexStatus).toBe('indexed');
      expect(after!.indexedHash).toBe(again!.contentHash);
      expect(after!.indexVersion).toBe(1);
      expect(after!.indexAttempts).toBe(0);
    });

    it('searches by cosine distance through the hnsw index', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await store.replaceChunks(d!.id, [chunk(0, 'alpha'), chunk(1, 'beta')], {
        indexedHash: d!.contentHash!,
        indexVersion: 1,
      });
      const { rows } = await database.db.query<{ text: string }>(
        `SELECT text FROM knowledge_chunks ORDER BY embedding <=> $1::halfvec LIMIT 1`,
        [toPgVector(vectorFor('beta'))],
      );
      expect(rows[0]!.text).toBe('beta');
    });
  });

  describe('review fixes', () => {
    it('C1: an unchanged re-store keeps a failed document retryable', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await store.markFailed(d!.id, 'boom');
      // Time passes (the backoff elapses) ...
      await database.db.query(
        `UPDATE knowledge_documents SET index_claimed_at = now() - interval '2 days' WHERE external_id = 'd1'`,
      );
      // ... then the next poll re-sends the same, unchanged document.
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')], [], 'cp2'));
      expect((await store.claimPending(10)).map((x) => x.externalId)).toEqual(['d1']);
    });

    it('C1: an unchanged re-store keeps a stale claim recoverable', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await store.claimPending(10); // a worker holds it, then dies
      await database.db.query(
        `UPDATE knowledge_documents SET index_claimed_at = now() - interval '11 minutes' WHERE external_id = 'd1'`,
      );
      // The poll re-sends the unchanged document while the claim is stale.
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')], [], 'cp2'));
      expect((await store.claimPending(10)).map((x) => x.externalId)).toEqual(['d1']);
    });

    it('C2: replaceChunks writes nothing when the document was tombstoned mid-flight', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await sink.storeBatch(await selectedC1(), batch([], ['d1'], 'cp2'));
      const written = await store.replaceChunks(d!.id, [chunk(0, 'a')], {
        indexedHash: d!.contentHash!,
        indexVersion: 1,
      });
      expect(written).toBe(false);
      expect((await database.db.query(`SELECT 1 FROM knowledge_chunks`)).rows).toHaveLength(0);
      const after = await store.getDocument(d!.id);
      expect(after!.indexStatus).toBe('skipped');
      expect(after!.deletedAt).not.toBeNull();
    });

    it('C2: replaceChunks writes nothing when the document was edited mid-flight', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a, edited')], [], 'cp2'));
      const written = await store.replaceChunks(d!.id, [chunk(0, 'a')], {
        indexedHash: d!.contentHash!,
        indexVersion: 1,
      });
      expect(written).toBe(false);
      const after = await store.getDocument(d!.id);
      expect(after!.indexStatus).toBe('pending'); // the edit is still waiting
      expect(after!.indexedHash).toBeNull();
    });

    it('C2: markFailed and markUnchanged leave a document that is no longer claimed alone', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await sink.storeBatch(await selectedC1(), batch([], ['d1'], 'cp2'));
      await store.markFailed(d!.id, 'late failure');
      expect((await store.getDocument(d!.id))!.indexStatus).toBe('skipped');
      await store.markUnchanged(d!.id, 1);
      expect((await store.getDocument(d!.id))!.indexStatus).toBe('skipped');
    });

    it('I2: redacts the title and string attributes, not only segments', async () => {
      const d = {
        ...doc('d1', 'clean body'),
        title: `rotate ${GH_TOKEN} now`,
        attributes: { summary: `key ${GH_TOKEN}`, n: 1, nested: { note: GH_TOKEN } },
      };
      await sink.storeBatch(await selectedC1(), batch([d]));
      const { rows } = await database.db.query<{
        title: string;
        attributes: Record<string, unknown>;
        redactions: number;
      }>(`SELECT title, attributes, redactions FROM knowledge_documents WHERE external_id = 'd1'`);
      expect(rows[0]!.title).toBe('rotate [redacted:github] now');
      expect(JSON.stringify(rows[0]!.attributes)).not.toContain(GH_TOKEN);
      expect(rows[0]!.attributes.n).toBe(1);
      expect(rows[0]!.redactions).toBe(3);
    });

    it('I3: a restricted stub carries no title, attributes, author or participants', async () => {
      const restricted = { ...doc('r1', 'secret body'), title: 'Secret plan', restricted: true };
      await sink.storeBatch(await selectedC1(), batch([restricted]));
      const { rows } = await database.db.query<Raw>(
        `SELECT title, attributes, author_principal_id, participant_principal_ids, segments FROM knowledge_documents WHERE external_id = 'r1'`,
      );
      expect(rows[0]).toEqual({
        title: '',
        attributes: {},
        author_principal_id: null,
        participant_principal_ids: [],
        segments: [],
      });
    });

    it('I4: pruneMissing spares documents stored after the listing started', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('old', 'a'), doc('keep', 'k')]));
      // The listing "started" after old and keep were stored, before new arrives.
      const listedAt = new Date(Date.now() + 1000).toISOString();
      await new Promise((r) => setTimeout(r, 1100));
      await sink.storeBatch(await selectedC1(), batch([doc('new', 'b')], [], 'cp2'));
      const pruned = await sink.pruneMissing(await selectedC1(), ['keep'], { listedAt });
      expect(pruned).toBe(1);
      const { rows } = await database.db.query<{ external_id: string }>(
        `SELECT external_id FROM knowledge_documents WHERE deleted_at IS NULL ORDER BY external_id`,
      );
      expect(rows.map((r) => r.external_id)).toEqual(['keep', 'new']);
    });

    it('an empty listing with documents present prunes nothing', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      expect(await sink.pruneMissing(await selectedC1(), [])).toBe(0);
      const { rows } = await database.db.query(
        `SELECT 1 FROM knowledge_documents WHERE deleted_at IS NULL`,
      );
      expect(rows).toHaveLength(2);
    });

    it('I8: a null checkpoint leaves the stored checkpoint alone', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')], [], 'cp-poll'));
      await sink.storeBatch(await selectedC1(), {
        documents: [doc('d2', 'b')],
        deletedExternalIds: [],
        checkpoint: null,
      });
      expect((await selectedC1()).checkpoint).toBe('cp-poll');
    });

    it('I9: selectedContainers orders the least recently polled container first', async () => {
      await selectAcknowledged('C2');
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1', 'C2']);
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C2', 'C1']);
    });
  });

  describe('audit fixes', () => {
    const indexD1 = async (text = 'a') => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', text)]));
      const [d] = await store.claimPending(10);
      await store.replaceChunks(d!.id, [chunk(0, 'alpha')], {
        indexedHash: d!.contentHash!,
        indexVersion: 1,
      });
      return d!;
    };
    const chunkCount = async () =>
      (await database.db.query(`SELECT 1 FROM knowledge_chunks`)).rows.length;

    it('a tombstoned document that returns unchanged forgets it was ever indexed', async () => {
      const d = await indexD1();
      await sink.storeBatch(await selectedC1(), batch([], ['d1'], 'cp2'));
      expect((await store.getDocument(d.id))!.indexedHash).toBeNull();

      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')], [], 'cp3'));
      const [again] = await store.claimPending(10);
      expect(again!.contentHash).toBe(d.contentHash);
      // Not equal to the content hash, so the pipeline rebuilds the chunks.
      expect(again!.indexedHash).toBeNull();
      expect(again!.indexVersion).toBeNull();
    });

    it('a document restricted and then opened again unchanged forgets it was ever indexed', async () => {
      const d = await indexD1();
      await sink.storeBatch(
        await selectedC1(),
        batch([{ ...doc('d1', 'a'), restricted: true }], [], 'cp2'),
      );
      expect(await chunkCount()).toBe(0);
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')], [], 'cp3'));
      const [again] = await store.claimPending(10);
      expect(again!.id).toBe(d.id);
      expect(again!.indexedHash).toBeNull();
    });

    it('markSkipped removes the chunks of the previous version', async () => {
      const d = await indexD1();
      await sink.storeBatch(
        await selectedC1(),
        batch([{ ...doc('d1', 'a'), segments: [] }], [], 'cp2'),
      );
      const [emptied] = await store.claimPending(10);
      await store.markSkipped(emptied!.id);
      expect(await chunkCount()).toBe(0);
      const after = await store.getDocument(d.id);
      expect(after!.indexStatus).toBe('skipped');
      expect(after!.indexedHash).toBeNull();
    });

    it('markSkipped leaves the chunks alone when the row is no longer its claim', async () => {
      const d = await indexD1();
      await store.markSkipped(d.id); // status is `indexed`, not `indexing`
      expect(await chunkCount()).toBe(1);
    });

    it('believes a second consecutive empty listing', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      expect(await sink.pruneMissing(await selectedC1(), [])).toBe(0);
      expect(await sink.pruneMissing(await selectedC1(), [])).toBe(2);
      const { rows } = await database.db.query(
        `SELECT 1 FROM knowledge_documents WHERE deleted_at IS NULL`,
      );
      expect(rows).toHaveLength(0);
    });

    it('a listing with ids between two empty ones starts the count again', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      expect(await sink.pruneMissing(await selectedC1(), [])).toBe(0);
      expect(await sink.pruneMissing(await selectedC1(), ['d1', 'd2'])).toBe(0);
      expect(await sink.pruneMissing(await selectedC1(), [])).toBe(0);
    });

    it('prunes only the kinds the listing covers', async () => {
      await sink.storeBatch(
        await selectedC1(),
        batch([
          { ...doc('issue-1', 'a'), kind: 'github_issue' },
          { ...doc('issue-2', 'b'), kind: 'github_issue' },
          { ...doc('pr-1', 'c'), kind: 'github_pull_request' },
        ]),
      );
      const pruned = await sink.pruneMissing(await selectedC1(), ['issue-1'], {
        kinds: ['github_issue'],
      });
      expect(pruned).toBe(1);
      const { rows } = await database.db.query<{ external_id: string }>(
        `SELECT external_id FROM knowledge_documents WHERE deleted_at IS NULL ORDER BY external_id`,
      );
      expect(rows.map((r) => r.external_id)).toEqual(['issue-1', 'pr-1']);
    });

    it('orders reconcile by the last reconcile, and poll by the last poll visit', async () => {
      await selectAcknowledged('C2');
      const [c1, c2] = await sink.selectedContainers('poll');
      expect([c1!.externalId, c2!.externalId]).toEqual(['C1', 'C2']);

      // A poll that found nothing still moves C1 to the back of the poll order.
      await sink.markVisited(c1!, 'poll');
      expect((await sink.selectedContainers('poll')).map((c) => c.externalId)).toEqual([
        'C2',
        'C1',
      ]);
      // The reconcile order is its own: nothing has been reconciled yet.
      expect((await sink.selectedContainers('reconcile')).map((c) => c.externalId)).toEqual([
        'C1',
        'C2',
      ]);
      await sink.markVisited(c1!, 'reconcile');
      expect((await sink.selectedContainers('reconcile')).map((c) => c.externalId)).toEqual([
        'C2',
        'C1',
      ]);
    });

    it('a reconcile batch does not move the poll order', async () => {
      await selectAcknowledged('C2');
      await sink.storeBatch(await selectedC1(), {
        documents: [doc('d1', 'a')],
        deletedExternalIds: [],
        checkpoint: null,
      });
      expect((await sink.selectedContainers('poll')).map((c) => c.externalId)).toEqual([
        'C1',
        'C2',
      ]);
    });

    it('waits 4^attempts minutes before retrying a failed document', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const age = (minutes: number) =>
        database.db.query(
          `UPDATE knowledge_documents SET index_claimed_at = now() - ($1::int * interval '1 minute')`,
          [minutes],
        );
      const [d] = await store.claimPending(10);
      await store.markFailed(d!.id, 'boom 1'); // attempts = 1: 4 minutes
      await age(3);
      expect(await store.claimPending(10)).toEqual([]);
      await age(5);
      expect(await store.claimPending(10)).toHaveLength(1);
      await store.markFailed(d!.id, 'boom 2'); // attempts = 2: 16 minutes
      await age(15);
      expect(await store.claimPending(10)).toEqual([]);
      await age(17);
      expect(await store.claimPending(10)).toHaveLength(1);
    });
  });

  describe('containers for the picker', () => {
    const rowOf = async (externalId: string) =>
      (await store.listContainers('slack-1')).find((c) => c.externalId === externalId)!;

    it('counts documents per container by index status', async () => {
      await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'a'), doc('d2', 'b'), { ...doc('d3', 'c'), restricted: true }]),
      );
      const [claimed] = await store.claimPending(1);
      await store.replaceChunks(claimed!.id, [chunk(0, 'alpha')], {
        indexedHash: claimed!.contentHash!,
        indexVersion: 1,
      });
      const rows = await store.containersWithCounts('slack-1');
      expect(rows.map((r) => r.externalId)).toEqual(['C1', 'C2']);
      expect(rows[0]).toMatchObject({
        documents: 2,
        indexed: 1,
        pending: 1,
        failed: 0,
        restricted: 1,
      });
      expect(rows[1]).toMatchObject({ documents: 0, indexed: 0, restricted: 0 });
    });

    it('searches by name and leaves out containers that are gone', async () => {
      expect((await store.containersWithCounts('slack-1', 'OPS')).map((r) => r.name)).toEqual([
        'ops',
      ]);
      await sink.upsertContainers([C1]); // C2 is no longer listed upstream
      expect((await store.containersWithCounts('slack-1')).map((r) => r.name)).toEqual(['general']);
    });

    it('records who selected a container and who acknowledged its visibility', async () => {
      const c2 = await rowOf('C2');
      await store.selectContainer('slack-1', c2.id, {
        selected: true,
        by: 'ada',
        acknowledged: true,
      });
      const [, after] = await store.containersWithCounts('slack-1');
      expect(after).toMatchObject({
        selected: true,
        selectedBy: 'ada',
        visibilityAcknowledgedBy: 'ada',
      });
      expect(await store.getContainer('slack-1', c2.id)).toMatchObject({ externalId: 'C2' });
      expect(await store.getContainer('other', c2.id)).toBeNull();
    });

    it('deselecting requests a purge; the purge deletes the content and resets the sync state', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      const c1 = await rowOf('C1');
      await store.selectContainer('slack-1', c1.id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      expect((await rowOf('C1')).purgeRequestedAt).not.toBeNull();

      expect(await store.purgeRequested()).toBe(2);
      const { rows } = await database.db.query(`SELECT 1 FROM knowledge_documents`);
      expect(rows).toHaveLength(0);
      expect(await rowOf('C1')).toMatchObject({
        purgeRequestedAt: null,
        checkpoint: null,
        selected: false,
      });
      expect(await store.purgeRequested()).toBe(0);
    });

    it('selecting again before the purge ran cancels it', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const c1 = await rowOf('C1');
      await store.selectContainer('slack-1', c1.id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      await store.selectContainer('slack-1', c1.id, {
        selected: true,
        by: 'ada',
        acknowledged: false,
      });
      expect(await store.purgeRequested()).toBe(0);
      expect((await database.db.query(`SELECT 1 FROM knowledge_documents`)).rows).toHaveLength(1);
    });

    it('refuses a batch for a container that is no longer selected', async () => {
      const selected = await selectedC1();
      const c1 = await rowOf('C1');
      await store.selectContainer('slack-1', c1.id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      await expect(sink.storeBatch(selected, batch([doc('d1', 'a')]))).rejects.toMatchObject({
        code: 'KNOWLEDGE_CONTAINER_CHANGED',
        message: expect.stringMatching(/not selected/),
      });
    });
  });

  describe('final review fixes (K1a)', () => {
    const NUL = String.fromCharCode(0);
    const documents = async () =>
      (
        await database.db.query<{ external_id: string }>(
          `SELECT external_id FROM knowledge_documents WHERE deleted_at IS NULL ORDER BY external_id`,
        )
      ).rows.map((r) => r.external_id);

    it('refuses a batch for a container that was purged and selected again since the run read it', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')], [], 'cp1'));
      const run = await selectedC1(); // a run reads the container: checkpoint cp1
      const c1 = await rowFor('C1');
      await store.selectContainer('slack-1', c1.id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      expect(await store.purgeRequested()).toBe(1);
      await store.selectContainer('slack-1', c1.id, {
        selected: true,
        by: 'ada',
        acknowledged: false,
      });

      // The run now reaches the container with what it read before the reset.
      await expect(
        sink.storeBatch(run, batch([doc('d9', 'newer than cp1')], [], 'cp2')),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_CONTAINER_CHANGED' });

      // Nothing was stored and the fresh backfill still starts from nothing.
      expect(await documents()).toEqual([]);
      expect((await selectedC1()).checkpoint).toBeNull();
    });

    it('accepts the next batch of the same run once the run holds the checkpoint it just wrote', async () => {
      const run = await selectedC1();
      await sink.storeBatch(run, batch([doc('d1', 'a')], [], 'cp1'));
      run.checkpoint = 'cp1'; // what the harness does after every stored batch
      await sink.storeBatch(run, batch([doc('d2', 'b')], [], 'cp2'));
      expect(await documents()).toEqual(['d1', 'd2']);
      expect((await selectedC1()).checkpoint).toBe('cp2');
    });

    it('leaves a selected container that is not open at the source out of a run until it is acknowledged', async () => {
      // Selected while the last listing said "open"; the source has since made it private.
      await sink.upsertContainers([{ ...C1, visibility: 'restricted' }, C2]);
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual([]);

      await selectAcknowledged('C1');
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1']);
    });

    it('shows a container the source no longer lists while it is selected or still holds content', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await sink.upsertContainers([C2]); // C1 is gone at the source
      const rows = await store.containersWithCounts('slack-1');
      expect(rows.map((r) => [r.externalId, r.goneAt !== null, r.documents])).toEqual([
        ['C1', true, 1],
        ['C2', false, 0],
      ]);
    });

    it('deselectConnector requests a purge of everything the connector holds', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      await selectAcknowledged('C2');

      expect(await store.deselectConnector('slack-1', 'ada')).toBe(2);
      expect(await sink.selectedContainers()).toEqual([]);
      // C1 holds documents and waits for the worker; C2 held nothing and is gone.
      const pending = await database.db.query<{
        external_id: string;
        selected: boolean;
        acked: string | null;
      }>(
        `SELECT external_id, selected, visibility_acknowledged_by AS acked
           FROM knowledge_containers WHERE connector_id = 'slack-1'`,
      );
      expect(pending.rows).toEqual([{ external_id: 'C1', selected: false, acked: null }]);
      expect(await store.purgeRequested()).toBe(2);
      expect(await documents()).toEqual([]);
      // Another connector's containers are untouched.
      expect(await store.deselectConnector('other', 'ada')).toBe(0);
    });

    it('upserts the principals a batch carries before its documents, so authorship resolves', async () => {
      const bot = {
        ...doc('d1', 'bump lodash'),
        authorExternalId: 'B7',
        participantExternalIds: ['B7'],
      };
      bot.segments = [{ key: 'm1', text: 'bump lodash', authorExternalId: 'B7' }];
      await sink.storeBatch(await selectedC1(), {
        ...batch([bot]),
        principals: [
          {
            externalId: 'B7',
            kind: 'bot',
            displayName: 'dependabot[bot]',
            login: 'dependabot[bot]',
            active: true,
          },
        ],
      });
      const { rows } = await database.db.query<{ kind: string; author: string | null; n: number }>(
        `SELECT p.kind, d.author_principal_id::text AS author, cardinality(d.participant_principal_ids) AS n
           FROM knowledge_documents d LEFT JOIN knowledge_principals p ON p.id = d.author_principal_id`,
      );
      expect(rows[0]).toMatchObject({ kind: 'bot', n: 1 });
      expect(rows[0]!.author).not.toBeNull();
    });

    it('strips NUL characters, which Postgres cannot store, from every text field', async () => {
      const dirty = {
        ...doc('d1', `be${NUL}fore`),
        title: `ti${NUL}tle`,
        url: `https://example.test/d${NUL}1`,
        attributes: { label: `a${NUL}b`, nested: [`c${NUL}d`] },
      };
      dirty.segments = [
        {
          key: 'm1',
          text: `be${NUL}fore`,
          headingPath: [`He${NUL}ading`],
          authorName: `A${NUL}da`,
          url: `https://example.test/s${NUL}1`,
        },
      ];
      await sink.storeBatch(await selectedC1(), batch([dirty]));
      const { rows } = await database.db.query<{
        title: string;
        url: string;
        segments: unknown;
        attributes: unknown;
      }>(`SELECT title, url, segments, attributes FROM knowledge_documents`);
      expect(rows[0]).toEqual({
        title: 'title',
        url: 'https://example.test/d1',
        segments: [
          {
            key: 'm1',
            text: 'before',
            headingPath: ['Heading'],
            authorName: 'Ada',
            url: 'https://example.test/s1',
          },
        ],
        attributes: { label: 'ab', nested: ['cd'] },
      });
    });

    it('strips NUL characters from container and principal names too', async () => {
      await sink.upsertContainers([C1, { ...C2, name: `o${NUL}ps` }]);
      await sink.upsertPrincipals([
        {
          externalId: 'U8',
          kind: 'user',
          displayName: `Gr${NUL}ace`,
          login: `gr${NUL}ace`,
          active: true,
        },
      ]);
      expect((await rowFor('C2')).name).toBe('ops');
      const { rows } = await database.db.query<{ display_name: string; login: string }>(
        `SELECT display_name, login FROM knowledge_principals WHERE external_id = 'U8'`,
      );
      expect(rows[0]).toEqual({ display_name: 'Grace', login: 'grace' });
    });
  });

  describe('pull request review fixes', () => {
    const NUL = String.fromCharCode(0);
    const principals = async (connectorId: string) =>
      (
        await database.db.query<{ external_id: string }>(
          `SELECT external_id FROM knowledge_principals WHERE connector_id = $1 ORDER BY external_id`,
          [connectorId],
        )
      ).rows.map((r) => r.external_id);
    const acknowledgedBy = async (externalId: string) =>
      (
        await database.db.query<{ visibility_acknowledged_by: string | null }>(
          `SELECT visibility_acknowledged_by FROM knowledge_containers WHERE external_id = $1`,
          [externalId],
        )
      ).rows[0]!.visibility_acknowledged_by;

    // A connector may build a segment key from source text: the Markdown
    // splitter uses the heading path. A key is stored on the document and on
    // every chunk made from it, so it is redacted like the rest.
    it('redacts a segment key and strips NUL from it', async () => {
      const heading = `Deploy token ${GH_TOKEN}`;
      const readme = {
        ...doc('d1', 'body'),
        segments: [
          { key: heading, text: 'body', headingPath: [heading] },
          { key: `Set${NUL}up`, text: 'more' },
        ],
      };
      await sink.storeBatch(await selectedC1(), batch([readme]));
      const { rows } = await database.db.query<{
        segments: Array<{ key: string }>;
        redactions: number;
      }>(`SELECT segments, redactions FROM knowledge_documents WHERE external_id = 'd1'`);
      expect(rows[0]!.segments.map((segment) => segment.key)).toEqual([
        expect.stringMatching(/^Deploy token \[redacted:/),
        'Setup',
      ]);
      expect(JSON.stringify(rows[0]!.segments)).not.toContain(GH_TOKEN);
      // Once in the heading path, once in the key.
      expect(rows[0]!.redactions).toBe(2);
    });

    it('redacts attribute names and strips NUL from them, not only their values', async () => {
      const issue = {
        ...doc('d1', 'body'),
        attributes: { [`fi${NUL}eld`]: 'v', [`key ${GH_TOKEN}`]: 1, nested: { [`a${NUL}b`]: 2 } },
      };
      await sink.storeBatch(await selectedC1(), batch([issue]));
      const { rows } = await database.db.query<{ attributes: Record<string, unknown> }>(
        `SELECT attributes FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(JSON.stringify(rows[0]!.attributes)).not.toContain(GH_TOKEN);
      expect(rows[0]!.attributes).toMatchObject({ field: 'v', nested: { ab: 2 } });
    });

    // The api-server publishes the wake-up on a Redis client that queues
    // commands while it is disconnected, so the promise may never settle.
    it('does not wait for the wake-up', async () => {
      const stuck = new PostgresKnowledgeSink({
        connectorId: 'slack-1',
        store,
        wake: () => new Promise<void>(() => {}),
      });
      const result = await stuck.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      expect(result.changed).toBe(1);
    });

    it('logs a wake-up that fails; the batch is stored all the same', async () => {
      const lines: string[] = [];
      const failing = new PostgresKnowledgeSink({
        connectorId: 'slack-1',
        store,
        wake: async () => {
          throw new Error('redis is down');
        },
        log: (line) => lines.push(line),
      });
      const result = await failing.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      expect(result.changed).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(lines).toEqual([expect.stringContaining('redis is down')]);
    });

    // An acknowledgement accepts that restricted content becomes visible to
    // every signed-in user. Sent for a container that is open, there is
    // nothing to accept, and it must not stand in for consent later.
    it('records a visibility acknowledgement only for a container that is not open', async () => {
      const c1 = await rowFor('C1');
      await store.selectContainer('slack-1', c1.id, {
        selected: true,
        by: 'ada',
        acknowledged: true,
      });
      expect(await acknowledgedBy('C1')).toBeNull();

      // It turns private later. Nobody accepted that, so runs leave it out.
      await sink.upsertContainers([{ ...C1, visibility: 'restricted' }, C2]);
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual([]);

      await store.selectContainer('slack-1', c1.id, {
        selected: true,
        by: 'grace',
        acknowledged: true,
      });
      expect(await acknowledgedBy('C1')).toBe('grace');
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1']);
    });

    // Names, emails and logins are held only while the connector has something
    // selected or stored (spec success criterion 11).
    it('deletes a connector’s principals once it has nothing selected and nothing stored', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      expect(await principals('slack-1')).toEqual(['U1']);
      await store.deselectConnector('slack-1', 'ada');
      await store.purgeRequested();
      expect(await principals('slack-1')).toEqual([]);
    });

    it('keeps the principals while another container of the connector is selected', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await selectAcknowledged('C2');
      await store.selectContainer('slack-1', (await rowFor('C1')).id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      expect(await store.purgeRequested()).toBe(1);
      expect(await principals('slack-1')).toEqual(['U1']);
    });

    it('keeps the principals while a purge of the connector is still pending', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await selectAcknowledged('C2');
      await sink.storeBatch(
        (await sink.selectedContainers()).find((c) => c.externalId === 'C2')!,
        batch([doc('e1', 'b')]),
      );
      await store.deselectConnector('slack-1', 'ada');
      // One container per pass: after the first, the other still awaits its purge.
      await store.purgeRequested(1);
      expect(await principals('slack-1')).toEqual(['U1']);
      await store.purgeRequested(1);
      expect(await principals('slack-1')).toEqual([]);
    });

    it('leaves another connector’s principals alone', async () => {
      const other = new PostgresKnowledgeSink({ connectorId: 'slack-2', store });
      await other.upsertPrincipals([
        { externalId: 'U7', kind: 'user', displayName: 'Lin', active: true },
      ]);
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await store.deselectConnector('slack-1', 'ada');
      await store.purgeRequested();
      expect(await principals('slack-2')).toEqual(['U7']);
    });

    it('stores what the source says about one container without touching the others', async () => {
      await sink.upsertContainer({
        ...C1,
        name: `gen${NUL}eral-renamed`,
        visibility: 'restricted',
      });
      const rows = (await store.listContainers('slack-1')).sort((a, b) =>
        a.externalId.localeCompare(b.externalId),
      );
      expect(rows.map((r) => [r.externalId, r.name, r.visibility, r.goneAt])).toEqual([
        ['C1', 'general-renamed', 'restricted', null],
        ['C2', 'ops', 'restricted', null],
      ]);
      // Selection and sync state stay as they were.
      expect(rows[0]).toMatchObject({ selected: true });
    });

    it('hands a claimed document back as pending, without counting an attempt', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [claimed] = await store.claimPending(10);
      await store.releaseClaim(claimed!.id);
      const { rows } = await database.db.query<{ index_status: string; index_attempts: number }>(
        `SELECT index_status, index_attempts FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(rows[0]).toEqual({ index_status: 'pending', index_attempts: 0 });
      // It is claimable again straight away.
      expect((await store.claimPending(10)).map((d) => d.id)).toEqual([claimed!.id]);

      // A document that is no longer this worker's claim is left alone.
      await store.markFailed(claimed!.id, 'boom');
      await store.releaseClaim(claimed!.id);
      const after = await database.db.query<{ index_status: string }>(
        `SELECT index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(after.rows[0]!.index_status).toBe('failed');
    });

    const containerIds = async (connectorId: string) =>
      (
        await database.db.query<{ external_id: string }>(
          `SELECT external_id FROM knowledge_containers WHERE connector_id = $1 ORDER BY external_id`,
          [connectorId],
        )
      ).rows.map((r) => r.external_id);

    // Spec §API: the worker deletes the content and then the rows. A container
    // row carries the name of a repository or channel, private ones included.
    it('removes every container row of a deleted connector, selected or not', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      // C2 was never selected and holds nothing: it goes at once. C1 waits for
      // the worker, which deletes what it holds first.
      expect(await store.deselectConnector('slack-1', 'ada')).toBe(2);
      expect(await containerIds('slack-1')).toEqual(['C1']);
      expect(await principals('slack-1')).toEqual(['U1']);
      await store.purgeRequested();
      expect(await containerIds('slack-1')).toEqual([]);
      expect(await principals('slack-1')).toEqual([]);
      expect((await database.db.query('SELECT 1 FROM knowledge_documents')).rows).toEqual([]);
    });

    // Nothing to wait for: a connector that indexed nothing must not queue two
    // thousand empty rows behind the worker's purge, twenty a minute.
    it('removes a deleted connector that holds no documents at once, people included', async () => {
      expect(await store.deselectConnector('slack-1', 'ada')).toBe(3); // two containers, one person
      expect(await containerIds('slack-1')).toEqual([]);
      expect(await principals('slack-1')).toEqual([]);
      expect(await store.purgeRequested()).toBe(0);
    });

    it('removes people left under an id that has no containers any more', async () => {
      await database.db.query(`DELETE FROM knowledge_containers WHERE connector_id = 'slack-1'`);
      expect(await principals('slack-1')).toEqual(['U1']);
      expect(await store.deselectConnector('slack-1', 'ada')).toBe(1);
      expect(await principals('slack-1')).toEqual([]);
    });

    // A run still in flight when its connector is deleted keeps fetching, and
    // each batch names its authors. Stored before the batch was checked, they
    // outlived the purge with nothing left to remove them.
    it('stores the people a batch carries only when the batch itself is accepted', async () => {
      const lin = {
        externalId: 'U5',
        kind: 'user' as const,
        displayName: 'Lin',
        email: 'lin@example.com',
        active: true,
      };
      const held = await selectedC1();
      await store.selectContainer('slack-1', (await rowFor('C1')).id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      await expect(
        sink.storeBatch(held, { ...batch([doc('d1', 'a')]), principals: [lin] }),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_CONTAINER_CHANGED' });
      expect(await principals('slack-1')).toEqual(['U1']);
    });

    it('treats a batch for a container whose row is gone as changed under the run, not as a failure', async () => {
      const held = await selectedC1();
      await store.deselectConnector('slack-1', 'ada');
      await expect(sink.storeBatch(held, batch([doc('d1', 'a')]))).rejects.toMatchObject({
        code: 'KNOWLEDGE_CONTAINER_CHANGED',
      });
      expect(await principals('slack-1')).toEqual([]);
    });

    // A listing that commits after the delete must not undo it: the row stays
    // on its way out, and a later listing adds a fresh one.
    it('does not bring a deleted connector’s container back while its purge is pending', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const before = (await rowFor('C1')).id;
      await store.deselectConnector('slack-1', 'ada');

      await sink.upsertContainers([C1, C2]);
      const pending = (await store.containersWithCounts('slack-1')).find(
        (c) => c.externalId === 'C1',
      )!;
      expect(pending.goneAt).not.toBeNull();
      expect(pending.purgeRequestedAt).not.toBeNull();

      await store.purgeRequested();
      await sink.upsertContainers([C1, C2]);
      const fresh = await rowFor('C1');
      expect(fresh.id).not.toBe(before);
      expect(fresh).toMatchObject({ selected: false, checkpoint: null, goneAt: null });
    });

    it('purges in batches and says how much each one did', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      await selectAcknowledged('C2');
      await sink.storeBatch(
        (await sink.selectedContainers()).find((c) => c.externalId === 'C2')!,
        batch([{ ...doc('e1', 'c'), externalId: 'e1' }]),
      );
      for (const id of ['C1', 'C2']) {
        await store.selectContainer('slack-1', (await rowFor(id)).id, {
          selected: false,
          by: 'ada',
          acknowledged: false,
        });
      }
      expect(await store.purgeBatch(1)).toMatchObject({ containers: 1 });
      expect(await store.purgeBatch(1)).toMatchObject({ containers: 1 });
      expect(await store.purgeBatch(1)).toEqual({ containers: 0, documents: 0 });
      expect((await database.db.query('SELECT 1 FROM knowledge_documents')).rows).toEqual([]);
    });

    it('sweeps people nothing refers to, whatever connector they belonged to', async () => {
      const other = new PostgresKnowledgeSink({ connectorId: 'slack-9', store });
      await other.upsertPrincipals([
        { externalId: 'U7', kind: 'user', displayName: 'Lin', active: true },
      ]);
      // slack-1 has C1 selected, so its person stays; slack-9 has no container at all.
      expect(await store.sweepUnusedPrincipals()).toBe(1);
      expect(await principals('slack-9')).toEqual([]);
      expect(await principals('slack-1')).toEqual(['U1']);
    });

    // Connector ids are chosen by the caller and can be used again. A new
    // connector must not start with what an earlier one with its id indexed,
    // selected or acknowledged.
    describe('a connector id that is used again', () => {
      const born = '2026-10-05T00:00:00.000Z';

      it('clears what an earlier connector left, when the new one first appears', async () => {
        await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
        // C1 marked for purging, and C2, which holds nothing, removed.
        expect(await store.beginConnectorLife('slack-1', born, 'system')).toBe(2);
        expect(await sink.selectedContainers()).toEqual([]);
        await store.purgeRequested();
        expect(await containerIds('slack-1')).toEqual([]);
        expect(await principals('slack-1')).toEqual([]);
      });

      it('leaves a connector’s own content alone from then on', async () => {
        expect(await store.beginConnectorLife('slack-1', born, 'system')).toBeGreaterThan(0);
        await sink.upsertContainers([C1, C2]);
        await store.setSelected('slack-1', 'C1', true, 'ada');
        await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));

        // Null: a connector the store already knows. Nothing was looked at.
        expect(await store.beginConnectorLife('slack-1', born, 'system')).toBeNull();
        expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1']);
        expect((await database.db.query('SELECT 1 FROM knowledge_documents')).rows).toHaveLength(1);
      });

      it('starts over for a later connector with the same id, and after a delete', async () => {
        expect(await store.beginConnectorLife('slack-1', born, 'system')).not.toBeNull();
        // A new life for an id that holds nothing by now: zero rows, not null.
        expect(
          await store.beginConnectorLife('slack-1', '2026-11-01T00:00:00.000Z', 'system'),
        ).toBe(0);
        await store.deselectConnector('slack-1', 'ada');
        // The deleted connector's record is gone with it.
        expect(
          await store.beginConnectorLife('slack-1', '2026-11-01T00:00:00.000Z', 'system'),
        ).toBe(0);
      });

      // A check made for a connector that has since been deleted and replaced
      // (a request that was slow, a process with an older registry) arrives
      // after the newer connector's. It must not clear what the newer one holds.
      it('leaves everything alone when the id is on record for a later connector', async () => {
        const later = '2026-11-01T00:00:00.000Z';
        await store.beginConnectorLife('slack-1', later, 'system');
        await sink.upsertContainers([C1, C2]);
        await store.setSelected('slack-1', 'C1', true, 'ada');

        expect(await store.beginConnectorLife('slack-1', born, 'system')).toBeNull();
        expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1']);
        expect(await store.getState('connector-life:slack-1')).toBe(later);
      });
    });

    // The picker reads a container's row and then writes to it. A delete of
    // the connector, or a listing that no longer has the container, can land
    // in between: selecting the row then would keep what was being removed.
    it('does not select a container that is on its way out with its connector', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const c1 = await rowFor('C1');
      await store.deselectConnector('slack-1', 'ada');

      expect(
        await store.selectContainer('slack-1', c1.id, {
          selected: true,
          by: 'ada',
          acknowledged: true,
        }),
      ).toBe(false);
      expect(await rowFor('C1')).toMatchObject({ selected: false });
      expect((await rowFor('C1')).purgeRequestedAt).not.toBeNull();
      expect(await store.purgeRequested()).toBe(1);
      expect(await containerIds('slack-1')).toEqual([]);
    });

    it('says whether there was a container to select or deselect', async () => {
      const c2 = await rowFor('C2');
      const change = (id: string, selected: boolean) =>
        store.selectContainer('slack-1', id, { selected, by: 'ada', acknowledged: true });
      expect(await change(c2.id, true)).toBe(true);
      expect(await change(c2.id, false)).toBe(true);
      expect(await change('99999999-9999-4999-8999-999999999999', true)).toBe(false);
      expect(await change('99999999-9999-4999-8999-999999999999', false)).toBe(false);

      // Gone at the source: it can be deselected, which is how what it holds
      // is removed, and not selected.
      await change(c2.id, true);
      await sink.upsertContainers([C1]);
      expect(await change(c2.id, true)).toBe(false);
      expect(await change(c2.id, false)).toBe(true);
    });

    // Clearing twice (a delete tried again, the check of a new connector made
    // while the old one's purge is pending) finds nothing new to clear: the
    // count is what it removed or marked this time, and rows already on their
    // way out keep who deselected them and when their purge was asked for.
    it('counts only what a clearing changed, and leaves rows already on their way out as they are', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      // C1 marked, C2 (empty) removed; the people stay until C1 is purged.
      expect(await store.deselectConnector('slack-1', 'ada')).toBe(2);
      const marked = await database.db.query<{ selected_by: string; purge_requested_at: Date }>(
        `SELECT selected_by, purge_requested_at FROM knowledge_containers WHERE connector_id = 'slack-1'`,
      );

      expect(await store.deselectConnector('slack-1', 'someone-else')).toBe(0);
      expect(await store.beginConnectorLife('slack-1', '2026-10-05T00:00:00.000Z', 'system')).toBe(
        0,
      );
      const after = await database.db.query<{ selected_by: string; purge_requested_at: Date }>(
        `SELECT selected_by, purge_requested_at FROM knowledge_containers WHERE connector_id = 'slack-1'`,
      );
      expect(after.rows).toEqual(marked.rows);
      expect(after.rows[0]!.selected_by).toBe('ada');
    });

    it('removes a container the source no longer has once it is deselected and purged', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await sink.upsertContainers([C2]); // C1 is gone at the source, still selected
      expect(await containerIds('slack-1')).toEqual(['C1', 'C2']);
      await store.selectContainer('slack-1', (await rowFor('C1')).id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      await store.purgeRequested();
      expect(await containerIds('slack-1')).toEqual(['C2']);
    });

    it('keeps the row of a deselected container the source still lists', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      await store.selectContainer('slack-1', (await rowFor('C1')).id, {
        selected: false,
        by: 'ada',
        acknowledged: false,
      });
      await store.purgeRequested();
      expect(await containerIds('slack-1')).toEqual(['C1', 'C2']);
    });

    // An id is reused: what the deleted connector left is on its way out, and
    // the new connector's first listing brings its containers back, unselected.
    it('lets a new connector with the same id list its containers afresh', async () => {
      await selectAcknowledged('C2');
      await store.deselectConnector('slack-1', 'ada');
      await sink.upsertContainers([C1, C2]);
      await store.purgeRequested();
      const rows = await database.db.query<{
        external_id: string;
        selected: boolean;
        acked: string | null;
      }>(
        `SELECT external_id, selected, visibility_acknowledged_by AS acked FROM knowledge_containers
          WHERE connector_id = 'slack-1' ORDER BY external_id`,
      );
      expect(rows.rows).toEqual([
        { external_id: 'C1', selected: false, acked: null },
        { external_id: 'C2', selected: false, acked: null },
      ]);
    });

    it('says whether a connector has anything selected', async () => {
      expect(await store.hasSelection('slack-1')).toBe(true);
      expect(await store.hasSelection('slack-2')).toBe(false);
      await store.deselectConnector('slack-1', 'ada');
      expect(await store.hasSelection('slack-1')).toBe(false);
    });
  });

  describe('state and retention', () => {
    it('round-trips state and deletes old tombstones only', async () => {
      await store.setState('dictionary', { version: 3 });
      expect(await store.getState<{ version: number }>('dictionary')).toEqual({ version: 3 });
      expect(await store.getState('missing')).toBeNull();

      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      await sink.pruneMissing(await selectedC1(), ['d2']);
      await database.db.query(
        `UPDATE knowledge_documents SET deleted_at = now() - interval '40 days' WHERE external_id = 'd1'`,
      );
      expect(await store.deleteTombstonesOlderThan(30)).toBe(1);
      const { rows } = await database.db.query<{ external_id: string }>(
        `SELECT external_id FROM knowledge_documents ORDER BY external_id`,
      );
      expect(rows.map((r) => r.external_id)).toEqual(['d2']);
    });
  });
});
