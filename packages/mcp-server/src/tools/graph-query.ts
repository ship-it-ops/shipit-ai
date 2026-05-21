import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError } from '../errors.js';
import type { McpServerConfig } from '../config.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

const WRITE_KEYWORDS = /\b(MERGE|CREATE|DELETE|DETACH|SET|REMOVE|DROP|CALL\s*\{)\b/i;
const HOP_PATTERN = /\*\d*\.\.(\d+)/g;

export function registerGraphQuery(
  server: McpServer,
  neo4j: Neo4jClient,
  config: McpServerConfig,
): void {
  server.tool(
    'graph_query',
    MCP_TOOL_BY_NAME.graph_query.description,
    {
      query: z.string().describe('Cypher query (read-only, parameterized)'),
      params: z.record(z.unknown()).optional().describe('Query parameters'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (toolParams) => {
      const { query, params: queryParams, compact } = toolParams;
      const startTime = Date.now();

      // Guardrail: reject write operations
      if (WRITE_KEYWORDS.test(query)) {
        const error = createError(
          McpErrorCode.INVALID_PARAMETER,
          'Write operations are not allowed. graph_query is read-only. Detected forbidden keyword in query.',
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }

      // Guardrail: enforce hop limit on variable-length patterns
      const hopMatches = [...query.matchAll(HOP_PATTERN)];
      for (const match of hopMatches) {
        const maxHops = parseInt(match[1], 10);
        if (maxHops > config.rateLimits.hopLimit) {
          const error = createError(
            McpErrorCode.HOP_LIMIT_EXCEEDED,
            `Variable-length pattern exceeds hop limit of ${config.rateLimits.hopLimit}. Found *..${maxHops}. Use a structured tool like blast_radius instead.`,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
        }
      }

      // Add LIMIT if not present
      const limitedQuery = /\bLIMIT\b/i.test(query)
        ? query
        : `${query}\nLIMIT ${config.rateLimits.rowLimit}`;

      try {
        const result = await neo4j.runCypher(limitedQuery, queryParams ?? {});

        if (result.records.length >= config.rateLimits.rowLimit) {
          const rows = result.records.map((r) => r.toObject());
          const data = { rows, row_count: rows.length };
          const response = wrapResponse('graph_query', data, {
            compact,
            queryTimeMs: Date.now() - startTime,
            nodeCount: rows.length,
            truncated: true,
            warnings: [`Results truncated to ${config.rateLimits.rowLimit} rows`],
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
        }

        const rows = result.records.map((r) => r.toObject());
        const data = { rows, row_count: rows.length };

        const response = wrapResponse('graph_query', data, {
          compact,
          queryTimeMs: Date.now() - startTime,
          nodeCount: rows.length,
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('timeout') || message.includes('Timeout')) {
          const error = createError(McpErrorCode.QUERY_TIMEOUT, 'Query exceeded timeout limit.');
          return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
        }
        const error = createError(McpErrorCode.INTERNAL_ERROR, `graph_query failed: ${message}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}
