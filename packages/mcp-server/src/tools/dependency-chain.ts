import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { generateDependencyChainCypher } from '../cypher/generator.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError } from '../errors.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

export function registerDependencyChain(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'dependency_chain',
    MCP_TOOL_BY_NAME.dependency_chain.description,
    {
      from: z.string().describe('Source node canonical ID'),
      to: z.string().describe('Target node canonical ID'),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(6)
        .describe('Max path length (1-10, default 6)'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (params) => {
      const { from, to, max_depth, compact } = params;
      const startTime = Date.now();

      try {
        const cypher = generateDependencyChainCypher(from, to, max_depth);
        const result = await neo4j.runCypher(cypher.query, cypher.params);

        if (result.records.length === 0) {
          const data = {
            paths: [],
            shortest_path_length: 0,
            total_paths_found: 0,
          };
          const response = wrapResponse('dependency_chain', data, {
            compact,
            queryTimeMs: Date.now() - startTime,
            nodeCount: 0,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
        }

        const paths = result.records.map((r) => {
          const pathNodes = r.get('path_nodes') as Array<{ properties: Record<string, unknown> }>;
          const pathEdges = r.get('path_edges') as Array<{
            type: string;
            from: string;
            to: string;
          }>;
          const pathLength =
            (r.get('path_length') as { toNumber?: () => number })?.toNumber?.() ??
            (r.get('path_length') as number);

          return {
            nodes: pathNodes.map((n) => n.properties.id as string),
            edges: pathEdges.map((e) => `${e.from} -[${e.type}]-> ${e.to}`),
            length: pathLength,
          };
        });

        const shortestLength = Math.min(...paths.map((p) => p.length));

        const data = {
          paths,
          shortest_path_length: shortestLength,
          total_paths_found: paths.length,
        };

        const response = wrapResponse('dependency_chain', data, {
          compact,
          queryTimeMs: Date.now() - startTime,
          nodeCount: paths.reduce((sum, p) => sum + p.nodes.length, 0),
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const error = createError(
          McpErrorCode.INTERNAL_ERROR,
          `dependency_chain query failed: ${(err as Error).message}`,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}
