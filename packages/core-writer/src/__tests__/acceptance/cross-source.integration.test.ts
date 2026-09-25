/**
 * Cross-source ACCEPTANCE test (spec §Testing; success criteria 1, 3, 4).
 * GitHub fixtures + the reference cluster flow through the real CoreWriter into
 * Neo4j; the graph is then queried the way blast_radius does; finally a
 * sync.completed sweep hides a workload that vanished. Gated on NEO4J_TEST_URI;
 * wipes the graph; serial in CI (shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEPENDENCY_EDGE_PATTERN } from '@shipit-ai/shared';
import type { CanonicalEntity, EventEnvelope } from '@shipit-ai/shared';
import { buildIdempotencyKey } from '@shipit-ai/event-bus';
import { normalizeRepository, normalizeTeam } from '@shipit-ai/connector-github';
import {
  normalizeCluster,
  normalizeNamespace,
  normalizeWorkload,
} from '@shipit-ai/connector-kubernetes';
import { CoreWriter } from '../../writer.js';
import { DEFAULT_CONFIG } from '../../config.js';
import { Neo4jClient } from '../../neo4j/client.js';
import { Neo4jNodeWriter } from '../../neo4j/node-writer.js';
import { Neo4jLinkingKeyIndex } from '../../neo4j/linking-key-index.js';
import { Neo4jIdempotencyChecker } from '../../neo4j/idempotency-checker.js';
import {
  ALL_DEPLOYMENTS,
  GITHUB_CONNECTOR,
  GITHUB_ORG,
  K8S_CONNECTOR,
  REPO_ID,
  SERVICE_ID,
  TEAM_ID,
  WEB_UI_ARTIFACT_ID,
  WEB_UI_ID,
  contextAt,
  referenceCluster,
  referenceNamespace,
  referenceRepo,
  referenceTeam,
  referenceWorkloads,
} from './reference-cluster.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

// Same shape the BullMQ producer emits: one envelope per node carrying the whole entity.
function envelopes(entity: CanonicalEntity, connectorId: string): EventEnvelope[] {
  const now = new Date().toISOString();
  return entity.nodes.map((node) => ({
    id: randomUUID(),
    timestamp: now,
    connector_id: connectorId,
    idempotency_key: buildIdempotencyKey(connectorId, node),
    payload: entity,
  }));
}

function controlEnvelope(connectorId: string, startedAt: string): EventEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    connector_id: connectorId,
    idempotency_key: `${connectorId}~sync-completed~${Date.parse(startedAt)}`,
    payload: { nodes: [], edges: [] },
    kind: 'sync.completed',
    control: { kind: 'sync.completed', startedAt, mode: 'full' },
  };
}

function merge(
  ...parts: Array<{ nodes: CanonicalEntity['nodes']; edges: CanonicalEntity['edges'] }>
): CanonicalEntity {
  const nodes = new Map<string, CanonicalEntity['nodes'][number]>();
  const edges = new Map<string, CanonicalEntity['edges'][number]>();
  for (const p of parts) {
    for (const n of p.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of p.edges) {
      const key = `${e.type}|${e.from}|${e.to}`;
      const prev = edges.get(key);
      if (!prev || e._confidence > prev._confidence) edges.set(key, e);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// The REAL generator mcp-server serves blast_radius from — not a hand-kept
// copy of its Cypher, which could not catch a divergence in the generator
// (M7). BOTH traverses dependency edges only, which is what this acceptance
// case is about: repository → workloads.

describe.skipIf(!URI)('acceptance — GitHub + Kubernetes cross-source graph', () => {
  let client: Neo4jClient;
  let writer: CoreWriter;
  let connected = false;
  // Captured at the end of run 1; run 2 asserts the graph is byte-for-byte
  // unchanged by its own (fully-duplicate) processBatch call, before the sweep
  // marks anything absent.
  let nodeCountAfterRun1 = 0;
  let edgeCountAfterRun1 = 0;

  // Deployment ids reachable from the repository, traversed with the SAME edge
  // list mcp-server's blast_radius builds its query from (M7). Importing the
  // shared constant is what makes a new dependency edge type show up here
  // instead of silently diverging from a hand-kept copy.
  //
  // Why the constant and not `generateBlastRadiusCypher` itself: core-writer's
  // Dockerfile builder COPYs a fixed package set that does not include
  // mcp-server, and `tsc` compiles this test file during the image build — a
  // cross-package test-only import breaks `Docker Build (core-writer)`. See
  // docs/agent/scars/docker-builder-copies-fixed-package-set.md.
  const blastDeploymentIds = async (includeAbsent: boolean): Promise<string[]> => {
    const absentFilter = includeAbsent ? '' : ' AND n._absent_since IS NULL';
    return ids(
      `MATCH (r:Repository {id: $id})-[:${DEPENDENCY_EDGE_PATTERN}*1..2]-(n:Deployment)
       WHERE n <> r${absentFilter}
       RETURN DISTINCT n.id AS id`,
      { id: REPO_ID },
    );
  };

  const wipe = () =>
    client.executeWrite(async (tx) => tx.run('MATCH (n) DETACH DELETE n'), DATABASE);
  const rows = (cypher: string, params: Record<string, unknown> = {}) =>
    client.executeRead(async (tx) => (await tx.run(cypher, params)).records, DATABASE);
  const ids = async (cypher: string, params: Record<string, unknown> = {}) =>
    (await rows(cypher, params)).map((r) => String(r.get('id'))).sort();
  const count = async (cypher: string, params: Record<string, unknown> = {}) => {
    const c = (await rows(cypher, params))[0].get('c') as { toNumber?: () => number } | number;
    return typeof c === 'object' && c.toNumber ? c.toNumber() : Number(c);
  };

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    connected = true;
    writer = new CoreWriter(
      new Neo4jNodeWriter(client, DATABASE),
      new Neo4jLinkingKeyIndex(client, DATABASE),
      new Neo4jIdempotencyChecker(client, 30, DATABASE),
      DEFAULT_CONFIG,
    );
    await wipe();
  });

  afterAll(async () => {
    // If beforeAll's connect() threw, `driver` is still null — wiping would
    // mask the real connection error behind "Neo4j client not connected".
    if (connected) await wipe();
    await client?.close();
  });

  // Each envelope carries the whole entity and the writer re-walks it, so run 1
  // issues several hundred Cypher round trips against CI's Neo4j service.
  it(
    'run 1: both sources land and the workloads link to the repository and team',
    { timeout: 120_000 },
    async () => {
      const T1 = '2026-09-16T12:00:00.000Z';
      const github = merge(
        normalizeRepository(referenceRepo, GITHUB_ORG),
        normalizeTeam(referenceTeam, GITHUB_ORG),
      );
      const ctx = contextAt(T1);
      const k8s = merge(
        normalizeCluster(referenceCluster, ctx),
        normalizeNamespace(referenceNamespace, ctx),
        ...referenceWorkloads.map((w) => normalizeWorkload(w, ctx)),
      );

      const r1 = await writer.processBatch(envelopes(github, GITHUB_CONNECTOR));
      const r2 = await writer.processBatch(envelopes(k8s, K8S_CONNECTOR));
      expect(r1.errors).toEqual([]);
      expect(r2.errors).toEqual([]);

      expect(await ids('MATCH (d:Deployment) RETURN d.id AS id')).toEqual(ALL_DEPLOYMENTS);
      expect(await ids('MATCH (c:Cluster) RETURN c.id AS id')).toEqual([
        'shipit://cluster/default/shipit-demo',
      ]);

      // Deployment → BuildArtifact → Repository (annotation tier on api-server)
      expect(
        await ids(
          `MATCH (d:Deployment {name: 'api-server'})-[:RUNS_IMAGE]->(:BuildArtifact)-[:BUILT_FROM]->(r:Repository) RETURN r.id AS id`,
        ),
      ).toEqual([REPO_ID]);

      // One LogicalService, linked to the repo by the best available signal
      const impl = await rows(
        `MATCH (s:LogicalService {id: $s})-[e:IMPLEMENTED_BY]->(r:Repository) RETURN r.id AS id, e.link_method AS method, e._confidence AS confidence`,
        { s: SERVICE_ID },
      );
      expect(impl).toHaveLength(1);
      expect(String(impl[0].get('id'))).toBe(REPO_ID);
      expect(impl[0].get('method')).toBe('annotation');
      expect(Number(impl[0].get('confidence'))).toBe(1);

      // Team OWNS LogicalService via the namespace team label
      expect(
        await ids(`MATCH (t:Team)-[:OWNS]->(s:LogicalService {id: $s}) RETURN t.id AS id`, {
          s: SERVICE_ID,
        }),
      ).toEqual([TEAM_ID]);

      // Success criterion 3: blast radius from the repository reaches every workload
      expect(await blastDeploymentIds(false)).toEqual(ALL_DEPLOYMENTS);

      // Structural edges nothing above checks: web-ui RUNS_IN its Namespace, that
      // Namespace is PART_OF the Cluster, and web-ui RUNS_IN_ENV an Environment.
      // Their re-emission in run 2 (for the survivors, not web-ui) is exactly what
      // keeps run 2's node/edge counts stable below — load-bearing for that check.
      expect(
        await count(
          `MATCH (d:Deployment {id: $id})-[:RUNS_IN]->(:Namespace)-[:PART_OF]->(:Cluster)
         MATCH (d)-[:RUNS_IN_ENV]->(:Environment)
         RETURN count(d) AS c`,
          { id: WEB_UI_ID },
        ),
      ).toBe(1);

      nodeCountAfterRun1 = await count('MATCH (n) RETURN count(n) AS c');
      edgeCountAfterRun1 = await count('MATCH ()-[r]->() RETURN count(r) AS c');
    },
  );

  // Depends on run 1's graph (the wipe is beforeAll, not beforeEach) — running
  // this file with `-t 'run 2'` in isolation is expected to fail.
  it(
    'run 2: a vanished workload is marked absent and hidden from the traversal',
    { timeout: 120_000 },
    async () => {
      const T2 = '2026-09-16T12:10:00.000Z';
      const ctx = contextAt(T2);
      const survivors = referenceWorkloads.filter((w) => w.object.metadata?.name !== 'web-ui');
      const k8s = merge(
        normalizeCluster(referenceCluster, ctx),
        normalizeNamespace(referenceNamespace, ctx),
        ...survivors.map((w) => normalizeWorkload(w, ctx)),
      );
      const rerun = await writer.processBatch(envelopes(k8s, K8S_CONNECTOR));
      expect(rerun.errors).toEqual([]);
      // Unchanged content is deduped — nothing is (re)written; only `_last_synced`
      // is touched. (`duplicatesSkipped > 0` would also pass if cross-run dedup
      // were completely broken — each envelope re-walks the whole payload, so a
      // single run already produces dozens of within-run duplicates on its own.)
      expect(rerun.nodesWritten).toBe(0);
      expect(rerun.freshnessSkipped).toBe(0);
      // Graph-level idempotency: the vanished web-ui nodes are still present at
      // this point (only the sweep below marks them absent), so this must be exact.
      expect(await count('MATCH (n) RETURN count(n) AS c')).toBe(nodeCountAfterRun1);
      expect(await count('MATCH ()-[r]->() RETURN count(r) AS c')).toBe(edgeCountAfterRun1);

      const sweep = await writer.processBatch([
        controlEnvelope(K8S_CONNECTOR, '2026-09-16T12:05:00.000Z'),
      ]);
      // The workload AND its (now unreferenced) image artifact were both unseen.
      expect(sweep.absentMarked).toBe(2);
      expect(await ids('MATCH (n) WHERE n._absent_since IS NOT NULL RETURN n.id AS id')).toEqual(
        [WEB_UI_ARTIFACT_ID, WEB_UI_ID].sort(),
      );

      // Success criterion 4: hidden by default, visible on request
      expect(await blastDeploymentIds(false)).toEqual(
        ALL_DEPLOYMENTS.filter((id) => id !== WEB_UI_ID),
      );
      expect(await blastDeploymentIds(true)).toEqual(ALL_DEPLOYMENTS);

      // GitHub's nodes belong to another instance and are never swept by k8s
      expect(
        await ids(`MATCH (r:Repository) WHERE r._absent_since IS NULL RETURN r.id AS id`),
      ).toEqual([REPO_ID]);
    },
  );
});
