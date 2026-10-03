import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentStore,
  AgentVersionConflictError,
} from '../agent-store.js';
import type { AgentDefinition } from '../definition.js';
import { runMigrations } from '../migrate.js';
import {
  createTestDatabase,
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  type TestDatabase,
} from './test-db.js';

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'claude-opus',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

describe.skipIf(!DATABASE_TEST_URL)('AgentStore — Postgres integration', () => {
  let database: TestDatabase;
  let store: AgentStore;

  beforeAll(async () => {
    database = await createTestDatabase();
    await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    store = new AgentStore(database.db);
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.query('DELETE FROM agents');
  });

  const make = (slug: string, extra: Partial<Parameters<AgentStore['create']>[0]> = {}) =>
    store.create({ slug, name: `Agent ${slug}`, definition, actor: 'admin@example.com', ...extra });

  it('creates an agent at revision 1 and reads it back unchanged', async () => {
    const created = await make('owners');
    expect(created).toMatchObject({
      slug: 'owners',
      name: 'Agent owners',
      description: '',
      ownerTeamId: null,
      enabled: true,
      builtin: false,
      draftDefinition: definition,
      publishedVersion: null,
      revision: 1,
      createdBy: 'admin@example.com',
      updatedBy: 'admin@example.com',
      archivedAt: null,
    });
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(await store.get(created.id)).toEqual(created);
    expect(await store.getBySlug('owners')).toEqual(created);
  });

  it('returns null, not an error, for an id that is not a UUID or does not exist', async () => {
    expect(await store.get('not-a-uuid')).toBeNull();
    expect(await store.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('refuses a second live agent with the same slug', async () => {
    await make('owners');
    await expect(make('owners')).rejects.toBeInstanceOf(AgentSlugTakenError);
  });

  it('frees the slug when the agent is archived', async () => {
    const first = await make('owners');
    await store.archive(first.id, first.revision, 'admin@example.com');
    const second = await make('owners');
    expect(second.id).not.toBe(first.id);
    expect(await store.getBySlug('owners')).toMatchObject({ id: second.id });
  });

  it('updates only the fields in the patch and bumps the revision', async () => {
    const created = await make('owners', { ownerTeamId: 'team:platform' });
    const updated = await store.update(
      created.id,
      created.revision,
      { name: 'Ownership helper', ownerTeamId: null, enabled: false },
      'other@example.com',
    );
    expect(updated).toMatchObject({
      name: 'Ownership helper',
      description: '',
      ownerTeamId: null,
      enabled: false,
      draftDefinition: definition,
      revision: 2,
      createdBy: 'admin@example.com',
      updatedBy: 'other@example.com',
    });
  });

  it('rejects a stale revision and leaves the row untouched', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'First writer' }, 'a@example.com');

    const stale = store.update(created.id, 1, { name: 'Second writer' }, 'b@example.com');
    await expect(stale).rejects.toBeInstanceOf(AgentVersionConflictError);
    await expect(stale).rejects.toMatchObject({ serverRevision: 2 });
    expect(await store.get(created.id)).toMatchObject({ name: 'First writer', revision: 2 });
  });

  it('lets exactly one of two writers holding the same revision win', async () => {
    const created = await make('owners');
    const results = await Promise.allSettled([
      store.update(created.id, 1, { name: 'A' }, 'a@example.com'),
      store.update(created.id, 1, { name: 'B' }, 'b@example.com'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await store.get(created.id))!.revision).toBe(2);
  });

  it('forces the write when no revision is given', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'First' }, 'a@example.com');
    const forced = await store.update(created.id, undefined, { name: 'Forced' }, 'b@example.com');
    expect(forced).toMatchObject({ name: 'Forced', revision: 3 });
  });

  it('publishes the draft as immutable, numbered versions', async () => {
    const created = await make('owners');
    const first = await store.publish(created.id, 1, 'first cut', 'admin@example.com');
    expect(first.version).toMatchObject({ version: 1, definition, note: 'first cut' });
    expect(first.agent).toMatchObject({ publishedVersion: 1, revision: 2 });

    const edited: AgentDefinition = { ...definition, instructions: 'Changed.' };
    const afterEdit = await store.update(
      created.id,
      2,
      { definition: edited },
      'admin@example.com',
    );
    const second = await store.publish(created.id, afterEdit.revision, '', 'admin@example.com');
    expect(second.version).toMatchObject({ version: 2, definition: edited });

    expect((await store.getVersion(created.id, 1))!.definition).toEqual(definition);
    expect((await store.listVersions(created.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('does not create a version when publish is given a stale revision', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'Moved on' }, 'a@example.com');
    await expect(store.publish(created.id, 1, '', 'b@example.com')).rejects.toBeInstanceOf(
      AgentVersionConflictError,
    );
    expect(await store.listVersions(created.id)).toEqual([]);
    expect((await store.get(created.id))!.publishedVersion).toBeNull();
  });

  it('hides archived agents from the default list and refuses further edits', async () => {
    const keep = await make('keep');
    const gone = await make('gone');
    await store.archive(gone.id, undefined, 'admin@example.com');

    const live = await store.list();
    expect(live.total).toBe(1);
    expect(live.items.map((a) => a.id)).toEqual([keep.id]);

    const all = await store.list({ includeArchived: true });
    expect(all.total).toBe(2);
    expect((await store.get(gone.id))!.archivedAt).not.toBeNull();
    expect((await store.get(gone.id))!.enabled).toBe(false);

    await expect(store.update(gone.id, undefined, { name: 'x' }, 'a')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    await expect(store.archive(gone.id, undefined, 'a')).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(store.publish(gone.id, undefined, '', 'a')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it('never archives a built-in agent', async () => {
    const builtin = await make('graph-assistant', { builtin: true });
    await expect(store.archive(builtin.id, undefined, 'admin@example.com')).rejects.toBeInstanceOf(
      AgentBuiltinProtectedError,
    );
    expect((await store.get(builtin.id))!.archivedAt).toBeNull();
  });

  it('rejects a stale revision on archive', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'x' }, 'a@example.com');
    await expect(store.archive(created.id, 1, 'b@example.com')).rejects.toBeInstanceOf(
      AgentVersionConflictError,
    );
  });

  it('pages the list and reports the full total', async () => {
    for (const slug of ['a1', 'a2', 'a3']) await make(slug);
    const page = await store.list({ limit: 2, offset: 0 });
    const rest = await store.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(rest.items).toHaveLength(1);
    const slugs = [...page.items, ...rest.items].map((a) => a.slug).sort();
    expect(slugs).toEqual(['a1', 'a2', 'a3']);
  });

  it('clamps a silly page size instead of failing', async () => {
    await make('a1');
    expect((await store.list({ limit: 0, offset: -5 })).items).toHaveLength(1);
    expect((await store.list({ limit: 10_000 })).items).toHaveLength(1);
  });

  it('removes versions with the agent row (foreign key cascade)', async () => {
    const created = await make('owners');
    await store.publish(created.id, 1, '', 'admin@example.com');
    await database.db.query('DELETE FROM agents WHERE id = $1', [created.id]);
    expect(await store.listVersions(created.id)).toEqual([]);
  });

  it('lets the database refuse a slug the API should have caught', async () => {
    await expect(make('Not A Slug')).rejects.toThrow(/agents_slug_format/);
  });
});
