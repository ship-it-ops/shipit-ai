// Connector interface & types
export type {
  ConnectorConfig,
  AuthResult,
  DiscoveryResult,
  FetchResult,
  SyncResult,
  WebhookEvent,
  ConnectorManifest,
  ShipItConnector,
} from './interface.js';

// Harness
export { ConnectorHarness } from './harness.js';
export type { HarnessOptions } from './harness.js';

// Dry-run
export { dryRun } from './dry-run.js';
export type { DryRunResult, DryRunSummary } from './dry-run.js';

// Sync state
export { SyncState, SyncStateMachine } from './sync-state.js';

// Knowledge connectors (documents, not graph entities)
export * from './knowledge/index.js';
