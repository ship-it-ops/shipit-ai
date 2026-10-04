import { describe, it, expect } from 'vitest';
import type { ChangeBatch, SelectedContainer } from '@shipit-ai/connector-sdk';
import { connectorInstanceSchema, type GitHubConnectorConfig } from '@shipit-ai/shared';
import {
  GitHubKnowledgeConnector,
  NOTE_ISSUES_PERMISSION,
  NOTE_RATE_LIMITED,
  type GitHubKnowledgeClient,
} from '../connector.js';

const knowledge = (
  connectorInstanceSchema.parse({
    id: 'gh-1',
    type: 'github',
    name: 'acme',
    installationId: '1',
    org: 'acme',
    knowledge: { enabled: true },
  }) as GitHubConnectorConfig
).knowledge;

interface Ref {
  number: number;
  updatedAt: string;
}

interface World {
  prs: Ref[];
  issues: Ref[];
  /** Tree oid of the default branch head; null for an empty repository. */
  head: string | null;
  tree: Array<{ path: string; sha: string; size: number }>;
  blobs: Record<string, string>;
  issuesGranted: boolean;
  /** GitHub cut the tree listing short. */
  truncated?: boolean;
  /** Extra repositories after the three named ones, to make a second page. */
  extraRepos?: number;
}

function world(overrides: Partial<World> = {}): World {
  return {
    prs: [
      { number: 1, updatedAt: '2026-01-01T00:00:00Z' },
      { number: 2, updatedAt: '2026-01-02T00:00:00Z' },
      { number: 3, updatedAt: '2026-01-03T00:00:00Z' },
    ],
    issues: [{ number: 10, updatedAt: '2026-01-05T00:00:00Z' }],
    head: 'tree-1',
    tree: [{ path: 'README.md', sha: 'blob-1', size: 20 }],
    blobs: { 'blob-1': '# Payments\nhello' },
    issuesGranted: true,
    ...overrides,
  };
}

function full(ref: Ref, field: 'pullRequest' | 'issue') {
  const base = {
    number: ref.number,
    title: `${field} ${ref.number}`,
    body: `body of ${ref.number}`,
    url: `https://github.com/acme/payments/${field === 'issue' ? 'issues' : 'pull'}/${ref.number}`,
    state: 'OPEN',
    createdAt: ref.updatedAt,
    updatedAt: ref.updatedAt,
    author: { login: 'ada', databaseId: 7 },
    labels: { nodes: [] },
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  };
  return field === 'issue'
    ? base
    : {
        ...base,
        merged: false,
        isDraft: false,
        baseRefName: 'main',
        headRefName: 'x',
        reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
      };
}

function clientFor(w: World, graphqlOverride?: GitHubKnowledgeClient['graphql']) {
  const calls = {
    graphql: [] as string[],
    blobs: [] as string[],
    trees: 0,
    repoPages: [] as number[],
  };
  const client: GitHubKnowledgeClient = {
    issuesGranted: w.issuesGranted,
    graphql:
      graphqlOverride ??
      (async (query) => {
        calls.graphql.push(query);
        if (query.includes('defaultBranchRef')) {
          return {
            repository: {
              defaultBranchRef: w.head
                ? {
                    name: 'main',
                    target: {
                      oid: 'c1',
                      committedDate: '2026-02-01T00:00:00Z',
                      tree: { oid: w.head },
                    },
                  }
                : null,
            },
          };
        }
        const listing = /items: (pullRequests|issues)\(/.exec(query);
        if (listing) {
          const items = listing[1] === 'pullRequests' ? w.prs : w.issues;
          const nodes = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          return {
            repository: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
          };
        }
        const repository: Record<string, unknown> = {};
        for (const [, n, field] of query.matchAll(/n(\d+): (pullRequest|issue)\(/g)) {
          const source = field === 'pullRequest' ? w.prs : w.issues;
          const ref = source.find((r) => r.number === Number(n));
          repository[`n${n}`] = ref ? full(ref, field as 'pullRequest' | 'issue') : null;
        }
        return { repository };
      }),
    git: {
      async getTree() {
        calls.trees += 1;
        return {
          data: {
            truncated: w.truncated === true,
            tree: w.tree.map((e) => ({ ...e, type: 'blob' })),
          },
        };
      },
      async getBlob({ file_sha }) {
        calls.blobs.push(file_sha);
        return {
          data: {
            content: Buffer.from(w.blobs[file_sha] ?? '').toString('base64'),
            encoding: 'base64',
          },
        };
      },
    },
    async listRepositoriesPage(_org, page) {
      calls.repoPages.push(page);
      const named = [
        {
          id: 42,
          fullName: 'acme/payments',
          htmlUrl: 'https://github.com/acme/payments',
          visibility: 'private',
          archived: false,
        },
        {
          id: 43,
          fullName: 'acme/site',
          htmlUrl: 'https://github.com/acme/site',
          visibility: 'public',
          archived: true,
        },
        {
          id: 44,
          fullName: 'acme/tools',
          htmlUrl: 'https://github.com/acme/tools',
          visibility: 'internal',
          archived: false,
        },
      ];
      const extra = Array.from({ length: w.extraRepos ?? 0 }, (_, i) => ({
        id: 1000 + i,
        fullName: `acme/extra-${i}`,
        htmlUrl: `https://github.com/acme/extra-${i}`,
        visibility: 'public',
        archived: false,
      }));
      return [...named, ...extra].slice((page - 1) * 100, page * 100);
    },
    async listMembersPage(_org, page) {
      return page === 1 ? [{ id: 7, login: 'ada' }] : [];
    },
  };
  return { client, calls };
}

const sdkConfig = { id: 'gh-1', type: 'github', credentials: {}, scope: { org: 'acme' } };
const container: SelectedContainer = {
  externalId: '42',
  kind: 'repository',
  name: 'acme/payments',
  visibility: 'restricted',
  archived: false,
  checkpoint: null,
};

async function connected(
  w: World,
  options: Partial<ConstructorParameters<typeof GitHubKnowledgeConnector>[0]> = {},
  graphqlOverride?: GitHubKnowledgeClient['graphql'],
) {
  const { client, calls } = clientFor(w, graphqlOverride);
  const connector = new GitHubKnowledgeConnector({
    knowledge,
    maxDocumentChars: 400_000,
    batchSize: 2,
    now: () => Date.parse('2026-03-01T00:00:00Z'),
    connect: async () => ({ ok: true, client }),
    ...options,
  });
  expect(await connector.authenticate(sdkConfig)).toEqual({ success: true });
  return { connector, calls };
}

async function collect(
  connector: GitHubKnowledgeConnector,
  checkpoint: string | null = null,
  options: { historyDays?: number; deadline?: number } = {},
): Promise<ChangeBatch[]> {
  const batches: ChangeBatch[] = [];
  for await (const b of connector.fetchChanges(container, checkpoint, {
    historyDays: 0,
    ...options,
  })) {
    batches.push(b);
  }
  return batches;
}

const ids = (batches: ChangeBatch[]) =>
  batches.flatMap((b) => b.documents.map((d) => d.externalId));

/** The batches a run yields before it throws, and what it threw. */
async function collectUntilError(
  connector: GitHubKnowledgeConnector,
  checkpoint: string | null = null,
  options: { historyDays?: number; deadline?: number } = {},
): Promise<{ batches: ChangeBatch[]; error: unknown }> {
  const batches: ChangeBatch[] = [];
  try {
    for await (const b of connector.fetchChanges(container, checkpoint, {
      historyDays: 0,
      ...options,
    })) {
      batches.push(b);
    }
  } catch (error) {
    return { batches, error };
  }
  return { batches, error: null };
}

// The two shapes Octokit throws for a rate limit (see rate-limit.test.ts).
const restLimited = () =>
  Object.assign(new Error('secondary rate limit'), {
    status: 403,
    response: { headers: { 'retry-after': '600' } },
  });
const graphqlLimited = () =>
  Object.assign(new Error('API rate limit exceeded for installation ID 1.'), {
    name: 'GraphqlResponseError',
    errors: [{ type: 'RATE_LIMITED' }],
    // Resets at 2026-03-01T01:00:00Z, an hour after the tests' `now`.
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1772326800' },
    data: { repository: null },
  });
const SOON = Date.parse('2026-03-01T00:01:00Z'); // one minute after the tests' `now`

describe('GitHubKnowledgeConnector', () => {
  it('reports a failed connection as a failed authentication', async () => {
    const connector = new GitHubKnowledgeConnector({
      knowledge,
      maxDocumentChars: 1000,
      connect: async () => ({ ok: false, error: 'GitHub App auth failed: bad key' }),
    });
    expect(await connector.authenticate(sdkConfig)).toEqual({
      success: false,
      error: 'GitHub App auth failed: bad key',
    });
  });

  it('lists repositories as containers: private is restricted, public and internal are open', async () => {
    const { connector } = await connected(world());
    const out = [];
    for await (const c of connector.listContainers()) out.push(c);
    expect(out).toEqual([
      {
        externalId: '42',
        kind: 'repository',
        name: 'acme/payments',
        url: 'https://github.com/acme/payments',
        visibility: 'restricted',
        archived: false,
      },
      {
        externalId: '43',
        kind: 'repository',
        name: 'acme/site',
        url: 'https://github.com/acme/site',
        visibility: 'open',
        archived: true,
      },
      {
        externalId: '44',
        kind: 'repository',
        name: 'acme/tools',
        url: 'https://github.com/acme/tools',
        visibility: 'open',
        archived: false,
      },
    ]);
  });

  it('lists organisation members as principals keyed by their numeric id', async () => {
    const { connector } = await connected(world());
    const out = [];
    for await (const p of connector.listPrincipals()) out.push(p);
    expect(out).toEqual([
      { externalId: '7', kind: 'user', displayName: 'ada', login: 'ada', active: true },
    ]);
  });

  it('backfills pull requests oldest first, then issues, then docs, moving the checkpoint each batch', async () => {
    const { connector } = await connected(world());
    const batches = await collect(connector);
    expect(ids(batches)).toEqual([
      'pr:42:1',
      'pr:42:2',
      'pr:42:3',
      'issue:42:10',
      'doc:42:README.md',
    ]);
    const checkpoints = batches.map((b) => JSON.parse(b.checkpoint!) as Record<string, unknown>);
    expect(checkpoints[0]).toMatchObject({ pr: '2026-01-02T00:00:00Z', issue: null, tree: null });
    expect(checkpoints[1]).toMatchObject({ pr: '2026-01-03T00:00:00Z' });
    expect(checkpoints.at(-1)).toMatchObject({
      pr: '2026-01-03T00:00:00Z',
      issue: '2026-01-05T00:00:00Z',
      tree: 'tree-1',
      docs: { 'README.md': 'blob-1' },
    });
  });

  it("a second run from the first batch's checkpoint fetches the rest", async () => {
    const { connector } = await connected(world());
    const [first] = await collect(connector);
    const rest = await collect(connector, first!.checkpoint);
    // PR 2 is the checkpoint itself and comes again (harmless: same content); 3 was never reached.
    expect(ids(rest).filter((id) => id.startsWith('pr:'))).toEqual(['pr:42:2', 'pr:42:3']);
  });

  it('fetches nothing new on a run with nothing new, except the item at the checkpoint', async () => {
    const { connector, calls } = await connected(world());
    const done = (await collect(connector)).at(-1)!.checkpoint;
    calls.blobs.length = 0;
    const again = await collect(connector, done);
    expect(ids(again)).toEqual(['pr:42:3', 'issue:42:10']);
    expect(calls.blobs).toEqual([]);
  });

  it('respects the history horizon', async () => {
    const { connector } = await connected(world());
    // now is 2026-03-01; 58 days back is 2026-01-02: PR 1 is older.
    const batches = await collect(connector, null, { historyDays: 58 });
    expect(ids(batches).filter((id) => id.startsWith('pr:'))).toEqual(['pr:42:2', 'pr:42:3']);
  });

  it('syncs pull requests and docs and notes the missing issues permission', async () => {
    const { connector, calls } = await connected(world({ issuesGranted: false }));
    const batches = await collect(connector);
    expect(ids(batches)).toEqual(['pr:42:1', 'pr:42:2', 'pr:42:3', 'doc:42:README.md']);
    expect(batches.flatMap((b) => b.notes ?? [])).toEqual([NOTE_ISSUES_PERMISSION]);
    expect(calls.graphql.some((q) => q.includes('items: issues('))).toBe(false);
  });

  it('notes the missing permission when GitHub refuses the issues listing although the installation claimed it', async () => {
    const w = world();
    const answer = clientFor(w).client.graphql;
    const { connector } = await connected(w, {}, async (query, variables, signal) => {
      if (query.includes('items: issues(')) {
        // What octokit.graphql throws for a connection the installation may not read.
        throw Object.assign(new Error('Resource not accessible by integration'), {
          errors: [{ type: 'FORBIDDEN', path: ['repository', 'items'] }],
          data: { repository: { items: null } },
        });
      }
      return answer(query, variables, signal);
    });
    const batches = await collect(connector);
    expect(ids(batches)).toEqual(['pr:42:1', 'pr:42:2', 'pr:42:3', 'doc:42:README.md']);
    expect(batches.flatMap((b) => b.notes ?? [])).toEqual([NOTE_ISSUES_PERMISSION]);
    // And nothing is pruned by an issue listing this connector cannot make.
    expect(connector.prunableKinds).toEqual([]);
  });

  it('covers no kind while issues cannot be listed', async () => {
    expect((await connected(world({ issuesGranted: false }))).connector.prunableKinds).toEqual([]);
    expect((await connected(world())).connector.prunableKinds).toEqual(['github_issue']);
    const off = await connected(world(), { knowledge: { ...knowledge, issues: false } });
    expect(off.connector.prunableKinds).toEqual([]);
  });

  it('lists every issue id for the prune', async () => {
    const { connector } = await connected(world());
    const pages: string[][] = [];
    for await (const p of connector.listDocumentIds(container)) pages.push(p);
    expect(pages).toEqual([['issue:42:10']]);
  });

  it('skips the docs when the tree did not change', async () => {
    const { connector, calls } = await connected(world());
    const done = (await collect(connector)).at(-1)!.checkpoint;
    calls.trees = 0;
    await collect(connector, done);
    expect(calls.trees).toBe(0);
  });

  it('fetches only the blob that changed and deletes a doc that left the tree', async () => {
    const w = world({
      tree: [
        { path: 'README.md', sha: 'blob-1', size: 20 },
        { path: 'docs/old.md', sha: 'blob-2', size: 20 },
      ],
      blobs: { 'blob-1': '# Payments\nhello', 'blob-2': '# Old\nbye', 'blob-3': '# New\nhi' },
    });
    const { connector, calls } = await connected(w);
    const done = (await collect(connector)).at(-1)!.checkpoint;

    w.head = 'tree-2';
    w.tree = [
      { path: 'README.md', sha: 'blob-1', size: 20 },
      { path: 'docs/new.md', sha: 'blob-3', size: 20 },
    ];
    calls.blobs.length = 0;
    const batches = await collect(connector, done);

    expect(calls.blobs).toEqual(['blob-3']);
    expect(batches.flatMap((b) => b.deletedExternalIds)).toEqual(['doc:42:docs/old.md']);
    expect(ids(batches)).toContain('doc:42:docs/new.md');
    expect(JSON.parse(batches.at(-1)!.checkpoint!)).toMatchObject({
      tree: 'tree-2',
      docs: { 'README.md': 'blob-1', 'docs/new.md': 'blob-3' },
    });
  });

  it('handles an empty repository', async () => {
    const { connector } = await connected(world({ prs: [], issues: [], head: null, tree: [] }));
    expect(await collect(connector)).toEqual([]);
  });

  it('leaves out what is switched off', async () => {
    const { connector, calls } = await connected(world(), {
      knowledge: { ...knowledge, pullRequests: false, docs: { ...knowledge.docs, enabled: false } },
    });
    expect(ids(await collect(connector))).toEqual(['issue:42:10']);
    expect(calls.graphql.some((q) => q.includes('items: pullRequests('))).toBe(false);
    expect(calls.trees).toBe(0);
  });

  it('cuts a document over the size limit and flags it', async () => {
    const { connector } = await connected(world({ issues: [], head: null }), {
      maxDocumentChars: 5,
    });
    const [batch] = await collect(connector);
    expect(batch!.documents[0]!.attributes.truncated).toBe(true);
    expect(batch!.documents[0]!.segments[0]!.text).toHaveLength(5);
  });

  it('ends the run through the SDK signal when GitHub asks to wait past the deadline', async () => {
    const { connector } = await connected(world(), {}, async () => {
      throw restLimited();
    });
    const { batches, error } = await collectUntilError(connector, null, { deadline: SOON });
    expect(batches).toEqual([]);
    expect(error).toMatchObject({ code: 'KNOWLEDGE_RUN_CUT_SHORT', note: NOTE_RATE_LIMITED });
  });

  it('recognises a spent GraphQL budget, which is not an HTTP error', async () => {
    let calls = 0;
    const { connector } = await connected(world(), {}, async () => {
      calls += 1;
      throw graphqlLimited();
    });
    const { error } = await collectUntilError(connector, null, { deadline: SOON });
    expect(error).toMatchObject({ code: 'KNOWLEDGE_RUN_CUT_SHORT', note: NOTE_RATE_LIMITED });
    expect(calls).toBe(1);
    // The next repository of the same run does not spend a call to learn it again.
    const next = await collectUntilError(connector, null, { deadline: SOON });
    expect(next.error).toMatchObject({ code: 'KNOWLEDGE_RUN_CUT_SHORT' });
    expect(calls).toBe(1);
  });

  it('does not lose a pending note when the run is cut short', async () => {
    const w = world({ prs: [], issuesGranted: false });
    const answer = clientFor(w).client.graphql;
    const { connector } = await connected(w, {}, async (query, variables, signal) => {
      if (query.includes('defaultBranchRef')) throw restLimited();
      return answer(query, variables, signal);
    });
    const { batches, error } = await collectUntilError(connector, null, { deadline: SOON });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ documents: [], notes: [NOTE_ISSUES_PERMISSION] });
    expect(error).toMatchObject({ code: 'KNOWLEDGE_RUN_CUT_SHORT' });
  });

  it('ends the run, and does not look like an auth failure, when listing repositories is rate limited', async () => {
    const { client } = clientFor(world());
    client.listRepositoriesPage = async () => {
      throw restLimited();
    };
    const connector = new GitHubKnowledgeConnector({
      knowledge,
      maxDocumentChars: 1000,
      now: () => Date.parse('2026-03-01T00:00:00Z'),
      connect: async () => ({ ok: true, client }),
    });
    await connector.authenticate(sdkConfig);
    const drain = async (): Promise<void> => {
      for await (const c of connector.listContainers({ deadline: SOON })) void c;
    };
    await expect(drain()).rejects.toMatchObject({ code: 'KNOWLEDGE_RUN_CUT_SHORT' });
    // The harness reads a `status` of 403 as an authentication failure.
    await expect(drain()).rejects.not.toHaveProperty('status');
  });

  it('pages through every repository', async () => {
    const { connector, calls } = await connected(world({ extraRepos: 98 })); // 101 in all
    const names: string[] = [];
    for await (const c of connector.listContainers()) names.push(c.name);
    expect(names).toHaveLength(101);
    expect(names.at(-1)).toBe('acme/extra-97');
    expect(calls.repoPages).toEqual([1, 2]);
  });

  it('a failing pull-request fetch does not keep issues and docs from syncing', async () => {
    const w = world();
    const answer = clientFor(w).client.graphql;
    const { connector } = await connected(w, {}, async (query, variables, signal) => {
      if (query.includes('items: pullRequests(')) throw new Error('boom');
      return answer(query, variables, signal);
    });
    const { batches, error } = await collectUntilError(connector);
    expect(ids(batches)).toEqual(['issue:42:10', 'doc:42:README.md']);
    expect(JSON.parse(batches.at(-1)!.checkpoint!)).toMatchObject({
      pr: null,
      issue: '2026-01-05T00:00:00Z',
      tree: 'tree-1',
    });
    // The repository is still reported as failed, with the first error.
    expect((error as Error).message).toBe('boom');
  });

  it('sends the people a batch refers to along with it', async () => {
    const { connector } = await connected(world());
    const [first] = await collect(connector);
    expect(first!.principals).toEqual([
      { externalId: '7', kind: 'user', displayName: 'ada', login: 'ada', active: true },
    ]);
  });

  describe('docs', () => {
    const docsOnly = (paths: string[]) => ({
      knowledge: {
        ...knowledge,
        pullRequests: false,
        issues: false,
        docs: { ...knowledge.docs, paths },
      },
    });
    const ALL = ['README.md', 'docs/**/*.md'];
    const threeDocs = () =>
      world({
        tree: [
          { path: 'README.md', sha: 'blob-r', size: 20 },
          { path: 'docs/a.md', sha: 'blob-a', size: 20 },
          { path: 'docs/b.md', sha: 'blob-b', size: 20 },
        ],
        blobs: { 'blob-r': '# R\nr', 'blob-a': '# A\na', 'blob-b': '# B\nb' },
      });
    const state = (b: ChangeBatch) =>
      JSON.parse(b.checkpoint!) as { tree: string | null; docs: Record<string, string> };

    it('records the tree only with the last batch, so a restart fetches what is still missing', async () => {
      const { connector, calls } = await connected(threeDocs(), docsOnly(ALL));
      const batches = await collect(connector); // batch size 2: two batches
      expect(batches.map((b) => b.documents.map((d) => d.externalId))).toEqual([
        ['doc:42:README.md', 'doc:42:docs/a.md'],
        ['doc:42:docs/b.md'],
      ]);
      expect(state(batches[0]!).tree).toBeNull();
      expect(state(batches[1]!).tree).toBe('tree-1');

      // The run was cut after its first batch: the next one lists again and fetches only b.
      calls.blobs.length = 0;
      const resumed = await collect(connector, batches[0]!.checkpoint);
      expect(calls.blobs).toEqual(['blob-b']);
      expect(ids(resumed)).toEqual(['doc:42:docs/b.md']);
    });

    it('deletes a doc that left the tree even when no file changed', async () => {
      const w = threeDocs();
      const { connector, calls } = await connected(w, docsOnly(ALL));
      const done = (await collect(connector)).at(-1)!.checkpoint;
      w.head = 'tree-2';
      w.tree = w.tree.filter((e) => e.path !== 'docs/b.md');
      calls.blobs.length = 0;

      const batches = await collect(connector, done);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ documents: [], deletedExternalIds: ['doc:42:docs/b.md'] });
      expect(state(batches[0]!)).toMatchObject({
        tree: 'tree-2',
        docs: { 'README.md': 'blob-r', 'docs/a.md': 'blob-a' },
      });
      expect(state(batches[0]!).docs).not.toHaveProperty('docs/b.md');
      expect(calls.blobs).toEqual([]);
    });

    it('deletes nothing by a tree GitHub cut short, and lists it again next run', async () => {
      const w = threeDocs();
      const { connector, calls } = await connected(w, docsOnly(ALL));
      const done = (await collect(connector)).at(-1)!.checkpoint;
      // The tree moved, and the listing now comes back incomplete.
      w.head = 'tree-2';
      w.tree = [{ path: 'README.md', sha: 'blob-r', size: 20 }];
      w.truncated = true;

      const batches = await collect(connector, done);

      expect(batches.flatMap((b) => b.deletedExternalIds)).toEqual([]);
      expect(batches.flatMap((b) => b.notes ?? [])).toEqual(['tree_truncated']);
      expect(state(batches.at(-1)!).tree).toBe('tree-1'); // not recorded as seen
      calls.trees = 0;
      await collect(connector, batches.at(-1)!.checkpoint);
      expect(calls.trees).toBe(1);
    });

    it('applies a wider path setting without waiting for the tree to change', async () => {
      const w = threeDocs();
      const narrow = await connected(w, docsOnly(['README.md']));
      const done = (await collect(narrow.connector)).at(-1)!;
      expect(Object.keys(state(done).docs)).toEqual(['README.md']);

      const wide = await connected(w, docsOnly(ALL));
      const batches = await collect(wide.connector, done.checkpoint); // same tree oid as before
      expect(ids(batches)).toEqual(['doc:42:docs/a.md', 'doc:42:docs/b.md']);
      expect(wide.calls.blobs).toEqual(['blob-a', 'blob-b']); // the README was not fetched again
    });

    it('deletes what a narrower path setting no longer covers', async () => {
      const w = threeDocs();
      const wide = await connected(w, docsOnly(ALL));
      const done = (await collect(wide.connector)).at(-1)!.checkpoint;

      const narrow = await connected(w, docsOnly(['docs/**/*.md']));
      const batches = await collect(narrow.connector, done);
      expect(batches.flatMap((b) => b.deletedExternalIds)).toEqual(['doc:42:README.md']);
      expect(narrow.calls.blobs).toEqual([]);
    });
  });

  describe('history', () => {
    const prsOnly = {
      knowledge: { ...knowledge, issues: false, docs: { ...knowledge.docs, enabled: false } },
    };

    it('reaches further back when the history setting is raised', async () => {
      const { connector } = await connected(world(), prsOnly);
      // now is 2026-03-01; 58 days back is 2026-01-02: pull request 1 is older.
      const first = await collect(connector, null, { historyDays: 58 });
      expect(ids(first)).toEqual(['pr:42:2', 'pr:42:3']);

      const all = await collect(connector, first.at(-1)!.checkpoint, { historyDays: 0 });
      expect(ids(all)).toEqual(['pr:42:1', 'pr:42:2', 'pr:42:3']);

      // And only once: the next run with the same setting is an ordinary poll.
      const again = await collect(connector, all.at(-1)!.checkpoint, { historyDays: 0 });
      expect(ids(again)).toEqual(['pr:42:3']);
    });

    it('does not walk again because the horizon moved forward with time', async () => {
      const w = world();
      const day1 = await connected(w, prsOnly);
      const done = (await collect(day1.connector, null, { historyDays: 58 })).at(-1)!.checkpoint;

      const day2 = await connected(w, {
        ...prsOnly,
        now: () => Date.parse('2026-03-02T00:00:00Z'),
      });
      const batches = await collect(day2.connector, done, { historyDays: 58 });
      expect(ids(batches)).toEqual(['pr:42:3']); // the item at the cursor, nothing older
    });
  });

  it('lets other errors fail the container', async () => {
    const { connector } = await connected(world(), {}, async () => {
      throw new Error('socket hang up');
    });
    await expect(collect(connector)).rejects.toThrow('socket hang up');
  });
});
