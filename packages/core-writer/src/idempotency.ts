import type { CanonicalNode, EventEnvelope } from '@shipit-ai/shared';

/**
 * Build an idempotency key from an event envelope.
 * Format: {connector_id}:{entity_primary_key}:{event_version}
 */
export function buildIdempotencyKey(envelope: EventEnvelope): string {
  return envelope.idempotency_key;
}

/**
 * Build an idempotency key for a specific node within a connector event.
 * Format: {connector_id}:{node_id}:{event_version}
 */
export function buildNodeIdempotencyKey(connectorId: string, node: CanonicalNode): string {
  return `${connectorId}:${node.id}:${node._event_version}`;
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
