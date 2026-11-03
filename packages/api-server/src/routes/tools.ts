// The catalog of tools an agent can be granted (mounted /api/tools). Today
// that is the built-in graph tools, described from the MCP metadata the MCP
// server registers them with; connections (external MCP servers, the GitHub
// actions App) add theirs in Milestone 3. Nothing here is stored, so the
// route answers even when agent features are off.
//
// Only tools marked for agents are listed: graph_query runs a caller-written
// Cypher string and is withheld from agents (see the tool metadata).
import type { FastifyPluginAsync } from 'fastify';
import { MCP_TOOLS } from '@shipit-ai/mcp-server/metadata';
import { requireCapability } from '../middleware/require-auth.js';

export interface ToolInfo {
  /** '<service>.<tool>', as agent grants name it. */
  id: string;
  service: string;
  effect: 'read' | 'write' | 'delete';
  description: string;
  source: 'builtin' | 'connection' | 'agent';
}

const BUILTIN: ToolInfo[] = MCP_TOOLS.filter((tool) => tool.agents).map((tool) => ({
  id: `${tool.service}.${tool.name}`,
  service: tool.service,
  effect: tool.effect,
  description: tool.description,
  source: 'builtin',
}));

const toolsRoutes: FastifyPluginAsync = async (server) => {
  server.get('/', { preHandler: requireCapability('agents:read') }, async () => ({
    tools: BUILTIN,
  }));
};

export default toolsRoutes;
