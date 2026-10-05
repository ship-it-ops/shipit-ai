import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';
import { captureTool, toolPayload } from './helpers/capture-tool.js';
import { registerFindOwners } from '../tools/find-owners.js';
import { graphReadTools } from '../tools/registry.js';
import { MCP_TOOLS } from '../tools/metadata.js';

const RATE_LIMITS = { rateLimits: { rowLimit: 100, hopLimit: 6 } };

function ownersResponses() {
  const responses = new Map();
  responses.set('MATCH (entity {id: $entityId})', {
    records: [
      createMockRecord({
        entity: {
          properties: { id: 'shipit://logical-service/default/graph-api', name: 'graph-api' },
        },
        owners: [{ properties: { id: 'shipit://team/default/api-team', name: 'api-team' } }],
        codeowners: [],
        on_call: [],
      }),
    ],
    summary: { resultAvailableAfter: 1 },
  });
  return responses;
}

describe('graphReadTools', () => {
  it('exposes every tool the MCP server registers, in metadata order', () => {
    const tools = graphReadTools(createMockNeo4jClient(), RATE_LIMITS);
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      const meta = MCP_TOOLS.find((m) => m.name === tool.name)!;
      expect(tool.description).toBe(meta.description);
      expect(tool.effect).toBe(meta.effect);
      expect(tool.agents).toBe(meta.agents);
    }
  });

  it('gives each tool a Zod input schema, empty for schema_info', () => {
    const tools = graphReadTools(createMockNeo4jClient(), RATE_LIMITS);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName.schema_info.inputSchema.shape)).toEqual([]);
    expect(Object.keys(byName.find_owners.inputSchema.shape)).toEqual([
      'entity',
      'include_chain',
      'include_absent',
      'compact',
    ]);
    // Defaults apply on parse, exactly as the MCP SDK applies them.
    expect(byName.find_owners.inputSchema.parse({ entity: 'x' })).toEqual({
      entity: 'x',
      include_chain: false,
      include_absent: false,
      compact: false,
    });
  });

  it('returns the same payload as the MCP tool, parsed instead of stringified', async () => {
    const viaMcp = toolPayload(
      await captureTool(
        registerFindOwners,
        createMockNeo4jClient(ownersResponses()) as never,
      )({
        entity: 'shipit://logical-service/default/graph-api',
        include_chain: false,
        include_absent: false,
        compact: true,
      }),
    );
    const tool = graphReadTools(createMockNeo4jClient(ownersResponses()), RATE_LIMITS).find(
      (t) => t.name === 'find_owners',
    )!;
    const direct = await tool.run(
      tool.inputSchema.parse({
        entity: 'shipit://logical-service/default/graph-api',
        compact: true,
      }),
    );
    expect(direct).toEqual(viaMcp);
  });

  it('passes the row and hop limits through to graph_query', async () => {
    const tool = graphReadTools(createMockNeo4jClient(), {
      rateLimits: { rowLimit: 100, hopLimit: 2 },
    }).find((t) => t.name === 'graph_query')!;
    const result = (await tool.run(
      tool.inputSchema.parse({ query: 'MATCH (a)-[*..5]->(b) RETURN b' }),
    )) as { error: { code: string } };
    expect(result.error.code).toBe('HOP_LIMIT_EXCEEDED');
  });

  it('refuses a search label, sort key or filter key that is not a plain identifier', () => {
    const neo4j = createMockNeo4jClient();
    const tool = graphReadTools(neo4j, RATE_LIMITS).find((t) => t.name === 'search_entities')!;
    const refused = (input: unknown) => tool.inputSchema.safeParse(input).success === false;
    expect(refused({ label: 'Repository`) MATCH (m' })).toBe(true);
    expect(refused({ label: '_AccessToken' })).toBe(true);
    expect(refused({ sort_by: 'name` DESC //' })).toBe(true);
    expect(refused({ property_filters: { 'name` IS NOT NULL OR n.`x': 1 } })).toBe(true);
    expect(
      tool.inputSchema.safeParse({
        label: 'LogicalService',
        property_filters: { tier_effective: 1, _absent_since: null },
        sort_by: 'name',
      }).success,
    ).toBe(true);
    expect(neo4j.runCypher).not.toHaveBeenCalled();
  });

  it('rejects input the schema does not allow before any query runs', () => {
    const neo4j = createMockNeo4jClient();
    const tool = graphReadTools(neo4j, RATE_LIMITS).find((t) => t.name === 'blast_radius')!;
    expect(tool.inputSchema.safeParse({ node: 'x', depth: 99 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(neo4j.runCypher).not.toHaveBeenCalled();
    expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
  });
});
