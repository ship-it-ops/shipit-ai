import { vi } from 'vitest';
import type { Neo4jClient, CypherResult } from '../../neo4j-client.js';

export interface MockRecord {
  _data: Record<string, unknown>;
  get(key: string): unknown;
  toObject(): Record<string, unknown>;
}

export function createMockRecord(data: Record<string, unknown>): MockRecord {
  return {
    _data: data,
    get(key: string): unknown {
      return data[key];
    },
    toObject(): Record<string, unknown> {
      return data;
    },
  };
}

export function createMockNeo4jClient(
  responses?: Map<string, CypherResult>,
): Neo4jClient & { runCypher: ReturnType<typeof vi.fn> } {
  const defaultResult: CypherResult = {
    records: [],
    summary: { resultAvailableAfter: 0 },
  };

  const runCypher = vi.fn(async (query: string, _params?: Record<string, unknown>) => {
    if (responses) {
      for (const [pattern, result] of responses.entries()) {
        if (query.includes(pattern)) return result;
      }
    }
    return defaultResult;
  });

  return {
    runCypher,
    close: vi.fn(async () => {}),
  };
}

export function createNodeRecord(nodeProps: Record<string, unknown>, labels: string[]): MockRecord {
  return createMockRecord({
    node: { properties: nodeProps },
    labels,
  });
}
