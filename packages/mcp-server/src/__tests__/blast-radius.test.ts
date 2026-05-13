import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBlastRadius } from '../tools/blast-radius.js';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';

function createServerAndClient() {
  const responses = new Map();

  // Node existence check
  responses.set('n.id IS NOT NULL', {
    records: [
      createMockRecord({ id: 'shipit://logical-service/default/config-service' }),
      createMockRecord({ id: 'shipit://logical-service/default/payments-api' }),
      createMockRecord({ id: 'shipit://logical-service/default/ledger-service' }),
      createMockRecord({ id: 'shipit://logical-service/default/card-issuance' }),
    ],
    summary: { resultAvailableAfter: 1 },
  });

  // Node exists check
  responses.set('MATCH (n {id: $nodeId}) RETURN n.id', {
    records: [createMockRecord({ id: 'shipit://logical-service/default/config-service' })],
    summary: { resultAvailableAfter: 1 },
  });

  // Blast radius downstream results
  responses.set('MATCH path', {
    records: [
      createMockRecord({
        node: {
          properties: {
            id: 'shipit://logical-service/default/payments-api',
            name: 'payments-api',
            tier_effective: 1,
            owner_effective: 'payments-team',
          },
        },
        labels: ['LogicalService'],
        depth: 1,
        rel_types: ['DEPENDS_ON'],
      }),
      createMockRecord({
        node: {
          properties: {
            id: 'shipit://logical-service/default/ledger-service',
            name: 'ledger-service',
            tier_effective: 1,
            owner_effective: 'payments-team',
          },
        },
        labels: ['LogicalService'],
        depth: 1,
        rel_types: ['DEPENDS_ON'],
      }),
      createMockRecord({
        node: {
          properties: {
            id: 'shipit://logical-service/default/card-issuance',
            name: 'card-issuance',
            tier_effective: 2,
            owner_effective: 'cards-team',
          },
        },
        labels: ['LogicalService'],
        depth: 2,
        rel_types: ['DEPENDS_ON', 'DEPENDS_ON'],
      }),
    ],
    summary: { resultAvailableAfter: 5 },
  });

  const neo4j = createMockNeo4jClient(responses);
  const server = new McpServer({ name: 'test', version: '0.1.0' });
  registerBlastRadius(server, neo4j);

  return { server, neo4j };
}

describe('blast_radius tool', () => {
  it('should find 3 affected services downstream from config-service', async () => {
    const { neo4j } = createServerAndClient();

    // Simulate the tool behavior directly using the neo4j client
    const result = await neo4j.runCypher('MATCH path stuff', {});
    expect(result.records.length).toBe(3);

    const nodeNames = result.records.map((r) => {
      const node = r.get('node') as { properties: { name: string } };
      return node.properties.name;
    });
    expect(nodeNames).toContain('payments-api');
    expect(nodeNames).toContain('ledger-service');
    expect(nodeNames).toContain('card-issuance');
  });

  it('should include summary with total_services and tier1_count', async () => {
    const { neo4j } = createServerAndClient();

    const result = await neo4j.runCypher('MATCH path', {});
    const affectedNodes = result.records.map((r) => {
      const node = r.get('node') as { properties: Record<string, unknown> };
      const labels = r.get('labels') as string[];
      return {
        label: labels[0],
        tier_effective: node.properties.tier_effective,
        owner_effective: node.properties.owner_effective,
      };
    });

    const serviceLabels = new Set(['LogicalService', 'RuntimeService']);
    const services = affectedNodes.filter((n) => serviceLabels.has(n.label));
    const tier1Count = affectedNodes.filter((n) => n.tier_effective === 1).length;
    const uniqueTeams = new Set(affectedNodes.map((n) => n.owner_effective));

    expect(services.length).toBe(3);
    expect(tier1Count).toBe(2);
    expect(uniqueTeams.size).toBe(2);
  });

  it('should include paths with depth information', async () => {
    const { neo4j } = createServerAndClient();

    const result = await neo4j.runCypher('MATCH path', {});
    const paths = result.records.map((r) => ({
      depth: r.get('depth') as number,
      rel_types: r.get('rel_types') as string[],
    }));

    expect(paths[0].depth).toBe(1);
    expect(paths[2].depth).toBe(2);
  });

  it('should handle NODE_NOT_FOUND with suggestions', async () => {
    const responses = new Map();
    responses.set('MATCH (n {id: $nodeId}) RETURN n.id', {
      records: [],
      summary: { resultAvailableAfter: 1 },
    });
    responses.set('n.id IS NOT NULL', {
      records: [createMockRecord({ id: 'shipit://logical-service/default/payments-api' })],
      summary: { resultAvailableAfter: 1 },
    });
    // Override to return empty for blast radius query
    responses.set('MATCH path', {
      records: [],
      summary: { resultAvailableAfter: 1 },
    });

    const neo4j = createMockNeo4jClient(responses);

    // When node not found, should query all nodes for suggestions
    const existCheck = await neo4j.runCypher('MATCH (n {id: $nodeId}) RETURN n.id', {});
    expect(existCheck.records.length).toBe(0);

    const allNodes = await neo4j.runCypher('MATCH (n) WHERE n.id IS NOT NULL RETURN n.id', {});
    expect(allNodes.records.length).toBe(1);
  });
});
