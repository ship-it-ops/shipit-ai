// Retention/cleanup for `GraphEditEvent` audit nodes.
//
// `GraphEditEvent` nodes (`ge:<uuid>`, label `GraphEditEvent`) are written one
// per manual claim set/revert, relation add/remove, and `contradicted`
// detection by manual-edit-service / relation-edit-service / verification-service,
// each anchored via `(e:GraphEditEvent)-[:EDITS]->(n)`. Nothing ever deleted
// them, so they grew unbounded — the same incident class as the 2026-06-17 /
// 2026-06-22 Redis OOM scars. This service is the bound: a periodic, batched
// DETACH DELETE of audit events older than `now - retentionDays`. Deferred S6
// follow-up from docs/agent/plans/manual-edit-write-path.md.
//
// PERFORMANCE NOTE: with zero Neo4j indexes today (see
// docs/agent/open-questions/neo4j-no-indexes-declared.md), the
// `WHERE e.ts < $cutoff` predicate is a label scan over `:GraphEditEvent`. That
// is cheap at current scale (the audit set is small); the eventual optimization
// is an index on `:GraphEditEvent(ts)`, which ties into the parked Neo4j-index
// follow-up. The `LIMIT $batch` keeps each transaction bounded regardless.
import neo4j, { type Record as Neo4jRecord } from 'neo4j-driver';

// Default rows deleted per transaction. Bounded so a large backlog doesn't open
// one enormous DETACH DELETE that holds locks / blows the heap; the cleanup loop
// re-issues until a pass deletes nothing.
const DEFAULT_BATCH_SIZE = 1000;
// Defensive ceiling on loop passes so a clock/data anomaly (or a pathological
// continuous-write rate) can never spin this forever. At the default batch this
// caps one run at 10M deletions — far above any realistic audit backlog.
const DEFAULT_MAX_ITERATIONS = 10_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Cutoff-filtered, batched, detach delete. `$cutoff` is a bound datetime
// parameter (never string-interpolated) so it round-trips as a real Neo4j
// `DATETIME` and compares against the `e.ts` `datetime()` written by the audit
// services. DETACH DELETE so the dangling `[:EDITS]` (and any future audit
// edges) go with the node.
const CLEANUP_CYPHER = `
  MATCH (e:GraphEditEvent)
  WHERE e.ts < datetime($cutoff)
  WITH e LIMIT $batch
  DETACH DELETE e
  RETURN count(e) AS deleted`;

// Minimal Neo4j surface this service needs — just `runQuery`. Lets the unit test
// pass a fake without standing up a driver.
interface Neo4jLike {
  runQuery(cypher: string, params?: Record<string, unknown>): Promise<Neo4jRecord[]>;
}

export interface AuditRetentionOptions {
  // Days to keep audit events. `0` (or negative — rejected at config load) means
  // retention is DISABLED: cleanup() is a no-op and never touches the DB.
  retentionDays: number;
  // Injectable clock for deterministic tests. Defaults to wall-clock.
  now?: () => Date;
  // Rows per DETACH DELETE transaction. Defaults to DEFAULT_BATCH_SIZE.
  batchSize?: number;
  // Defensive loop cap. Defaults to DEFAULT_MAX_ITERATIONS.
  maxIterations?: number;
}

export class AuditRetentionService {
  private readonly neo4j: Neo4jLike;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly maxIterations: number;

  constructor(neo4j: Neo4jLike, opts: AuditRetentionOptions) {
    this.neo4j = neo4j;
    this.retentionDays = opts.retentionDays;
    this.now = opts.now ?? (() => new Date());
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  /** True when a positive retention window is configured (retention is active). */
  get enabled(): boolean {
    return this.retentionDays > 0;
  }

  /**
   * Delete every `GraphEditEvent` older than `now - retentionDays`, in bounded
   * batches, looping until a pass deletes nothing (or the iteration cap is hit).
   * Returns the total number of audit events deleted. No-op (returns 0, issues
   * no query) when retention is disabled.
   */
  async cleanup(): Promise<number> {
    if (!this.enabled) return 0;

    const cutoff = new Date(this.now().getTime() - this.retentionDays * MS_PER_DAY).toISOString();

    let totalDeleted = 0;
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const records = await this.neo4j.runQuery(CLEANUP_CYPHER, {
        cutoff,
        // `LIMIT` requires a Neo4j INTEGER; a plain JS number marshals as a
        // float (`100.0`) which Cypher's LIMIT rejects (22N03). Wrap it.
        batch: neo4j.int(this.batchSize),
      });
      const deleted = toInt(records[0]?.get('deleted'));
      totalDeleted += deleted;
      // A pass that deleted fewer than a full batch means the backlog is
      // drained — stop rather than issue a final no-op query.
      if (deleted < this.batchSize) break;
    }
    return totalDeleted;
  }
}

/** Neo4j integers arrive as { low, high }; tolerate plain numbers (fakes/tests). */
function toInt(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'low' in raw) return Number((raw as { low: number }).low);
  return Number(raw) || 0;
}
