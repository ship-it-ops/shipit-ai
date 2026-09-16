import type { ConnectorConfig, ShipItConnector } from '@shipit-ai/connector-sdk';
import type { AppLike, ConnectorInstanceConfig } from '@shipit-ai/shared';

/** What a connector type may need to turn a stored instance into a runnable connector. */
export interface BuildContext {
  // LIVE reference to the global GitHub App — the same object GitHubAppService
  // mutates on PUT /github/app. See docs/agent/patterns/live-reference-for-hot-reload.md.
  globalApp: AppLike;
  // Memoized in the scheduler (one disk read per path per process), plain
  // readFileSync in routes. Always fed a path already pinned to the key dir.
  readPrivateKey(path: string): string;
  // Absolute directory every credential file lives in (SHIPIT_GITHUB_APP_KEY_DIR).
  keyDir: string;
  // Graph lookups the Kubernetes linking tiers use (source-cased repo names,
  // team slugs for a GitHub org). Optional: absent in unit tests / no Neo4j.
  lookupRepositoryNames?(org: string): Promise<string[]>;
  lookupTeamSlugs?(org: string): Promise<string[]>;
  listConnectors(): ConnectorInstanceConfig[];
}

export type BuiltConnector = ShipItConnector & { getWarnings?(): string[] };

export type BuildResult =
  | { ok: true; connector: BuiltConnector; sdkConfig: ConnectorConfig }
  | { ok: false; code: string; message: string };

export interface ProbeResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ConnectorType<C extends ConnectorInstanceConfig = ConnectorInstanceConfig> {
  readonly type: C['type'];
  /**
   * Mode the repeatable poll job enqueues. GitHub polls `incremental` (webhooks
   * carry the deltas); Kubernetes lists the whole cluster every run, so it polls
   * `full` and every successful poll triggers the absence sweep.
   */
  readonly pollMode: 'full' | 'incremental';
  /**
   * True only when a successful full run is EXHAUSTIVE for everything this
   * type writes (Kubernetes lists the whole scope every run). GitHub full
   * syncs are bounded by scope/cap/entity toggles, so unseen ≠ gone — they
   * must not sweep.
   */
  readonly sweepsAbsent: boolean;
  build(cfg: C, ctx: BuildContext): Promise<BuildResult>;
  /** Types whose probe lives in the factory (Kubernetes); GitHub's stays in the route. */
  probe?(body: unknown, ctx: BuildContext): Promise<ProbeResult>;
}
