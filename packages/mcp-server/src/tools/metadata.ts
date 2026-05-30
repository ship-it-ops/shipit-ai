// Canonical, UI-renderable metadata for every tool the MCP server registers.
// Each tool's `register*` function imports its description from here so the
// strings shown to AI agents and the strings shown on /configure/mcp can't drift.
// This module is dependency-free so the web UI can import it without pulling
// in the MCP SDK or neo4j-driver.

export interface McpToolParamSpec {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  required: boolean;
  description: string;
  default?: string;
  enumValues?: readonly string[];
}

export interface McpToolMetadata {
  name: string;
  description: string;
  /** Anchor on docs/mcp-tools.md (the tool name itself, slugified). */
  docAnchor: string;
  params: readonly McpToolParamSpec[];
}

const COMPACT_PARAM: McpToolParamSpec = {
  name: 'compact',
  type: 'boolean',
  required: false,
  description: 'Strip _meta envelope; return data only.',
  default: 'false',
};

export const MCP_TOOLS: readonly McpToolMetadata[] = [
  {
    name: 'blast_radius',
    description:
      'Analyze downstream/upstream impact of a node in the knowledge graph. Returns affected nodes, paths, and summary statistics.',
    docAnchor: 'blast_radius',
    params: [
      {
        name: 'node',
        type: 'string',
        required: true,
        description:
          'Starting node canonical ID (e.g. shipit://repository/default/acme-corp/config-service).',
      },
      {
        name: 'depth',
        type: 'integer',
        required: false,
        description: 'Max traversal hops (1-6).',
        default: '3',
      },
      {
        name: 'direction',
        type: 'enum',
        required: false,
        description: 'Traversal direction.',
        default: 'DOWNSTREAM',
        enumValues: ['DOWNSTREAM', 'UPSTREAM', 'BOTH'],
      },
      {
        name: 'include_environments',
        type: 'array',
        required: false,
        description: 'Filter deployments by environment name.',
      },
      {
        name: 'production_only',
        type: 'boolean',
        required: false,
        description: "Shorthand for include_environments: ['production'].",
        default: 'false',
      },
      COMPACT_PARAM,
    ],
  },
  {
    name: 'entity_detail',
    description:
      'Get detailed information about a single entity in the knowledge graph, including properties, claims, and neighbors.',
    docAnchor: 'entity_detail',
    params: [
      { name: 'entity', type: 'string', required: true, description: 'Entity canonical ID.' },
      {
        name: 'include_claims',
        type: 'boolean',
        required: false,
        description: 'Return all PropertyClaims for each property.',
        default: 'false',
      },
      {
        name: 'include_neighbors',
        type: 'boolean',
        required: false,
        description: 'Return 1-hop neighbors grouped by relationship type.',
        default: 'true',
      },
      COMPACT_PARAM,
    ],
  },
  {
    name: 'schema_info',
    description:
      'Return the current graph schema: all node types with property definitions and resolution strategies, all relationship types with direction and cardinality.',
    docAnchor: 'schema_info',
    params: [],
  },
  {
    name: 'find_owners',
    description:
      'Find owners, code owners, and on-call personnel for an entity. Traverses OWNS, CODEOWNER_OF, MEMBER_OF, and ON_CALL_FOR relationships.',
    docAnchor: 'find_owners',
    params: [
      { name: 'entity', type: 'string', required: true, description: 'Entity canonical ID.' },
      {
        name: 'include_chain',
        type: 'boolean',
        required: false,
        description: 'Return full ownership chain (CODEOWNERS → Team → Members).',
        default: 'false',
      },
      COMPACT_PARAM,
    ],
  },
  {
    name: 'dependency_chain',
    description: 'Find the shortest dependency path between two entities in the knowledge graph.',
    docAnchor: 'dependency_chain',
    params: [
      { name: 'from', type: 'string', required: true, description: 'Source node canonical ID.' },
      { name: 'to', type: 'string', required: true, description: 'Target node canonical ID.' },
      {
        name: 'max_depth',
        type: 'integer',
        required: false,
        description: 'Max path length (1-10).',
        default: '6',
      },
      COMPACT_PARAM,
    ],
  },
  {
    name: 'graph_stats',
    description:
      'Return aggregate statistics about the knowledge graph: node counts by label, edge counts by type, environments, totals, and freshness summary.',
    docAnchor: 'graph_stats',
    params: [],
  },
  {
    name: 'search_entities',
    description: 'Search and filter entities in the knowledge graph by label and property values.',
    docAnchor: 'search_entities',
    params: [
      {
        name: 'label',
        type: 'string',
        required: false,
        description: 'Filter by node label (e.g. "LogicalService").',
      },
      {
        name: 'property_filters',
        type: 'object',
        required: false,
        description: 'Filter by property values, e.g. {"tier_effective": 1}.',
      },
      {
        name: 'limit',
        type: 'integer',
        required: false,
        description: 'Max results (1-100).',
        default: '25',
      },
      {
        name: 'sort_by',
        type: 'string',
        required: false,
        description: 'Property to sort by.',
        default: 'name',
      },
      COMPACT_PARAM,
    ],
  },
  {
    name: 'graph_query',
    description:
      'Execute a raw Cypher query against the knowledge graph. Read-only queries only. Subject to guardrails: parameterized queries, timeout, row limit, hop limit.',
    docAnchor: 'graph_query',
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Cypher query (read-only, parameterized).',
      },
      { name: 'params', type: 'object', required: false, description: 'Query parameters.' },
      COMPACT_PARAM,
    ],
  },
];

export const MCP_TOOL_BY_NAME: Readonly<Record<string, McpToolMetadata>> = Object.freeze(
  Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t])),
);
