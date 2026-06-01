import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../../server.js';
import type { Neo4jService } from '../../services/neo4j-service.js';
import type { FastifyInstance } from 'fastify';
import { makeTestConfig } from '../test-config.js';

function createMockNeo4jService(): Neo4jService {
  // queryRoutes calls getDriver() at register time; return a stub driver so the
  // CypherQueryService constructor doesn't throw, even though these tests never
  // exercise /api/query.
  const stubDriver = { session: () => ({ close: vi.fn().mockResolvedValue(undefined) }) };
  return {
    getDriver: vi.fn().mockReturnValue(stubDriver),
    runQuery: vi.fn().mockResolvedValue([]),
    getGraphStats: vi.fn().mockResolvedValue({
      nodeCount: 42,
      edgeCount: 100,
      nodesByLabel: { LogicalService: 10, Repository: 20, Team: 12 },
      edgeCountsByType: { OWNS: 30, IMPLEMENTED_BY: 40, DEPENDS_ON: 30 },
      staleness: 0,
      lastSync: '2026-04-19T00:00:00.000Z',
      healthScore: 100,
    }),
    getNeighborhood: vi.fn().mockResolvedValue({
      nodes: [
        {
          data: {
            id: 'shipit://LogicalService/shipitops/graph-api',
            label: 'LogicalService',
            name: 'graph-api',
          },
        },
        {
          data: {
            id: 'shipit://Repository/shipitops/graph-api',
            label: 'Repository',
            name: 'graph-api',
          },
        },
      ],
      edges: [
        {
          data: {
            source: 'shipit://LogicalService/shipitops/graph-api',
            target: 'shipit://Repository/shipitops/graph-api',
            type: 'IMPLEMENTED_BY',
          },
        },
      ],
    }),
    searchEntities: vi.fn().mockResolvedValue([
      {
        get: () => ({
          properties: {
            id: 'shipit://LogicalService/shipitops/graph-api',
            name: 'graph-api',
            tier: 1,
          },
        }),
      },
    ]),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Neo4jService;
}

describe('Graph routes', () => {
  let server: FastifyInstance;
  let mockNeo4j: Neo4jService;

  beforeAll(async () => {
    mockNeo4j = createMockNeo4jService();
    server = await createServer({ neo4jService: mockNeo4j, config: makeTestConfig() });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/graph/stats returns graph statistics', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/stats',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nodeCount).toBe(42);
    expect(body.edgeCount).toBe(100);
    expect(body.nodesByLabel.LogicalService).toBe(10);
  });

  it('GET /api/graph/neighborhood/:id returns neighborhood', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/neighborhood/shipit%3A%2F%2FLogicalService%2Fshipitops%2Fgraph-api',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
  });

  it('GET /api/graph/neighborhood/:id respects depth parameter', async () => {
    await server.inject({
      method: 'GET',
      url: '/api/graph/neighborhood/test-node?depth=3',
    });
    expect(mockNeo4j.getNeighborhood).toHaveBeenCalledWith(expect.anything(), 'test-node', 3);
  });

  it('GET /api/graph/neighborhood/:id caps depth at 5', async () => {
    await server.inject({
      method: 'GET',
      url: '/api/graph/neighborhood/test-node?depth=99',
    });
    expect(mockNeo4j.getNeighborhood).toHaveBeenCalledWith(expect.anything(), 'test-node', 5);
  });

  it('GET /api/graph/search returns search results', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/search?label=LogicalService&q=graph',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('graph-api');
  });
});
