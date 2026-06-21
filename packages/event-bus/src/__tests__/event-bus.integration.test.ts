/**
 * Redis/BullMQ-BACKED integration test for the event bus (#2).
 *
 * The unit suite mocks ioredis + bullmq, so: (a) the producer→Redis→consumer
 * round trip is never crossed, and (b) the colon-in-job-id/queue-name scar is
 * only asserted as a string shape — the REAL `Queue`/`addBulk` synchronous throw
 * never fires. This runs the real producer→BullMQ→consumer path against Redis
 * and asserts a `shipit://…` canonical id (full of colons) publishes cleanly
 * because the producer rewrites `:`→`~`.
 *
 * Gated on REDIS_TEST_URL (skips by default → unit run stays Docker-free). Uses
 * a unique queue name per run for isolation; the client is closed in afterAll.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import type { CanonicalEntity, CanonicalNode, EventEnvelope } from '@shipit-ai/shared';
import { BullMQEventBusClient } from '../bullmq/client.js';

const REDIS_URL = process.env.REDIS_TEST_URL;
const RUN = `itest-${process.pid}-${Math.floor(performance.now())}`;

function entity(id: string): CanonicalEntity {
  const node: CanonicalNode = {
    id,
    label: 'Repository',
    properties: { name: 'web' },
    _claims: [],
    _source_system: 'github',
    _source_org: 'github/acme',
    _source_id: 'github://acme/web',
    _last_synced: '2026-06-19T00:00:00Z',
    _event_version: 1_719_000_000_000,
  };
  return { nodes: [node], edges: [] };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!REDIS_URL)('event bus — Redis/BullMQ integration', () => {
  const clients: BullMQEventBusClient[] = [];
  const make = () => {
    const c = new BullMQEventBusClient({ redisUrl: REDIS_URL!, queueName: `shipit-events-${RUN}` });
    clients.push(c);
    return c;
  };

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
  });

  it('round-trips a node with a colon-laden shipit:// id producer→consumer (scar guard)', async () => {
    const received: EventEnvelope[] = [];
    const consumer = make();
    await consumer.subscribe(async (env) => {
      received.push(env);
    });

    const producer = make();
    const id = 'shipit://Repository/default/acme/web';
    // Must NOT throw: BullMQ 5 forbids ':' in job ids; the producer rewrites :→~.
    await expect(producer.publish([entity(id)], 'github-acme')).resolves.toBeUndefined();

    // Wait for the worker to deliver.
    for (let i = 0; i < 50 && received.length === 0; i++) await wait(100);

    expect(received).toHaveLength(1);
    expect(received[0].connector_id).toBe('github-acme');
    expect(received[0].payload.nodes[0].id).toBe(id); // payload survives serialization intact
    expect(received[0].idempotency_key).not.toContain(':'); // colon-free job id
  });

  it('real BullMQ Queue rejects a colon in the queue name (the scar itself)', () => {
    const u = new URL(REDIS_URL!);
    expect(
      () =>
        new Queue('shipit:events:bad', {
          connection: { host: u.hostname, port: Number(u.port) || 6379 },
        }),
    ).toThrow();
  });
});
