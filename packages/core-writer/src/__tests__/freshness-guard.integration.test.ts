/**
 * Neo4j-BACKED integration test for the Cut B freshness guard.
 *
 * The guard is an atomic compare-and-set INSIDE the `mergeNode` Cypher (the
 * audit's fix for a read-then-write TOCTOU race). That ordering decision lives
 * in Cypher by design and CANNOT be exercised by the mocked unit suite — and
 * neo4j-driver returns stored integers as lossless `Integer` objects, so the
 * legacy-version path only behaves correctly against a real database. This
 * suite runs the real `Neo4jNodeWriter` → real Cypher → real Neo4j.
 *
 * Gated on NEO4J_TEST_URI: with no env the whole suite is skipped (so the
 * default `pnpm test` stays Docker-free and fast). CI's `integration` job
 * provides an ephemeral Neo4j service and sets the env. Writes use a unique
 * per-run id prefix + `Repository` label and clean up after themselves, so it
 * is safe to point at any scratch database.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { CanonicalNode } from '@shipit-ai/shared';
import { Neo4jClient } from '../neo4j/client.js';
import { Neo4jNodeWriter } from '../neo4j/node-writer.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE; // undefined → driver default

// Unique prefix so concurrent runs / a shared scratch DB never collide.
const RUN = `itest-${process.pid}-${Math.floor(performance.now())}`;
const idFor = (name: string): string => `shipit://Repository/${RUN}/${name}`;

const EPOCH_OLD = 1_718_000_000_000;
const EPOCH_NEW = 1_719_000_000_000;

function node(name: string, version: number | string, lastSynced: string, rev = ''): CanonicalNode {
  return {
    id: idFor(name),
    label: 'Repository',
    properties: { name, rev: rev || String(version) },
    _claims: [],
    _source_system: 'github',
    _source_org: 'github/itest',
    _source_id: `github://itest/${name}`,
    _last_synced: lastSynced,
    _event_version: version,
  };
}

describe.skipIf(!URI)('freshness guard — Neo4j integration', () => {
  let client: Neo4jClient;
  let writer: Neo4jNodeWriter;

  const read = (id: string) =>
    client.executeRead(async (tx) => {
      const r = await tx.run(
        `MATCH (n {id:$id}) RETURN n._event_version AS v, n._last_synced AS ls`,
        {
          id,
        },
      );
      if (r.records.length === 0) return null;
      const v = r.records[0].get('v');
      const num = v !== null && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : v;
      return { version: num, lastSynced: r.records[0].get('ls') as string };
    }, DATABASE);

  const write = (n: CanonicalNode) => writer.writeNode(n, n._claims, n.properties);

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    writer = new Neo4jNodeWriter(client, DATABASE);
  });

  afterEach(async () => {
    await client.executeWrite(
      async (tx) => tx.run(`MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n`, { p: idFor('') }),
      DATABASE,
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  it('first write is accepted and persists the version', async () => {
    const r = await write(node('a', EPOCH_NEW, '2026-06-21T00:00:00Z'));
    expect(r.written).toBe(true);
    expect((await read(idFor('a')))?.version).toBe(EPOCH_NEW);
  });

  it('accepts a strictly-newer delivery', async () => {
    await write(node('b', EPOCH_OLD, '2026-06-10T00:00:00Z'));
    const r = await write(node('b', EPOCH_NEW, '2026-06-21T00:00:00Z'));
    expect(r.written).toBe(true);
    expect((await read(idFor('b')))?.version).toBe(EPOCH_NEW);
  });

  it('REJECTS a strictly-older delivery and leaves stored state intact', async () => {
    await write(node('c', EPOCH_NEW, '2026-06-21T00:00:00Z', 'new'));
    const r = await write(node('c', EPOCH_OLD, '2026-06-10T00:00:00Z', 'old'));
    expect(r.written).toBe(false);
    const stored = await read(idFor('c'));
    expect(stored?.version).toBe(EPOCH_NEW);
    expect(stored?.lastSynced).toBe('2026-06-21T00:00:00Z'); // not moved backward
  });

  it('accepts an equal-version delivery whose content differs (strict > guard)', async () => {
    await write(node('d', EPOCH_NEW, '2026-06-21T00:00:00Z', 'v1'));
    const r = await write(node('d', EPOCH_NEW, '2026-06-22T00:00:00Z', 'v2'));
    expect(r.written).toBe(true);
  });

  it('legacy stored Integer 1 accepts an incoming epoch (lossless-Integer round-trip)', async () => {
    // Persist a legacy node exactly as the pre-Cut-B normalizers did: a Cypher integer.
    await client.executeWrite(
      async (tx) =>
        tx.run(
          `CREATE (n:Repository {id:$id, _event_version: 1, _last_synced:'2026-01-01T00:00:00Z'})`,
          {
            id: idFor('legacy'),
          },
        ),
      DATABASE,
    );
    const r = await write(node('legacy', EPOCH_NEW, '2026-06-21T00:00:00Z'));
    expect(r.written).toBe(true);
    expect((await read(idFor('legacy')))?.version).toBe(EPOCH_NEW);
  });

  it('content-hash (incomparable) versions always write — hashless last-writer-wins', async () => {
    await write(node('e', 'ch_aaa', '2026-06-21T00:00:00Z', 'x'));
    const r = await write(node('e', 'ch_bbb', '2026-06-10T00:00:00Z', 'y'));
    expect(r.written).toBe(true);
  });

  it('touchLastSynced advances forward but never backward', async () => {
    await write(node('f', EPOCH_NEW, '2026-06-15T00:00:00Z'));
    await writer.touchLastSynced(idFor('f'), '2026-06-20T00:00:00Z');
    expect((await read(idFor('f')))?.lastSynced).toBe('2026-06-20T00:00:00Z');
    await writer.touchLastSynced(idFor('f'), '2026-06-01T00:00:00Z'); // older → no-op
    expect((await read(idFor('f')))?.lastSynced).toBe('2026-06-20T00:00:00Z');
  });
});
