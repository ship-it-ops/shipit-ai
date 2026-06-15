import type { FastifyPluginAsync } from 'fastify';
import { MCP_TOOLS } from '@shipit-ai/mcp-server';

const mcpRoutes: FastifyPluginAsync = async (server) => {
  // Runtime metadata about the MCP server, fetched by /configure/mcp.
  // Auth-status is the only field that depends on live config; the tool
  // catalog could be statically imported, but exposing it here keeps the
  // UI one round-trip and lets future clients (CLI, plugins) discover
  // available tools from a single endpoint.
  server.get('/info', async () => {
    // Auth posture follows the instance's login enforcement, NOT the legacy
    // (never-enforced) backend.mcp.apiKeySecret flag. When auth is enabled
    // (production), the remote MCP HTTP surface requires a per-user token —
    // see packages/mcp-server Stage 2a — so the UI must tell users to mint one
    // rather than showing a benign "dev mode" all-clear.
    const authRequired = server.config?.accessControl.auth.enabled === true;
    return {
      authRequired,
      transport: 'http' as const,
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
