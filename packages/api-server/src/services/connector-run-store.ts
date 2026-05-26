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
// On-disk layout:
//   shipit:connector-runs:<connectorId>   LIST   newest entry at index 0
//
// Operations:
//   recordRun   LPUSH + LTRIM(0, MAX_RUNS-1)
//   listRuns    LRANGE 0 (limit-1)
//   clear       DEL  (called by the registry on connector delete)
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

function keyFor(connectorId: string): string {
  return `${KEY_PREFIX}${connectorId}`;
}

// Test seam — the registry depends on this interface, not on Redis. The
// in-memory implementation below is what unit tests pull in, and the
// production wiring in index.ts swaps in the Redis-backed one.
export interface ConnectorRunStore {
  recordRun(connectorId: string, run: LastRun): Promise<void>;
  listRuns(connectorId: string, limit?: number): Promise<LastRun[]>;
  listManyLatest(connectorIds: string[], limit?: number): Promise<Record<string, LastRun[]>>;
  clear(connectorId: string): Promise<void>;
}

// ── Redis-backed (production) ────────────────────────────────────────────
export class RedisConnectorRunStore implements ConnectorRunStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async recordRun(connectorId: string, run: LastRun): Promise<void> {
    const key = keyFor(connectorId);
    // Single pipelined round trip: prepend + cap. Atomic enough for our
    // use case; concurrent writers might briefly exceed MAX_RUNS between
    // LPUSH and LTRIM, but the next call always converges.
    const pipeline = this.redis.pipeline();
    pipeline.lpush(key, JSON.stringify(run));
    pipeline.ltrim(key, 0, MAX_RUNS - 1);
    await pipeline.exec();
  }

  async listRuns(connectorId: string, limit: number = MAX_RUNS): Promise<LastRun[]> {
    const cap = Math.min(Math.max(limit, 0), MAX_RUNS);
    if (cap === 0) return [];
    const raw = await this.redis.lrange(keyFor(connectorId), 0, cap - 1);
    return raw.map(parseRun).filter((r): r is LastRun => r !== null);
  }

  // Pipelined fetch of N keys at once so the list-connectors endpoint
  // doesn't pay one Redis round-trip per connector. The result preserves
  // input ordering by populating a Record keyed on connectorId.
  async listManyLatest(
    connectorIds: string[],
    limit: number = MAX_RUNS,
  ): Promise<Record<string, LastRun[]>> {
    if (connectorIds.length === 0) return {};
    const cap = Math.min(Math.max(limit, 0), MAX_RUNS);
    const pipeline = this.redis.pipeline();
    for (const id of connectorIds) pipeline.lrange(keyFor(id), 0, cap - 1);
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
      const raw = entry[1] as string[];
      out[id] = raw.map(parseRun).filter((r): r is LastRun => r !== null);
    }
    return out;
  }

  async clear(connectorId: string): Promise<void> {
    await this.redis.del(keyFor(connectorId));
  }
}

// ── In-memory (tests, no-Redis dev) ──────────────────────────────────────
// Same semantics, no IO. Tests pass an instance of this directly instead
// of mocking the Redis client.
export class InMemoryConnectorRunStore implements ConnectorRunStore {
  private readonly byId = new Map<string, LastRun[]>();

  async recordRun(connectorId: string, run: LastRun): Promise<void> {
    const existing = this.byId.get(connectorId) ?? [];
    const next = [run, ...existing].slice(0, MAX_RUNS);
    this.byId.set(connectorId, next);
  }

  async listRuns(connectorId: string, limit: number = MAX_RUNS): Promise<LastRun[]> {
    const cap = Math.min(Math.max(limit, 0), MAX_RUNS);
    return (this.byId.get(connectorId) ?? []).slice(0, cap);
  }

  async listManyLatest(
    connectorIds: string[],
    limit: number = MAX_RUNS,
  ): Promise<Record<string, LastRun[]>> {
    const out: Record<string, LastRun[]> = {};
    for (const id of connectorIds) out[id] = await this.listRuns(id, limit);
    return out;
  }

  async clear(connectorId: string): Promise<void> {
    this.byId.delete(connectorId);
  }
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
