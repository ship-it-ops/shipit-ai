import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { generateSearchEntitiesCypher } from '../cypher/generator.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError } from '../errors.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

export function registerSearchEntities(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'search_entities',
    MCP_TOOL_BY_NAME.search_entities.description,
    {
      label: z.string().optional().describe('Filter by node label (e.g., "LogicalService")'),
      property_filters: z
        .record(z.unknown())
        .optional()
        .describe('Filter by property values (e.g., {"tier_effective": 1})'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Max results (1-100, default 25)'),
      sort_by: z.string().default('name').describe('Property to sort by'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (params) => {
      const { label, property_filters, limit, sort_by, compact } = params;
      const startTime = Date.now();

      try {
        const cypher = generateSearchEntitiesCypher(
          label,
          property_filters as Record<string, unknown> | undefined,
          limit,
          sort_by,
        );
        const result = await neo4j.runCypher(cypher.query, cypher.params);

        if (result.records.length === 0) {
          const data = { entities: [], total_matching: 0, returned: 0 };
          const response = wrapResponse('search_entities', data, {
            compact,
            queryTimeMs: Date.now() - startTime,
            nodeCount: 0,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
        }

        const record = result.records[0];
        const total = toNumber(record.get('total'));
        const entitiesRaw = record.get('entities') as Array<{
          node: { properties: Record<string, unknown> };
          labels: string[];
        }>;

        const entities = entitiesRaw.map((e) => ({
          id: e.node.properties.id as string,
          label: e.labels[0] ?? 'Unknown',
          name: (e.node.properties.name as string) ?? '',
          ...(e.node.properties.tier_effective !== undefined
            ? { tier_effective: e.node.properties.tier_effective as number }
            : {}),
          ...(e.node.properties.owner_effective
            ? { owner_effective: e.node.properties.owner_effective as string }
            : {}),
        }));

        const data = {
          entities,
          total_matching: total,
          returned: entities.length,
        };

        const response = wrapResponse('search_entities', data, {
          compact,
          queryTimeMs: Date.now() - startTime,
          nodeCount: entities.length,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const error = createError(
          McpErrorCode.INTERNAL_ERROR,
          `search_entities query failed: ${(err as Error).message}`,
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
