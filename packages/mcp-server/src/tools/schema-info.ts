import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import { wrapResponse } from '../envelope.js';
import { McpErrorCode, createError } from '../errors.js';
import { MCP_TOOL_BY_NAME } from './metadata.js';

export function registerSchemaInfo(server: McpServer, neo4j: Neo4jClient): void {
  server.tool('schema_info', MCP_TOOL_BY_NAME.schema_info.description, async () => {
    const startTime = Date.now();

    try {
      const nodeResult = await neo4j.runCypher(`
          CALL db.labels() YIELD label
          RETURN collect(label) AS labels
        `);

      const relResult = await neo4j.runCypher(`
          CALL db.relationshipTypes() YIELD relationshipType
          RETURN collect(relationshipType) AS types
        `);

      const labels = (nodeResult.records[0]?.get('labels') as string[]) ?? [];
      const relTypes = (relResult.records[0]?.get('types') as string[]) ?? [];

      const nodeTypes = labels.map((label) => ({
        label,
        properties: [],
      }));

      const relationshipTypes = relTypes.map((type) => ({
        type,
        from: '*',
        to: '*',
        cardinality: 'N:M',
      }));

      const data = { node_types: nodeTypes, relationship_types: relationshipTypes };

      const response = wrapResponse('schema_info', data, {
        queryTimeMs: Date.now() - startTime,
        nodeCount: labels.length,
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    } catch (err) {
      const error = createError(
        McpErrorCode.INTERNAL_ERROR,
        `schema_info query failed: ${(err as Error).message}`,
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
    }
  });
}
