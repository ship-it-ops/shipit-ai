import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { generateBlastRadiusCypher } from '../cypher/generator.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError, findSuggestions } from '../errors.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

export interface BlastRadiusResult {
  affected_nodes: Array<{
    id: string;
    label: string;
    name: string;
    tier_effective?: number;
    environment?: string;
    owner_effective?: string;
  }>;
  paths: Array<{
    from: string;
    to: string;
    relationship: string;
    depth: number;
  }>;
  summary: {
    total_services: number;
    total_teams: number;
    tier1_count: number;
  };
}

export function registerBlastRadius(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'blast_radius',
    MCP_TOOL_BY_NAME.blast_radius.description,
    {
      node: z
        .string()
        .describe(
          'Starting node canonical ID (e.g., shipit://repository/default/shipitops/config-service)',
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(6)
        .default(3)
        .describe('Max traversal hops (1-6, default 3)'),
      direction: z
        .enum(['DOWNSTREAM', 'UPSTREAM', 'BOTH'])
        .default('DOWNSTREAM')
        .describe('Traversal direction'),
      include_environments: z
        .array(z.string())
        .optional()
        .describe('Filter deployments by environment'),
      production_only: z
        .boolean()
        .default(false)
        .describe("Convenience flag: equivalent to include_environments: ['production']"),
      compact: z.boolean().default(false).describe('Strip _meta envelope for compact responses'),
    },
    async (params) => {
      const { node, depth, direction, include_environments, production_only, compact } = params;

      const environments = production_only ? ['production'] : include_environments;

      const startTime = Date.now();

      try {
        const cypher = generateBlastRadiusCypher(node, depth, direction, environments);
        const result = await neo4j.runCypher(cypher.query, cypher.params);

        if (result.records.length === 0) {
          // Check if the starting node exists
          const existCheck = await neo4j.runCypher('MATCH (n {id: $nodeId}) RETURN n.id AS id', {
            nodeId: node,
          });

          if (existCheck.records.length === 0) {
            const allNodes = await neo4j.runCypher(
              'MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id',
            );
            const allIds = allNodes.records.map((r) => r.get('id') as string);
            const suggestions = findSuggestions(node, allIds);
            const error = createError(
              McpErrorCode.NODE_NOT_FOUND,
              `Entity '${node}' not found in the graph.`,
              suggestions,
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
          }

          // Node exists but no blast radius
          const data: BlastRadiusResult = {
            affected_nodes: [],
            paths: [],
            summary: { total_services: 0, total_teams: 0, tier1_count: 0 },
          };
          const response = wrapResponse('blast_radius', data, {
            compact,
            queryTimeMs: Date.now() - startTime,
            nodeCount: 0,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
        }

        const affectedNodes = result.records.map((r) => {
          const nodeData = r.get('node');
          const labels = r.get('labels') as string[];
          const props = nodeData.properties;
          return {
            id: props.id as string,
            label: labels[0] ?? 'Unknown',
            name: (props.name as string) ?? '',
            ...(props.tier_effective !== undefined
              ? { tier_effective: props.tier_effective as number }
              : {}),
            ...(props.environment ? { environment: props.environment as string } : {}),
            ...(props.owner_effective ? { owner_effective: props.owner_effective as string } : {}),
          };
        });

        const paths = result.records.map((r) => {
          const nodeData = r.get('node');
          const relTypes = r.get('rel_types') as string[];
          return {
            from: node,
            to: nodeData.properties.id as string,
            relationship: relTypes[relTypes.length - 1] ?? 'UNKNOWN',
            depth:
              (r.get('depth') as { toNumber?: () => number })?.toNumber?.() ??
              (r.get('depth') as number),
          };
        });

        const uniqueTeams = new Set(
          affectedNodes.filter((n) => n.owner_effective).map((n) => n.owner_effective),
        );
        const serviceLabels = new Set(['LogicalService', 'RuntimeService']);
        const services = affectedNodes.filter((n) => serviceLabels.has(n.label));

        const data: BlastRadiusResult = {
          affected_nodes: affectedNodes,
          paths,
          summary: {
            total_services: services.length,
            total_teams: uniqueTeams.size,
            tier1_count: affectedNodes.filter((n) => n.tier_effective === 1).length,
          },
        };

        const response = wrapResponse('blast_radius', data, {
          compact,
          queryTimeMs: Date.now() - startTime,
          nodeCount: affectedNodes.length,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const error = createError(
          McpErrorCode.INTERNAL_ERROR,
          `blast_radius query failed: ${(err as Error).message}`,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}
