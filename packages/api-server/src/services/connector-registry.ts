import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { ConnectorInstanceConfig, GitHubConnectorConfig, LastRun } from '@shipit-ai/shared';
import { connectorInstanceSchema } from '@shipit-ai/shared';
import { InMemoryConnectorRunStore, type ConnectorRunStore } from './connector-run-store.js';

// ── ETag conflict ─────────────────────────────────────────────────────────
// Mirrors SchemaVersionConflictError so the routes can map both to HTTP 409
// with the current server hash. We deliberately use a distinct class name so
// `instanceof` checks stay precise across mixed schema/connector edits.
export class ConnectorVersionConflictError extends Error {
  readonly serverHash: string;
  constructor(serverHash: string) {
    super('Connector was modified by another writer since you read it.');
    this.name = 'ConnectorVersionConflictError';
    this.serverHash = serverHash;
  }
}

// ── Runtime status ────────────────────────────────────────────────────────
// `state` is the live execution status (idle/running/failed/degraded) — this
// is intentionally separate from the historical `lastRuns[]` persisted in
// YAML, which is the durable run log. The status is held only in memory
// because it changes on every poll tick; restarting the server reseeds
// `state: 'idle'` from YAML's `lastRuns[0]`.
export type SyncRuntimeState = 'idle' | 'running' | 'failed' | 'degraded';

export interface SyncRuntimeStatus {
  connectorId: string;
  state: SyncRuntimeState;
  startedAt?: string;
  lastError?: string;
  rateLimitRemaining?: number;
}

// ── Runner contract ───────────────────────────────────────────────────────
// The scheduler implements this; the registry calls into it without knowing
// about BullMQ or Redis. Keeping the dependency unidirectional lets the
// registry stay test-friendly (pass a fake runner) and lets the scheduler
// own all queue lifecycle concerns.
export interface ConnectorRunner {
  start(connector: GitHubConnectorConfig): Promise<void>;
  stop(connectorId: string): Promise<void>;
  triggerSync(
    connector: GitHubConnectorConfig,
    mode: 'full' | 'incremental',
  ): Promise<SyncRuntimeStatus>;
  getStatus(connectorId: string): SyncRuntimeStatus;
}

// Default no-op runner — used when the API server boots without a real
// scheduler (e.g. unit tests, or first-boot before BullMQ is wired). All
// methods are inert; triggerSync immediately reports completion. P0.4 swaps
// this out for the BullMQ-backed implementation.
class NoopRunner implements ConnectorRunner {
  private statuses = new Map<string, SyncRuntimeStatus>();

  async start(connector: GitHubConnectorConfig): Promise<void> {
    this.statuses.set(connector.id, { connectorId: connector.id, state: 'idle' });
  }
  async stop(connectorId: string): Promise<void> {
    this.statuses.delete(connectorId);
  }
  async triggerSync(
    connector: GitHubConnectorConfig,
    _mode: 'full' | 'incremental',
  ): Promise<SyncRuntimeStatus> {
    const status: SyncRuntimeStatus = {
      connectorId: connector.id,
      state: 'idle',
      startedAt: new Date().toISOString(),
    };
    this.statuses.set(connector.id, status);
    return status;
  }
  getStatus(connectorId: string): SyncRuntimeStatus {
    return this.statuses.get(connectorId) ?? { connectorId, state: 'idle' };
  }
}

export interface ConnectorRegistryOptions {
  localConfigPath: string;
  initial: ConnectorInstanceConfig[];
  runner?: ConnectorRunner;
  // Where run history lives. Defaults to an in-memory store so unit tests
  // can construct a registry without Redis. Production wiring in
  // packages/api-server/src/index.ts supplies a RedisConnectorRunStore.
  runStore?: ConnectorRunStore;
}

// Canonical-JSON serialization for hashing. JSON.stringify with sorted keys
// gives a stable representation across writes — without it, key order
// differences would flip the ETag for a logically-identical config.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj = value as Record<string, unknown>;
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

interface CreateConnectorInput {
  id: string;
  type: 'github';
  name: string;
  enabled?: boolean;
  installationId: string;
  org: string;
  schedule?: string;
  scope?: GitHubConnectorConfig['scope'];
  entities?: GitHubConnectorConfig['entities'];
  // Optional per-connector GitHub App override; absent → inherits global.
  app?: GitHubConnectorConfig['app'];
}

interface UpdateConnectorInput {
  enabled?: boolean;
  name?: string;
  schedule?: string;
  scope?: GitHubConnectorConfig['scope'];
  entities?: GitHubConnectorConfig['entities'];
  // Explicit `null` clears any existing override so the connector falls
  // back to the global App. `undefined` leaves the existing value alone.
  app?: GitHubConnectorConfig['app'] | null;
}

export class ConnectorRegistry {
  private localConfigPath: string;
  private connectors = new Map<string, ConnectorInstanceConfig>();
  private runner: ConnectorRunner;
  private runStore: ConnectorRunStore;

  constructor(opts: ConnectorRegistryOptions) {
    this.localConfigPath = opts.localConfigPath;
    this.runner = opts.runner ?? new NoopRunner();
    this.runStore = opts.runStore ?? new InMemoryConnectorRunStore();
    for (const c of opts.initial) {
      // Strip lastRuns from any legacy YAML that still carries it — runs
      // live in `runStore` now (Redis in prod, in-memory in tests). Keeping
      // them on the in-memory config object would re-emit them on the next
      // persist() round trip, undoing the migration.
      this.connectors.set(c.id, { ...c, lastRuns: [] });
    }
  }

  // Exposed so callers (routes, scheduler) can read run history without
  // reaching into private state. Always returns the same instance the
  // registry uses internally so writes via recordRun + reads here are
  // guaranteed consistent.
  getRunStore(): ConnectorRunStore {
    return this.runStore;
  }

  // Bootstraps the runner for already-loaded connectors. Called once after
  // the registry is constructed and the server is otherwise ready, so the
  // runner can schedule polling without blocking server start.
  async startRunner(): Promise<void> {
    for (const connector of this.connectors.values()) {
      if (connector.enabled) {
        await this.runner.start(connector as GitHubConnectorConfig);
      }
    }
  }

  list(): ConnectorInstanceConfig[] {
    return Array.from(this.connectors.values());
  }

  get(id: string): ConnectorInstanceConfig {
    const c = this.connectors.get(id);
    if (!c) {
      throw Object.assign(new Error(`Connector '${id}' not found`), { statusCode: 404 });
    }
    return c;
  }

  // ETag value for a single connector. Strong validator — same bytes → same
  // hash. Returned by GET and required by PATCH/DELETE via If-Match.
  getHash(id: string): string {
    return sha256(canonicalJson(this.get(id)));
  }

  async create(input: CreateConnectorInput): Promise<ConnectorInstanceConfig> {
    if (this.connectors.has(input.id)) {
      throw Object.assign(new Error(`Connector '${input.id}' already exists`), {
        statusCode: 409,
      });
    }
    // Run the input through Zod with the same schema the loader uses so we
    // can't drift between bootup validation and runtime creation. Order
    // matters: spread `input` last only after providing defaults, otherwise
    // `type` ends up duplicated by TypeScript.
    const parsed = parseConnectorInstance({
      enabled: input.enabled ?? true,
      schedule: input.schedule ?? '*/15 * * * *',
      scope: input.scope ?? {
        repos: { include: ['**'], exclude: [] },
        teams: { include: ['**'], exclude: [] },
        cappedAt: 100,
        cappedAcknowledged: false,
      },
      entities: input.entities ?? {
        repository: true,
        team: true,
        pipeline: true,
        codeowners: true,
        environment: false,
        deployment: false,
        branchProtection: false,
        workflowRun: false,
      },
      lastRuns: [],
      id: input.id,
      type: 'github' as const,
      name: input.name,
      installationId: input.installationId,
      org: input.org,
      // `app` is intentionally optional in the schema; only include it
      // when the caller provided one so YAML doesn't accumulate empty
      // override blocks.
      ...(input.app ? { app: input.app } : {}),
    });

    this.connectors.set(parsed.id, parsed);
    await this.persist();
    if (parsed.enabled) await this.runner.start(parsed as GitHubConnectorConfig);
    return parsed;
  }

  async update(
    id: string,
    input: UpdateConnectorInput,
    ifMatch: string | undefined,
  ): Promise<ConnectorInstanceConfig> {
    const existing = this.get(id);
    const currentHash = sha256(canonicalJson(existing));
    // Optimistic concurrency: if the caller supplied a hash and it doesn't
    // match what we have, refuse. Mirrors SchemaService.updateSchema so the
    // UI can use one error-handling path for both surfaces.
    if (ifMatch !== undefined && ifMatch !== currentHash) {
      throw new ConnectorVersionConflictError(currentHash);
    }

    // Merge: explicit undefined means "leave alone", null is treated as a
    // legitimate value. The wizard sends a complete object for scope/entities
    // so partial merges happen only at the top level. `app: null` clears
    // an existing override; `app: {...}` replaces it; `app: undefined`
    // leaves it alone.
    const mergedApp =
      input.app === null ? undefined : input.app !== undefined ? input.app : existing.app;
    const next = parseConnectorInstance({
      ...existing,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.entities !== undefined ? { entities: input.entities } : {}),
      app: mergedApp,
    });

    this.connectors.set(id, next);
    await this.persist();

    // Re-bind the runner so a flipped enabled flag or changed schedule takes
    // effect immediately. Stop-then-start is wasteful when only labels
    // changed; the runner is expected to no-op idempotently when nothing of
    // operational consequence changed.
    await this.runner.stop(id);
    if (next.enabled) await this.runner.start(next as GitHubConnectorConfig);
    return next;
  }

  async remove(id: string, ifMatch: string | undefined): Promise<void> {
    const existing = this.get(id);
    const currentHash = sha256(canonicalJson(existing));
    if (ifMatch !== undefined && ifMatch !== currentHash) {
      throw new ConnectorVersionConflictError(currentHash);
    }
    this.connectors.delete(id);
    await this.persist();
    await this.runner.stop(id);
    // Drop the connector's run history; otherwise a future connector
    // with the same id would inherit stale telemetry from a different
    // installation.
    await this.runStore.clear(id);
  }

  async triggerSync(id: string, mode: 'full' | 'incremental' = 'full'): Promise<SyncRuntimeStatus> {
    const connector = this.get(id);
    return this.runner.triggerSync(connector as GitHubConnectorConfig, mode);
  }

  getStatus(id: string): SyncRuntimeStatus {
    this.get(id); // 404 if missing
    return this.runner.getStatus(id);
  }

  // Appends a run summary to the connector's history. The history lives in
  // the run store (Redis in prod, in-memory in tests) — NOT in the
  // shipit.config.local.yaml that holds user-edited configuration. See
  // docs/agent/decisions/connector-run-storage-redis-not-yaml.md for the
  // rationale; the short version is "every poll wrote to YAML, which is
  // operational telemetry stomping on user-edited config".
  async recordRun(id: string, run: LastRun): Promise<void> {
    this.get(id); // 404 if the connector vanished mid-run
    await this.runStore.recordRun(id, run);
  }

  // ── Persistence ───────────────────────────────────────────────────────
  // Round-trip through yaml's Document API so comments and unrelated keys
  // survive untouched. Atomic via tempfile + rename so a mid-write crash
  // leaves the active file readable.
  //
  // `lastRuns` is intentionally stripped from the serialized output — run
  // history is operational state owned by the run store, not user-edited
  // configuration. Emitting it here would (a) re-introduce the write
  // contention this refactor solved, and (b) leak operational telemetry
  // into a file users version-control and hand-edit.
  private async persist(): Promise<void> {
    const raw = existsSync(this.localConfigPath) ? readFileSync(this.localConfigPath, 'utf-8') : '';
    const doc = raw.trim() ? parseDocument(raw) : parseDocument('');
    const instancesForYaml = this.list().map(({ lastRuns: _ignored, ...rest }) => rest);
    doc.setIn(['connectors', 'instances'], instancesForYaml);
    const next = String(doc);
    const tmp = join(
      dirname(this.localConfigPath),
      `.${process.pid}.${Date.now()}.shipit-local.tmp`,
    );
    writeFileSync(tmp, next, 'utf-8');
    renameSync(tmp, this.localConfigPath);
  }
}

// Re-validate through the same discriminated-union schema used by the
// loader, so values landing in the registry can't drift from boot-time shape
// checks. Exported from @shipit-ai/shared specifically to skip the ZodDefault
// wrapper that lives on `configSchema.connectors.instances`.
function parseConnectorInstance(value: unknown): ConnectorInstanceConfig {
  const result = connectorInstanceSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (i: { path: (string | number)[]; message: string }) =>
          `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
      )
      .join('\n');
    throw Object.assign(new Error(`Connector validation failed:\n${issues}`), {
      statusCode: 400,
    });
  }
  return result.data;
}
