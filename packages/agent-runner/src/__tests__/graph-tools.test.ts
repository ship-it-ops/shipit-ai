import { describe, it, expect, vi } from 'vitest';
import { graphReadTools, type Neo4jClient } from '@shipit-ai/mcp-server/tools';
import { graphTools, toRunnerTool } from '../tools/graph-tools.js';

// A Neo4j stand-in: every query returns no rows, and calls are recorded.
function emptyGraph() {
  const runCypher = vi.fn(async () => ({ records: [], summary: { resultAvailableAfter: 0 } }));
  const runReadOnlyQuery = vi.fn(async () => ({
    columns: [] as string[],
    rows: [] as Array<Record<string, unknown>>,
    truncated: false,
    withheld: 0,
  }));
  return { runCypher, runReadOnlyQuery, close: vi.fn(async () => {}) } as unknown as Neo4jClient & {
    runCypher: typeof runCypher;
    runReadOnlyQuery: typeof runReadOnlyQuery;
  };
}

const LIMITS = { rateLimits: { rowLimit: 100, hopLimit: 6, queryTimeoutMs: 10_000 } };

describe('graphTools', () => {
  it('describes the graph tools an agent may be offered as built-in graph reads', () => {
    const tools = graphTools(emptyGraph(), LIMITS);
    expect(tools.map((t) => t.descriptor.id)).toEqual([
      'graph.blast_radius',
      'graph.entity_detail',
      'graph.schema_info',
      'graph.find_owners',
      'graph.dependency_chain',
      'graph.graph_stats',
      'graph.search_entities',
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

  // graph_query runs a caller-written string as Cypher, and a model is steered
  // by the text it reads, so the runner never hands it over (mcp-server
  // metadata: agents: false).
  it('does not offer raw Cypher to a model', () => {
    const ids = graphTools(emptyGraph(), LIMITS).map((t) => t.descriptor.id);
    expect(ids).not.toContain('graph.graph_query');
  });

  it('refuses search input that is not a plain identifier, before any query runs', () => {
    const graph = emptyGraph();
    const search = graphTools(graph, LIMITS).find(
      (t) => t.descriptor.id === 'graph.search_entities',
    )!;
    expect(search.parse({ label: 'Repository`) MATCH (m' })).toEqual({
      ok: false,
      message: expect.stringContaining('label'),
    });
    expect(search.parse({ sort_by: 'name` DESC //' })).toMatchObject({ ok: false });
    expect(search.parse({ property_filters: { 'name` OR n.`x': 1 } })).toMatchObject({
      ok: false,
    });
    expect(
      search.parse({ label: 'Repository', property_filters: { tier_effective: 1 } }),
    ).toMatchObject({ ok: true });
    expect(graph.runCypher).not.toHaveBeenCalled();
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
    const graph = emptyGraph();
    graph.runReadOnlyQuery.mockResolvedValue({
      columns: ['n'],
      rows: [{ n: 1 }, { n: 1 }],
      truncated: true,
      withheld: 0,
    });
    // graph_query is the one tool that truncates today. It is not offered to
    // agents, so the adapter is exercised on it directly.
    const query = toRunnerTool(
      graphReadTools(graph, {
        rateLimits: { rowLimit: 2, hopLimit: 6, queryTimeoutMs: 10_000 },
      }).find((t) => t.name === 'graph_query')!,
    );
    const parsed = query.parse({ query: 'MATCH (n) RETURN n' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(await query.execute(parsed.value)).toEqual({
      data: { rows: [{ n: 1 }, { n: 1 }], row_count: 2 },
      truncated: true,
      warnings: ['Results truncated to 2 rows'],
    });
  });

  it('returns a tool-level failure as data, not as a thrown error', async () => {
    const detail = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.entity_detail',
    )!;
    const parsed = detail.parse({ entity: 'shipit://repository/default/acme/nowhere' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(await detail.execute(parsed.value)).toEqual({
      error: expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    });
  });
});
