import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkReadOnlyCypher } from '@shipit-ai/shared';
import type { Neo4jClient } from '../neo4j-client.js';
import { ReadOnlyQueryError } from '../cypher/read-only-query.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError, type McpError } from '../errors.js';
import type { McpServerConfig } from '../config.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

const HOP_PATTERN = /\*\d*\.\.(\d+)/g;

const asText = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

function failure(err: unknown): McpError {
  if (err instanceof ReadOnlyQueryError) {
    if (err.kind === 'busy') return createError(McpErrorCode.SERVER_BUSY, err.message);
    if (err.kind === 'timeout') return createError(McpErrorCode.QUERY_TIMEOUT, err.message);
    if (err.kind === 'write_refused') {
      return createError(McpErrorCode.INVALID_PARAMETER, err.message);
    }
  }
  return createError(McpErrorCode.INTERNAL_ERROR, `graph_query failed: ${(err as Error).message}`);
}

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
      params: z.record(z.string(), z.unknown()).optional().describe('Query parameters'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (toolParams) => {
      const { query, params: queryParams, compact } = toolParams;
      const { rowLimit, hopLimit, queryTimeoutMs } = config.rateLimits;
      const startTime = Date.now();

      // Guardrail: the read-only check every caller-written query passes, the
      // same one the Query Playground applies.
      const verdict = checkReadOnlyCypher(query);
      if (!verdict.ok) {
        return asText(createError(McpErrorCode.INVALID_PARAMETER, verdict.message));
      }

      // Guardrail: enforce hop limit on variable-length patterns
      for (const match of query.matchAll(HOP_PATTERN)) {
        const maxHops = parseInt(match[1], 10);
        if (maxHops > hopLimit) {
          return asText(
            createError(
              McpErrorCode.HOP_LIMIT_EXCEEDED,
              `Variable-length pattern exceeds hop limit of ${hopLimit}. Found *..${maxHops}. Use a structured tool like blast_radius instead.`,
            ),
          );
        }
      }

      try {
        // The row limit and the timeout are enforced where the query runs, not
        // by editing its text: a LIMIT of the caller's own cannot raise them.
        const result = await neo4j.runReadOnlyQuery(query, queryParams ?? {}, {
          timeoutMs: queryTimeoutMs,
          rowLimit,
        });

        const warnings: string[] = [];
        if (result.truncated) warnings.push(`Results truncated to ${rowLimit} rows`);
        if (result.withheld > 0) {
          warnings.push(
            `${result.withheld} ${result.withheld === 1 ? 'value' : 'values'} withheld: internal nodes are not available to graph_query`,
          );
        }

        return asText(
          wrapResponse(
            'graph_query',
            { rows: result.rows, row_count: result.rows.length },
            {
              compact,
              queryTimeMs: Date.now() - startTime,
              nodeCount: result.rows.length,
              truncated: result.truncated,
              warnings,
            },
          ),
        );
      } catch (err) {
        return asText(failure(err));
      }
    },
  );
}
