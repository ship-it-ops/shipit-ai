import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock ioredis ──────────────────────────────────────────────────────
const mockPipelineExec = vi.fn().mockResolvedValue([]);
const mockPipeline = vi.fn().mockReturnValue({
  xadd: vi.fn().mockReturnThis(),
  xtrim: vi.fn().mockReturnThis(),
  exec: mockPipelineExec,
});
const mockXrange = vi.fn().mockResolvedValue([]);
const mockDisconnect = vi.fn();

vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(() => ({
    pipeline: mockPipeline,
    xrange: mockXrange,
    disconnect: mockDisconnect,
    options: { host: 'localhost', port: 6379 },
    duplicate: vi.fn().mockReturnThis(),
  }));
  return { Redis: RedisMock, default: RedisMock };
});

// ── Mock bullmq ───────────────────────────────────────────────────────
const mockAddBulk = vi.fn().mockResolvedValue([]);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockWaitUntilReady = vi.fn().mockResolvedValue(undefined);

let capturedWorkerProcessor: ((job: { data: unknown }) => Promise<void>) | null = null;

vi.mock('bullmq', () => {
  const Queue = vi.fn().mockImplementation(() => ({
    addBulk: mockAddBulk,
    close: mockQueueClose,
  }));

  const Worker = vi
    .fn()
    .mockImplementation((_name: string, processor: (job: { data: unknown }) => Promise<void>) => {
      capturedWorkerProcessor = processor;
      return {
        close: mockWorkerClose,
        waitUntilReady: mockWaitUntilReady,
      };
    });

  return { Queue, Worker };
});

import { Queue } from 'bullmq';
import { resolveConfig, DEFAULT_CONFIG } from '../config.js';
import type { ResolvedConfig } from '../config.js';
import { EventBusProducer, buildIdempotencyKey, EVENT_LOG_STREAM } from '../bullmq/producer.js';
import { EventBusConsumer } from '../bullmq/consumer.js';
import { EventBusReplay } from '../bullmq/replay.js';
import { BullMQEventBusClient } from '../bullmq/client.js';
import { FAILED_JOB_RETENTION } from '../bullmq/retention.js';
import type { CanonicalEntity, CanonicalNode, EventEnvelope } from '@shipit-ai/shared';

// ── Test fixtures ─────────────────────────────────────────────────────
function makeNode(overrides: Partial<CanonicalNode> = {}): CanonicalNode {
  return {
    id: 'shipit://LogicalService/github/graph-api',
    label: 'LogicalService',
    properties: { name: 'graph-api' },
    _claims: [],
    _source_system: 'github',
    _source_org: 'github/shipitops',
    _source_id: 'github://shipitops/graph-api',
    _last_synced: '2026-02-28T00:00:00Z',
    _event_version: 1,
    ...overrides,
  };
}

function makeEntity(nodes?: CanonicalNode[]): CanonicalEntity {
  return {
    nodes: nodes ?? [makeNode()],
    edges: [],
  };
}

const TEST_CONFIG: ResolvedConfig = {
  redisHost: 'localhost',
  redisPort: 6379,
  queueName: 'shipit-events',
  maxRetries: 3,
  retentionDays: 7,
  batchSize: 500,
  concurrency: 1,
};

// ── Config tests ──────────────────────────────────────────────────────
describe('resolveConfig', () => {
  it('parses redis URL and applies defaults', () => {
    const config = resolveConfig({ redisUrl: 'redis://myhost:6380' });
    expect(config.redisHost).toBe('myhost');
    expect(config.redisPort).toBe(6380);
    expect(config.queueName).toBe(DEFAULT_CONFIG.queueName);
    expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
    expect(config.retentionDays).toBe(DEFAULT_CONFIG.retentionDays);
    expect(config.batchSize).toBe(DEFAULT_CONFIG.batchSize);
    expect(config.concurrency).toBe(DEFAULT_CONFIG.concurrency);
  });

  it('uses custom values when provided', () => {
    const config = resolveConfig({
      redisUrl: 'redis://localhost:6379',
      queueName: 'custom-queue',
      maxRetries: 5,
      retentionDays: 14,
      batchSize: 100,
      concurrency: 4,
    });
    expect(config.queueName).toBe('custom-queue');
    expect(config.maxRetries).toBe(5);
    expect(config.retentionDays).toBe(14);
    expect(config.batchSize).toBe(100);
    expect(config.concurrency).toBe(4);
  });

  it('defaults port to 6379 when not specified', () => {
    const config = resolveConfig({ redisUrl: 'redis://localhost' });
    expect(config.redisPort).toBe(6379);
  });
});

// ── Idempotency key tests ─────────────────────────────────────────────
describe('buildIdempotencyKey', () => {
  it('formats key as {connectorId}~{nodeId}~{eventVersion} with all colons replaced', () => {
    // BullMQ 5 forbids `:` in custom job IDs, so the lone colon in the
    // `shipit:` scheme gets rewritten to `~`; the `//` slashes survive.
    const node = makeNode({
      id: 'shipit://LogicalService/github/graph-api',
      _event_version: 42,
    });
    const key = buildIdempotencyKey('github-shipitops', node);
    expect(key).toBe('github-shipitops~shipit~//LogicalService/github/graph-api~42');
    expect(key).not.toContain(':');
  });

  it('handles ISO 8601 event version', () => {
    const node = makeNode({ _event_version: '2026-02-28T12:00:00Z' });
    const key = buildIdempotencyKey('k8s-prod', node);
    expect(key).toContain('k8s-prod~');
    expect(key).toContain('~2026-02-28T12~00~00Z');
    expect(key).not.toContain(':');
  });
});

// ── Producer tests ────────────────────────────────────────────────────
describe('EventBusProducer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates jobs with correct idempotency keys via addBulk', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    const entity = makeEntity();
    await producer.publish([entity], 'github-shipitops');

    expect(mockAddBulk).toHaveBeenCalledOnce();
    const jobs = mockAddBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('event');
    expect(jobs[0].opts.jobId).toBe('github-shipitops~shipit~//LogicalService/github/graph-api~1');
    expect(jobs[0].data.connector_id).toBe('github-shipitops');
    expect(jobs[0].data.payload).toEqual(entity);
    // Retention now lives in the queue's defaultJobOptions, not per-job —
    // per-job opts carry only the dedup jobId.
    expect(jobs[0].opts.removeOnComplete).toBeUndefined();
    expect(jobs[0].opts.removeOnFail).toBeUndefined();
  });

  it('constructs its queue with bounded retention (completed immediate, failed 7d/5k)', () => {
    new EventBusProducer(TEST_CONFIG);
    const lastCall = vi.mocked(Queue).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('shipit-events');
    expect(lastCall?.[1]).toMatchObject({
      defaultJobOptions: { removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION },
    });
  });

  it('creates one envelope per node', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    const node1 = makeNode({ id: 'shipit://LogicalService/github/svc-a', _event_version: 1 });
    const node2 = makeNode({ id: 'shipit://LogicalService/github/svc-b', _event_version: 2 });
    const entity = makeEntity([node1, node2]);

    await producer.publish([entity], 'github-shipitops');

    const jobs = mockAddBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(2);
    expect(jobs[0].opts.jobId).toContain('svc-a~1');
    expect(jobs[1].opts.jobId).toContain('svc-b~2');
  });

  it('emits one envelope for an edge-only entity (e.g., Codeowners batch)', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    const entity: CanonicalEntity = {
      nodes: [],
      edges: [
        {
          type: 'CODEOWNER_OF',
          from: 'shipit://person/default/alice',
          to: 'shipit://repository/default/shipitops/graph-api',
          properties: { pattern: '*' },
          _source: 'github',
          _confidence: 0.95,
          _ingested_at: '2026-02-28T00:00:00Z',
        },
      ],
    };

    await producer.publish([entity], 'github-shipitops');

    expect(mockAddBulk).toHaveBeenCalledOnce();
    const jobs = mockAddBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].opts.jobId).toMatch(/^github-shipitops~edges~[a-f0-9]{16}$/);
    expect(jobs[0].data.payload).toEqual(entity);
  });

  it('emits the same envelope id for the same edge batch (stable hash)', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    const edge = {
      type: 'CODEOWNER_OF',
      from: 'shipit://person/default/alice',
      to: 'shipit://repository/default/shipitops/graph-api',
      _source: 'github',
      _confidence: 0.95,
      _ingested_at: '2026-02-28T00:00:00Z',
    };
    const entity: CanonicalEntity = { nodes: [], edges: [edge] };

    await producer.publish([entity], 'github-shipitops');
    await producer.publish([entity], 'github-shipitops');

    const firstJobId = mockAddBulk.mock.calls[0][0][0].opts.jobId;
    const secondJobId = mockAddBulk.mock.calls[1][0][0].opts.jobId;
    expect(firstJobId).toBe(secondJobId);
  });

  it('writes events to Redis Stream', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    await producer.publish([makeEntity()], 'github-shipitops');

    expect(mockPipeline).toHaveBeenCalled();
    expect(mockPipelineExec).toHaveBeenCalled();
  });

  it('does nothing for empty events array', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    await producer.publish([], 'github-shipitops');

    expect(mockAddBulk).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
  });
});

// ── Consumer tests ────────────────────────────────────────────────────
describe('EventBusConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWorkerProcessor = null;
  });

  it('creates a worker and processes events via handler', async () => {
    const consumer = new EventBusConsumer(TEST_CONFIG);
    const handler = vi.fn().mockResolvedValue(undefined);

    await consumer.subscribe(handler);

    expect(capturedWorkerProcessor).not.toBeNull();

    // Simulate a job being processed
    const fakeEnvelope: EventEnvelope = {
      id: 'test-uuid',
      timestamp: '2026-02-28T00:00:00Z',
      connector_id: 'github-shipitops',
      idempotency_key: 'github-shipitops~node~1',
      payload: makeEntity(),
    };

    await capturedWorkerProcessor!({ data: fakeEnvelope });
    expect(handler).toHaveBeenCalledWith(fakeEnvelope);

    await consumer.close();
    expect(mockWorkerClose).toHaveBeenCalled();
  });

  it('throws if subscribe is called twice', async () => {
    const consumer = new EventBusConsumer(TEST_CONFIG);
    await consumer.subscribe(vi.fn());
    await expect(consumer.subscribe(vi.fn())).rejects.toThrow('Already subscribed');
    await consumer.close();
  });

  it('close is safe to call without subscribing', async () => {
    const consumer = new EventBusConsumer(TEST_CONFIG);
    await consumer.close(); // should not throw
    expect(mockWorkerClose).not.toHaveBeenCalled();
  });
});

// ── Replay tests ──────────────────────────────────────────────────────
describe('EventBusReplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads from Redis Stream and re-publishes to queue', async () => {
    const envelope: EventEnvelope = {
      id: 'replay-uuid',
      timestamp: '2026-02-28T00:00:00Z',
      connector_id: 'github-shipitops',
      idempotency_key: 'github-shipitops~node~1',
      payload: makeEntity(),
    };

    mockXrange.mockResolvedValueOnce([['1709078400000-0', ['data', JSON.stringify(envelope)]]]);

    const replay = new EventBusReplay(TEST_CONFIG);
    await replay.replay('2026-02-28T00:00:00Z');

    expect(mockXrange).toHaveBeenCalledWith(
      EVENT_LOG_STREAM,
      expect.any(String),
      '+',
      'COUNT',
      TEST_CONFIG.batchSize,
    );

    expect(mockAddBulk).toHaveBeenCalledOnce();
    const jobs = mockAddBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].opts.jobId).toBe('replay~github-shipitops~node~1');
    expect(jobs[0].data).toEqual(envelope);

    await replay.close();
  });

  it('handles empty stream', async () => {
    mockXrange.mockResolvedValueOnce([]);

    const replay = new EventBusReplay(TEST_CONFIG);
    await replay.replay('2026-02-28T00:00:00Z');

    expect(mockAddBulk).not.toHaveBeenCalled();
    await replay.close();
  });

  it('constructs its queue with bounded failed-job retention', () => {
    new EventBusReplay(TEST_CONFIG);
    const lastCall = vi.mocked(Queue).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('shipit-events');
    expect(lastCall?.[1]).toMatchObject({
      defaultJobOptions: { removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION },
    });
  });
});

// ── BullMQEventBusClient (integration of all components) ──────────────
describe('BullMQEventBusClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWorkerProcessor = null;
  });

  it('publish delegates to producer', async () => {
    const client = new BullMQEventBusClient({ redisUrl: 'redis://localhost:6379' });
    await client.publish([makeEntity()], 'github-shipitops');

    expect(mockAddBulk).toHaveBeenCalledOnce();
    await client.close();
  });

  it('subscribe delegates to consumer', async () => {
    const client = new BullMQEventBusClient({ redisUrl: 'redis://localhost:6379' });
    const handler = vi.fn();
    await client.subscribe(handler);

    expect(capturedWorkerProcessor).not.toBeNull();
    await client.close();
  });

  it('replay delegates to replay module', async () => {
    mockXrange.mockResolvedValueOnce([]);
    const client = new BullMQEventBusClient({ redisUrl: 'redis://localhost:6379' });
    await client.replay('2026-02-28T00:00:00Z');

    expect(mockXrange).toHaveBeenCalled();
    await client.close();
  });

  it('close shuts down all components', async () => {
    const client = new BullMQEventBusClient({ redisUrl: 'redis://localhost:6379' });
    await client.close();

    expect(mockQueueClose).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
