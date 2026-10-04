// GET /api/runs/:id/stream over a real HTTP connection (inject() cannot read a
// response that stays open). Postgres is real; the Redis subscription is a
// local EventEmitter the test publishes on, as the runner would.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import {
  AgentStore,
  RUN_EVENTS_CHANNEL,
  RunStore,
  type AgentDefinition,
  type RunEvent,
  type RunRecord,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { RunEventHub } from '../../services/ai/run-event-hub.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

const AVAILABLE: AiStatus = {
  available: true,
  definitionsAvailable: true,
  checks: [],
};

interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

/** Reads server-sent events from a streaming response until `stop` says so. */
async function readEvents(
  res: Response,
  stop: (events: SseEvent[]) => boolean,
  ms = 5_000,
): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  while (!stop(events)) {
    if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(events)}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(':')) continue; // keep-alive comment
      const fields = Object.fromEntries(
        block
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
      );
      events.push({ event: fields.event!, id: fields.id, data: JSON.parse(fields.data!) });
    }
  }
  await reader.cancel();
  return events;
}

describe.skipIf(!DATABASE_TEST_URL)('GET /api/runs/:id/stream', () => {
  let database: TestDatabase;
  let agents: AgentStore;
  let runs: RunStore;
  let server: FastifyInstance;
  let base: string;
  const redis = new EventEmitter();
  const announce = (event: RunEvent) =>
    redis.emit('message', RUN_EVENTS_CHANNEL, JSON.stringify(event));

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    agents = new AgentStore(database.db);
    runs = new RunStore(database.db);
    server = await createServer({
      config: makeTestConfig(),
      agentStore: agents,
      runStore: runs,
      runQueue: { enqueue: async () => {} },
      runEvents: new RunEventHub(redis),
      aiStatus: { status: async () => AVAILABLE } as unknown as AiStatusService,
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await server.close();
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
  });

  async function startedRun(): Promise<RunRecord> {
    const agent = await agents.create({
      slug: `owners-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Owners',
      definition,
      actor: 'dev@shipit.local',
    });
    return runs.create({
      agentId: agent.id,
      agentVersion: null,
      definition,
      triggerKind: 'manual',
      triggeredBy: 'dev@shipit.local',
      mode: 'task',
      input: { text: 'Who owns x?' },
      messages: [{ role: 'user', content: 'Who owns x?' }],
    });
  }

  it('replays the run so far, follows new messages, and ends when the run does', async () => {
    const run = await startedRun();
    const res = await fetch(`${base}/api/runs/${run.id}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reading = readEvents(res, (events) => events.some((e) => e.event === 'end'));
    // Let the replay go out before the runner "works".
    await new Promise((r) => setTimeout(r, 100));
    await runs.claim(run.id, 'w', 60);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'team-a' }], 'w');
    announce({ runId: run.id, seq: 1 });
    await runs.finish(run.id, { status: 'succeeded', output: { text: 'team-a' } }, 'w');
    announce({ runId: run.id, status: 'succeeded' });
    // An event for another run never reaches this stream.
    announce({ runId: '00000000-0000-0000-0000-000000000000', seq: 9 });

    const events = await reading;
    expect(events.map((e) => [e.event, e.id ?? null])).toEqual([
      ['run', null],
      ['message', '0'],
      ['message', '1'],
      ['run', null],
      ['end', null],
    ]);
    expect(events[0]!.data).toMatchObject({ id: run.id, status: 'queued' });
    expect(events[2]!.data).toMatchObject({
      seq: 1,
      content: { role: 'assistant', content: 'team-a' },
    });
    expect(events[3]!.data).toMatchObject({ status: 'succeeded', output: { text: 'team-a' } });
  });

  it('answers a browser on another origin with CORS headers, so it may read the stream', async () => {
    // Local dev serves the UI on :3000 and the API on :3001. The stream writes
    // its own response head, which must still carry what @fastify/cors set.
    const run = await startedRun();
    await runs.finish(run.id, { status: 'succeeded', output: null });
    const res = await fetch(`${base}/api/runs/${run.id}/stream`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    await res.text();
  });

  it('resumes after the last event the client saw, without repeating it', async () => {
    const run = await startedRun();
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'one' }]);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'two' }]);
    await runs.finish(run.id, { status: 'succeeded', output: null });

    const res = await fetch(`${base}/api/runs/${run.id}/stream`, {
      headers: { 'last-event-id': '1' },
    });
    const events = await readEvents(res, (e) => e.some((x) => x.event === 'end'));
    expect(events.map((e) => [e.event, e.id ?? null])).toEqual([
      ['run', null],
      ['message', '2'],
      ['end', null],
    ]);
  });

  it('answers 404 for an unknown run, before any stream starts', async () => {
    const res = await fetch(`${base}/api/runs/00000000-0000-0000-0000-000000000000/stream`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('stops listening when the client goes away', async () => {
    const run = await startedRun();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
    await readEvents(res, (e) => e.length >= 2);
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(redis.listenerCount('message')).toBe(1); // the hub's own listener only
    expect((server.runEvents as RunEventHub).listeners(run.id)).toBe(0);
  });

  // The API cancels a parked run itself and publishes nothing, and an event can
  // be lost while the subscriber reconnects. The stream must not depend on one.
  it('notices a change nobody announced, on its next keep-alive tick', async () => {
    const own = await createServer({
      config: makeTestConfig(),
      agentStore: agents,
      runStore: runs,
      runQueue: { enqueue: async () => {} },
      runEvents: new RunEventHub(new EventEmitter()),
      runStreamKeepaliveMs: 50,
      aiStatus: { status: async () => AVAILABLE } as unknown as AiStatusService,
    });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.server.address() as { port: number };
    try {
      const run = await startedRun();
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/stream`);
      const reading = readEvents(res, (events) => events.some((e) => e.event === 'end'), 3_000);
      await new Promise((r) => setTimeout(r, 100));
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'late' }]);
      await runs.requestCancel(run.id); // queued: cancelled at once, no event

      const events = await reading;
      expect(events.map((e) => [e.event, e.id ?? null])).toEqual([
        ['run', null],
        ['message', '0'],
        ['message', '1'],
        ['run', null],
        ['end', null],
      ]);
      expect(events[3]!.data).toMatchObject({ status: 'cancelled' });
    } finally {
      await own.close();
    }
  });

  it('does not repeat the run record on a tick when nothing changed', async () => {
    const own = await createServer({
      config: makeTestConfig(),
      agentStore: agents,
      runStore: runs,
      runQueue: { enqueue: async () => {} },
      runEvents: new RunEventHub(new EventEmitter()),
      runStreamKeepaliveMs: 30,
      aiStatus: { status: async () => AVAILABLE } as unknown as AiStatusService,
    });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.server.address() as { port: number };
    try {
      const run = await startedRun();
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/stream`, {
        signal: controller.signal,
      });
      const started = Date.now();
      const events = await readEvents(res, () => Date.now() - started > 250).catch(() => []);
      controller.abort();
      expect(events.filter((e) => e.event === 'run')).toHaveLength(1);
    } finally {
      await own.close();
    }
  });

  it('ends open streams when the server shuts down, so the process can exit', async () => {
    const own = await createServer({
      config: makeTestConfig(),
      agentStore: agents,
      runStore: runs,
      runQueue: { enqueue: async () => {} },
      runEvents: new RunEventHub(new EventEmitter()),
      aiStatus: { status: async () => AVAILABLE } as unknown as AiStatusService,
    });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.server.address() as { port: number };
    const run = await startedRun();
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/stream`);
    const reader = res.body!.getReader();
    await reader.read(); // the stream is open

    const closed = Promise.race([
      own.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('still open'), 3_000)),
    ]);
    expect(await closed).toBe('closed');
    // The client sees the stream end and can reconnect elsewhere with Last-Event-ID.
    let done = false;
    while (!done) done = (await reader.read()).done;
  });
});
