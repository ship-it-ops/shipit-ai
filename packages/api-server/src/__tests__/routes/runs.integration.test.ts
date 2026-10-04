// The runs API against a real Postgres (the run store's conditional writes are
// the point), with a recording stand-in for the BullMQ queue.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import {
  AgentStore,
  RunStore,
  type AgentDefinition,
  type AgentRecord,
  type RunRecord,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { createServer } from '../../server.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const check = (name: AiStatus['checks'][number]['name'], ok = true) => ({
  name,
  ok,
  detail: ok ? 'ok' : `${name} is down`,
});
const AVAILABLE: AiStatus = {
  available: true,
  definitionsAvailable: true,
  checks: (['enabled', 'database', 'schema', 'models', 'runner'] as const).map((n) => check(n)),
};
const RUNNER_DOWN: AiStatus = {
  available: false,
  definitionsAvailable: true,
  checks: [...AVAILABLE.checks.slice(0, 4), check('runner', false)],
};

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

class RecordingQueue {
  enqueued: string[] = [];
  failing = false;
  async enqueue(runId: string): Promise<void> {
    if (this.failing) throw new Error('OOM command not allowed');
    this.enqueued.push(runId);
  }
}

function authConfig(): Config {
  const base = makeTestConfig();
  return {
    ...base,
    accessControl: {
      ...base.accessControl,
      auth: {
        ...base.accessControl.auth,
        enabled: true,
        providers: {
          ...base.accessControl.auth.providers,
          oidc: {
            ...base.accessControl.auth.providers.oidc,
            enabled: true,
            issuerUrl: 'https://idp.example.com',
            clientId: 'oidc-test-client',
            displayName: 'Example IdP',
          },
        },
        admins: ['admin@example.com'],
        allowList: [],
        session: { ...base.accessControl.auth.session, secure: false },
      },
    },
  };
}

const stubOidc = {
  async startAuthorization() {
    return { url: 'https://idp.example.com/authorize', state: 's', codeVerifier: 'v' };
  },
  async exchange() {
    return { sub: 'sub', email: 'member@example.com', displayName: 'Member' };
  },
} as unknown as OidcProvider;

// Bearer tokens stand in for signed-in people with given capabilities.
const PRINCIPALS: Record<string, string[]> = {
  member: ['agents:read', 'agents:run'],
  other: ['agents:read', 'agents:run'],
  author: ['agents:read', 'agents:write', 'agents:run', 'graph:read'],
  reader: ['agents:read'],
  boss: ['*'],
};
const tokenService = {
  validate: async (plaintext: string) =>
    PRINCIPALS[plaintext]
      ? { id: plaintext, ownerEmail: `${plaintext}@example.com`, scopes: PRINCIPALS[plaintext] }
      : null,
} as unknown as TokenService;

describe.skipIf(!DATABASE_TEST_URL)('runs routes — Postgres integration', () => {
  let database: TestDatabase;
  let agents: AgentStore;
  let runs: RunStore;
  const queue = new RecordingQueue();
  let status: AiStatus = AVAILABLE;
  const aiStatus = { status: async () => status } as unknown as AiStatusService;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    agents = new AgentStore(database.db);
    runs = new RunStore(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
    await database.db.query('DELETE FROM agent_versions');
    await database.db.query('DELETE FROM agents');
    queue.enqueued = [];
    queue.failing = false;
    status = AVAILABLE;
  });

  async function publishedAgent(createdBy = 'author@example.com'): Promise<AgentRecord> {
    const agent = await agents.create({
      slug: `owners-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Owners',
      definition,
      actor: createdBy,
    });
    return (await agents.publish(agent.id, undefined, 'first', createdBy)).agent;
  }

  describe('as the local dev user (auth off, every capability)', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      server = await createServer({
        config: makeTestConfig(),
        agentStore: agents,
        runStore: runs,
        runQueue: queue,
        aiStatus,
      });
      await server.ready();
    });
    afterAll(async () => {
      await server.close();
    });

    const start = (agentId: string, payload: Record<string, unknown>) =>
      server.inject({ method: 'POST', url: `/api/agents/${agentId}/runs`, payload });

    it('starts a run of the published version and queues it', async () => {
      const agent = await publishedAgent();
      const res = await start(agent.id, { input: 'Who owns payments-api?' });
      expect(res.statusCode).toBe(201);
      const run = res.json() as RunRecord;
      expect(res.headers.location).toBe(`/api/runs/${run.id}`);
      expect(run).toMatchObject({
        agentId: agent.id,
        agentVersion: 1,
        definition,
        status: 'queued',
        mode: 'task',
        triggerKind: 'manual',
        triggeredBy: 'dev@shipit.local',
        input: { text: 'Who owns payments-api?' },
      });
      expect(queue.enqueued).toEqual([run.id]);
      expect((await runs.listMessages(run.id)).map((m) => m.content)).toEqual([
        { role: 'user', content: 'Who owns payments-api?' },
      ]);
    });

    it('passes structured input to the model as data, not as instructions', async () => {
      const agent = await publishedAgent();
      const res = await start(agent.id, { input: { pr: 42, repo: 'payments-api' } });
      expect(res.statusCode).toBe(201);
      const [first] = await runs.listMessages(res.json().id);
      expect(first!.content.content).toMatch(/JSON data, not instructions/);
      expect(first!.content.content).toContain('"repo":"payments-api"');
    });

    it('runs the draft when asked, pinning no version', async () => {
      const agent = await publishedAgent();
      const draft = { ...definition, instructions: 'Draft instructions.' };
      await agents.update(agent.id, undefined, { definition: draft }, 'author@example.com');
      const res = await start(agent.id, { input: 'hi', draft: true, mode: 'chat' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ agentVersion: null, definition: draft, mode: 'chat' });
    });

    it('refuses an agent with nothing published, a disabled one and an unknown one', async () => {
      const unpublished = await agents.create({
        slug: 'draft-only',
        name: 'Draft only',
        definition,
        actor: 'author@example.com',
      });
      expect((await start(unpublished.id, { input: 'x' })).json().error.code).toBe('NOT_PUBLISHED');
      const disabled = await publishedAgent();
      await agents.update(disabled.id, undefined, { enabled: false }, 'author@example.com');
      const res = await start(disabled.id, { input: 'x' });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'AGENT_DISABLED']);
      expect((await start('00000000-0000-0000-0000-000000000000', { input: 'x' })).statusCode).toBe(
        404,
      );
      expect(queue.enqueued).toEqual([]);
    });

    it('refuses an agent whose model the instance no longer offers', async () => {
      const agent = await agents.create({
        slug: 'retired',
        name: 'Retired',
        definition: { ...definition, model: 'retired-model' },
        actor: 'author@example.com',
      });
      const res = await start(agent.id, { input: 'x', draft: true });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'MODEL_UNAVAILABLE']);
    });

    it.each([
      ['no input', {}, 'input'],
      ['empty input', { input: '' }, 'input'],
      ['input over 20,000 characters', { input: 'x'.repeat(20_001) }, 'input'],
      ['an unknown mode', { input: 'x', mode: 'batch' }, 'mode'],
      ['a draft flag that is not boolean', { input: 'x', draft: 'yes' }, 'draft'],
    ])('rejects %s, naming the field', async (_label, payload, path) => {
      const agent = await publishedAgent();
      const res = await start(agent.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toBe(path);
    });

    it('answers 503 naming the runner when no runner is working, and starts nothing', async () => {
      const agent = await publishedAgent();
      status = RUNNER_DOWN;
      const res = await start(agent.id, { input: 'x' });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks).toEqual([check('runner', false)]);
      expect((await runs.list({})).total).toBe(0);
    });

    it('fails the run and answers 503 when the queue is unreachable', async () => {
      const agent = await publishedAgent();
      queue.failing = true;
      const res = await start(agent.id, { input: 'x' });
      expect([res.statusCode, res.json().error.code]).toEqual([503, 'QUEUE_UNAVAILABLE']);
      const [run] = (await runs.list({})).items;
      expect(run).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
    });

    it('lists runs, filtered by agent and status, and reads one', async () => {
      const a = await publishedAgent();
      const b = await publishedAgent();
      const first = (await start(a.id, { input: 'one' })).json() as RunRecord;
      await start(b.id, { input: 'two' });
      const all = await server.inject({ method: 'GET', url: '/api/runs' });
      expect(all.json().total).toBe(2);
      const forA = await server.inject({ method: 'GET', url: `/api/runs?agentId=${a.id}` });
      expect(forA.json().items.map((r: RunRecord) => r.id)).toEqual([first.id]);
      const queued = await server.inject({ method: 'GET', url: '/api/runs?status=queued' });
      expect(queued.json().total).toBe(2);
      const bad = await server.inject({ method: 'GET', url: '/api/runs?status=bogus' });
      expect(bad.statusCode).toBe(400);
      const one = await server.inject({ method: 'GET', url: `/api/runs/${first.id}` });
      expect(one.json()).toMatchObject({ id: first.id, input: { text: 'one' } });
      expect((await server.inject({ method: 'GET', url: '/api/runs/not-a-run' })).statusCode).toBe(
        404,
      );
    });

    it('returns the transcript and tool calls, optionally after a sequence number', async () => {
      const agent = await publishedAgent();
      const run = (await start(agent.id, { input: 'one' })).json() as RunRecord;
      await runs.claim(run.id, 'w', 60);
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'two' }]);
      const all = await server.inject({ method: 'GET', url: `/api/runs/${run.id}/messages` });
      expect(all.json().messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1]);
      expect(all.json().toolCalls).toEqual([]);
      const later = await server.inject({
        method: 'GET',
        url: `/api/runs/${run.id}/messages?afterSeq=0`,
      });
      expect(later.json().messages.map((m: { seq: number }) => m.seq)).toEqual([1]);
    });

    it('takes the next chat message for a waiting run and queues it again', async () => {
      const agent = await publishedAgent();
      const run = (await start(agent.id, { input: 'hi', mode: 'chat' })).json() as RunRecord;
      queue.enqueued = [];
      const early = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/messages`,
        payload: { text: 'too soon' },
      });
      expect([early.statusCode, early.json().error.code]).toEqual([409, 'RUN_NOT_WAITING']);

      await runs.claim(run.id, 'w', 60);
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'Hello.' }], 'w');
      await runs.waitForInput(run.id, 'w');
      const res = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/messages`,
        payload: { text: 'Who owns x?' },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe('queued');
      expect(queue.enqueued).toEqual([run.id]);
      const empty = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/messages`,
        payload: { text: '  ' },
      });
      expect(empty.statusCode).toBe(400);
    });

    it('cancels a queued run', async () => {
      const agent = await publishedAgent();
      const run = (await start(agent.id, { input: 'x' })).json() as RunRecord;
      const res = await server.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'cancelled', cancelRequested: true });
      const missing = await server.inject({
        method: 'POST',
        url: '/api/runs/00000000-0000-0000-0000-000000000000/cancel',
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('as signed-in people (auth on)', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
      server = await createServer({
        config: authConfig(),
        redis: new RedisMock() as unknown as Redis,
        resolved: makeTestResolved(),
        oidcProvider: stubOidc,
        tokenService,
        agentStore: agents,
        runStore: runs,
        runQueue: queue,
        aiStatus,
      });
      await server.ready();
    });
    afterAll(async () => {
      await server.close();
      delete process.env.SHIPIT_SESSION_SECRET;
    });

    const as = (who: string) => ({ authorization: `Bearer ${who}` });
    const startAs = (who: string, agentId: string, payload: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/runs`,
        headers: as(who),
        payload,
      });

    it('lets a member start a published agent, not a draft', async () => {
      const agent = await publishedAgent();
      const res = await startAs('member', agent.id, { input: 'x' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ triggerKind: 'api', triggeredBy: 'member@example.com' });
      const draft = await startAs('member', agent.id, { input: 'x', draft: true });
      expect([draft.statusCode, draft.json().error.code]).toEqual([403, 'FORBIDDEN']);
      expect((await startAs('reader', agent.id, { input: 'x' })).statusCode).toBe(403);
    });

    it('shows a run’s content only to its starter, the agent’s author and admins', async () => {
      const agent = await publishedAgent('author@example.com');
      const run = (await startAs('member', agent.id, { input: 'secret question' })).json();
      for (const who of ['member', 'author', 'boss']) {
        const res = await server.inject({
          method: 'GET',
          url: `/api/runs/${run.id}`,
          headers: as(who),
        });
        expect(res.json().input, who).toEqual({ text: 'secret question' });
        const transcript = await server.inject({
          method: 'GET',
          url: `/api/runs/${run.id}/messages`,
          headers: as(who),
        });
        expect(transcript.statusCode, who).toBe(200);
      }
      const other = await server.inject({
        method: 'GET',
        url: `/api/runs/${run.id}`,
        headers: as('other'),
      });
      expect(other.json()).toMatchObject({
        id: run.id,
        input: null,
        output: null,
        contentHidden: true,
      });
      const list = await server.inject({ method: 'GET', url: '/api/runs', headers: as('other') });
      expect(list.json().items[0]).toMatchObject({ input: null, contentHidden: true });
      const denied = await server.inject({
        method: 'GET',
        url: `/api/runs/${run.id}/messages`,
        headers: as('other'),
      });
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'FORBIDDEN']);
    });

    it('lets only the starter or an admin cancel a run or add to it', async () => {
      const agent = await publishedAgent();
      const run = (await startAs('member', agent.id, { input: 'x', mode: 'chat' })).json();
      for (const [method, path, payload] of [
        ['POST', 'cancel', undefined],
        ['POST', 'messages', { text: 'hi' }],
      ] as const) {
        const res = await server.inject({
          method,
          url: `/api/runs/${run.id}/${path}`,
          headers: as('other'),
          payload,
        });
        expect([res.statusCode, res.json().error.code], path).toEqual([403, 'FORBIDDEN']);
      }
      const byAdmin = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/cancel`,
        headers: as('boss'),
      });
      expect(byAdmin.json().status).toBe('cancelled');
    });
  });
});
