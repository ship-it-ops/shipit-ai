import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from './neo4j-client.js';
import type { McpServerConfig } from './config.js';
import { registerBlastRadius } from './tools/blast-radius.js';
import { registerEntityDetail } from './tools/entity-detail.js';
import { registerSchemaInfo } from './tools/schema-info.js';
import { registerFindOwners } from './tools/find-owners.js';
import { registerDependencyChain } from './tools/dependency-chain.js';
import { registerGraphStats } from './tools/graph-stats.js';
import { registerSearchEntities } from './tools/search-entities.js';
import { registerGraphQuery, type GraphQueryOptions } from './tools/graph-query.js';

export function createMcpServer(
  neo4j: Neo4jClient,
  config: McpServerConfig,
  options: GraphQueryOptions = {},
): McpServer {
  const server = new McpServer({
    name: 'shipit-ai',
    version: '0.1.0',
  });

  registerBlastRadius(server, neo4j);
  registerEntityDetail(server, neo4j);
  registerSchemaInfo(server, neo4j);
  registerFindOwners(server, neo4j);
  registerDependencyChain(server, neo4j);
  registerGraphStats(server, neo4j);
  registerSearchEntities(server, neo4j);
  registerGraphQuery(server, neo4j, config, options);

  return server;
}
