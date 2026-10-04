// packages/connectors/github/src/knowledge/__tests__/connector.test.ts
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
  const calls = { graphql: [] as string[], blobs: [] as string[], trees: 0 };
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
        return { data: { truncated: false, tree: w.tree.map((e) => ({ ...e, type: 'blob' })) } };
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
    async *listRepositories() {
      yield {
        id: 42,
        fullName: 'acme/payments',
        htmlUrl: 'https://github.com/acme/payments',
        visibility: 'private',
        archived: false,
      };
      yield {
        id: 43,
        fullName: 'acme/site',
        htmlUrl: 'https://github.com/acme/site',
        visibility: 'public',
        archived: true,
      };
      yield {
        id: 44,
        fullName: 'acme/tools',
        htmlUrl: 'https://github.com/acme/tools',
        visibility: 'internal',
        archived: false,
      };
    },
    async *listMembers() {
      yield { id: 7, login: 'ada' };
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

  it('ends the run with a note when GitHub asks to wait past the deadline', async () => {
    const limited = Object.assign(new Error('secondary rate limit'), {
      status: 403,
      response: { headers: { 'retry-after': '600' } },
    });
    const { connector } = await connected(world(), {}, async () => {
      throw limited;
    });
    const batches = await collect(connector, null, {
      deadline: Date.parse('2026-03-01T00:01:00Z'),
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ documents: [], notes: [NOTE_RATE_LIMITED] });
  });

  it('lets other errors fail the container', async () => {
    const { connector } = await connected(world(), {}, async () => {
      throw new Error('socket hang up');
    });
    await expect(collect(connector)).rejects.toThrow('socket hang up');
  });
});
