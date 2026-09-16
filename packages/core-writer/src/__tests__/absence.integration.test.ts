/**
 * Neo4j-backed integration test for the absence sweep (Kubernetes connector v1):
 *   - markAbsent stamps `_absent_since` only on the connector's nodes whose
 *     `_last_synced` predates the run start
 *   - the confirmation floor: a run that confirmed NOTHING marks nothing
 *   - mergeNode (writeNode) clears `_absent_since`
 *   - touchLastSynced clears `_absent_since` even when the timestamp is not newer
 * Gated on NEO4J_TEST_URI; wipes the graph after each test. Runs serially in the
 * CI integration job (--no-file-parallelism; shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { CanonicalNode } from '@shipit-ai/shared';
import { Neo4jClient } from '../neo4j/client.js';
import { Neo4jNodeWriter } from '../neo4j/node-writer.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

function workload(name: string, connectorId: string, lastSynced: string): CanonicalNode {
  return {
    id: `shipit://deployment/default/demo/shipit/deployment/${name}`,
    label: 'Deployment',
    properties: { name },
    _claims: [],
    _source_system: 'kubernetes',
    _source_org: 'kubernetes/demo',
    _source_id: `k8s://demo/shipit/deployment/${name}`,
    _source_connector_id: connectorId,
    _last_synced: lastSynced,
    // Content-hash style version: unorderable, so the freshness guard never rejects.
    _event_version: `ch_${name}`,
  };
}

describe.skipIf(!URI)('core-writer absence sweep — integration', () => {
  let client: Neo4jClient;
  let writer: Neo4jNodeWriter;

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    writer = new Neo4jNodeWriter(client, DATABASE);
  });

  afterEach(async () => {
    await client.executeWrite(async (tx) => tx.run('MATCH (n) DETACH DELETE n'), DATABASE);
  });

  afterAll(async () => {
    await client?.close();
  });

  const absentSince = (id: string) =>
    client.executeRead(async (tx) => {
      const r = await tx.run('MATCH (n {id: $id}) RETURN n._absent_since AS a', { id });
      return (r.records[0]?.get('a') as string | null) ?? null;
    }, DATABASE);

  it("marks only the connector's unseen nodes; fresh and foreign nodes are untouched", async () => {
    await writer.writeNode(workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z'), [], {});
    await writer.writeNode(workload('web-ui', 'k8s-a', '2026-09-16T10:05:30.000Z'), [], {});
    await writer.writeNode(workload('redis', 'k8s-b', '2026-09-16T10:00:00.000Z'), [], {});

    const marked = await writer.markAbsent(
      'k8s-a',
      '2026-09-16T10:05:00.000Z',
      '2026-09-16T10:06:00.000Z',
    );

    expect(marked).toBe(1);
    expect(await absentSince('shipit://deployment/default/demo/shipit/deployment/api-server')).toBe(
      '2026-09-16T10:06:00.000Z',
    );
    expect(
      await absentSince('shipit://deployment/default/demo/shipit/deployment/web-ui'),
    ).toBeNull();
    expect(
      await absentSince('shipit://deployment/default/demo/shipit/deployment/redis'),
    ).toBeNull();
    // Idempotent: a second sweep with the same cut-off marks nothing new.
    expect(
      await writer.markAbsent('k8s-a', '2026-09-16T10:05:00.000Z', '2026-09-16T10:07:00.000Z'),
    ).toBe(0);
  });

  it('marks nothing when no node of this run reached the graph (confirmation floor)', async () => {
    // Both nodes predate the run start: the run's entity writes never landed
    // (swallowed write error, or a jobId-dedup blackout). Sweeping here would
    // stamp the connector's entire graph absent.
    await writer.writeNode(workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z'), [], {});
    await writer.writeNode(workload('web-ui', 'k8s-a', '2026-09-16T10:01:00.000Z'), [], {});

    const marked = await writer.markAbsent(
      'k8s-a',
      '2026-09-16T10:05:00.000Z',
      '2026-09-16T10:06:00.000Z',
    );

    expect(marked).toBe(0);
    expect(
      await absentSince('shipit://deployment/default/demo/shipit/deployment/api-server'),
    ).toBeNull();
    expect(
      await absentSince('shipit://deployment/default/demo/shipit/deployment/web-ui'),
    ).toBeNull();
  });

  it('a later writeNode clears _absent_since', async () => {
    const node = workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z');
    await writer.writeNode(node, [], {});
    // A node confirmed by this run, so the sweep clears its confirmation floor.
    await writer.writeNode(workload('web-ui', 'k8s-a', '2026-09-16T10:05:30.000Z'), [], {});
    await writer.markAbsent('k8s-a', '2026-09-16T10:05:00.000Z', '2026-09-16T10:06:00.000Z');
    expect(await absentSince(node.id)).not.toBeNull();

    // expectedClaimsRev 1: the first write bumped `_claims_rev` to 1. (Even a
    // claims-rev conflict would still run the property SET that clears absence.)
    await writer.writeNode({ ...node, _last_synced: '2026-09-16T10:10:00.000Z' }, [], {}, 1);
    expect(await absentSince(node.id)).toBeNull();
  });

  it('touchLastSynced clears _absent_since even when the timestamp does not advance', async () => {
    const node = workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z');
    await writer.writeNode(node, [], {});
    await writer.writeNode(workload('web-ui', 'k8s-a', '2026-09-16T10:05:30.000Z'), [], {});
    await writer.markAbsent('k8s-a', '2026-09-16T10:05:00.000Z', '2026-09-16T10:06:00.000Z');
    await writer.touchLastSynced(node.id, '2026-09-16T09:00:00.000Z');
    expect(await absentSince(node.id)).toBeNull();
  });
});
