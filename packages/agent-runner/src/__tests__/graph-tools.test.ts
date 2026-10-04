import { describe, it, expect, vi } from 'vitest';
import type { Neo4jClient } from '@shipit-ai/mcp-server/tools';
import { graphTools } from '../tools/graph-tools.js';

// A Neo4j stand-in: every query returns no rows, and calls are recorded.
function emptyGraph() {
  const runCypher = vi.fn(async () => ({ records: [], summary: { resultAvailableAfter: 0 } }));
  return { runCypher, close: vi.fn(async () => {}) } as unknown as Neo4jClient & {
    runCypher: typeof runCypher;
  };
}

const LIMITS = { rateLimits: { rowLimit: 100, hopLimit: 6 } };

describe('graphTools', () => {
  it('describes the eight graph tools as built-in graph reads', () => {
    const tools = graphTools(emptyGraph(), LIMITS);
    expect(tools.map((t) => t.descriptor.id)).toEqual([
      'graph.blast_radius',
      'graph.entity_detail',
      'graph.schema_info',
      'graph.find_owners',
      'graph.dependency_chain',
      'graph.graph_stats',
      'graph.search_entities',
      'graph.graph_query',
    ]);
    for (const { descriptor } of tools) {
      expect(descriptor).toMatchObject({
        service: 'graph',
        effect: 'read',
        source: 'builtin',
        effectConfirmed: true,
        enabled: true,
      });
      expect(descriptor.description.length).toBeGreaterThan(10);
    }
  });

  it('hides the compact flag from the model, and sends plain JSON Schema', () => {
    const findOwners = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.find_owners',
    )!;
    const schema = findOwners.descriptor.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
      $schema?: string;
    };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['entity', 'include_chain', 'include_absent']);
    expect(schema.required).toEqual(['entity']);
    expect(schema.$schema).toBeUndefined();
  });

  it('validates input and fills defaults, naming the field that is wrong', () => {
    const blast = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.blast_radius',
    )!;
    expect(blast.parse({ node: 'shipit://x' })).toEqual({
      ok: true,
      value: expect.objectContaining({ node: 'shipit://x', depth: 3, direction: 'DOWNSTREAM' }),
    });
    const bad = blast.parse({ node: 'shipit://x', depth: 99 });
    expect(bad).toEqual({ ok: false, message: expect.stringContaining('depth') });
    expect(blast.parse('not an object')).toMatchObject({ ok: false });
  });

  it('returns the payload without the MCP envelope', async () => {
    const graph = emptyGraph();
    const stats = graphTools(graph, LIMITS).find((t) => t.descriptor.id === 'graph.graph_stats')!;
    const parsed = stats.parse({});
    if (!parsed.ok) throw new Error(parsed.message);
    const result = (await stats.execute(parsed.value)) as Record<string, unknown>;
    expect(result).not.toHaveProperty('_meta');
    expect(graph.runCypher).toHaveBeenCalled();
  });

  it('keeps a truncation warning, so the model knows rows are missing', async () => {
    const row = { get: () => 1, toObject: () => ({ n: 1 }) };
    const graph = emptyGraph();
    graph.runCypher.mockResolvedValue({
      records: [row, row],
      summary: { resultAvailableAfter: 0 },
    } as never);
    const query = graphTools(graph, { rateLimits: { rowLimit: 2, hopLimit: 6 } }).find(
      (t) => t.descriptor.id === 'graph.graph_query',
    )!;
    const parsed = query.parse({ query: 'MATCH (n) RETURN n' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(await query.execute(parsed.value)).toEqual({
      data: { rows: [{ n: 1 }, { n: 1 }], row_count: 2 },
      truncated: true,
      warnings: ['Results truncated to 2 rows'],
    });
  });

  it('returns a tool-level failure as data, not as a thrown error', async () => {
    const query = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.graph_query',
    )!;
    const parsed = query.parse({ query: 'MATCH (n) DETACH DELETE n' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(await query.execute(parsed.value)).toEqual({
      error: expect.objectContaining({ code: 'INVALID_PARAMETER' }),
    });
  });
});
