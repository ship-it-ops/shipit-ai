import neo4j, { type Driver, type Integer, type Node, type Relationship } from 'neo4j-driver';
import { runReadOnlyQuery } from '@shipit-ai/mcp-server/cypher';

export interface CypherQueryLimits {
  timeoutMs: number;
  rowLimit: number;
}

function isInteger(value: unknown): value is Integer {
  return typeof value === 'object' && value !== null && neo4j.isInt(value);
}

// Neo4j returns BigInt-backed Integer objects for ints, plus Node/Relationship
// objects with `.properties`. JSON.stringify chokes on the first and silently
// drops methods on the second — convert to plain JS up front.
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isInteger(value)) {
    const n = (value as Integer).toNumber();
    return Number.isFinite(n) ? n : (value as Integer).toString();
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // Neo4j Node
    if ('labels' in v && 'properties' in v && 'identity' in v) {
      const node = value as unknown as Node;
      return {
        _kind: 'node',
        labels: node.labels,
        properties: toPlain(node.properties) as Record<string, unknown>,
      };
    }
    // Neo4j Relationship
    if ('type' in v && 'properties' in v && 'start' in v && 'end' in v) {
      const rel = value as unknown as Relationship;
      return {
        _kind: 'relationship',
        type: rel.type,
        properties: toPlain(rel.properties) as Record<string, unknown>,
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toPlain(val);
    return out;
  }
  return value;
}

export interface CypherExecResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  executionTimeMs: number;
  truncated: boolean;
  rowLimit: number;
  /** How many values came back as null because they were internal nodes. */
  withheld: number;
}

export class CypherQueryService {
  constructor(
    private driver: Driver,
    private limits: CypherQueryLimits,
  ) {}

  /**
   * Runs a caller-written query for reading only, within the limits. How it is
   * run, and what that guarantees, is runReadOnlyQuery's: the graph_query MCP
   * tool goes through the same function.
   *
   * @throws ReadOnlyQueryError on every failure.
   */
  async execute(cypher: string, params: Record<string, unknown> = {}): Promise<CypherExecResult> {
    const started = Date.now();
    const result = await runReadOnlyQuery(this.driver, cypher, params, this.limits);
    return {
      columns: result.columns,
      rows: result.rows.map((row) => toPlain(row) as Record<string, unknown>),
      executionTimeMs: Date.now() - started,
      truncated: result.truncated,
      rowLimit: this.limits.rowLimit,
      withheld: result.withheld,
    };
  }
}
