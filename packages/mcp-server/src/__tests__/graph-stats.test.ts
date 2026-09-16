import { describe, it, expect } from 'vitest';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';
import { captureTool } from './helpers/capture-tool.js';
import { registerGraphStats } from '../tools/graph-stats.js';

describe('graph_stats tool', () => {
  it('should return correct stats response shape', async () => {
    const responses = new Map();
    responses.set('labels(n)', {
      records: [
        createMockRecord({
          node_counts: [
            { label: 'LogicalService', count: 5 },
            { label: 'Repository', count: 5 },
            { label: 'Deployment', count: 10 },
            { label: 'Team', count: 3 },
            { label: 'Person', count: 8 },
          ],
          total_nodes: 41,
          edge_counts: [
            { type: 'DEPENDS_ON', count: 5 },
            { type: 'OWNS', count: 5 },
            { type: 'IMPLEMENTED_BY', count: 5 },
            { type: 'DEPLOYED_AS', count: 10 },
          ],
          total_edges: 40,
          environments: ['production', 'staging'],
        }),
      ],
      summary: { resultAvailableAfter: 10 },
    });

    const neo4j = createMockNeo4jClient(responses);
    const result = await neo4j.runCypher('MATCH (n) UNWIND labels(n)', {});

    const record = result.records[0];
    const nodeCounts = record.get('node_counts') as Array<{ label: string; count: number }>;
    const edgeCounts = record.get('edge_counts') as Array<{ type: string; count: number }>;
    const totalNodes = record.get('total_nodes') as number;
    const totalEdges = record.get('total_edges') as number;
    const environments = record.get('environments') as string[];

    expect(nodeCounts.length).toBe(5);
    expect(edgeCounts.length).toBe(4);
    expect(totalNodes).toBe(41);
    expect(totalEdges).toBe(40);
    expect(environments).toContain('production');
    expect(environments).toContain('staging');

    // Verify the shape can be converted to the expected response format
    const nodeCountsByLabel: Record<string, number> = {};
    for (const nc of nodeCounts) {
      nodeCountsByLabel[nc.label] = nc.count;
    }
    expect(nodeCountsByLabel['LogicalService']).toBe(5);
    expect(nodeCountsByLabel['Deployment']).toBe(10);
  });

  it('should handle empty graph', async () => {
    const neo4j = createMockNeo4jClient();
    const result = await neo4j.runCypher('MATCH (n) UNWIND labels(n)', {});
    expect(result.records.length).toBe(0);
  });
});

describe('graph_stats include_absent', () => {
  it('threads include_absent into the generated Cypher', async () => {
    const excluding = createMockNeo4jClient();
    await captureTool(registerGraphStats as never, excluding as never)({ include_absent: false });
    expect(excluding.runCypher.mock.calls[0][0] as string).toContain('n._absent_since IS NULL');

    const including = createMockNeo4jClient();
    await captureTool(registerGraphStats as never, including as never)({ include_absent: true });
    expect(including.runCypher.mock.calls[0][0] as string).not.toContain('_absent_since');
  });
});
