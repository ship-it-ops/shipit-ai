// Connector run history lives in Redis, NOT in shipit.config.local.yaml.
//
// Why not YAML:
//   - Runs are operational telemetry, not user-edited configuration. Mixing
//     them creates write contention (every poll tick races user edits) and
//     leaks process-internal state into a file users are expected to read
//     and version-control.
//   - YAML write costs scale with file size and require the parseDocument
//     round-trip — fine for once-per-edit, painful for every-15-minutes-
//     per-connector.
//   - Capped FIFO is exactly what Redis lists model; using YAML for it is
//     the wrong shape.
//
// On-disk layout, one list per facet of a connector (newest entry at index 0):
//   shipit:connector-runs:<connectorId>             LIST   graph syncs
//   shipit:connector-runs:<connectorId>:knowledge   LIST   knowledge syncs
//
// The two are separate because every reader of the graph history takes entry
// 0 as the latest graph sync (the Connector Hub's status, last sync and entity
// count). A knowledge run in that list would overwrite all three.
//
// Operations:
//   recordRun   LPUSH + LTRIM(0, MAX_RUNS-1), on the list of the run's facet
//   listRuns    LRANGE 0 (limit-1)
//   clear       DEL of both lists (called by the registry on connector delete)
//
// The list is bounded at MAX_RUNS so a runaway poll loop can't fill Redis.
// No TTL — runs persist across restarts and are cleared explicitly on
// connector delete. If a connector is removed by hand-editing the YAML
// (out-of-band), its run history will linger as a small orphan; we accept
// that trade rather than coupling registry CRUD to Redis with a sweep.

import type { Redis } from 'ioredis';
import type { LastRun } from '@shipit-ai/shared';

export const MAX_RUNS = 20;
export const KEY_PREFIX = 'shipit:connector-runs:';

export type RunFacet = 'graph' | 'knowledge';

// A connector id cannot contain ':', so the suffix cannot name another connector.
function keyFor(connectorId: string, facet: RunFacet = 'graph'): string {
  const key = `${KEY_PREFIX}${connectorId}`;
  return facet === 'knowledge' ? `${key}:knowledge` : key;
}

/** A run with no facet is a graph sync: that is all there was before the field existed. */
const facetOf = (run: LastRun): RunFacet => (run.facet === 'knowledge' ? 'knowledge' : 'graph');

// Test seam — the registry depends on this interface, not on Redis. The
// in-memory implementation below is what unit tests pull in, and the
// production wiring in index.ts swaps in the Redis-backed one.
export interface ConnectorRunStore {
  /** Appends to the history of the run's own facet. */
  recordRun(connectorId: string, run: LastRun): Promise<void>;
  /** The graph syncs unless `facet` says otherwise. */
  listRuns(connectorId: string, limit?: number, facet?: RunFacet): Promise<LastRun[]>;
  listManyLatest(
    connectorIds: string[],
    limit?: number,
    facet?: RunFacet,
  ): Promise<Record<string, LastRun[]>>;
  /** Drops both histories. */
  clear(connectorId: string): Promise<void>;
}

// ── Redis-backed (production) ────────────────────────────────────────────
export class RedisConnectorRunStore implements ConnectorRunStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async recordRun(connectorId: string, run: LastRun): Promise<void> {
    const key = keyFor(connectorId, facetOf(run));
    // Single pipelined round trip: prepend + cap. Atomic enough for our
    // use case; concurrent writers might briefly exceed MAX_RUNS between
    // LPUSH and LTRIM, but the next call always converges.
    const pipeline = this.redis.pipeline();
    pipeline.lpush(key, JSON.stringify(run));
    pipeline.ltrim(key, 0, MAX_RUNS - 1);
    await pipeline.exec();
  }

  async listRuns(
    connectorId: string,
    limit: number = MAX_RUNS,
    facet: RunFacet = 'graph',
  ): Promise<LastRun[]> {
    const cap = Math.min(Math.max(limit, 0), MAX_RUNS);
    if (cap === 0) return [];
    const raw = await this.redis.lrange(keyFor(connectorId, facet), 0, cap - 1);
    return parseRuns(raw, facet);
  }

  // Pipelined fetch of N keys at once so the list-connectors endpoint
  // doesn't pay one Redis round-trip per connector. The result preserves
  // input ordering by populating a Record keyed on connectorId.
  async listManyLatest(
    connectorIds: string[],
    limit: number = MAX_RUNS,
    facet: RunFacet = 'graph',
  ): Promise<Record<string, LastRun[]>> {
    if (connectorIds.length === 0) return {};
    const cap = Math.min(Math.max(limit, 0), MAX_RUNS);
    const pipeline = this.redis.pipeline();
    for (const id of connectorIds) pipeline.lrange(keyFor(id, facet), 0, cap - 1);
    const results = await pipeline.exec();
    const out: Record<string, LastRun[]> = {};
    for (let i = 0; i < connectorIds.length; i++) {
      const id = connectorIds[i] as string;
      const entry = results?.[i];
      // pipeline.exec returns [err, value] tuples; ignore individual key
      // failures so one bad key doesn't break the whole response.
      if (!entry || entry[0]) {
        out[id] = [];
        continue;
      }
      out[id] = parseRuns(entry[1] as string[], facet);
    }
    return out;
  }

  async clear(connectorId: string): Promise<void> {
    await this.redis.del(keyFor(connectorId), keyFor(connectorId, 'knowledge'));
  }
}

// ── In-memory (tests, no-Redis dev) ──────────────────────────────────────
// Same semantics, no IO. Tests pass an instance of this directly instead
// of mocking the Redis client.
export class InMemoryConnectorRunStore implements ConnectorRunStore {
  private readonly byKey = new Map<string, LastRun[]>();

  async recordRun(connectorId: string, run: LastRun): Promise<void> {
    const key = keyFor(connectorId, facetOf(run));
    const existing = this.byKey.get(key) ?? [];
    this.byKey.set(key, [run, ...existing].slice(0, MAX_RUNS));
  }

  async listRuns(
    connectorId: string,
    limit: number = MAX_RUNS,
    facet: RunFacet = 'graph',
  ): Promise<LastRun[]> {
    const cap = Math.min(Math.max(limit, 0), MAX_RUNS);
    return (this.byKey.get(keyFor(connectorId, facet)) ?? []).slice(0, cap);
  }

  async listManyLatest(
    connectorIds: string[],
    limit: number = MAX_RUNS,
    facet: RunFacet = 'graph',
  ): Promise<Record<string, LastRun[]>> {
    const out: Record<string, LastRun[]> = {};
    for (const id of connectorIds) out[id] = await this.listRuns(id, limit, facet);
    return out;
  }

  async clear(connectorId: string): Promise<void> {
    this.byKey.delete(keyFor(connectorId));
    this.byKey.delete(keyFor(connectorId, 'knowledge'));
  }
}

// Entries of `facet` only. A build from before the lists were split wrote
// knowledge runs into the graph list; those are left out rather than shown as
// graph syncs.
function parseRuns(raw: string[], facet: RunFacet): LastRun[] {
  return raw.map(parseRun).filter((r): r is LastRun => r !== null && facetOf(r) === facet);
}

// Defensive parser — a stray non-JSON entry (e.g. a manual `redis-cli LPUSH`
// during debugging) should not crash the API. Drop it instead.
function parseRun(s: string): LastRun | null {
  try {
    const v = JSON.parse(s) as LastRun;
    if (typeof v !== 'object' || v === null) return null;
    return v;
  } catch {
    return null;
  }
}
