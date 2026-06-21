/**
 * Redis-BACKED integration test for the WebhookRefetchQueue delivery-dedup (#4).
 *
 * The unit suite uses an in-memory Set-backed fake, so the real SETNX-NX → DEL →
 * redelivery-within-TTL cycle (the dedup-token-before-failable-side-effect scar)
 * and the per-connector last-verified marker are unverified against a real
 * keyspace. This exercises them on real Redis. Only the redis-touching methods
 * are tested; registry/eventBus/globalApp are inert stubs.
 *
 * Gated on REDIS_TEST_URL (skips by default). Unique ids + a unique queue name
 * keep it isolated; close() releases the BullMQ queue/worker + redis client.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebhookRefetchQueue } from '../../services/webhook-refetch-queue.js';
import type { ConnectorRegistry } from '../../services/connector-registry.js';
import type { EventBusClient } from '@shipit-ai/shared';

const URL = process.env.REDIS_TEST_URL;
const RUN = `itest-${process.pid}-${Math.floor(performance.now())}`;

describe.skipIf(!URL)('WebhookRefetchQueue delivery-dedup — Redis integration', () => {
  let q: WebhookRefetchQueue;

  beforeAll(() => {
    q = new WebhookRefetchQueue({
      redisUrl: URL!,
      // Inert stubs — the dedup methods under test only touch the redis client.
      registry: {} as unknown as ConnectorRegistry,
      eventBus: {} as unknown as EventBusClient,
      globalApp: {} as never,
      queueName: `shipit-webhook-refetch-${RUN}`,
    });
  });

  afterAll(async () => {
    await q.close();
  });

  it('markDeliverySeen is true once, then false within the TTL (SET NX)', async () => {
    const id = `${RUN}-d1`;
    expect(await q.markDeliverySeen(id)).toBe(true);
    expect(await q.markDeliverySeen(id)).toBe(false);
  });

  it('releaseDelivery clears the key so a redelivery is processed again', async () => {
    const id = `${RUN}-d2`;
    expect(await q.markDeliverySeen(id)).toBe(true);
    await q.releaseDelivery(id);
    expect(await q.markDeliverySeen(id)).toBe(true); // released → NX succeeds again
  });

  it('records and reads back the last verified delivery; unknown → null', async () => {
    const connectorId = `${RUN}-conn`;
    expect(await q.getLastVerifiedDelivery(connectorId)).toBeNull();
    await q.recordVerifiedDelivery({
      connectorId,
      event: 'push',
      deliveryId: 'gh-123',
      ts: '2026-06-19T00:00:00Z',
    });
    expect(await q.getLastVerifiedDelivery(connectorId)).toEqual({
      event: 'push',
      deliveryId: 'gh-123',
      ts: '2026-06-19T00:00:00Z',
    });
  });
});
