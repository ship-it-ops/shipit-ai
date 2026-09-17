import type { CanonicalEntity } from './canonical.js';

/** Envelope kinds. An absent `kind` means `'entities'` (every pre-existing producer). */
export type EventKind = 'entities' | 'sync.completed';

/**
 * Control payload the scheduler publishes after a connector run finished with
 * `status: 'success'` in `mode: 'full'`. The core-writer marks every node stamped
 * with this connector id whose `_last_synced` predates `startedAt` as absent
 * (`_absent_since`). See docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md.
 */
export interface SyncCompletedControl {
  kind: 'sync.completed';
  /** ISO-8601 UTC start of the run, api-server clock — the same clock as `_last_synced`. */
  startedAt: string;
  mode: 'full' | 'incremental';
}

export interface EventEnvelope {
  id: string; // UUID
  timestamp: string; // ISO 8601
  connector_id: string;
  // {connector_id}~{entity_primary_key}~{event_version} — `:` is forbidden
  // by BullMQ 5 in custom job IDs, so the key uses `~` as both separator and
  // colon replacement. Opaque downstream; only used for dedup + replay.
  idempotency_key: string;
  payload: CanonicalEntity;
  /** Absent ⇒ `'entities'`. Control envelopes carry an empty payload. */
  kind?: EventKind;
  control?: SyncCompletedControl;
}

export interface EventHandler {
  (event: EventEnvelope): Promise<void>;
}

export interface EventBusClient {
  publish(events: CanonicalEntity[], connectorId: string): Promise<void>;
  /** Publish a control envelope (no entities). See `SyncCompletedControl`. */
  publishControl(connectorId: string, control: SyncCompletedControl): Promise<void>;
  subscribe(handler: EventHandler): Promise<void>;
  replay(fromTimestamp: string): Promise<void>;
  close(): Promise<void>;
}
