/**
 * Neo4j-BACKED integration test for the `_claims_rev` OPTIMISTIC-CONCURRENCY guard
 * added to `mergeNode` (task T0 of the manual-edit write path).
 *
 * api-server's manual-edit writers take a write-lock by bumping `_claims_rev` in a
 * single tx. core-writer is NOT a participant in that lock — it reads `_claims` in a
 * separate read tx, resolves app-side, then writes in a later write tx. Without a CAS
 * on `_claims_rev`, a connector resync that read at T0 would clobber a manual claim an
 * api-server writer committed at T1. This suite asserts the CAS in REAL Cypher (the
 * comparison runs against the live stored value, so it cannot be faked in the unit
 * suite — neo4j-driver returns stored integers as lossless `Integer` objects).
 *
 * Gated on NEO4J_TEST_URI: with no env the whole suite is skipped (default `pnpm test`
 * stays Docker-free). CI's `integration` job provides Neo4j. Writes use a unique
 * per-run id prefix and clean up after themselves.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { CanonicalNode, PropertyClaim } from '@shipit-ai/shared';
import { Neo4jClient } from '../neo4j/client.js';
import { mergeNode, getExistingClaims } from '../neo4j/queries.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

const RUN = `crev-${process.pid}-${Math.floor(performance.now())}`;
const idFor = (name: string): string => `shipit://Repository/${RUN}/${name}`;

const EPOCH = 1_719_000_000_000;

function node(name: string, claims: PropertyClaim[]): CanonicalNode {
  return {
    id: idFor(name),
    label: 'Repository',
    properties: { name },
    _claims: claims,
    _source_system: 'github',
    _source_org: 'github/itest',
    _source_id: `github://itest/${name}`,
    _last_synced: '2026-06-21T00:00:00Z',
    _event_version: EPOCH,
  };
}

const claim = (source: string, value: unknown): PropertyClaim => ({
  property_key: 'tier',
  value,
  source,
  source_id: `${source}://itest/x`,
  ingested_at: '2026-06-21T00:00:00Z',
  confidence: 0.9,
  evidence: null,
});

describe.skipIf(!URI)('mergeNode _claims_rev CAS — Neo4j integration', () => {
  let client: Neo4jClient;

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
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

  const merge = (n: CanonicalNode, expectedRev: number) =>
    client.executeWrite(
      async (tx) => mergeNode(tx, n, n._claims, { tier: n._claims[0]?.value }, expectedRev),
      DATABASE,
    );

  const read = (id: string) =>
    client.executeRead(async (tx) => getExistingClaims(tx, id), DATABASE);

  it('(a) writes claims and bumps _claims_rev when the rev is unchanged', async () => {
    // First write: stored rev is null → coalesced to 0 → matches expected 0.
    const r1 = await merge(node('a', [claim('github', 'gold')]), 0);
    expect(r1.written).toBe(true);
    expect(r1.claimsWritten).toBe(true);
    expect(r1.claimsConflict).toBe(false);
    expect((await read(idFor('a'))).claimsRev).toBe(1);

    // Second write threading the just-read rev (1) → matches → writes + bumps to 2.
    const r2 = await merge(node('a', [claim('github', 'silver')]), 1);
    expect(r2.claimsWritten).toBe(true);
    const after = await read(idFor('a'));
    expect(after.claimsRev).toBe(2);
    expect(after.claims.find((c) => c.source === 'github')?.value).toBe('silver');
  });

  it('(b) does NOT overwrite _claims and reports a conflict when the rev changed since read', async () => {
    // Seed a node with a manual claim and rev=1 (as an api-server write-lock would).
    await merge(node('b', [claim('manual', 'human-override')]), 0);
    expect((await read(idFor('b'))).claimsRev).toBe(1);

    // core-writer "read" happened when rev was still 0 (stale): expectedRev=0 but
    // stored is now 1. The connector tries to overwrite tier with its own value.
    const r = await merge(node('b', [claim('github', 'connector-value')]), 0);
    expect(r.claimsConflict).toBe(true);
    expect(r.claimsWritten).toBe(false);
    expect(r.written).toBe(true); // freshness guard still refreshed node props/version

    // The manual claim survives untouched; rev did NOT advance (no claims write).
    const after = await read(idFor('b'));
    expect(after.claimsRev).toBe(1);
    expect(after.claims).toHaveLength(1);
    expect(after.claims[0].source).toBe('manual');
    expect(after.claims[0].value).toBe('human-override');
  });
});
