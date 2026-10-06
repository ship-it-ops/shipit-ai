import { describe, it, expect } from 'vitest';
import { MCP_TOOLS, MCP_TOOL_BY_NAME } from '../tools/metadata.js';

describe('MCP tool metadata — include_absent', () => {
  it.each([
    'blast_radius',
    'entity_detail',
    'search_entities',
    'dependency_chain',
    'find_owners',
    'graph_stats',
  ])('%s documents include_absent (boolean, default false)', (tool) => {
    const param = MCP_TOOL_BY_NAME[tool as keyof typeof MCP_TOOL_BY_NAME].params.find(
      (p) => p.name === 'include_absent',
    );
    expect(param).toMatchObject({ type: 'boolean', required: false, default: 'false' });
  });

  // schema_info returns the schema, not entities, so there is nothing to include.
  it('schema_info does not expose include_absent', () => {
    expect(MCP_TOOL_BY_NAME.schema_info.params.some((p) => p.name === 'include_absent')).toBe(
      false,
    );
  });
});

describe('MCP tool metadata — service and effect', () => {
  // Agents see these tools as service 'graph'. All eight only read; a write
  // tool added here must say so, because the agent gateway grants by effect.
  it.each(MCP_TOOLS.map((t) => t.name))('%s is a graph read tool', (tool) => {
    expect(MCP_TOOL_BY_NAME[tool]).toMatchObject({ service: 'graph', effect: 'read' });
  });
});

describe('MCP tool metadata — offered to agents', () => {
  // The agent runner and the agent tool catalog read this flag. graph_query
  // runs a caller-written string as Cypher, and a model acts on the text it
  // reads, so a model is not handed it unless the owner decides otherwise.
  it('keeps raw Cypher away from agents', () => {
    expect(MCP_TOOL_BY_NAME.graph_query.agents).toBe(false);
  });

  it('offers every other tool to agents', () => {
    const offered = MCP_TOOLS.filter((t) => t.agents).map((t) => t.name);
    expect(offered).toEqual([
      'blast_radius',
      'entity_detail',
      'schema_info',
      'find_owners',
      'dependency_chain',
      'graph_stats',
      'search_entities',
    ]);
  });
});
