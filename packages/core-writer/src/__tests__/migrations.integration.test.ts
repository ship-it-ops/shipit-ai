/**
 * Neo4j-BACKED integration test for the boot-time DELETE migrations.
 *
 * `runCanonicalIdMigration` / `runPersonLoginCaseMigration` run `DETACH DELETE`
 * driven by Cypher `=~` regexes on EVERY core-writer boot (main.ts). The unit
 * suite (migrations.test.ts) only re-implements the regex strings as JS
 * `RegExp` and `.test()`s literals — it never runs the real Cypher, so neither
 * the blast radius (does it delete EXACTLY the old-format nodes and survive new
 * + unrelated?) nor the JS-`RegExp`-vs-Neo4j-`=~` anchoring divergence is
 * covered. This suite runs the real migration functions against a real Neo4j.
 *
 * Gated on NEO4J_TEST_URI (skips by default → unit run stays Docker-free).
 * REQUIRES AN ISOLATED/SCRATCH DATABASE: the migrations match graph-wide, and
 * each test wipes the graph in afterEach. CI's `integration` job provides an
 * ephemeral Neo4j service; never point this at a database with real data.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Neo4jClient } from '../neo4j/client.js';
import { runCanonicalIdMigration, runPersonLoginCaseMigration } from '../neo4j/migrations.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

describe.skipIf(!URI)('boot migrations — Neo4j integration', () => {
  let client: Neo4jClient;

  const run = (cypher: string, params: Record<string, unknown> = {}) =>
    client.executeWrite(async (tx) => {
      await tx.run(cypher, params);
    }, DATABASE);

  const ids = (cypher: string, params: Record<string, unknown> = {}) =>
    client.executeRead(async (tx) => {
      const r = await tx.run(cypher, params);
      return r.records.map((rec) => rec.get('id') as string).sort();
    }, DATABASE);

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
  });

  afterEach(async () => {
    await run('MATCH (n) DETACH DELETE n'); // isolated scratch DB — full reset
  });

  afterAll(async () => {
    await client?.close();
  });

  describe('runCanonicalIdMigration', () => {
    it('deletes EXACTLY old-format scoped nodes; new-format + unrelated survive', async () => {
      await run(`
        CREATE (:Repository {id:'shipit://repository/default/web'})
        CREATE (:Repository {id:'shipit://repository/default/acme/web'})
        CREATE (:Team {id:'shipit://team/default/platform'})
        CREATE (:Team {id:'shipit://team/default/acme/platform'})
        CREATE (:Pipeline {id:'shipit://pipeline/default/ci'})
        CREATE (:Person {id:'shipit://person/default/alice'})
      `);

      const stats = await runCanonicalIdMigration(client);

      expect(stats.nodesDeleted).toEqual({ repository: 1, team: 1, pipeline: 1 });
      expect(await ids('MATCH (n) RETURN n.id AS id')).toEqual(
        [
          'shipit://person/default/alice', // unrelated label — survives
          'shipit://repository/default/acme/web', // new format — survives
          'shipit://team/default/acme/platform', // new format — survives
        ].sort(),
      );
    });

    it('DETACH DELETE drops the old node’s relationships but keeps the other endpoint', async () => {
      await run(`
        CREATE (old:Repository {id:'shipit://repository/default/web'})
        CREATE (keep:Repository {id:'shipit://repository/default/acme/api'})
        CREATE (old)-[:DEPENDS_ON]->(keep)
      `);

      await runCanonicalIdMigration(client);

      expect(await ids('MATCH (n) RETURN n.id AS id')).toEqual([
        'shipit://repository/default/acme/api',
      ]);
      const rels = await client.executeRead(async (tx) => {
        const r = await tx.run('MATCH ()-[r]->() RETURN count(r) AS c');
        const c = r.records[0].get('c');
        return typeof c === 'object' && 'toNumber' in c ? c.toNumber() : Number(c);
      }, DATABASE);
      expect(rels).toBe(0);
    });

    it('deletes old-format _LinkingKey and _IdempotencyLog, preserves new-format', async () => {
      await run(`
        CREATE (:_LinkingKey {linking_key:'lk-old', canonical_id:'shipit://repository/default/web'})
        CREATE (:_LinkingKey {linking_key:'lk-new', canonical_id:'shipit://repository/default/acme/web'})
        CREATE (:_IdempotencyLog {key:'conn~shipit~//repository/default/web~123'})
        CREATE (:_IdempotencyLog {key:'conn~shipit~//repository/default/acme/web~123'})
      `);

      const stats = await runCanonicalIdMigration(client);

      expect(stats.linkingKeysDeleted.repository).toBe(1);
      expect(stats.idempotencyEntriesDeleted.repository).toBe(1);
      expect(await ids('MATCH (lk:_LinkingKey) RETURN lk.canonical_id AS id')).toEqual([
        'shipit://repository/default/acme/web',
      ]);
      expect(await ids('MATCH (i:_IdempotencyLog) RETURN i.key AS id')).toEqual([
        'conn~shipit~//repository/default/acme/web~123',
      ]);
    });

    it('is a clean no-op on an already-migrated graph (idempotent)', async () => {
      await run(`CREATE (:Repository {id:'shipit://repository/default/acme/web'})`);
      const stats = await runCanonicalIdMigration(client);
      expect(stats.nodesDeleted).toEqual({ repository: 0, team: 0, pipeline: 0 });
    });
  });

  describe('runPersonLoginCaseMigration', () => {
    it('deletes mixed-case Person ids; lowercase + non-Person uppercase survive', async () => {
      await run(`
        CREATE (:Person {id:'shipit://person/default/Mohamed-E'})
        CREATE (:Person {id:'shipit://person/default/mohamed-e'})
        CREATE (:Repository {id:'shipit://repository/default/acme/MyRepo'})
      `);

      const stats = await runPersonLoginCaseMigration(client);

      expect(stats.nodesDeleted).toBe(1);
      // lowercase Person survives; the uppercase REPOSITORY survives because the
      // broad `.*[A-Z].*` regex is fenced by the `person/default/` prefix guard.
      expect(await ids('MATCH (n) RETURN n.id AS id')).toEqual([
        'shipit://person/default/mohamed-e',
        'shipit://repository/default/acme/MyRepo',
      ]);
    });

    it('deletes mixed-case _LinkingKey/_IdempotencyLog and is idempotent on rerun', async () => {
      await run(`
        CREATE (:_LinkingKey {linking_key:'lk', canonical_id:'shipit://person/default/Mohamed-E'})
        CREATE (:_IdempotencyLog {key:'conn~shipit~//person/default/Mohamed-E~2026-06-14'})
      `);

      const first = await runPersonLoginCaseMigration(client);
      expect(first.linkingKeysDeleted).toBe(1);
      expect(first.idempotencyEntriesDeleted).toBe(1);

      const second = await runPersonLoginCaseMigration(client);
      expect(second).toEqual({
        nodesDeleted: 0,
        linkingKeysDeleted: 0,
        idempotencyEntriesDeleted: 0,
      });
    });
  });
});
