import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { generateEntityDetailCypher } from '../cypher/generator.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError, findSuggestions } from '../errors.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

export function registerEntityDetail(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'entity_detail',
    MCP_TOOL_BY_NAME.entity_detail.description,
    {
      entity: z.string().describe('Entity canonical ID'),
      include_claims: z
        .boolean()
        .default(false)
        .describe('Return all PropertyClaims for each property'),
      include_neighbors: z
        .boolean()
        .default(true)
        .describe('Return 1-hop neighbors grouped by relationship type'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (params) => {
      const { entity, include_claims, include_neighbors, compact } = params;
      const startTime = Date.now();

      try {
        const cypher = generateEntityDetailCypher(entity, include_neighbors);
        const result = await neo4j.runCypher(cypher.query, cypher.params);

        if (result.records.length === 0) {
          const allNodes = await neo4j.runCypher(
            'MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id',
          );
          const allIds = allNodes.records.map((r) => r.get('id') as string);
          const suggestions = findSuggestions(entity, allIds);
          const error = createError(
            McpErrorCode.NODE_NOT_FOUND,
            `Entity '${entity}' not found in the graph.`,
            suggestions,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
        }

        const record = result.records[0];
        const nodeData = record.get('node');
        const labels = record.get('labels') as string[];
        const props = nodeData.properties;

        const effectiveProperties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key.endsWith('_effective')) {
            effectiveProperties[key] = value;
          }
        }

        const node = {
          id: props.id as string,
          label: labels[0] ?? 'Unknown',
          properties: Object.fromEntries(Object.entries(props).filter(([k]) => !k.startsWith('_'))),
          effective_properties: effectiveProperties,
        };

        let claims: unknown[] | undefined;
        if (include_claims && props._claims) {
          try {
            claims =
              typeof props._claims === 'string'
                ? JSON.parse(props._claims as string)
                : (props._claims as unknown[]);
          } catch {
            claims = [];
          }
        }

        let neighbors: Record<string, unknown[]> | undefined;
        if (include_neighbors) {
          neighbors = {};
          const neighborData = record.get('neighbors') as Array<{
            neighbor: { properties: Record<string, unknown> };
            neighbor_labels: string[];
            rel_type: string;
            direction: string;
          }>;

          for (const n of neighborData) {
            if (!n.neighbor) continue;
            const relKey = `${n.direction === 'incoming' ? '<-' : ''}${n.rel_type}${n.direction === 'outgoing' ? '->' : ''}`;
            if (!neighbors[relKey]) neighbors[relKey] = [];
            neighbors[relKey].push({
              id: n.neighbor.properties.id,
              label: n.neighbor_labels[0] ?? 'Unknown',
              name: n.neighbor.properties.name ?? '',
            });
          }
        }

        const data = {
          node,
          ...(claims !== undefined ? { claims } : {}),
          ...(neighbors !== undefined ? { neighbors } : {}),
        };

        const response = wrapResponse('entity_detail', data, {
          compact,
          queryTimeMs: Date.now() - startTime,
          nodeCount: 1,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const error = createError(
          McpErrorCode.INTERNAL_ERROR,
          `entity_detail query failed: ${(err as Error).message}`,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}
