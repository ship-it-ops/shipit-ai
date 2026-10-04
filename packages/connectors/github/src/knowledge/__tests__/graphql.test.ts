// packages/connectors/github/src/knowledge/__tests__/graphql.test.ts
import { describe, it, expect } from 'vitest';
import {
  GraphqlForbiddenError,
  fetchIssues,
  fetchPullRequests,
  fetchRepoHead,
  listIssueNumbers,
  listUpdated,
  type Gql,
} from '../graphql.js';

const repo = { id: 42, owner: 'acme', name: 'payments' };

/** A Gql that answers from a script and remembers what it was asked. */
function scripted(answers: unknown[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const gql: Gql = async <T>(query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next as T;
  };
  return { gql, calls };
}

// What octokit.graphql throws when the installation may not read the connection.
const forbiddenListing = () =>
  Object.assign(new Error('Resource not accessible by integration'), {
    errors: [{ type: 'FORBIDDEN', path: ['repository', 'items'] }],
    data: { repository: { items: null } },
  });

const page = (nodes: unknown[], endCursor: string | null) => ({
  repository: { items: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
});

describe('listUpdated', () => {
  it('returns the oldest first', async () => {
    const { gql } = scripted([
      page(
        [
          { number: 3, updatedAt: '2026-01-03T00:00:00Z' },
          { number: 2, updatedAt: '2026-01-02T00:00:00Z' },
        ],
        'cur1',
      ),
      page([{ number: 1, updatedAt: '2026-01-01T00:00:00Z' }], null),
    ]);
    const out = await listUpdated(gql, repo, 'pullRequests', { stopBefore: null, horizon: null });
    expect(out.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  it('stops at the checkpoint, keeps the item equal to it, and asks for no further page', async () => {
    const { gql, calls } = scripted([
      page(
        [
          { number: 3, updatedAt: '2026-01-03T00:00:00Z' },
          { number: 2, updatedAt: '2026-01-02T00:00:00Z' },
          { number: 1, updatedAt: '2026-01-01T00:00:00Z' },
        ],
        'cur1',
      ),
    ]);
    const out = await listUpdated(gql, repo, 'pullRequests', {
      stopBefore: '2026-01-02T00:00:00Z',
      horizon: null,
    });
    expect(out.map((r) => r.number)).toEqual([2, 3]);
    expect(calls).toHaveLength(1);
  });

  it('stops at the history horizon', async () => {
    const { gql } = scripted([
      page(
        [
          { number: 2, updatedAt: '2026-01-02T00:00:00Z' },
          { number: 1, updatedAt: '2025-01-01T00:00:00Z' },
        ],
        null,
      ),
    ]);
    const out = await listUpdated(gql, repo, 'issues', {
      stopBefore: null,
      horizon: '2025-06-01T00:00:00.000Z',
    });
    expect(out.map((r) => r.number)).toEqual([2]);
  });

  it('turns a FORBIDDEN answer into GraphqlForbiddenError', async () => {
    const { gql } = scripted([forbiddenListing()]);
    await expect(
      listUpdated(gql, repo, 'issues', { stopBefore: null, horizon: null }),
    ).rejects.toBeInstanceOf(GraphqlForbiddenError);
  });

  it('asks the connection it was told to', async () => {
    const { gql, calls } = scripted([page([], null)]);
    await listUpdated(gql, repo, 'issues', { stopBefore: null, horizon: null });
    expect(calls[0]!.query).toContain('items: issues(');
    expect(calls[0]!.variables).toMatchObject({ owner: 'acme', name: 'payments', after: null });
  });
});

describe('listIssueNumbers', () => {
  it('pages through every issue', async () => {
    const { gql } = scripted([
      page([{ number: 1 }, { number: 2 }], 'cur1'),
      page([{ number: 5 }], null),
    ]);
    const pages: number[][] = [];
    for await (const p of listIssueNumbers(gql, repo)) pages.push(p);
    expect(pages).toEqual([[1, 2], [5]]);
  });

  it('turns a FORBIDDEN answer into GraphqlForbiddenError', async () => {
    const { gql } = scripted([forbiddenListing()]);
    const drain = async (): Promise<void> => {
      for await (const page of listIssueNumbers(gql, repo)) void page;
    };
    await expect(drain()).rejects.toBeInstanceOf(GraphqlForbiddenError);
  });
});

const comment = (id: number) => ({
  databaseId: id,
  url: `https://github.com/acme/payments/pull/1#issuecomment-${id}`,
  createdAt: '2026-01-01T00:00:00Z',
  body: `comment ${id}`,
  author: { login: 'ada', databaseId: 7 },
});

const fullPr = (number: number, comments: unknown, reviewsHasNext = false) => ({
  number,
  title: `pr ${number}`,
  body: '',
  url: `https://github.com/acme/payments/pull/${number}`,
  state: 'OPEN',
  merged: false,
  isDraft: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  baseRefName: 'main',
  headRefName: 'x',
  author: null,
  labels: { nodes: [] },
  comments,
  reviews: { pageInfo: { hasNextPage: reviewsHasNext }, nodes: [] },
});

describe('fetchPullRequests', () => {
  it('asks for every number in one query and returns them in order', async () => {
    const done = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment(1)] };
    const { gql, calls } = scripted([{ repository: { n7: fullPr(7, done), n9: fullPr(9, done) } }]);
    const out = await fetchPullRequests(gql, repo, [9, 7]);
    expect(out.map((p) => p.number)).toEqual([9, 7]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain('n9: pullRequest(number: 9)');
    expect(calls[0]!.query).toContain('n7: pullRequest(number: 7)');
  });

  it('follows the comment cursor until every comment is in', async () => {
    const first = { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [comment(1)] };
    const { gql, calls } = scripted([
      { repository: { n7: fullPr(7, first) } },
      {
        repository: {
          item: {
            comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment(2)] },
          },
        },
      },
    ]);
    const [pr] = await fetchPullRequests(gql, repo, [7]);
    expect(pr!.comments.nodes.map((c) => c.databaseId)).toEqual([1, 2]);
    expect(calls[1]!.variables).toMatchObject({ number: 7, after: 'c1' });
  });

  it('says so when a pull request has more reviews than one page holds', async () => {
    const done = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    const { gql } = scripted([{ repository: { n7: fullPr(7, done, true) } }]);
    const [pr] = await fetchPullRequests(gql, repo, [7]);
    expect(pr!.reviewsTruncated).toBe(true);
  });

  it('returns nothing for no numbers without calling GitHub', async () => {
    const { gql, calls } = scripted([]);
    expect(await fetchPullRequests(gql, repo, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('fetchIssues', () => {
  it('leaves out an issue that was deleted between the listing and the fetch', async () => {
    const done = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    const {
      reviews: _r,
      merged: _m,
      isDraft: _d,
      baseRefName: _b,
      headRefName: _h,
      ...issue
    } = fullPr(4, done);
    // octokit.graphql throws on any error but attaches the partial data.
    const notFound = Object.assign(new Error('Could not resolve to an Issue'), {
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'n5'] }],
      data: { repository: { n4: issue, n5: null } },
    });
    const { gql } = scripted([notFound]);
    const out = await fetchIssues(gql, repo, [4, 5]);
    expect(out.map((i) => i.number)).toEqual([4]);
  });

  it('turns a FORBIDDEN answer into GraphqlForbiddenError', async () => {
    const forbidden = Object.assign(new Error('Resource not accessible by integration'), {
      errors: [{ type: 'FORBIDDEN', path: ['repository', 'n4'] }],
      data: { repository: { n4: null } },
    });
    const { gql } = scripted([forbidden]);
    await expect(fetchIssues(gql, repo, [4])).rejects.toBeInstanceOf(GraphqlForbiddenError);
  });

  it('rethrows anything else', async () => {
    const { gql } = scripted([new Error('socket hang up')]);
    await expect(fetchIssues(gql, repo, [4])).rejects.toThrow('socket hang up');
  });
});

describe('fetchRepoHead', () => {
  it('reads the default branch head and its tree', async () => {
    const { gql } = scripted([
      {
        repository: {
          defaultBranchRef: {
            name: 'main',
            target: { oid: 'c1', committedDate: '2026-02-01T00:00:00Z', tree: { oid: 't1' } },
          },
        },
      },
    ]);
    expect(await fetchRepoHead(gql, repo)).toEqual({
      branch: 'main',
      commitOid: 'c1',
      committedAt: '2026-02-01T00:00:00Z',
      treeOid: 't1',
    });
  });

  it('answers null for an empty repository', async () => {
    const { gql } = scripted([{ repository: { defaultBranchRef: null } }]);
    expect(await fetchRepoHead(gql, repo)).toBeNull();
  });
});
