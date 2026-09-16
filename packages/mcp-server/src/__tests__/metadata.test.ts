import { describe, it, expect } from 'vitest';
import { MCP_TOOL_BY_NAME } from '../tools/metadata.js';

describe('MCP tool metadata — include_absent', () => {
  it.each(['blast_radius', 'entity_detail', 'search_entities', 'dependency_chain'])(
    '%s documents include_absent (boolean, default false)',
    (tool) => {
      const param = MCP_TOOL_BY_NAME[tool as keyof typeof MCP_TOOL_BY_NAME].params.find(
        (p) => p.name === 'include_absent',
      );
      expect(param).toMatchObject({ type: 'boolean', required: false, default: 'false' });
    },
  );

  it('graph_stats and schema_info do not expose include_absent', () => {
    for (const tool of ['graph_stats', 'schema_info'] as const) {
      expect(MCP_TOOL_BY_NAME[tool].params.some((p) => p.name === 'include_absent')).toBe(false);
    }
  });
});
