// Route tests for agent definitions. The store is an in-memory FAKE that throws
// the real error classes; the SQL behind the real store is covered by
// packages/agents' Postgres integration suite. Coverage:
//   - 503 AI_UNAVAILABLE when not wired or when a prerequisite fails
//   - create / read / update / publish / archive happy paths and ETags
//   - body, definition, model and ceiling validation (400 with issue paths)
//   - If-Match handling and 409 VERSION_CONFLICT
//   - store failures become 503, never 500, and never leak the driver message
//   - capability gating with auth enabled, including the author's own ceiling
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentVersionConflictError,
  type AgentDefinition,
  type AgentRecord,
  type AgentStore,
  type AgentVersionRecord,
  type CreateAgentInput,
  type UpdateAgentPatch,
} from '@shipit-ai/agents';
import { createServer } from '../../server.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const READY: AiStatus = {
  available: false,
  definitionsAvailable: true,
  checks: [
    { name: 'enabled', ok: true, detail: 'on' },
    { name: 'database', ok: true, detail: 'ok' },
    { name: 'schema', ok: true, detail: 'ok' },
    { name: 'models', ok: true, detail: 'ok' },
    { name: 'runner', ok: false, detail: 'No heartbeat from the agent runner in the last minute.' },
  ],
};

const statusOf = (status: AiStatus) =>
  ({ status: async () => status }) as unknown as AiStatusService;

const definition = {
  instructions: 'Answer questions about service ownership.',
  model: 'claude-opus',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
};

/** In-memory stand-in with the same contract as the Postgres AgentStore. */
class FakeAgentStore {
  agents = new Map<string, AgentRecord>();
  versions = new Map<string, AgentVersionRecord[]>();
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** When set, every method throws it. */
  failWith: Error | null = null;
  private seq = 0;

  private touch(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    if (this.failWith) throw this.failWith;
  }

  private live(id: string): AgentRecord {
    const agent = this.agents.get(id);
    if (!agent || agent.archivedAt) throw new AgentNotFoundError(id);
    return agent;
  }

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    this.touch('create', input);
    for (const a of this.agents.values()) {
      if (a.slug === input.slug && !a.archivedAt) throw new AgentSlugTakenError(input.slug);
    }
    this.seq += 1;
    const now = new Date().toISOString();
    const agent: AgentRecord = {
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      ownerTeamId: input.ownerTeamId ?? null,
      enabled: true,
      builtin: input.builtin ?? false,
      draftDefinition: input.definition,
      publishedVersion: null,
      revision: 1,
      createdBy: input.actor,
      updatedBy: input.actor,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async get(id: string): Promise<AgentRecord | null> {
    this.touch('get', id);
    return this.agents.get(id) ?? null;
  }

  async list(opts: unknown): Promise<{ items: AgentRecord[]; total: number }> {
    this.touch('list', opts);
    const items = [...this.agents.values()].filter((a) => !a.archivedAt);
    return { items, total: items.length };
  }

  async update(
    id: string,
    expected: number | undefined,
    patch: UpdateAgentPatch,
    actor: string,
  ): Promise<AgentRecord> {
    this.touch('update', id, expected, patch, actor);
    const agent = this.live(id);
    if (expected !== undefined && expected !== agent.revision) {
      throw new AgentVersionConflictError(id, agent.revision);
    }
    const { definition: nextDefinition, ...rest } = patch;
    const next: AgentRecord = {
      ...agent,
      ...rest,
      draftDefinition: nextDefinition ?? agent.draftDefinition,
      revision: agent.revision + 1,
      updatedBy: actor,
    };
    this.agents.set(id, next);
    return next;
  }

  async publish(id: string, expected: number | undefined, note: string, actor: string) {
    this.touch('publish', id, expected, note, actor);
    const agent = this.live(id);
    if (expected !== undefined && expected !== agent.revision) {
      throw new AgentVersionConflictError(id, agent.revision);
    }
    const list = this.versions.get(id) ?? [];
    const version: AgentVersionRecord = {
      agentId: id,
      version: list.length + 1,
      definition: agent.draftDefinition,
      note,
      createdBy: actor,
      createdAt: new Date().toISOString(),
    };
    this.versions.set(id, [version, ...list]);
    const next = { ...agent, publishedVersion: version.version, revision: agent.revision + 1 };
    this.agents.set(id, next);
    return { agent: next, version };
  }

  async archive(id: string, expected: number | undefined, actor: string): Promise<void> {
    this.touch('archive', id, expected, actor);
    const agent = this.live(id);
    if (agent.builtin) throw new AgentBuiltinProtectedError(id);
    if (expected !== undefined && expected !== agent.revision) {
      throw new AgentVersionConflictError(id, agent.revision);
    }
    this.agents.set(id, { ...agent, archivedAt: new Date().toISOString(), enabled: false });
  }

  async listVersions(id: string): Promise<AgentVersionRecord[]> {
    this.touch('listVersions', id);
    return this.versions.get(id) ?? [];
  }
}

const asStore = (fake: FakeAgentStore) => fake as unknown as AgentStore;

describe('agents routes — not available', () => {
  it('answers 503 AI_UNAVAILABLE when the server has no agent store', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AI_UNAVAILABLE');
    expect(res.json().checks).toHaveLength(1);
    // The rest of the product is unaffected.
    expect((await server.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await server.close();
  });

  it('names the failing prerequisites and never touches the store', async () => {
    const fake = new FakeAgentStore();
    const behind: AiStatus = {
      available: false,
      definitionsAvailable: false,
      checks: [
        { name: 'enabled', ok: true, detail: 'on' },
        { name: 'database', ok: true, detail: 'ok' },
        { name: 'schema', ok: false, detail: 'The schema is at 0000. This build needs 0001.' },
      ],
    };
    const server = await createServer({
      config: makeTestConfig(),
      agentStore: asStore(fake),
      aiStatus: statusOf(behind),
    });
    await server.ready();
    for (const [method, url] of [
      ['GET', '/api/agents'],
      ['POST', '/api/agents'],
      ['GET', '/api/agents/x'],
      ['PUT', '/api/agents/x'],
      ['DELETE', '/api/agents/x'],
      ['POST', '/api/agents/x/publish'],
      ['GET', '/api/agents/x/versions'],
    ] as const) {
      const res = await server.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().checks).toEqual([
        { name: 'schema', ok: false, detail: 'The schema is at 0000. This build needs 0001.' },
      ]);
    }
    expect(fake.calls).toEqual([]);
    await server.close();
  });
});

describe('agents routes — definitions (auth disabled, admin principal)', () => {
  let server: FastifyInstance;
  let fake: FakeAgentStore;

  beforeAll(async () => {
    fake = new FakeAgentStore();
    server = await createServer({
      config: makeTestConfig(),
      agentStore: asStore(fake),
      aiStatus: statusOf(READY),
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    fake.agents.clear();
    fake.versions.clear();
    fake.calls = [];
    fake.failWith = null;
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    server.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { slug: 'owners', name: 'Owners', definition, ...overrides },
    });

  it('creates an agent: 201, ETag "1", defaults filled in, author recorded', async () => {
    const res = await create({ description: 'Who owns what', ownerTeamId: 'team:platform' });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    const body = res.json() as AgentRecord;
    expect(body).toMatchObject({
      slug: 'owners',
      name: 'Owners',
      description: 'Who owns what',
      ownerTeamId: 'team:platform',
      revision: 1,
      publishedVersion: null,
    });
    expect(body.draftDefinition).toEqual({
      ...definition,
      grants: { services: {}, tools: {} },
      output: { schema: null },
    } satisfies AgentDefinition);
    expect(body.createdBy).toBeTruthy();
    expect(body.createdBy).toBe(body.updatedBy);
  });

  it.each([
    ['a missing slug', { slug: undefined }, 'slug'],
    ['an upper-case slug', { slug: 'Owners' }, 'slug'],
    ['a slug with a space', { slug: 'my agent' }, 'slug'],
    ['an empty name', { name: '   ' }, 'name'],
    ['a 121-character name', { name: 'x'.repeat(121) }, 'name'],
    ['a non-text description', { description: 7 }, 'description'],
    ['an empty ownerTeamId', { ownerTeamId: '' }, 'ownerTeamId'],
    ['a missing definition', { definition: undefined }, 'definition'],
    [
      'blank instructions',
      { definition: { ...definition, instructions: ' ' } },
      'definition.instructions',
    ],
    [
      'allow on delete',
      { definition: { ...definition, grants: { services: { graph: { delete: 'allow' } } } } },
      'definition.grants.services.graph.delete',
    ],
    ['an unknown model', { definition: { ...definition, model: 'gpt-x' } }, 'definition.model'],
    [
      'a limit above the ceiling',
      { definition: { ...definition, limits: { ...definition.limits, maxSteps: 26 } } },
      'definition.limits.maxSteps',
    ],
  ])(
    'rejects %s with 400 and the field path, and stores nothing',
    async (_name, overrides, path) => {
      const res = await create(overrides);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect((res.json().issues as Array<{ path: string }>).map((i) => i.path)).toContain(path);
      expect(fake.calls.filter((c) => c.method === 'create')).toEqual([]);
    },
  );

  it('rejects a body that is not a JSON object', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/agents', payload: ['nope'] });
    expect(res.statusCode).toBe(400);
  });

  it('answers 409 SLUG_TAKEN for a duplicate slug', async () => {
    await create();
    const res = await create();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SLUG_TAKEN');
  });

  it('reads one agent with its ETag, and 404s an unknown id', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({ method: 'GET', url: `/api/agents/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.json().slug).toBe('owners');

    const missing = await server.inject({ method: 'GET', url: '/api/agents/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('lists agents, passing paging through and ignoring junk paging values', async () => {
    await create();
    const res = await server.inject({
      method: 'GET',
      url: '/api/agents?limit=10&offset=abc&includeArchived=true',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1 });
    expect(fake.calls.at(-1)).toEqual({
      method: 'list',
      args: [{ includeArchived: true, limit: 10, offset: undefined }],
    });
  });

  it('clamps paging values Postgres cannot hold instead of passing them through', async () => {
    // An out-of-range OFFSET is a driver error, which the route would report as
    // the database being down. Clamped, it is just a page past the end.
    await server.inject({
      method: 'GET',
      url: '/api/agents?limit=99999999999&offset=100000000000000000000',
    });
    expect(fake.calls.at(-1)).toEqual({
      method: 'list',
      args: [{ includeArchived: false, limit: 2_147_483_647, offset: 2_147_483_647 }],
    });
  });

  it('updates with If-Match, returning the new ETag', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      headers: { 'if-match': '"1"' },
      payload: { name: 'Ownership helper', enabled: false, ownerTeamId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.json()).toMatchObject({ name: 'Ownership helper', enabled: false, revision: 2 });
    const call = fake.calls.find((c) => c.method === 'update')!;
    expect(call.args[1]).toBe(1);
    expect(call.args[2]).toEqual({ name: 'Ownership helper', enabled: false, ownerTeamId: null });
  });

  it('forces the write when If-Match is absent', async () => {
    const created = (await create()).json() as AgentRecord;
    await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { name: 'A' },
    });
    expect(fake.calls.find((c) => c.method === 'update')!.args[1]).toBeUndefined();
  });

  it('answers 409 VERSION_CONFLICT with the server revision for a stale If-Match', async () => {
    const created = (await create()).json() as AgentRecord;
    await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { name: 'First' },
    });
    const res = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      headers: { 'if-match': '"1"' },
      payload: { name: 'Second' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' }, serverRevision: 2 });
  });

  it.each(['"abc"', '"0"', '"-1"', '"1.5"', 'W/"1"', '"2147483648"', '"99999999999999999999"'])(
    'rejects the If-Match value %s',
    async (header) => {
      const created = (await create()).json() as AgentRecord;
      const res = await server.inject({
        method: 'PUT',
        url: `/api/agents/${created.id}`,
        headers: { 'if-match': header },
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(fake.calls.filter((c) => c.method === 'update')).toEqual([]);
    },
  );

  it('rejects an update with nothing in it, and one with a bad field', async () => {
    const created = (await create()).json() as AgentRecord;
    const empty = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const bad = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe('enabled');
  });

  it('validates a definition sent in an update the same way as on create', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { definition: { ...definition, model: 'gpt-x' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toMatchObject({ path: 'definition.model', code: 'UNKNOWN_MODEL' });
  });

  it('publishes the draft and lists the version', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'POST',
      url: `/api/agents/${created.id}/publish`,
      headers: { 'if-match': '"1"' },
      payload: { note: 'first cut' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.json()).toMatchObject({
      agent: { publishedVersion: 1, revision: 2 },
      version: { version: 1, note: 'first cut' },
    });
    const versions = await server.inject({
      method: 'GET',
      url: `/api/agents/${created.id}/versions`,
    });
    expect(versions.json().items).toHaveLength(1);
  });

  it('refuses to publish a draft whose model the instance no longer offers', async () => {
    const created = (await create()).json() as AgentRecord;
    fake.agents.set(created.id, {
      ...created,
      draftDefinition: { ...created.draftDefinition, model: 'retired-model' },
    });
    const res = await server.inject({
      method: 'POST',
      url: `/api/agents/${created.id}/publish`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toMatchObject({ path: 'definition.model', code: 'UNKNOWN_MODEL' });
    expect(fake.calls.filter((c) => c.method === 'publish')).toEqual([]);
  });

  it('archives with 204, then 404s further writes', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/agents/${created.id}`,
      headers: { 'if-match': '"1"' },
    });
    expect(res.statusCode).toBe(204);
    const again = await server.inject({ method: 'DELETE', url: `/api/agents/${created.id}` });
    expect(again.statusCode).toBe(404);
  });

  it('answers 409 BUILTIN_PROTECTED when archiving a built-in agent', async () => {
    const created = (await create()).json() as AgentRecord;
    fake.agents.set(created.id, { ...created, builtin: true });
    const res = await server.inject({ method: 'DELETE', url: `/api/agents/${created.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUILTIN_PROTECTED');
  });

  it('turns a store failure into 503 without leaking the driver message', async () => {
    fake.failWith = new Error('connect ECONNREFUSED 10.20.30.40:5432');
    for (const [method, url, payload] of [
      ['GET', '/api/agents', undefined],
      ['POST', '/api/agents', { slug: 'owners', name: 'Owners', definition }],
      ['GET', '/api/agents/00000000-0000-4000-8000-000000000001', undefined],
    ] as const) {
      const res = await server.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error.code).toBe('AI_UNAVAILABLE');
      expect(res.body).not.toContain('10.20.30.40');
    }
  });
});

// --- Capability gating with auth ENABLED (principals from bearer tokens).
function buildAuthConfig(): Config {
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

describe('agents routes — capability gating (auth enabled)', () => {
  let server: FastifyInstance;
  let fake: FakeAgentStore;

  const SCOPES: Record<string, string[]> = {
    reader: ['agents:read'],
    author: ['agents:read', 'agents:write', 'graph:read'],
    'graph-author': ['agents:read', 'agents:write', 'graph:read', 'graph:write'],
  };
  const tokenService = {
    validate: async (plaintext: string) =>
      SCOPES[plaintext]
        ? { id: plaintext, ownerEmail: `${plaintext}@example.com`, scopes: SCOPES[plaintext] }
        : null,
  } as unknown as TokenService;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    fake = new FakeAgentStore();
    server = await createServer({
      config: buildAuthConfig(),
      redis: new RedisMock() as unknown as Redis,
      resolved: makeTestResolved(),
      oidcProvider: stubOidc,
      tokenService,
      agentStore: asStore(fake),
      aiStatus: statusOf(READY),
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });
  beforeEach(() => {
    fake.agents.clear();
    fake.calls = [];
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, def: unknown) =>
    server.inject({
      method: 'POST',
      url: '/api/agents',
      headers: as(token),
      payload: { slug: 'owners', name: 'Owners', definition: def },
    });

  it('401s an unauthenticated request before any gate', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
  });

  it('lets agents:read list but not create, edit, publish or archive', async () => {
    expect(
      (await server.inject({ method: 'GET', url: '/api/agents', headers: as('reader') }))
        .statusCode,
    ).toBe(200);
    for (const [method, url] of [
      ['POST', '/api/agents'],
      ['PUT', '/api/agents/x'],
      ['POST', '/api/agents/x/publish'],
      ['DELETE', '/api/agents/x'],
    ] as const) {
      const res = await server.inject({ method, url, headers: as('reader'), payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('lets an author create an agent whose grants they hold', async () => {
    const res = await post('author', {
      ...definition,
      grants: { services: { graph: { read: 'allow' } } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().createdBy).toBe('author@example.com');
  });

  it('refuses a grant the author does not hold, naming the capability', async () => {
    const res = await post('author', {
      ...definition,
      grants: { services: { graph: { read: 'allow', write: 'ask' } } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('GRANT_EXCEEDS_CAPABILITY');
    expect(res.json().issues).toEqual([
      expect.objectContaining({ path: 'definition.grants.services.graph.write' }),
    ]);
    expect(fake.calls.filter((c) => c.method === 'create')).toEqual([]);
  });

  it('accepts the same grant from an author who holds graph:write', async () => {
    const res = await post('graph-author', {
      ...definition,
      grants: { services: { graph: { read: 'allow', write: 'ask' } } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('treats any non-graph service, and any tool-level grant, as admin-only', async () => {
    const service = await post('graph-author', {
      ...definition,
      grants: { services: { github: { read: 'allow' } } },
    });
    const tool = await post('graph-author', {
      ...definition,
      grants: { tools: { 'github.open_pull_request': 'ask' } },
    });
    expect(service.statusCode).toBe(403);
    expect(tool.statusCode).toBe(403);
  });
});
