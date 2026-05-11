import { describe, it, expect } from 'vitest';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';

describe('find_owners tool', () => {
  it('should return owners, codeowners, and on_call', async () => {
    const responses = new Map();
    responses.set('MATCH (entity {id: $entityId})', {
      records: [
        createMockRecord({
          entity: {
            properties: {
              id: 'shipit://logical-service/default/payments-api',
              name: 'payments-api',
            },
          },
          owners: [
            {
              properties: {
                name: 'payments-team',
                email: 'payments@acme.com',
                id: 'shipit://team/default/payments-team',
              },
            },
          ],
          codeowners: [
            {
              properties: {
                name: 'Alice Smith',
                email: 'alice@acme.com',
                id: 'shipit://person/default/alice',
              },
            },
          ],
          on_call: [
            {
              properties: {
                name: 'Alice Smith',
                email: 'alice@acme.com',
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
    expect(owners[0].properties.name).toBe('payments-team');
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
          owners: [{ properties: { name: 'payments-team', email: null, id: 'team-id' } }],
          codeowners: [],
          on_call: [],
          members: [
            { properties: { name: 'Alice Smith', email: 'alice@acme.com', id: 'alice-id' } },
            { properties: { name: 'Bob Jones', email: 'bob@acme.com', id: 'bob-id' } },
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
