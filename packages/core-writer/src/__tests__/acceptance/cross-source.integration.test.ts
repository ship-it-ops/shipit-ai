/**
 * Cross-source ACCEPTANCE test (spec §Testing; success criteria 1, 3, 4).
 * GitHub fixtures + the reference cluster flow through the real CoreWriter into
 * Neo4j; the graph is then queried the way blast_radius does; finally a
 * sync.completed sweep hides a workload that vanished. Gated on NEO4J_TEST_URI;
 * wipes the graph; serial in CI (shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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

// Mirrors the MCP generator's BOTH direction over dependency edges.
const BLAST = `MATCH (r:Repository {id: $id})-[:IMPLEMENTED_BY|DEPLOYED_AS*1..2]-(n:Deployment)
  WHERE n._absent_since IS NULL RETURN DISTINCT n.id AS id`;
const BLAST_INCLUDING_ABSENT = `MATCH (r:Repository {id: $id})-[:IMPLEMENTED_BY|DEPLOYED_AS*1..2]-(n:Deployment)
  RETURN DISTINCT n.id AS id`;

describe.skipIf(!URI)('acceptance — GitHub + Kubernetes cross-source graph', () => {
  let client: Neo4jClient;
  let writer: CoreWriter;

  const wipe = () =>
    client.executeWrite(async (tx) => tx.run('MATCH (n) DETACH DELETE n'), DATABASE);
  const rows = (cypher: string, params: Record<string, unknown> = {}) =>
    client.executeRead(async (tx) => (await tx.run(cypher, params)).records, DATABASE);
  const ids = async (cypher: string, params: Record<string, unknown> = {}) =>
    (await rows(cypher, params)).map((r) => String(r.get('id'))).sort();

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    writer = new CoreWriter(
      new Neo4jNodeWriter(client, DATABASE),
      new Neo4jLinkingKeyIndex(client, DATABASE),
      new Neo4jIdempotencyChecker(client, 30, DATABASE),
      DEFAULT_CONFIG,
    );
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await client?.close();
  });

  it('run 1: both sources land and the workloads link to the repository and team', async () => {
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
    expect(await ids(BLAST, { id: REPO_ID })).toEqual(ALL_DEPLOYMENTS);
  });

  it('run 2: a vanished workload is marked absent and hidden from the traversal', async () => {
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
    // Unchanged content dedups; the touch path still refreshes `_last_synced`.
    expect(rerun.duplicatesSkipped).toBeGreaterThan(0);

    const sweep = await writer.processBatch([
      controlEnvelope(K8S_CONNECTOR, '2026-09-16T12:05:00.000Z'),
    ]);
    // The workload AND its (now unreferenced) image artifact were both unseen.
    expect(sweep.absentMarked).toBe(2);
    expect(await ids('MATCH (n) WHERE n._absent_since IS NOT NULL RETURN n.id AS id')).toEqual(
      [WEB_UI_ARTIFACT_ID, WEB_UI_ID].sort(),
    );

    // Success criterion 4: hidden by default, visible on request
    expect(await ids(BLAST, { id: REPO_ID })).toEqual(
      ALL_DEPLOYMENTS.filter((id) => id !== WEB_UI_ID),
    );
    expect(await ids(BLAST_INCLUDING_ABSENT, { id: REPO_ID })).toEqual(ALL_DEPLOYMENTS);

    // GitHub's nodes belong to another instance and are never swept by k8s
    expect(
      await ids(`MATCH (r:Repository) WHERE r._absent_since IS NULL RETURN r.id AS id`),
    ).toEqual([REPO_ID]);
  });
});
