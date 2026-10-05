// The runner's moving parts against a real Redis and Postgres: the queue, the
// worker, the event channel, the heartbeat and the sweeper. The run loop
// itself is covered by agent-loop.integration.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  AgentStore,
  RUN_EVENTS_CHANNEL,
  RUNNER_HEARTBEAT_KEY,
  RunQueue,
  RunStore,
  type RunEvent,
  type RunStatus,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { AgentLoop } from '../loop/agent-loop.js';
import { userMessage } from '../model/messages.js';
import { Housekeeping } from '../process/housekeeping.js';
import { RedisRunEvents } from '../process/run-events.js';
import { RunWorker } from '../process/run-worker.js';
import { MODEL, ScriptedModel, answer, definition } from './helpers/loop-fixtures.js';

const REDIS_URL = process.env.REDIS_TEST_URL;
const CEILINGS = { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 };

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > until)
      throw new Error(`waitFor timed out; last value ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!DATABASE_TEST_URL || !REDIS_URL)('runner process — Redis and Postgres', () => {
  let database: TestDatabase;
  let runs: RunStore;
  let agentId: string;
  let redis: Redis;
  let subscriber: Redis;
  const heard: RunEvent[] = [];
  // A queue of its own per suite run, so parallel CI jobs never share one.
  const queueName = `shipit-agent-runs-test-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    runs = new RunStore(database.db);
    agentId = (
      await new AgentStore(database.db).create({
        slug: 'owners',
        name: 'Owners',
        definition: definition(),
        actor: 'admin@example.com',
      })
    ).id;
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    subscriber = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    await subscriber.subscribe(RUN_EVENTS_CHANNEL);
    subscriber.on('message', (_channel, text: string) => heard.push(JSON.parse(text) as RunEvent));
  });

  afterAll(async () => {
    await subscriber.quit();
    await redis.quit();
    await database.drop();
  });

  beforeEach(async () => {
    heard.length = 0;
    await database.db.query('DELETE FROM runs');
    await database.db.query('DELETE FROM agent_usage_daily');
  });

  const createRun = (mode: 'task' | 'chat' = 'task') =>
    runs.create({
      agentId,
      agentVersion: 1,
      definition: definition(),
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode,
      input: { text: 'Who owns payments-api?' },
      messages: [userMessage('Who owns payments-api?')],
    });

  const status = async (id: string): Promise<RunStatus | undefined> => (await runs.get(id))?.status;

  function stack(script: Parameters<typeof answer>[0][] = ['team-a']) {
    const events = new RedisRunEvents(redis);
    const loop = new AgentLoop({
      runs,
      model: new ScriptedModel(script.map((text) => answer(text))),
      tools: [],
      models: [MODEL],
      ceilings: CEILINGS,
      toolResultChars: 50_000,
      owner: 'worker-test',
      publish: (e) => events.publish(e),
    });
    const queue = new RunQueue({ redisUrl: REDIS_URL!, queueName });
    const worker = new RunWorker({
      redisUrl: REDIS_URL!,
      queueName,
      concurrency: 2,
      runtime: loop,
    });
    const housekeeping = new Housekeeping({
      runs,
      redis,
      queue,
      publish: (e) => events.publish(e),
      chatIdleMinutes: 60,
    });
    return {
      queue,
      worker,
      housekeeping,
      async close() {
        await worker.close();
        await queue.close();
      },
    };
  }

  it('works a run when its id is enqueued, and announces it on the events channel', async () => {
    const parts = stack();
    try {
      const run = await createRun();
      await parts.queue.enqueue(run.id);
      expect(
        await waitFor(
          () => status(run.id),
          (s) => s === 'succeeded',
        ),
      ).toBe('succeeded');
      await waitFor(
        async () => heard,
        (events) => events.some((e) => e.runId === run.id && e.status === 'succeeded'),
      );
      expect(heard.filter((e) => e.runId === run.id)).toEqual([
        { runId: run.id, status: 'running' },
        { runId: run.id, seq: 1 },
        { runId: run.id, status: 'succeeded' },
      ]);
    } finally {
      await parts.close();
    }
  });

  it('treats a duplicate job for the same run as a no-op', async () => {
    const parts = stack(['once']);
    try {
      const run = await createRun();
      await parts.queue.enqueue(run.id);
      await parts.queue.enqueue(run.id);
      await waitFor(
        () => status(run.id),
        (s) => s === 'succeeded',
      );
      // The scripted model had one step; a second processing would have thrown.
      expect((await runs.get(run.id))!.steps).toBe(1);
    } finally {
      await parts.close();
    }
  });

  it('writes the runner heartbeat with a 60-second expiry', async () => {
    const parts = stack();
    try {
      await parts.housekeeping.beat();
      expect(await redis.get(RUNNER_HEARTBEAT_KEY)).not.toBeNull();
      const ttl = await redis.ttl(RUNNER_HEARTBEAT_KEY);
      expect(ttl).toBeGreaterThan(50);
      expect(ttl).toBeLessThanOrEqual(60);
    } finally {
      await parts.close();
    }
  });

  it('re-queues a run whose worker died, and the run is finished by another', async () => {
    const parts = stack(['resumed']);
    try {
      const run = await createRun();
      await runs.claim(run.id, 'worker-dead', 60);
      await database.db.query(
        `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [run.id],
      );
      await parts.housekeeping.sweep();
      expect(
        await waitFor(
          () => status(run.id),
          (s) => s === 'succeeded',
        ),
      ).toBe('succeeded');
    } finally {
      await parts.close();
    }
  });

  // The job for a queued run can be lost (Redis restarted before a worker
  // took it). Nothing else would ever start that run.
  it('queues again a run that has waited a minute with no worker', async () => {
    const parts = stack(['found']);
    try {
      const run = await createRun(); // created, but never enqueued
      await parts.housekeeping.sweep();
      expect(await status(run.id)).toBe('queued'); // too recent to be lost
      await database.db.query(
        `UPDATE runs SET updated_at = now() - interval '61 seconds' WHERE id = $1`,
        [run.id],
      );
      await parts.housekeeping.sweep();
      expect(
        await waitFor(
          () => status(run.id),
          (s) => s === 'succeeded',
        ),
      ).toBe('succeeded');
    } finally {
      await parts.close();
    }
  });

  it('finishes a cancelled run whose worker died, and announces it', async () => {
    const parts = stack();
    try {
      const run = await createRun();
      await runs.claim(run.id, 'worker-dead', 60);
      await runs.requestCancel(run.id);
      await database.db.query(
        `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [run.id],
      );
      await parts.housekeeping.sweep();
      expect(await status(run.id)).toBe('cancelled');
      await waitFor(
        async () => heard,
        (events) => events.some((e) => e.runId === run.id),
      );
      expect(heard).toContainEqual({ runId: run.id, status: 'cancelled' });
    } finally {
      await parts.close();
    }
  });

  it('fails stalled runs and closes idle chats on a sweep, announcing each', async () => {
    const parts = stack();
    try {
      const stuck = await createRun();
      await runs.claim(stuck.id, 'worker-dead', 3600);
      const chat = await createRun('chat');
      await runs.claim(chat.id, 'worker-test', 60);
      await runs.waitForInput(chat.id);
      await database.db.query(
        `UPDATE runs SET updated_at = now() - interval '2 hours' WHERE id = ANY($1::uuid[])`,
        [[stuck.id, chat.id]],
      );
      await parts.housekeeping.sweep();
      expect(await status(stuck.id)).toBe('failed');
      expect(await status(chat.id)).toBe('succeeded');
      await waitFor(
        async () => heard,
        (events) => events.length >= 2,
      );
      expect(heard).toEqual(
        expect.arrayContaining([
          { runId: stuck.id, status: 'failed' },
          { runId: chat.id, status: 'succeeded' },
        ]),
      );
    } finally {
      await parts.close();
    }
  });
});
