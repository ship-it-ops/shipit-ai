import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { AgentStore } from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { makeTestConfig } from '../../test-config.js';
import { GRAPH_ASSISTANT_SLUG, ensureBuiltinAgents } from '../../../services/ai/builtin-agents.js';

describe.skipIf(!DATABASE_TEST_URL)('ensureBuiltinAgents', () => {
  let database: TestDatabase;
  let store: AgentStore;
  const ai = makeTestConfig().ai;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = new AgentStore(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.query('DELETE FROM agent_versions');
    await database.db.query('DELETE FROM agents');
  });

  it('creates and publishes the Graph assistant when it is missing', async () => {
    const log = vi.fn();
    await ensureBuiltinAgents(store, { ...ai, defaultModel: 'gemini' }, log);
    const agent = await store.getBySlug(GRAPH_ASSISTANT_SLUG);
    expect(agent).toMatchObject({
      name: 'Graph assistant',
      builtin: true,
      enabled: true,
      publishedVersion: 1,
      createdBy: 'system',
    });
    const version = await store.getVersion(agent!.id, 1);
    expect(version!.definition).toMatchObject({
      model: 'gemini',
      grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
    });
    expect(version!.definition.instructions).toMatch(/knowledge graph/);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Created the built-in Graph assistant'),
    );
  });

  it('leaves an existing assistant alone, edits included', async () => {
    await ensureBuiltinAgents(store, ai, () => {});
    const agent = (await store.getBySlug(GRAPH_ASSISTANT_SLUG))!;
    await store.update(agent.id, undefined, { name: 'Our graph helper' }, 'admin@example.com');
    await ensureBuiltinAgents(store, ai, () => {});
    expect(await store.getBySlug(GRAPH_ASSISTANT_SLUG)).toMatchObject({
      name: 'Our graph helper',
      publishedVersion: 1,
    });
    expect(await store.listVersions(agent.id)).toHaveLength(1);
  });

  it('publishes an assistant that an interrupted boot created but never published', async () => {
    await store.create({
      slug: GRAPH_ASSISTANT_SLUG,
      name: 'Graph assistant',
      builtin: true,
      definition: {
        instructions: 'x',
        model: 'gemini',
        limits: { maxSteps: 5, maxTokens: 10_000, timeoutSeconds: 60, dailyTokens: 100_000 },
        grants: { services: {}, tools: {} },
        output: { schema: null },
      },
      actor: 'system',
    });
    await ensureBuiltinAgents(store, ai, () => {});
    expect((await store.getBySlug(GRAPH_ASSISTANT_SLUG))!.publishedVersion).toBe(1);
  });

  it('uses the first catalog model when no default is set, within the instance ceilings', async () => {
    await ensureBuiltinAgents(
      store,
      { ...ai, defaultModel: '', limits: { ...ai.limits, maxSteps: 5, maxTokens: 50_000 } },
      () => {},
    );
    const agent = (await store.getBySlug(GRAPH_ASSISTANT_SLUG))!;
    expect(agent.draftDefinition.model).toBe(ai.models[0]!.key);
    expect(agent.draftDefinition.limits).toMatchObject({ maxSteps: 5, maxTokens: 50_000 });
  });

  it('waits, saying why, when the instance offers no model', async () => {
    const log = vi.fn();
    expect(await ensureBuiltinAgents(store, { ...ai, models: [], defaultModel: '' }, log)).toBe(
      false,
    );
    expect(await store.getBySlug(GRAPH_ASSISTANT_SLUG)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no model'));
  });

  it('tolerates another api-server creating it at the same moment', async () => {
    const results = await Promise.all([
      ensureBuiltinAgents(store, ai, () => {}),
      ensureBuiltinAgents(store, ai, () => {}),
    ]);
    expect(results).toEqual([true, true]);
    expect((await store.list({})).total).toBe(1);
  });
});
