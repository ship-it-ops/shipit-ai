import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentStore } from '../agent-store.js';
import type { AgentDefinition } from '../definition.js';
import { runMigrations } from '../migrate.js';
import {
  RunLeaseLostError,
  RunNotFoundError,
  RunNotWaitingError,
  RunStore,
  type CreateRunInput,
  type StoredMessage,
} from '../run-store.js';
import {
  createTestDatabase,
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  type TestDatabase,
} from './test-db.js';

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

const userMessage = (text: string): StoredMessage => ({ role: 'user', content: text });

describe.skipIf(!DATABASE_TEST_URL)('RunStore — Postgres integration', () => {
  let database: TestDatabase;
  let runs: RunStore;
  let agentId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    runs = new RunStore(database.db);
    const agent = await new AgentStore(database.db).create({
      slug: 'owners',
      name: 'Owners',
      definition,
      actor: 'admin@example.com',
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
    await database.db.query('DELETE FROM agent_usage_daily');
  });

  const make = (extra: Partial<CreateRunInput> = {}) =>
    runs.create({
      agentId,
      agentVersion: 1,
      definition,
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode: 'task',
      input: { text: 'Who owns payments-api?' },
      messages: [userMessage('Who owns payments-api?')],
      ...extra,
    });

  it('creates a queued run with its first message and reads it back', async () => {
    const run = await make();
    expect(run).toMatchObject({
      agentId,
      agentVersion: 1,
      definition,
      parentRunId: null,
      rootRunId: run.id,
      depth: 0,
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode: 'task',
      writePolicy: 'as_granted',
      status: 'queued',
      input: { text: 'Who owns payments-api?' },
      output: null,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
      cancelRequested: false,
      warnings: [],
      startedAt: null,
      finishedAt: null,
    });
    expect(await runs.get(run.id)).toEqual(run);
    const messages = await runs.listMessages(run.id);
    expect(messages.map((m) => [m.seq, m.role, m.content])).toEqual([
      [0, 'user', userMessage('Who owns payments-api?')],
    ]);
  });

  it('returns null for an unknown or malformed id', async () => {
    expect(await runs.get('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await runs.get('not-a-uuid')).toBeNull();
  });

  it('links a child run to its parent and root, one level deeper', async () => {
    const parent = await make();
    const child = await make({ parentRunId: parent.id, triggerKind: 'agent_tool' });
    expect(child).toMatchObject({ parentRunId: parent.id, rootRunId: parent.id, depth: 1 });
  });

  it('claims a queued run exactly once', async () => {
    const run = await make();
    const [a, b] = await Promise.all([
      runs.claim(run.id, 'worker-a', 60),
      runs.claim(run.id, 'worker-b', 60),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: 'running' });
    expect(winners[0]!.startedAt).not.toBeNull();
    expect(await runs.claim(run.id, 'worker-c', 60)).toBeNull();
  });

  it('lets another worker take over a running run whose lease ran out', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    expect(await runs.claim(run.id, 'worker-b', 60)).toBeNull();
    await database.db.query(
      `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    expect(await runs.expiredLeases()).toEqual([run.id]);
    expect(await runs.claim(run.id, 'worker-b', 60)).toMatchObject({ status: 'running' });
    // The old holder finds out when it next renews, and stops.
    expect(await runs.renewLease(run.id, 'worker-a', 60)).toEqual({
      held: false,
      cancelRequested: false,
    });
    expect(await runs.renewLease(run.id, 'worker-b', 60)).toEqual({
      held: true,
      cancelRequested: false,
    });
  });

  it('refuses writes from a worker that no longer holds the lease', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await database.db.query(`UPDATE runs SET lease_owner = 'worker-b' WHERE id = $1`, [run.id]);
    await expect(
      runs.appendMessages(run.id, [{ role: 'assistant', content: 'stale' }], 'worker-a'),
    ).rejects.toBeInstanceOf(RunLeaseLostError);
    await expect(
      runs.finish(run.id, { status: 'succeeded', output: null }, 'worker-a'),
    ).rejects.toBeInstanceOf(RunLeaseLostError);
    await expect(runs.waitForInput(run.id, 'worker-a')).rejects.toBeInstanceOf(RunLeaseLostError);
    expect((await runs.listMessages(run.id)).map((m) => m.seq)).toEqual([0]);
    // The holder's writes go through.
    expect(
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'ok' }], 'worker-b'),
    ).toHaveLength(1);
  });

  it('reports a cancel request to the lease holder when it renews', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await runs.requestCancel(run.id);
    expect(await runs.renewLease(run.id, 'worker-a', 60)).toEqual({
      held: true,
      cancelRequested: true,
    });
  });

  it('appends messages with consecutive sequence numbers and lists them after a seq', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const appended = await runs.appendMessages(run.id, [
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
      { role: 'tool', content: [] },
    ]);
    expect(appended.map((m) => m.seq)).toEqual([1, 2]);
    const after = await runs.listMessages(run.id, { afterSeq: 0 });
    expect(after.map((m) => m.role)).toEqual(['assistant', 'tool']);
    // The stored message is the whole object, role included, as the model layer replays it.
    expect(after[0]!.content).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Looking.' }],
    });
  });

  it('adds usage and counts steps', async () => {
    const run = await make();
    await runs.recordStep(run.id, { input: 100, output: 20 });
    const after = await runs.recordStep(run.id, { input: 50, output: 5 });
    expect(after).toMatchObject({ steps: 2, inputTokens: 150, outputTokens: 25 });
  });

  it('records each warning once', async () => {
    const run = await make();
    await runs.addWarning(run.id, 'Tool graph.x is no longer available.');
    const after = await runs.addWarning(run.id, 'Tool graph.x is no longer available.');
    expect(after.warnings).toEqual(['Tool graph.x is no longer available.']);
  });

  it('finishes a run once; a second finish does not overwrite the first', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const done = await runs.finish(run.id, { status: 'succeeded', output: { text: 'team-a' } });
    expect(done).toMatchObject({ status: 'succeeded', output: { text: 'team-a' }, error: null });
    expect(done!.finishedAt).not.toBeNull();
    const again = await runs.finish(run.id, {
      status: 'failed',
      error: { code: 'INTERNAL', message: 'late' },
    });
    expect(again).toBeNull();
    expect((await runs.get(run.id))!.status).toBe('succeeded');
  });

  it('parks a chat run waiting for input, then takes the next message and requeues it', async () => {
    const run = await make({ mode: 'chat' });
    await runs.claim(run.id, 'worker-a', 60);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'Hi.' }]);
    expect(await runs.waitForInput(run.id)).toMatchObject({ status: 'waiting_input' });

    const resumed = await runs.addUserMessage(run.id, userMessage('And payments-db?'));
    expect(resumed.status).toBe('queued');
    const messages = await runs.listMessages(run.id);
    expect(messages.at(-1)).toMatchObject({ seq: 2, role: 'user' });
  });

  // A worker sees a cancel request at its next heartbeat or before its next
  // model step. A chat turn that ends before either must not park the run with
  // the request still pending: claim() refuses such a run, so the next message
  // would leave it queued for good.
  it('ends a chat run cancelled when it parks with a cancel request pending', async () => {
    const run = await make({ mode: 'chat' });
    await runs.claim(run.id, 'worker-a', 60);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'Hi.' }]);
    await runs.requestCancel(run.id);

    const parked = await runs.waitForInput(run.id, 'worker-a');
    expect(parked).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(parked!.finishedAt).not.toBeNull();
    await expect(runs.addUserMessage(run.id, userMessage('more'))).rejects.toBeInstanceOf(
      RunNotWaitingError,
    );
    expect(await runs.requeueStaleQueued(0)).toEqual([]);
  });

  it('refuses a message for a run that is not waiting for one', async () => {
    const run = await make({ mode: 'chat' });
    await expect(runs.addUserMessage(run.id, userMessage('x'))).rejects.toBeInstanceOf(
      RunNotWaitingError,
    );
    await expect(
      runs.addUserMessage('00000000-0000-0000-0000-000000000000', userMessage('x')),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('cancels a run that no worker holds at once, and flags a running one', async () => {
    const queued = await make();
    expect(await runs.requestCancel(queued.id)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
    });
    expect(await runs.claim(queued.id, 'worker-a', 60)).toBeNull();

    const running = await make();
    await runs.claim(running.id, 'worker-a', 60);
    expect(await runs.requestCancel(running.id)).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });

    const finished = await make();
    await runs.claim(finished.id, 'worker-a', 60);
    await runs.finish(finished.id, { status: 'succeeded', output: null });
    expect(await runs.requestCancel(finished.id)).toMatchObject({
      status: 'succeeded',
      cancelRequested: false,
    });
    expect(await runs.requestCancel('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('records a tool call from start to finish, and restarts one left executing', async () => {
    const run = await make();
    const base = {
      runId: run.id,
      callId: 'call_1',
      messageSeq: 1,
      toolId: 'graph.find_owners',
      service: 'graph',
      effect: 'read' as const,
      policy: 'allow' as const,
      decision: 'allow' as const,
      input: { entity: 'payments-api' },
    };
    const started = await runs.startToolCall({ ...base, status: 'executing' });
    expect(started).toMatchObject({ status: 'executing', output: null });
    expect(started.startedAt).not.toBeNull();

    // A crash before finishing leaves the row executing; starting the same call
    // again (a read being re-run) reuses the row instead of failing on the key.
    const restarted = await runs.startToolCall({ ...base, status: 'executing' });
    expect(restarted.id).toBe(started.id);

    const finished = await runs.finishToolCall(started.id, {
      status: 'succeeded',
      output: { owners: ['team-a'] },
      outputTruncated: false,
    });
    expect(finished).toMatchObject({ status: 'succeeded', output: { owners: ['team-a'] } });
    expect(finished.finishedAt).not.toBeNull();
    expect((await runs.listToolCalls(run.id)).map((c) => c.callId)).toEqual(['call_1']);
  });

  const writeCall = (runId: string) => ({
    runId,
    callId: 'call_w',
    messageSeq: 1,
    toolId: 'gh.comment',
    service: 'gh',
    effect: 'write' as const,
    policy: 'allow' as const,
    decision: 'allow' as const,
    status: 'executing' as const,
    input: { body: 'hi' },
  });

  // "A write is never repeated" has to hold against a worker that is still
  // alive but no longer holds the run, not only against one that died.
  it('refuses to start a tool call for a worker that does not hold the run', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await expect(runs.startToolCall(writeCall(run.id), 'worker-b')).rejects.toBeInstanceOf(
      RunLeaseLostError,
    );
    expect(await runs.listToolCalls(run.id)).toEqual([]);
    expect(await runs.startToolCall(writeCall(run.id), 'worker-a')).toMatchObject({
      status: 'executing',
    });
  });

  it('never starts a write a second time', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const first = await runs.startToolCall(writeCall(run.id), 'worker-a');
    await expect(runs.startToolCall(writeCall(run.id), 'worker-a')).rejects.toBeInstanceOf(
      RunLeaseLostError,
    );
    const [stored] = await runs.listToolCalls(run.id);
    expect(stored).toMatchObject({ id: first.id, startedAt: first.startedAt });
  });

  // A write that waits for approval has not run: starting it is the first
  // time, not a repeat.
  it('starts a call that was recorded as pending, once', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const pending = await runs.startToolCall(
      { ...writeCall(run.id), status: 'pending' },
      'worker-a',
    );
    const started = await runs.startToolCall(writeCall(run.id), 'worker-a');
    expect(started).toMatchObject({ id: pending.id, status: 'executing' });
    await expect(runs.startToolCall(writeCall(run.id), 'worker-a')).rejects.toBeInstanceOf(
      RunLeaseLostError,
    );
  });

  it('does not start a call again once it has an outcome, read or write', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const read = { ...writeCall(run.id), callId: 'call_r', effect: 'read' as const };
    const row = await runs.startToolCall(read, 'worker-a');
    await runs.finishToolCall(row.id, { status: 'succeeded', output: { owners: ['team-a'] } });

    await expect(runs.startToolCall(read, 'worker-a')).rejects.toBeInstanceOf(RunLeaseLostError);
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({
      status: 'succeeded',
      output: { owners: ['team-a'] },
    });
  });

  it('keeps the first outcome recorded for a tool call', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const call = await runs.startToolCall(writeCall(run.id), 'worker-a');
    // The worker that took the run over found the write in flight and said so.
    await runs.finishToolCall(call.id, {
      status: 'outcome_unknown',
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'The runner stopped while this call was running.',
      },
    });
    // The worker that lost the run finishes late.
    const late = await runs.finishToolCall(call.id, { status: 'succeeded', output: { ok: true } });
    expect(late).toMatchObject({ status: 'outcome_unknown', output: null });
    await expect(
      runs.finishToolCall('00000000-0000-0000-0000-000000000000', { status: 'failed' }),
    ).rejects.toThrow(/not found/);
  });

  it('records a call to a tool that does not exist, with no service or effect', async () => {
    const run = await make();
    const denied = await runs.startToolCall({
      runId: run.id,
      callId: 'c9',
      messageSeq: 1,
      toolId: 'graph__drop_database',
      service: null,
      effect: null,
      policy: 'off',
      decision: 'deny',
      status: 'denied',
      input: {},
      error: { code: 'UNKNOWN_TOOL', message: 'no such tool' },
    });
    expect(denied).toMatchObject({
      service: null,
      effect: null,
      status: 'denied',
      error: { code: 'UNKNOWN_TOOL' },
    });
    expect(denied.finishedAt).not.toBeNull();
  });

  it('sums what an agent spent on a day, across runs', async () => {
    const a = await make();
    const b = await make();
    await runs.recordStep(a.id, { input: 1000, output: 200 });
    await runs.recordStep(b.id, { input: 300, output: 0 });
    expect(await runs.tokensOnDay(agentId, new Date())).toBe(1500);
    expect(await runs.tokensOnDay(agentId, new Date(Date.now() + 2 * 86_400_000))).toBe(0);
  });

  // The daily cap is the only bound on a chat that stays active for days:
  // its per-turn limits reset with every question.
  it('counts tokens on the day they were spent, not the day the run began', async () => {
    const chat = await make({ mode: 'chat' });
    await database.db.query(
      `UPDATE runs SET created_at = now() - interval '2 days' WHERE id = $1`,
      [chat.id],
    );
    await runs.recordStep(chat.id, { input: 4000, output: 500 });
    expect(await runs.tokensOnDay(agentId, new Date())).toBe(4500);
    expect(await runs.tokensOnDay(agentId, new Date(Date.now() - 2 * 86_400_000))).toBe(0);
  });

  it('lists runs newest first, filtered by agent and status', async () => {
    const first = await make();
    const second = await make();
    await runs.claim(second.id, 'worker-a', 60);
    const all = await runs.list({});
    expect(all.total).toBe(2);
    expect(all.items.map((r) => r.id)).toEqual([second.id, first.id]);
    const running = await runs.list({ agentId, status: 'running' });
    expect(running.items.map((r) => r.id)).toEqual([second.id]);
    expect((await runs.list({ agentId: 'not-a-uuid' })).total).toBe(0);
  });

  it('fails runs that made no progress for twice their timeout', async () => {
    const stuck = await make();
    await runs.claim(stuck.id, 'worker-a', 60);
    const fresh = await make();
    await runs.claim(fresh.id, 'worker-a', 60);
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '601 seconds' WHERE id = $1`,
      [stuck.id],
    );
    expect(await runs.failStalled()).toEqual([stuck.id]);
    expect(await runs.get(stuck.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERNAL' },
    });
    expect((await runs.get(fresh.id))!.status).toBe('running');
  });

  // A run that kills its worker every time is taken over again and again. Each
  // takeover must not look like progress, or the stall check never fires.
  it('does not reset the stall clock when a run is taken over', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '601 seconds',
                       lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [run.id],
    );
    expect(await runs.claim(run.id, 'worker-b', 60)).not.toBeNull();
    expect(await runs.failStalled()).toEqual([run.id]);
  });

  // The run loop adds a run's warnings again after every takeover. One the run
  // already has is not progress either.
  it('does not reset the stall clock when a warning the run already has is added again', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await runs.addWarning(run.id, 'Tool graph.x is no longer available.');
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '601 seconds',
                       lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [run.id],
    );
    expect(await runs.claim(run.id, 'worker-b', 60)).not.toBeNull();
    await runs.addWarning(run.id, 'Tool graph.x is no longer available.');
    expect(await runs.failStalled()).toEqual([run.id]);
  });

  it('moves the stall clock for a warning the run did not have', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '601 seconds' WHERE id = $1`,
      [run.id],
    );
    await runs.addWarning(run.id, 'Tool graph.y is no longer available.');
    expect(await runs.failStalled()).toEqual([]);
  });

  it('still starts the clock when a queued run is first claimed', async () => {
    const run = await make();
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '601 seconds' WHERE id = $1`,
      [run.id],
    );
    await runs.claim(run.id, 'worker-a', 60);
    expect(await runs.failStalled()).toEqual([]);
  });

  // claim() refuses a run with a cancel request, so a cancelled run whose
  // worker died can never be taken over: the sweep has to finish it.
  it('finishes a cancelled run whose worker died, and stops re-queuing it', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await runs.requestCancel(run.id);
    expect(await runs.cancelAbandoned()).toEqual([]); // its worker may still be alive
    await database.db.query(
      `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    expect(await runs.expiredLeases()).toEqual([]);
    expect(await runs.cancelAbandoned()).toEqual([run.id]);
    expect(await runs.get(run.id)).toMatchObject({ status: 'cancelled' });
    expect((await runs.get(run.id))!.finishedAt).not.toBeNull();
  });

  // A job can be lost (Redis restarted, or the worker threw before claiming).
  // The run would stay queued forever, and a chat in that state takes no
  // further message.
  it('hands back a queued run nobody picked up, once per window', async () => {
    const lost = await make();
    const fresh = await make();
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '5 minutes' WHERE id = $1`,
      [lost.id],
    );
    expect(await runs.requeueStaleQueued(60)).toEqual([lost.id]);
    expect(await runs.requeueStaleQueued(60)).toEqual([]);
    expect((await runs.get(lost.id))!.status).toBe('queued');
    expect((await runs.get(fresh.id))!.status).toBe('queued');
  });

  it('closes chat runs idle past the limit', async () => {
    const chat = await make({ mode: 'chat' });
    await runs.claim(chat.id, 'worker-a', 60);
    await runs.waitForInput(chat.id);
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '61 minutes' WHERE id = $1`,
      [chat.id],
    );
    expect(await runs.closeIdleChats(60)).toEqual([chat.id]);
    expect((await runs.get(chat.id))!.status).toBe('succeeded');
  });
});
