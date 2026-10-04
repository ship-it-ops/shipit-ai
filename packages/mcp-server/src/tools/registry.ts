// The graph read tools as plain in-process functions, for callers that are not
// MCP clients (the agent runner). Each tool's existing `register*` function is
// run against a recorder that keeps the input shape and handler it registers,
// so the MCP server and the runner execute the same code: there is one handler
// per tool, not a copy.
//
// This module imports no value from the MCP SDK, so the runner can load it
// without starting a server.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import type { McpServerConfig } from '../config.js';
import { registerBlastRadius } from './blast-radius.js';
import { registerEntityDetail } from './entity-detail.js';
import { registerSchemaInfo } from './schema-info.js';
import { registerFindOwners } from './find-owners.js';
import { registerDependencyChain } from './dependency-chain.js';
import { registerGraphStats } from './graph-stats.js';
import { registerSearchEntities } from './search-entities.js';
import { registerGraphQuery } from './graph-query.js';
import { MCP_TOOL_BY_NAME, type McpToolMetadata } from './metadata.js';

// The runner opens its own read-session client; re-exported so it never has to
// import the package root, which pulls in the MCP transports.
export { createNeo4jClient } from '../neo4j-client.js';
export type { Neo4jClient } from '../neo4j-client.js';

export interface GraphReadTool {
  /** The MCP tool name, e.g. 'blast_radius'. */
  name: string;
  description: string;
  /** From the tool's metadata. Every graph tool today only reads. */
  effect: McpToolMetadata['effect'];
  /** Validates and fills defaults. Parse with it before calling `run`. */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * Runs the tool on already-parsed input and returns its payload: the JSON the
   * MCP tool would send as text, as an object. Tool-level failures (unknown
   * node, hop limit) come back as `{ error: { code, message } }`, not thrown.
   */
  run(params: Record<string, unknown>): Promise<unknown>;
}

/** The slice of the MCP server config the tools read (graph_query's guardrails). */
export interface GraphToolConfig {
  rateLimits: Pick<McpServerConfig['rateLimits'], 'rowLimit' | 'hopLimit'>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

export function graphReadTools(neo4j: Neo4jClient, config: GraphToolConfig): GraphReadTool[] {
  const tools: GraphReadTool[] = [];
  // server.tool(name, description, handler) or server.tool(name, description, shape, handler).
  const recorder = {
    tool: (name: string, description: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as ToolHandler;
      const shape = (rest.length > 1 ? rest[0] : {}) as z.ZodRawShape;
      tools.push({
        name,
        description,
        effect: MCP_TOOL_BY_NAME[name]!.effect,
        inputSchema: z.object(shape),
        run: async (params) => JSON.parse((await handler(params)).content[0]!.text) as unknown,
      });
    },
  } as unknown as McpServer;

  registerBlastRadius(recorder, neo4j);
  registerEntityDetail(recorder, neo4j);
  registerSchemaInfo(recorder, neo4j);
  registerFindOwners(recorder, neo4j);
  registerDependencyChain(recorder, neo4j);
  registerGraphStats(recorder, neo4j);
  registerSearchEntities(recorder, neo4j);
  registerGraphQuery(recorder, neo4j, config as McpServerConfig);
  return tools;
}
