import { describe, it, expect } from 'vitest';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';
import { captureTool } from './helpers/capture-tool.js';
import { registerFindOwners } from '../tools/find-owners.js';

describe('find_owners tool', () => {
  it('should return owners, codeowners, and on_call', async () => {
    const responses = new Map();
    responses.set('MATCH (entity {id: $entityId})', {
      records: [
        createMockRecord({
          entity: {
            properties: {
              id: 'shipit://logical-service/default/graph-api',
              name: 'graph-api',
            },
          },
          owners: [
            {
              properties: {
                name: 'api-team',
                email: 'api@shipitops.com',
                id: 'shipit://team/default/api-team',
              },
            },
          ],
          codeowners: [
            {
              properties: {
                name: 'Alice Smith',
                email: 'alice@shipitops.com',
                id: 'shipit://person/default/alice',
              },
            },
          ],
          on_call: [
            {
              properties: {
                name: 'Alice Smith',
                email: 'alice@shipitops.com',
                id: 'shipit://person/default/alice',
              },
            },
          ],
        }),
      ],
      summary: { resultAvailableAfter: 3 },
    });

    const neo4j = createMockNeo4jClient(responses);
    const result = await neo4j.runCypher('MATCH (entity {id: $entityId}) OPTIONAL', {
      entityId: 'test',
    });

    const record = result.records[0];
    const owners = record.get('owners') as Array<{ properties: { name: string } }>;
    const codeowners = record.get('codeowners') as Array<{ properties: { name: string } }>;
    const onCall = record.get('on_call') as Array<{ properties: { name: string } }>;

    expect(owners.length).toBe(1);
    expect(owners[0].properties.name).toBe('api-team');
    expect(codeowners.length).toBe(1);
    expect(codeowners[0].properties.name).toBe('Alice Smith');
    expect(onCall.length).toBe(1);
  });

  it('should include ownership chain with members', async () => {
    const responses = new Map();
    responses.set('MATCH (entity {id: $entityId})', {
      records: [
        createMockRecord({
          entity: { properties: { id: 'test-id' } },
          owners: [{ properties: { name: 'api-team', email: null, id: 'team-id' } }],
          codeowners: [],
          on_call: [],
          members: [
            { properties: { name: 'Alice Smith', email: 'alice@shipitops.com', id: 'alice-id' } },
            { properties: { name: 'Bob Jones', email: 'bob@shipitops.com', id: 'bob-id' } },
          ],
        }),
      ],
      summary: { resultAvailableAfter: 2 },
    });

    const neo4j = createMockNeo4jClient(responses);
    const result = await neo4j.runCypher('MATCH (entity {id: $entityId}) with members', {});

    const record = result.records[0];
    const members = record.get('members') as Array<{ properties: { name: string } }>;
    expect(members.length).toBe(2);
    expect(members[0].properties.name).toBe('Alice Smith');
  });
});

describe('find_owners include_absent', () => {
  function run(includeAbsent: boolean) {
    const neo4j = createMockNeo4jClient();
    const handler = captureTool(registerFindOwners as never, neo4j as never);
    return { neo4j, handler, includeAbsent };
  }

  it('threads include_absent into the generated Cypher', async () => {
    const { neo4j, handler } = run(false);
    await handler({ entity: 'x', include_chain: true, include_absent: false, compact: true });
    const cypher = neo4j.runCypher.mock.calls[0][0] as string;
    for (const alias of ['entity', 'owner', 'codeowner', 'oncall', 'member']) {
      expect(cypher).toContain(`${alias}._absent_since IS NULL`);
    }

    const inclusive = run(true);
    await inclusive.handler({
      entity: 'x',
      include_chain: true,
      include_absent: true,
      compact: true,
    });
    expect(inclusive.neo4j.runCypher.mock.calls[0][0] as string).not.toContain('_absent_since');
  });
});
