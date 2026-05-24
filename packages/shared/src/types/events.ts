import type { CanonicalEntity } from './canonical.js';

export interface EventEnvelope {
  id: string; // UUID
  timestamp: string; // ISO 8601
  connector_id: string;
  // {connector_id}~{entity_primary_key}~{event_version} — `:` is forbidden
  // by BullMQ 5 in custom job IDs, so the key uses `~` as both separator and
  // colon replacement. Opaque downstream; only used for dedup + replay.
  idempotency_key: string;
  payload: CanonicalEntity;
}

export interface EventHandler {
  (event: EventEnvelope): Promise<void>;
}

export interface EventBusClient {
  publish(events: CanonicalEntity[], connectorId: string): Promise<void>;
  subscribe(handler: EventHandler): Promise<void>;
  replay(fromTimestamp: string): Promise<void>;
  close(): Promise<void>;
}
