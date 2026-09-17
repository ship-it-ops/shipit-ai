import { describe, it, expect } from 'vitest';
import { MCP_TOOL_BY_NAME } from '../tools/metadata.js';

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
