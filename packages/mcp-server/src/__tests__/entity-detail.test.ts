import { describe, it, expect } from 'vitest';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';

describe('entity_detail tool', () => {
  it('should return entity detail with neighbors', async () => {
    const responses = new Map();
    responses.set('MATCH (n {id: $entityId})', {
      records: [
        createMockRecord({
          node: {
            properties: {
              id: 'shipit://logical-service/default/payments-api',
              name: 'payments-api',
              tier_effective: 1,
              owner_effective: 'payments-team',
              _claims: JSON.stringify([
                { property_key: 'tier', value: 1, source: 'backstage', confidence: 0.95 },
              ]),
            },
          },
          labels: ['LogicalService'],
          neighbors: [
            {
              neighbor: {
                properties: {
                  id: 'shipit://logical-service/default/config-service',
                  name: 'config-service',
                },
              },
              neighbor_labels: ['LogicalService'],
              rel_type: 'DEPENDS_ON',
              direction: 'outgoing',
            },
            {
              neighbor: {
                properties: {
                  id: 'shipit://team/default/payments-team',
                  name: 'payments-team',
                },
              },
              neighbor_labels: ['Team'],
              rel_type: 'OWNS',
              direction: 'incoming',
            },
          ],
        }),
      ],
      summary: { resultAvailableAfter: 2 },
    });

    const neo4j = createMockNeo4jClient(responses);
    const result = await neo4j.runCypher('MATCH (n {id: $entityId}) OPTIONAL', {
      entityId: 'shipit://logical-service/default/payments-api',
    });

    const record = result.records[0];
    const nodeData = record.get('node') as { properties: Record<string, unknown> };
    expect(nodeData.properties.name).toBe('payments-api');
    expect(nodeData.properties.tier_effective).toBe(1);

    const neighbors = record.get('neighbors') as Array<{
      neighbor: { properties: Record<string, unknown> };
      rel_type: string;
      direction: string;
    }>;
    expect(neighbors.length).toBe(2);
    expect(neighbors[0].rel_type).toBe('DEPENDS_ON');
    expect(neighbors[0].direction).toBe('outgoing');
  });

  it('should return entity detail without claims', async () => {
    const responses = new Map();
    responses.set('MATCH (n {id: $entityId})', {
      records: [
        createMockRecord({
          node: {
            properties: {
              id: 'shipit://logical-service/default/payments-api',
              name: 'payments-api',
            },
          },
          labels: ['LogicalService'],
          neighbors: [],
        }),
      ],
      summary: { resultAvailableAfter: 1 },
    });

    const neo4j = createMockNeo4jClient(responses);
    const result = await neo4j.runCypher('MATCH (n {id: $entityId})', { entityId: 'test' });

    const record = result.records[0];
    const nodeData = record.get('node') as { properties: Record<string, unknown> };
    expect(nodeData.properties._claims).toBeUndefined();
  });

  it('should include claims when present', async () => {
    const claimsJson = JSON.stringify([
      { property_key: 'tier', value: 1, source: 'backstage', confidence: 0.95 },
      { property_key: 'owner', value: 'payments-team', source: 'github', confidence: 0.8 },
    ]);

    const responses = new Map();
    responses.set('MATCH (n {id: $entityId})', {
      records: [
        createMockRecord({
          node: {
            properties: {
              id: 'test-id',
              name: 'test',
              _claims: claimsJson,
            },
          },
          labels: ['LogicalService'],
          neighbors: [],
        }),
      ],
      summary: { resultAvailableAfter: 1 },
    });

    const neo4j = createMockNeo4jClient(responses);
    const result = await neo4j.runCypher('MATCH (n {id: $entityId})', {});

    const nodeData = result.records[0].get('node') as { properties: Record<string, unknown> };
    const claims = JSON.parse(nodeData.properties._claims as string) as Array<{
      property_key: string;
    }>;
    expect(claims.length).toBe(2);
    expect(claims[0].property_key).toBe('tier');
  });
});
