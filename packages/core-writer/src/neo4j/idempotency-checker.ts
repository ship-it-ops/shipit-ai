// Neo4j-backed IdempotencyChecker. Production swap for the
// InMemoryIdempotencyChecker used in tests. Persists processed keys as
// `_IdempotencyLog` nodes with TTL so re-runs of the same sync don't
// double-write entities.
import type { IdempotencyChecker } from '../idempotency.js';
import { Neo4jClient } from './client.js';
import {
  checkIdempotencyKey,
  writeIdempotencyKey,
  cleanupExpiredIdempotencyKeys,
} from './queries.js';

export class Neo4jIdempotencyChecker implements IdempotencyChecker {
  private readonly client: Neo4jClient;
  private readonly ttlDays: number;
  private readonly database?: string;

  constructor(client: Neo4jClient, ttlDays: number, database?: string) {
    this.client = client;
    this.ttlDays = ttlDays;
    this.database = database;
  }

  async isDuplicate(key: string): Promise<boolean> {
    return this.client.executeRead(async (tx) => {
      return checkIdempotencyKey(tx, key);
    }, this.database);
  }

  async record(key: string): Promise<void> {
    await this.client.executeWrite(async (tx) => {
      await writeIdempotencyKey(tx, key, this.ttlDays);
    }, this.database);
  }

  /**
   * Delete expired `_IdempotencyLog` entries. Cut B makes the dedup key
   * content-derived, so a frequently-changing entity accumulates one log node
   * per distinct content version; without periodic cleanup the log grows
   * unbounded (the reclaim was previously never scheduled). Returns the count
   * deleted. Best-effort — callers swallow errors.
   */
  async cleanupExpired(): Promise<number> {
    return this.client.executeWrite(async (tx) => {
      return cleanupExpiredIdempotencyKeys(tx);
    }, this.database);
  }
}
