import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  AgentStore,
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
import { AgentLoop, type AgentLoopOptions } from '../loop/agent-loop.js';
import { ModelCallError } from '../model/model-client.js';
import { userMessage } from '../model/messages.js';
import {
  MODEL,
  ScriptedModel,
  answer,
  callTools,
  definition,
  fakeTool,
  toolCallMessage,
  toolResults,
  type FakeTool,
} from './helpers/loop-fixtures.js';

const CEILINGS = { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 };

describe.skipIf(!DATABASE_TEST_URL)('AgentLoop — Postgres integration', () => {
  let database: TestDatabase;
  let runs: RunStore;
  let agentId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    runs = new RunStore(database.db);
    const agent = await new AgentStore(database.db).create({
      slug: 'owners',
      name: 'Owners',
      definition: definition(),
      actor: 'admin@example.com',
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
  });

  const createRun = (
    extra: { definition?: AgentDefinition; mode?: 'task' | 'chat'; text?: string } = {},
  ) =>
    runs.create({
      agentId,
      agentVersion: 1,
      definition: extra.definition ?? definition(),
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode: extra.mode ?? 'task',
      input: { text: extra.text ?? 'Who owns payments-api?' },
      messages: [userMessage(extra.text ?? 'Who owns payments-api?')],
    });

  function loop(model: ScriptedModel, tools: FakeTool[], extra: Partial<AgentLoopOptions> = {}) {
    const events: RunEvent[] = [];
    const instance = new AgentLoop({
      runs,
      model,
      tools,
      models: [MODEL],
      ceilings: CEILINGS,
      toolResultChars: 50_000,
      owner: 'worker-test',
      renewEveryMs: 20,
      publish: (e) => events.push(e),
      ...extra,
    });
    return { instance, events };
  }

  const reload = async (id: string): Promise<RunRecord> => (await runs.get(id))!;

  it('answers without tools: one step, the answer as output, usage recorded', async () => {
    const run = await createRun();
    const model = new ScriptedModel([answer('team-payments owns it.', { input: 120, output: 30 })]);
    const { instance, events } = loop(model, []);
    expect(await instance.process(run.id)).toBe('finished');

    expect(await reload(run.id)).toMatchObject({
      status: 'succeeded',
      output: { text: 'team-payments owns it.' },
      steps: 1,
      inputTokens: 120,
      outputTokens: 30,
    });
    expect((await runs.listMessages(run.id)).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(model.requests[0]).toMatchObject({
      model: MODEL,
      instructions: 'Answer ownership questions using the tools.',
    });
    expect(events.at(-1)).toEqual({ runId: run.id, status: 'succeeded' });
  });

  it('runs an allowed tool, hands the result back, then answers', async () => {
    const run = await createRun();
    const owners = fakeTool('graph.find_owners', 'read');
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'payments-api' } }]),
      answer('team-payments'),
    ]);
    const { instance } = loop(model, [owners]);
    await instance.process(run.id);

    expect(owners.calls).toEqual([{ q: 'payments-api' }]);
    const messages = await runs.listMessages(run.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(toolResults(messages)).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'graph__find_owners',
        output: { type: 'json', value: { answer: 'payments-api' } },
      },
    ]);
    // The provider metadata the model sent is replayed on the next step.
    expect(JSON.stringify(model.requests[1]!.messages)).toContain('sig-c1');
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['graph__find_owners']);
    expect(await runs.listToolCalls(run.id)).toEqual([
      expect.objectContaining({
        callId: 'c1',
        toolId: 'graph.find_owners',
        service: 'graph',
        effect: 'read',
        policy: 'allow',
        decision: 'allow',
        status: 'succeeded',
        input: { q: 'payments-api' },
        output: { answer: 'payments-api' },
      }),
    ]);
    expect((await reload(run.id)).status).toBe('succeeded');
  });

  it('denies a tool the model invented, tells it so, and carries on', async () => {
    const run = await createRun();
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__drop_database', input: {} }]),
      answer('I cannot do that.'),
    ]);
    const { instance } = loop(model, [fakeTool('graph.find_owners', 'read')]);
    await instance.process(run.id);

    expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
      error: { code: 'UNKNOWN_TOOL', message: expect.stringContaining('graph__drop_database') },
    });
    expect(await runs.listToolCalls(run.id)).toEqual([
      expect.objectContaining({
        toolId: 'graph__drop_database',
        decision: 'deny',
        status: 'denied',
        policy: 'off',
      }),
    ]);
    expect((await reload(run.id)).status).toBe('succeeded');
  });

  it('returns invalid input to the model as an error naming the problem, without running the tool', async () => {
    const run = await createRun();
    const owners = fakeTool('graph.find_owners', 'read');
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 42 } }]),
      answer('Sorry.'),
    ]);
    await loop(model, [owners]).instance.process(run.id);

    expect(owners.calls).toEqual([]);
    expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
      error: { code: 'INVALID_INPUT', message: 'q: expected a string' },
    });
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({ status: 'failed' });
  });

  it('records a tool that throws as a failed call and lets the model see the error', async () => {
    const run = await createRun();
    const broken = fakeTool('graph.find_owners', 'read', {
      result: () => {
        throw new Error('Neo4j unavailable');
      },
    });
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'x' } }]),
      answer('The graph is down.'),
    ]);
    await loop(model, [broken]).instance.process(run.id);

    expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
      error: { code: 'TOOL_ERROR', message: 'Neo4j unavailable' },
    });
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: 'Neo4j unavailable' },
    });
    expect((await reload(run.id)).status).toBe('succeeded');
  });

  it('runs reads in parallel and appends every result in call order', async () => {
    const run = await createRun();
    const slow = fakeTool('graph.slow', 'read', { delayMs: 80 });
    const fast = fakeTool('graph.fast', 'read', { delayMs: 5 });
    const model = new ScriptedModel([
      callTools([
        { callId: 'c1', name: 'graph__slow', input: { q: 'a' } },
        { callId: 'c2', name: 'graph__fast', input: { q: 'b' } },
      ]),
      answer('done'),
    ]);
    await loop(model, [slow, fast]).instance.process(run.id);

    // The fast read started before the slow one finished.
    expect(fast.spans[0]![0]).toBeLessThan(slow.spans[0]![1]);
    const messages = await runs.listMessages(run.id);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(toolResults(messages).map((r) => r.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('runs writes one at a time', async () => {
    const run = await createRun();
    const first = fakeTool('gh.comment', 'write', { delayMs: 40 });
    const second = fakeTool('gh.add_labels', 'write', { delayMs: 5 });
    const model = new ScriptedModel([
      callTools([
        { callId: 'c1', name: 'gh__comment', input: { q: 'a' } },
        { callId: 'c2', name: 'gh__add_labels', input: { q: 'b' } },
      ]),
      answer('done'),
    ]);
    await loop(model, [first, second]).instance.process(run.id);

    expect(second.spans[0]![0]).toBeGreaterThanOrEqual(first.spans[0]![1]);
  });

  it('offers only allowed tools; an ask grant waits for approvals, with a warning', async () => {
    const run = await createRun({
      definition: definition({
        grants: {
          services: { graph: { read: 'allow', write: 'off', delete: 'off' } },
          tools: { 'gh.comment': 'ask' },
        },
      }),
    });
    const model = new ScriptedModel([answer('ok')]);
    await loop(model, [
      fakeTool('graph.find_owners', 'read'),
      fakeTool('gh.comment', 'write'),
      fakeTool('gh.add_labels', 'write'),
    ]).instance.process(run.id);

    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['graph__find_owners']);
    expect((await reload(run.id)).warnings).toEqual([
      'gh.comment needs approval before it runs. Approvals are not available yet, so it was not offered.',
    ]);
  });

  it('stores a large result in full and gives the model a truncated copy', async () => {
    const run = await createRun();
    const big = fakeTool('graph.find_owners', 'read', {
      result: () => ({ blob: 'x'.repeat(500) }),
    });
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'x' } }]),
      answer('ok'),
    ]);
    await loop(model, [big], { toolResultChars: 100 }).instance.process(run.id);

    const inContext = toolResults(await runs.listMessages(run.id))[0]!.output.value as {
      truncated: boolean;
      note: string;
      content: string;
    };
    expect(inContext.truncated).toBe(true);
    expect(inContext.content).toHaveLength(100);
    expect(inContext.note).toMatch(/100 of 511 characters/);
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({
      output: { blob: 'x'.repeat(500) },
      outputTruncated: true,
    });
  });

  describe('limits', () => {
    it('fails with STEP_LIMIT when the model keeps calling tools past maxSteps', async () => {
      const run = await createRun({
        definition: definition({
          limits: { maxSteps: 2, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        callTools([{ callId: 'c2', name: 'graph__find_owners', input: { q: 'b' } }]),
        answer('never reached'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')]).instance.process(run.id);

      expect(model.requests).toHaveLength(2);
      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        error: { code: 'STEP_LIMIT' },
        steps: 2,
      });
      // A call made on the last step is kept in the transcript but never run.
      expect((await runs.listToolCalls(run.id)).map((c) => c.callId)).toEqual(['c1']);
      expect((await runs.listMessages(run.id)).at(-1)!.role).toBe('assistant');
    });

    it('asks for an answer on the last allowed step, from what the run found', async () => {
      const run = await createRun({
        definition: definition({
          limits: { maxSteps: 2, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        answer('team-a, as far as I found.'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')]).instance.process(run.id);

      // Tools stay declared (Gemini invents tool names when they vanish from a
      // transcript that used them); the instructions ask for an answer.
      expect(model.requests[1]!.tools).toHaveLength(1);
      expect(model.requests[0]!.instructions).not.toMatch(/last step/i);
      expect(model.requests[1]!.instructions).toMatch(/last step.*answer now/i);
      // A note at the end of the transcript is what long transcripts heed
      // (measured live); it is stored, tagged so the UI can show it as a note.
      const note = model.requests[1]!.messages.at(-1)!;
      expect(note).toMatchObject({
        role: 'user',
        content: expect.stringMatching(/last step/i),
        providerOptions: { shipit: { kind: 'step-limit-note' } },
      });
      const stored = (await runs.listMessages(run.id)).map((m) => m.content);
      expect(stored.filter((m) => JSON.stringify(m).includes('step-limit-note'))).toHaveLength(1);
      expect(await reload(run.id)).toMatchObject({
        status: 'succeeded',
        output: { text: 'team-a, as far as I found.' },
      });
    });

    it('fails with BUDGET_EXCEEDED once the run has used its tokens', async () => {
      const run = await createRun({
        definition: definition({
          limits: { maxSteps: 10, maxTokens: 1_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }], {
          input: 900,
          output: 200,
        }),
        answer('never reached'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')]).instance.process(run.id);

      expect(model.requests).toHaveLength(1);
      expect((await reload(run.id)).error).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    });

    it('applies the instance ceiling when it is lower than the agent’s own limit', async () => {
      const run = await createRun();
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        answer('never reached'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')], {
        ceilings: { ...CEILINGS, maxSteps: 1 },
      }).instance.process(run.id);

      expect((await reload(run.id)).error).toMatchObject({ code: 'STEP_LIMIT' });
    });

    it('refuses to start with DAILY_LIMIT when the agent spent its daily tokens', async () => {
      const earlier = await createRun();
      await runs.recordStep(earlier.id, { input: 999_000, output: 1_000 });
      const run = await createRun();
      const model = new ScriptedModel([answer('never reached')]);
      await loop(model, []).instance.process(run.id);

      expect(model.requests).toHaveLength(0);
      expect((await reload(run.id)).error).toMatchObject({ code: 'DAILY_LIMIT' });
    });

    it('fails with TIMEOUT once the run is older than its timeout', async () => {
      const run = await createRun();
      const later = () => new Date(Date.now() + 301_000);
      const model = new ScriptedModel([answer('never reached')]);
      await loop(model, [], { now: later }).instance.process(run.id);

      expect(model.requests).toHaveLength(0);
      expect((await reload(run.id)).error).toMatchObject({ code: 'TIMEOUT' });
    });
  });

  describe('model outcomes', () => {
    it('fails with MODEL_REFUSED when the model stops for safety', async () => {
      const run = await createRun();
      const model = new ScriptedModel([
        () => ({
          messages: [],
          toolCalls: [],
          text: '',
          finish: 'refusal',
          usage: { input: 5, output: 0 },
        }),
      ]);
      await loop(model, []).instance.process(run.id);
      expect((await reload(run.id)).error).toMatchObject({ code: 'MODEL_REFUSED' });
    });

    it('fails with the model layer’s code when the call fails', async () => {
      for (const code of ['MODEL_ERROR', 'CONTEXT_EXCEEDED'] as const) {
        const run = await createRun();
        const model = new ScriptedModel([
          () => {
            throw new ModelCallError(code, `boom ${code}`);
          },
        ]);
        await loop(model, []).instance.process(run.id);
        expect((await reload(run.id)).error).toEqual({ code, message: `boom ${code}` });
      }
    });

    it('fails with MODEL_ERROR when the agent names a model the instance does not offer', async () => {
      const run = await createRun({ definition: definition({ model: 'retired-model' }) });
      const model = new ScriptedModel([answer('never reached')]);
      await loop(model, []).instance.process(run.id);
      expect(model.requests).toHaveLength(0);
      expect((await reload(run.id)).error).toMatchObject({
        code: 'MODEL_ERROR',
        message: expect.stringContaining('retired-model'),
      });
    });

    it('offers no tools to a model that cannot call them, and says so', async () => {
      const run = await createRun();
      const model = new ScriptedModel([answer('ok')]);
      await loop(model, [fakeTool('graph.find_owners', 'read')], {
        models: [{ ...MODEL, tools: false }],
      }).instance.process(run.id);
      expect(model.requests[0]!.tools).toEqual([]);
      expect((await reload(run.id)).warnings).toContain(
        'Model gemini cannot call tools, so none were offered.',
      );
    });
  });

  describe('cancel', () => {
    it('aborts the model call in flight and ends the run cancelled', async () => {
      const run = await createRun();
      const model = new ScriptedModel([
        (request) =>
          new Promise((_resolve, reject) => {
            void runs.requestCancel(run.id);
            request.signal.addEventListener('abort', () =>
              reject(new ModelCallError('ABORTED', 'aborted')),
            );
          }),
      ]);
      expect(await loop(model, []).instance.process(run.id)).toBe('finished');
      expect((await reload(run.id)).status).toBe('cancelled');
    });

    it('does nothing for a run that was cancelled before a worker took it', async () => {
      const run = await createRun();
      await runs.requestCancel(run.id);
      const model = new ScriptedModel([answer('never reached')]);
      expect(await loop(model, []).instance.process(run.id)).toBe('not_claimed');
      expect(model.requests).toHaveLength(0);
    });
  });

  describe('chat', () => {
    it('ends each turn waiting for input and continues on the next message', async () => {
      const run = await createRun({ mode: 'chat', text: 'Hi' });
      const model = new ScriptedModel([answer('Hello. Ask me about owners.'), answer('team-a')]);
      const { instance } = loop(model, []);
      expect(await instance.process(run.id)).toBe('waiting');
      expect((await reload(run.id)).status).toBe('waiting_input');

      await runs.addUserMessage(run.id, userMessage('Who owns x?'));
      expect(await instance.process(run.id)).toBe('waiting');
      expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect((await reload(run.id)).steps).toBe(2);
    });

    it('applies the step and token limits to each turn, not to the whole conversation', async () => {
      const run = await createRun({
        mode: 'chat',
        definition: definition({
          limits: { maxSteps: 2, maxTokens: 300, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const owners = fakeTool('graph.find_owners', 'read');
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        answer('team-a'),
        callTools([{ callId: 'c2', name: 'graph__find_owners', input: { q: 'b' } }]),
        answer('team-b'),
      ]);
      const { instance } = loop(model, [owners]);
      expect(await instance.process(run.id)).toBe('waiting');
      await runs.addUserMessage(run.id, userMessage('And b?'));
      // Two steps and 220 tokens already spent; the second turn gets its own two and 300.
      expect(await instance.process(run.id)).toBe('waiting');
      expect(await reload(run.id)).toMatchObject({ status: 'waiting_input', steps: 4 });
      expect(owners.calls).toEqual([{ q: 'a' }, { q: 'b' }]);
    });
  });

  describe('crash recovery', () => {
    // A worker died after the model asked for tools and after it wrote the
    // tool_calls row as executing, before the result was appended. The run's
    // lease has run out, so another worker takes it.
    async function crashedMidTool(effect: 'read' | 'write') {
      const name = effect === 'read' ? 'graph__find_owners' : 'gh__comment';
      const toolId = effect === 'read' ? 'graph.find_owners' : 'gh.comment';
      const run = await createRun();
      await runs.claim(run.id, 'worker-dead', 60);
      const [assistant] = await runs.appendMessages(run.id, [
        toolCallMessage([{ callId: 'c1', name, input: { q: 'x' } }]),
      ]);
      await runs.recordStep(run.id, { input: 100, output: 10 });
      await runs.startToolCall({
        runId: run.id,
        callId: 'c1',
        messageSeq: assistant!.seq,
        toolId,
        service: toolId.split('.')[0]!,
        effect,
        policy: 'allow',
        decision: 'allow',
        status: 'executing',
        input: { q: 'x' },
      });
      await database.db.query(
        `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [run.id],
      );
      return run;
    }

    it('re-runs a read that was in flight', async () => {
      const run = await crashedMidTool('read');
      const owners = fakeTool('graph.find_owners', 'read');
      const model = new ScriptedModel([answer('team-a')]);
      expect(await loop(model, [owners]).instance.process(run.id)).toBe('finished');

      expect(owners.calls).toEqual([{ q: 'x' }]);
      expect((await runs.listToolCalls(run.id))[0]).toMatchObject({ status: 'succeeded' });
      expect((await reload(run.id)).status).toBe('succeeded');
    });

    it('never repeats a write that was in flight; the model is told its outcome is unknown', async () => {
      const run = await crashedMidTool('write');
      const comment = fakeTool('gh.comment', 'write');
      const model = new ScriptedModel([answer('I will check before retrying.')]);
      await loop(model, [comment]).instance.process(run.id);

      expect(comment.calls).toEqual([]);
      expect((await runs.listToolCalls(run.id))[0]).toMatchObject({ status: 'outcome_unknown' });
      expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
        error: { code: 'OUTCOME_UNKNOWN', message: expect.stringMatching(/check/i) },
      });
    });

    it('reuses a result that was recorded before the crash instead of running the tool again', async () => {
      const run = await crashedMidTool('read');
      const [row] = await runs.listToolCalls(run.id);
      await runs.finishToolCall(row!.id, { status: 'succeeded', output: { answer: 'cached' } });
      const owners = fakeTool('graph.find_owners', 'read');
      const model = new ScriptedModel([answer('ok')]);
      await loop(model, [owners]).instance.process(run.id);

      expect(owners.calls).toEqual([]);
      expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
        answer: 'cached',
      });
    });
  });

  it('stops without touching the run when another worker takes it over', async () => {
    const run = await createRun();
    const model = new ScriptedModel([
      async (request) => {
        // Another worker steals the run while the model call is in flight.
        await database.db.query(`UPDATE runs SET lease_owner = 'worker-other' WHERE id = $1`, [
          run.id,
        ]);
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(new ModelCallError('ABORTED', 'aborted')),
          ),
        );
      },
    ]);
    expect(await loop(model, []).instance.process(run.id)).toBe('lease_lost');
    expect((await reload(run.id)).status).toBe('running');
  });

  it('announces every append and the final status', async () => {
    const run = await createRun();
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'x' } }]),
      answer('ok'),
    ]);
    const { instance, events } = loop(model, [fakeTool('graph.find_owners', 'read')]);
    await instance.process(run.id);
    expect(events).toEqual([
      { runId: run.id, status: 'running' },
      { runId: run.id, seq: 1 },
      { runId: run.id, seq: 2 },
      { runId: run.id, seq: 3 },
      { runId: run.id, status: 'succeeded' },
    ]);
  });
});
