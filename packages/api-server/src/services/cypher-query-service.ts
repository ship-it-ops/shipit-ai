import neo4j, { type Driver, type Integer, type Node, type Relationship } from 'neo4j-driver';

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
}

export class CypherQueryService {
  constructor(
    private driver: Driver,
    private limits: CypherQueryLimits,
  ) {}

  async execute(cypher: string, params: Record<string, unknown> = {}): Promise<CypherExecResult> {
    const { timeoutMs, rowLimit } = this.limits;
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    const started = Date.now();
    try {
      // Server-side timeout via tx config. The driver will abort the transaction
      // when the timeout elapses; we still race against a client-side timeout
      // to make sure the request can't hang forever if the driver is wedged.
      const tx = session.beginTransaction({ timeout: timeoutMs });
      const queryPromise = tx.run(cypher, params);

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Query exceeded ${timeoutMs}ms timeout`));
        }, timeoutMs + 500);
      });

      let result;
      try {
        result = await Promise.race([queryPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      await tx.commit();

      const columns = result.records[0]?.keys ?? [];
      const sliced = result.records.slice(0, rowLimit);
      const rows = sliced.map((rec) => {
        const obj: Record<string, unknown> = {};
        for (const key of columns) {
          obj[String(key)] = toPlain(rec.get(String(key)));
        }
        return obj;
      });

      return {
        columns: columns.map(String),
        rows,
        executionTimeMs: Date.now() - started,
        truncated: result.records.length > rowLimit,
        rowLimit,
      };
    } finally {
      await session.close();
    }
  }
}
