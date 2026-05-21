import type { FastifyPluginAsync } from 'fastify';
import { MCP_TOOLS } from '@shipit-ai/mcp-server';

const mcpRoutes: FastifyPluginAsync = async (server) => {
  // Runtime metadata about the MCP server, fetched by /configure/mcp.
  // Auth-status is the only field that depends on live config; the tool
  // catalog could be statically imported, but exposing it here keeps the
  // UI one round-trip and lets future clients (CLI, plugins) discover
  // available tools from a single endpoint.
  server.get('/info', async () => {
    const apiKeySecret = server.config?.backend.mcp.apiKeySecret ?? null;
    return {
      authRequired: apiKeySecret !== null,
      transport: 'stdio' as const,
      tools: MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        docAnchor: t.docAnchor,
        params: t.params,
      })),
    };
  });
};

export default mcpRoutes;
