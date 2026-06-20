/**
 * Neo4j-BACKED integration test for the core-writer storage round-trips that the
 * mocked unit suite cannot exercise (it replaces these with JS fakes):
 *   - linking-key register/lookup (MERGE upsert, case sensitivity, no dup forks)
 *   - mergeEdge: real MATCH-MATCH-MERGE, incl. the SILENT no-op when an endpoint
 *     is absent (the out-of-order-delivery hazard)
 *   - getExistingClaims: the `_claims` JSON round-trip
 *   - idempotency record/isDuplicate + cleanupExpired (lossless-Integer count)
 *
 * Gated on NEO4J_TEST_URI (skips by default). Requires an isolated/scratch DB —
 * each test wipes the graph. Runs in the CI `integration` job (serial via
 * --no-file-parallelism; see the shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';
import { Neo4jClient } from '../neo4j/client.js';
import { Neo4jNodeWriter } from '../neo4j/node-writer.js';
import { Neo4jLinkingKeyIndex } from '../neo4j/linking-key-index.js';
import { Neo4jIdempotencyChecker } from '../neo4j/idempotency-checker.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

function repo(name: string, claims: PropertyClaim[] = []): CanonicalNode {
  return {
    id: `shipit://Repository/default/acme/${name}`,
    label: 'Repository',
    properties: { name },
    _claims: claims,
    _source_system: 'github',
    _source_org: 'github/acme',
    _source_id: `github://acme/${name}`,
    _last_synced: '2026-06-19T00:00:00Z',
    _event_version: 1_719_000_000_000,
  };
}

const claim = (key: string, value: unknown): PropertyClaim => ({
  property_key: key,
  value,
  source: 'github',
  source_id: 'github://acme/x',
  ingested_at: '2026-06-19T00:00:00Z',
  confidence: 0.9,
  evidence: null,
});

describe.skipIf(!URI)('core-writer Neo4j storage — integration', () => {
  let client: Neo4jClient;
  let writer: Neo4jNodeWriter;
  let links: Neo4jLinkingKeyIndex;
  let idem: Neo4jIdempotencyChecker;

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    writer = new Neo4jNodeWriter(client, DATABASE);
    links = new Neo4jLinkingKeyIndex(client, DATABASE);
    idem = new Neo4jIdempotencyChecker(client, 30, DATABASE);
  });

  afterEach(async () => {
    await client.executeWrite(async (tx) => tx.run('MATCH (n) DETACH DELETE n'), DATABASE);
  });

  afterAll(async () => {
    await client?.close();
  });

  const count = (cypher: string, params: Record<string, unknown> = {}) =>
    client.executeRead(async (tx) => {
      const r = await tx.run(cypher, params);
      const c = r.records[0].get('c');
      return typeof c === 'object' && 'toNumber' in c ? c.toNumber() : Number(c);
    }, DATABASE);

  describe('linking-key index', () => {
    it('register → lookup round-trips and re-register upserts without duplicating', async () => {
      await links.register('shipit://Repository/default/acme/web', 'github://acme/web');
      expect(await links.lookupByLinkingKey('github://acme/web')).toBe(
        'shipit://Repository/default/acme/web',
      );
      // Re-register the same key to a new canonical id → MERGE upsert, still ONE node.
      await links.register('shipit://Repository/default/acme/web2', 'github://acme/web');
      expect(await links.lookupByLinkingKey('github://acme/web')).toBe(
        'shipit://Repository/default/acme/web2',
      );
      expect(await count('MATCH (lk:_LinkingKey) RETURN count(lk) AS c')).toBe(1);
    });

    it('lookup is case-sensitive and hasCanonicalId reflects presence', async () => {
      await writer.writeNode(repo('web'), [], {});
      await links.register('shipit://Repository/default/acme/web', 'github://acme/web');
      expect(await links.lookupByLinkingKey('GITHUB://ACME/WEB')).toBeNull();
      expect(await links.hasCanonicalId('shipit://Repository/default/acme/web')).toBe(true);
      expect(await links.hasCanonicalId('shipit://Repository/default/acme/nope')).toBe(false);
    });
  });

  describe('mergeEdge', () => {
    it('creates the edge when both endpoints exist', async () => {
      await writer.writeNode(repo('web'), [], {});
      await writer.writeNode(repo('api'), [], {});
      const edge: CanonicalEdge = {
        type: 'DEPENDS_ON',
        from: 'shipit://Repository/default/acme/web',
        to: 'shipit://Repository/default/acme/api',
        properties: { reason: 'imports' },
        _source: 'github',
        _confidence: 0.9,
        _ingested_at: '2026-06-19T00:00:00Z',
      };
      await writer.writeEdge(edge);
      expect(await count('MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS c')).toBe(1);
    });

    it('is a SILENT no-op when an endpoint is missing (out-of-order hazard)', async () => {
      await writer.writeNode(repo('web'), [], {});
      // target 'ghost' was never written
      const edge: CanonicalEdge = {
        type: 'DEPENDS_ON',
        from: 'shipit://Repository/default/acme/web',
        to: 'shipit://Repository/default/acme/ghost',
        _source: 'github',
        _confidence: 0.9,
        _ingested_at: '2026-06-19T00:00:00Z',
      };
      await expect(writer.writeEdge(edge)).resolves.toBeUndefined(); // no throw
      expect(await count('MATCH ()-[r]->() RETURN count(r) AS c')).toBe(0); // no edge
    });
  });

  describe('getExistingClaims', () => {
    it('round-trips _claims JSON and returns [] for a missing node', async () => {
      const claims = [claim('name', 'web'), claim('language', 'TypeScript')];
      await writer.writeNode(repo('web', claims), claims, {});
      const read = await writer.getExistingClaims('shipit://Repository/default/acme/web');
      expect(read).toHaveLength(2);
      expect(read.map((c) => c.property_key).sort()).toEqual(['language', 'name']);
      expect(read.find((c) => c.property_key === 'language')?.value).toBe('TypeScript');
      expect(await writer.getExistingClaims('shipit://Repository/default/acme/missing')).toEqual(
        [],
      );
    });
  });

  describe('idempotency log', () => {
    it('record → isDuplicate; unknown key is not a duplicate', async () => {
      expect(await idem.isDuplicate('k1')).toBe(false);
      await idem.record('k1');
      expect(await idem.isDuplicate('k1')).toBe(true);
    });

    it('cleanupExpired deletes only past-expiry entries and returns the count', async () => {
      await idem.record('fresh'); // expires_at = now + 30d (future)
      await client.executeWrite(
        async (tx) =>
          tx.run(
            `CREATE (:_IdempotencyLog {key:'stale', created_at:'2020-01-01T00:00:00Z', expires_at:'2020-02-01T00:00:00Z'})`,
          ),
        DATABASE,
      );
      const deleted = await idem.cleanupExpired();
      expect(deleted).toBe(1);
      expect(await idem.isDuplicate('stale')).toBe(false);
      expect(await idem.isDuplicate('fresh')).toBe(true);
    });
  });
});
