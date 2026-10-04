// The graph read tools, as the MCP server runs them. The runner calls the same
// handlers in-process through @shipit-ai/mcp-server/tools, on its own
// read-session Neo4j client.
import { z } from 'zod';
import {
  graphReadTools,
  type GraphToolConfig,
  type Neo4jClient,
} from '@shipit-ai/mcp-server/tools';
import type { RunnerTool } from './runner-tool.js';

export function graphTools(neo4j: Neo4jClient, config: GraphToolConfig): RunnerTool[] {
  return graphReadTools(neo4j, config).map((tool) => {
    // The runner unwraps the MCP envelope itself (see unwrap below), so the
    // `compact` flag means nothing here and is hidden from the model.
    const modelSchema =
      'compact' in tool.inputSchema.shape
        ? tool.inputSchema.omit({ compact: true } as never)
        : tool.inputSchema;
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(modelSchema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    return {
      descriptor: {
        id: `graph.${tool.name}`,
        service: 'graph',
        effect: tool.effect,
        description: tool.description,
        inputSchema,
        source: 'builtin',
        effectConfirmed: true,
        enabled: true,
      },
      parse(input) {
        const result = modelSchema.safeParse(input ?? {});
        if (result.success) return { ok: true, value: result.data as Record<string, unknown> };
        return {
          ok: false,
          message: result.error.issues
            .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
            .join('; '),
        };
      },
      execute: async (input) => unwrap(await tool.run(input)),
    };
  });
}

/**
 * Drops the MCP `_meta` envelope, which costs tokens and tells a model nothing,
 * but keeps the two parts of it that change what the data means: a truncation
 * flag and warnings. (MCP's own `compact` mode drops those too, and not every
 * tool offers it.) Error payloads have no envelope and pass through.
 */
function unwrap(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('_meta' in payload) || !('data' in payload)) {
    return payload;
  }
  const { _meta: meta, data } = payload as {
    _meta: { truncated?: boolean; warnings?: string[] };
    data: unknown;
  };
  if (!meta.truncated && !meta.warnings?.length) return data;
  return { data, truncated: meta.truncated ?? false, warnings: meta.warnings ?? [] };
}
