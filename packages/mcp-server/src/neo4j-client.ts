import neo4j, { type Driver, type Session, type Record as Neo4jRecord } from 'neo4j-driver';
import {
  runReadOnlyQuery,
  type ReadOnlyQueryLimits,
  type ReadOnlyQueryResult,
} from './cypher/read-only-query.js';

export interface CypherResult {
  records: Neo4jRecord[];
  summary: {
    resultAvailableAfter: number;
  };
}

export interface Neo4jClient {
  /** Runs a query this package wrote itself. */
  runCypher(query: string, params?: Record<string, unknown>): Promise<CypherResult>;
  /**
   * Runs a query a caller wrote, for reading only and within `limits`: see
   * runReadOnlyQuery. The text must have passed checkReadOnlyCypher first.
   */
  runReadOnlyQuery(
    query: string,
    params: Record<string, unknown>,
    limits: ReadOnlyQueryLimits,
  ): Promise<ReadOnlyQueryResult>;
  close(): Promise<void>;
}

export function createNeo4jClient(uri: string, user: string, password: string): Neo4jClient {
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  return {
    async runCypher(query: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
      const session: Session = driver.session({ defaultAccessMode: neo4j.session.READ });
      try {
        const result = await session.run(query, params);
        return {
          records: result.records,
          summary: {
            resultAvailableAfter: result.summary.resultAvailableAfter.toNumber(),
          },
        };
      } finally {
        await session.close();
      }
    },

    runReadOnlyQuery(query, params, limits) {
      return runReadOnlyQuery(driver, query, params, limits);
    },

    async close(): Promise<void> {
      await driver.close();
    },
  };
}
