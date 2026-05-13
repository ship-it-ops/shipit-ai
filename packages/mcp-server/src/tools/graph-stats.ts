import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { generateGraphStatsCypher } from '../cypher/generator.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError } from '../errors.js';

export function registerGraphStats(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'graph_stats',
    'Return aggregate statistics about the knowledge graph: node counts by label, edge counts by type, environments, totals, and freshness summary.',
    async () => {
      const startTime = Date.now();

      try {
        const cypher = generateGraphStatsCypher();
        const result = await neo4j.runCypher(cypher.query, cypher.params);

        if (result.records.length === 0) {
          const data = {
            node_counts_by_label: {},
            edge_counts_by_type: {},
            environments: [],
            total_nodes: 0,
            total_edges: 0,
            freshness_summary: { healthy: 0, stale: 0, orphaned: 0 },
          };
          const response = wrapResponse('graph_stats', data, {
            queryTimeMs: Date.now() - startTime,
            nodeCount: 0,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
        }

        const record = result.records[0];
        const nodeCounts = record.get('node_counts') as Array<{ label: string; count: unknown }>;
        const edgeCounts = record.get('edge_counts') as Array<{ type: string; count: unknown }>;
        const totalNodes = toNumber(record.get('total_nodes'));
        const totalEdges = toNumber(record.get('total_edges'));
        const environments = (record.get('environments') as string[]) ?? [];

        const nodeCountsByLabel: Record<string, number> = {};
        for (const nc of nodeCounts) {
          nodeCountsByLabel[nc.label] = toNumber(nc.count);
        }

        const edgeCountsByType: Record<string, number> = {};
        for (const ec of edgeCounts) {
          edgeCountsByType[ec.type] = toNumber(ec.count);
        }

        const data = {
          node_counts_by_label: nodeCountsByLabel,
          edge_counts_by_type: edgeCountsByType,
          environments,
          total_nodes: totalNodes,
          total_edges: totalEdges,
          freshness_summary: { healthy: totalNodes, stale: 0, orphaned: 0 },
        };

        const response = wrapResponse('graph_stats', data, {
          queryTimeMs: Date.now() - startTime,
          nodeCount: totalNodes,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const error = createError(
          McpErrorCode.INTERNAL_ERROR,
          `graph_stats query failed: ${(err as Error).message}`,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object' && 'toNumber' in val)
    return (val as { toNumber: () => number }).toNumber();
  return Number(val) || 0;
}
