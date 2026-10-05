import { describe, it, expect } from 'vitest';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';
import { captureTool, toolPayload } from './helpers/capture-tool.js';
import { registerSchemaInfo } from '../tools/schema-info.js';

describe('schema_info tool', () => {
  // Labels that start with an underscore are the application's own
  // bookkeeping, not part of the catalog a caller can ask about.
  it("lists the catalog's labels, not the internal ones", async () => {
    const responses = new Map();
    responses.set('db.labels', {
      records: [
        createMockRecord({ labels: ['Repository', '_AccessToken', 'Team', '_LinkingKey'] }),
      ],
      summary: { resultAvailableAfter: 1 },
    });
    responses.set('db.relationshipTypes', {
      records: [createMockRecord({ types: ['OWNS'] })],
      summary: { resultAvailableAfter: 1 },
    });
    const payload = toolPayload(
      await captureTool(registerSchemaInfo, createMockNeo4jClient(responses) as never)({}),
    ) as { data: { node_types: Array<{ label: string }> } };
    expect(payload.data.node_types.map((t) => t.label)).toEqual(['Repository', 'Team']);
  });
});
