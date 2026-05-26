import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { generateFindOwnersCypher } from '../cypher/generator.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError, findSuggestions } from '../errors.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

export function registerFindOwners(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'find_owners',
    MCP_TOOL_BY_NAME.find_owners.description,
    {
      entity: z.string().describe('Entity canonical ID'),
      include_chain: z
        .boolean()
        .default(false)
        .describe('Return full ownership chain (CODEOWNERS -> Team -> Members)'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (params) => {
      const { entity, include_chain, compact } = params;
      const startTime = Date.now();

      try {
        const cypher = generateFindOwnersCypher(entity, include_chain);
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
        const extractNodes = (key: string) => {
          const nodes = record.get(key) as Array<{ properties: Record<string, unknown> }>;
          return nodes
            .filter((n) => n !== null)
            .map((n) => ({
              name: (n.properties.name as string) ?? '',
              email: (n.properties.email as string) ?? null,
              id: n.properties.id as string,
            }));
        };

        const owners = extractNodes('owners').map((o) => ({
          type: 'team',
          name: o.name,
          email: o.email,
          role: 'owner',
        }));

        const codeowners = extractNodes('codeowners').map((c) => ({
          path_pattern: '*',
          team_or_person: c.name,
        }));

        const onCall = extractNodes('on_call').map((o) => ({
          name: o.name,
          email: o.email,
          rotation: 'primary',
        }));

        const data: Record<string, unknown> = { owners, codeowners, on_call: onCall };

        if (include_chain) {
          const members = extractNodes('members');
          data.members = members;
        }

        const response = wrapResponse('find_owners', data, {
          compact,
          queryTimeMs: Date.now() - startTime,
          nodeCount: owners.length + codeowners.length + onCall.length,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const error = createError(
          McpErrorCode.INTERNAL_ERROR,
          `find_owners query failed: ${(err as Error).message}`,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}
