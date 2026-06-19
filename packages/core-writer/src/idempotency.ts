import type { CanonicalNode, EventEnvelope } from '@shipit-ai/shared';
import { deriveNodeContentHash } from '@shipit-ai/shared';

/**
 * Build an idempotency key from an event envelope.
 * Format: {connector_id}:{entity_primary_key}:{event_version}
 */
export function buildIdempotencyKey(envelope: EventEnvelope): string {
  return envelope.idempotency_key;
}

/**
 * Build an idempotency key for a specific node within a connector event.
 *
 * Cut B (Option B): the key is the node's CONTENT fingerprint, NOT `_event_version`.
 * `_event_version` is now purely the ordering token (epoch / content hash) used by
 * the writer's freshness guard; if it were also the dedup key, a content change that
 * did not advance the timestamp (e.g. a Pipeline run-status transition while
 * `last_run.created_at` is unchanged) would be deduped away and never reach the
 * guard — the original suppression bug. Hashing content means any genuine change
 * yields a new key and is processed, while true re-syncs of unchanged content dedup.
 *
 * MUST stay in lock-step with `event-bus` `producer.ts buildIdempotencyKey`
 * (same `deriveNodeContentHash`) so the BullMQ jobId layer and the `_IdempotencyLog`
 * layer agree on what is a duplicate.
 */
export function buildNodeIdempotencyKey(connectorId: string, node: CanonicalNode): string {
  return `${connectorId}:${node.id}:${deriveNodeContentHash(node)}`;
}

export interface IdempotencyChecker {
  isDuplicate(key: string): Promise<boolean>;
  record(key: string): Promise<void>;
}

/**
 * In-memory idempotency checker for unit tests.
 */
export class InMemoryIdempotencyChecker implements IdempotencyChecker {
  private readonly seen = new Set<string>();

  async isDuplicate(key: string): Promise<boolean> {
    return this.seen.has(key);
  }

  async record(key: string): Promise<void> {
    this.seen.add(key);
  }

  clear(): void {
    this.seen.clear();
  }
}
