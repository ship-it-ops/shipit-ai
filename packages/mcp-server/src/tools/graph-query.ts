import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { checkReadOnlyCypher, cypherCodeText, GRAPH_QUERY_CAPABILITY } from '@shipit-ai/shared';
import type { Neo4jClient } from '../neo4j-client.js';
import { ReadOnlyQueryError } from '../cypher/read-only-query.js';
import { DailyBudget } from '../daily-budget.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError, type McpError } from '../errors.js';
import type { McpServerConfig } from '../config.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

// A variable-length relationship, [*], [*3], [*..5], [*2..5], with or without
// a variable, a type and a property map; and the quantifier of a quantified
// path pattern, (...){2}, (...){1,5}. Read on the query's code only (strings
// and comments blanked), so "[*]" inside a string is not taken for one.
const VARIABLE_LENGTH = /\[[^[\]]*?\*\s*(\d*)\s*(\.\.\s*(\d*))?\s*(?:\{[^{}]*\})?\s*\]/g;
const QUANTIFIED_PATH = /\)\s*\{\s*(\d*)\s*(,\s*(\d*))?\s*\}/g;

/** The upper bound of every variable-length pattern in `code`; null where there is none. */
function hopBounds(code: string): Array<number | null> {
  const bounds: Array<number | null> = [];
  for (const [, lower, range, upper] of code.matchAll(VARIABLE_LENGTH)) {
    // [*3] is exactly three hops; [*] and [*2..] have no upper bound.
    const bound = range === undefined ? lower : upper;
    bounds.push(bound ? Number(bound) : null);
  }
  for (const [, lower, comma, upper] of code.matchAll(QUANTIFIED_PATH)) {
    const bound = comma === undefined ? lower : upper;
    bounds.push(bound ? Number(bound) : null);
  }
  return bounds;
}

const asText = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

function failure(err: unknown): McpError {
  if (err instanceof ReadOnlyQueryError) {
    if (err.kind === 'busy') return createError(McpErrorCode.SERVER_BUSY, err.message);
    if (err.kind === 'too_large') return createError(McpErrorCode.ROW_LIMIT_EXCEEDED, err.message);
    if (err.kind === 'timeout') return createError(McpErrorCode.QUERY_TIMEOUT, err.message);
    if (err.kind === 'write_refused') {
      return createError(McpErrorCode.INVALID_PARAMETER, err.message);
    }
  }
  return createError(McpErrorCode.INTERNAL_ERROR, `graph_query failed: ${(err as Error).message}`);
}

export interface GraphQueryOptions {
  /** The clock the daily budget reads; tests move it. */
  now?: () => Date;
  /**
   * The budget to count against. The HTTP entry point makes one server per
   * request, so it keeps the one budget and passes it in; by default each
   * server has its own.
   */
  budget?: DailyBudget;
}

/**
 * Over HTTP the transport hands the handler the token the call came with
 * (index.ts puts its owner on `clientId` and its scopes on `scopes`). Over
 * stdio, and in-process in the agent runner, there is none: that is the
 * operator's own trust, and neither the scope nor the budget applies.
 */
function tokenOf(extra: unknown): AuthInfo | undefined {
  return (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
}

export function registerGraphQuery(
  server: McpServer,
  neo4j: Neo4jClient,
  config: McpServerConfig,
  options: GraphQueryOptions = {},
): void {
  const budget = options.budget ?? new DailyBudget(config.rateLimits.graphQueryPerDay, options.now);

  server.tool(
    'graph_query',
    MCP_TOOL_BY_NAME.graph_query.description,
    {
      query: z.string().describe('Cypher query (read-only, parameterized)'),
      params: z.record(z.string(), z.unknown()).optional().describe('Query parameters'),
      compact: z.boolean().default(false).describe('Strip _meta envelope'),
    },
    async (toolParams, extra) => {
      const { query, params: queryParams, compact } = toolParams;
      const { rowLimit, hopLimit, queryTimeoutMs } = config.rateLimits;
      const startTime = Date.now();

      // Guardrail: a raw query reads everything in the graph, so a token needs
      // the scope an administrator grants for it, and gets a number of calls a day.
      const token = tokenOf(extra);
      if (token && !token.scopes.includes(GRAPH_QUERY_CAPABILITY)) {
        return asText(
          createError(
            McpErrorCode.RBAC_DENIED,
            `graph_query needs a token with the ${GRAPH_QUERY_CAPABILITY} scope, which an administrator mints under Settings → API Keys.`,
          ),
        );
      }
      if (token && !budget.take(token.clientId)) {
        return asText(
          createError(
            McpErrorCode.RATE_LIMIT_EXCEEDED,
            `graph_query is limited to ${budget.perDay} calls per user per day; the count starts again at midnight UTC.`,
          ),
        );
      }

      // Guardrail: the read-only check every caller-written query passes, the
      // same one the Query Playground applies.
      const verdict = checkReadOnlyCypher(query);
      if (!verdict.ok) {
        return asText(createError(McpErrorCode.INVALID_PARAMETER, verdict.message));
      }

      // Guardrail: every variable-length pattern needs an upper bound, and
      // the bound may not exceed the hop limit. The check above has read the
      // text, so its code is there to read.
      for (const bound of hopBounds(cypherCodeText(query) ?? query)) {
        if (bound === null) {
          return asText(
            createError(
              McpErrorCode.HOP_LIMIT_EXCEEDED,
              `A variable-length pattern needs an upper bound of at most ${hopLimit} hops, as in [*..${hopLimit}]. Use a structured tool like blast_radius or dependency_chain for anything deeper.`,
            ),
          );
        }
        if (bound > hopLimit) {
          return asText(
            createError(
              McpErrorCode.HOP_LIMIT_EXCEEDED,
              `Variable-length pattern exceeds hop limit of ${hopLimit}. Found *..${bound}. Use a structured tool like blast_radius instead.`,
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
