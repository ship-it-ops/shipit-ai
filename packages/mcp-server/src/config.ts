import { loadConfig as loadSharedConfig, type Config } from '@shipit-ai/shared';

export interface McpServerConfig {
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  apiKeySecret: string | null;
  rateLimits: {
    graphQueryPerDay: number;
    rowLimit: number;
    hopLimit: number;
    queryTimeoutMs: number;
  };
}

function narrow(c: Config): McpServerConfig {
  return {
    neo4jUri: c.backend.neo4j.uri,
    neo4jUser: c.backend.neo4j.user,
    neo4jPassword: c.backend.neo4j.password,
    apiKeySecret: c.backend.mcp.apiKeySecret,
    rateLimits: c.backend.mcp.rateLimits,
  };
}

export function loadConfig(): McpServerConfig {
  return narrow(loadSharedConfig());
}
