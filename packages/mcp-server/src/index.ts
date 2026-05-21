import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createNeo4jClient } from './neo4j-client.js';
import { createMcpServer } from './server.js';

export { createMcpServer } from './server.js';
export { loadConfig } from './config.js';
export type { McpServerConfig } from './config.js';
export { createNeo4jClient } from './neo4j-client.js';
export type { Neo4jClient, CypherResult } from './neo4j-client.js';
export { wrapResponse } from './envelope.js';
export type { McpResponse, McpResponseMeta } from './envelope.js';
export { McpErrorCode, createError, findSuggestions, levenshteinDistance } from './errors.js';
export type { McpError } from './errors.js';
export { MCP_TOOLS, MCP_TOOL_BY_NAME } from './tools/metadata.js';
export type { McpToolMetadata, McpToolParamSpec } from './tools/metadata.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const neo4j = createNeo4jClient(config.neo4jUri, config.neo4jUser, config.neo4jPassword);
  const server = createMcpServer(neo4j, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await neo4j.close();
    process.exit(0);
  });
}

// Only run main when executed directly (not imported)
const isMainModule = process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  main().catch(console.error);
}
