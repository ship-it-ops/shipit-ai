import { describe, it, expect } from 'vitest';
import {
  issueDocument,
  markdownDocument,
  principalsOf,
  pullRequestDocument,
  truncateDocument,
  type GqlPullRequest,
} from '../documents.js';

const repo = { id: 42, owner: 'acme', name: 'payments' };
const ada = { login: 'ada', databaseId: 7 };

function pr(overrides: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    number: 12,
    title: 'Retry the ledger write',
    body: 'Fixes the double charge.',
    url: 'https://github.com/acme/payments/pull/12',
    state: 'MERGED',
    merged: true,
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
    baseRefName: 'main',
    headRefName: 'fix/ledger',
    author: ada,
    labels: { nodes: [{ name: 'bug' }] },
    comments: {
      nodes: [
        {
          databaseId: 100,
          url: 'https://github.com/acme/payments/pull/12#issuecomment-100',
          createdAt: '2026-01-02T00:00:00Z',
          body: 'Looks right.',
          author: { login: 'bob', databaseId: 8 },
        },
      ],
    },
    reviews: {
      nodes: [
        {
          databaseId: 200,
          url: 'https://github.com/acme/payments/pull/12#pullrequestreview-200',
          state: 'APPROVED',
          submittedAt: '2026-01-02T12:00:00Z',
          body: '',
          author: { login: 'bob', databaseId: 8 },
          comments: {
            nodes: [
              {
                databaseId: 300,
                url: 'https://github.com/acme/payments/pull/12#discussion_r300',
                createdAt: '2026-01-02T11:00:00Z',
                body: 'Use the idempotency key here.',
                path: 'src/ledger.ts',
                author: { login: 'bob', databaseId: 8 },
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('pullRequestDocument', () => {
  it('maps the pull request, its comments, reviews and review comments in time order', () => {
    const doc = pullRequestDocument(repo, pr());
    expect(doc).toMatchObject({
      externalId: 'pr:42:12',
      kind: 'github_pull_request',
      title: 'Retry the ledger write',
      url: 'https://github.com/acme/payments/pull/12',
      sourceVersion: '2026-01-03T00:00:00Z',
      sourceCreatedAt: '2026-01-01T00:00:00Z',
      sourceUpdatedAt: '2026-01-03T00:00:00Z',
      authorExternalId: '7',
      state: 'merged',
      restricted: false,
      attributes: {
        number: 12,
        labels: ['bug'],
        draft: false,
        base: 'main',
        head: 'fix/ledger',
      },
    });
    expect(doc.participantExternalIds.sort()).toEqual(['7', '8']);
    expect(doc.segments.map((s) => s.key)).toEqual(['body', 'c:100', 'rc:300', 'r:200']);
    expect(doc.segments[0]).toMatchObject({ text: 'Fixes the double charge.', authorName: 'ada' });
    expect(doc.segments[2]!.text).toBe('src/ledger.ts: Use the idempotency key here.');
    expect(doc.segments[3]!.text).toBe('[APPROVED]');
  });

  it('maps open and closed states and survives a deleted author', () => {
    expect(pullRequestDocument(repo, pr({ state: 'OPEN', merged: false })).state).toBe('open');
    expect(pullRequestDocument(repo, pr({ state: 'CLOSED', merged: false })).state).toBe('closed');
    const ghost = pullRequestDocument(repo, pr({ author: null }));
    expect(ghost.authorExternalId).toBeUndefined();
    expect(ghost.segments[0]!.authorName).toBeUndefined();
  });

  it('keeps an empty body as a header segment so comments stay comments', () => {
    const doc = pullRequestDocument(repo, pr({ body: '' }));
    expect(doc.segments[0]).toMatchObject({ key: 'body', text: '(no description)' });
  });
});

describe('principalsOf', () => {
  it('lists everyone who wrote in the items once, bots as bots', () => {
    const withBot = pr({
      number: 13,
      author: { __typename: 'Bot', login: 'dependabot', databaseId: 99 },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    });
    expect(principalsOf([pr(), withBot])).toEqual([
      { externalId: '7', kind: 'user', displayName: 'ada', login: 'ada', active: true },
      { externalId: '8', kind: 'user', displayName: 'bob', login: 'bob', active: true },
      {
        externalId: '99',
        kind: 'bot',
        displayName: 'dependabot',
        login: 'dependabot',
        active: true,
      },
    ]);
  });

  it('leaves out an actor GitHub gives no id for', () => {
    const ghost = pr({
      author: { login: 'ghost' },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    });
    expect(principalsOf([ghost])).toEqual([]);
  });
});

describe('issueDocument', () => {
  it('maps an issue the same way, with its own kind and id', () => {
    const {
      merged: _m,
      isDraft: _d,
      baseRefName: _b,
      headRefName: _h,
      reviews: _r,
      ...issue
    } = pr({
      state: 'CLOSED',
      url: 'https://github.com/acme/payments/issues/12',
    });
    const doc = issueDocument(repo, issue);
    expect(doc.externalId).toBe('issue:42:12');
    expect(doc.kind).toBe('github_issue');
    expect(doc.state).toBe('closed');
    expect(doc.segments.map((s) => s.key)).toEqual(['body', 'c:100']);
    expect(doc.attributes).toEqual({ number: 12, labels: ['bug'] });
  });
});

describe('markdownDocument', () => {
  it('splits the file by heading and versions it by blob sha', () => {
    const doc = markdownDocument(repo, {
      path: 'docs/runbook.md',
      sha: 'abc123',
      text: '# Runbook\nintro\n## Rollback\ndrain first',
      branch: 'main',
      committedAt: '2026-02-01T00:00:00Z',
    });
    expect(doc).toMatchObject({
      externalId: 'doc:42:docs/runbook.md',
      kind: 'github_doc',
      title: 'docs/runbook.md',
      url: 'https://github.com/acme/payments/blob/main/docs/runbook.md',
      sourceVersion: 'abc123',
      sourceUpdatedAt: '2026-02-01T00:00:00Z',
      attributes: { path: 'docs/runbook.md' },
    });
    expect(doc.segments.map((s) => s.headingPath)).toEqual([['Runbook'], ['Runbook', 'Rollback']]);
  });
});

describe('truncateDocument', () => {
  it('leaves a document under the limit alone', () => {
    const doc = pullRequestDocument(repo, pr());
    expect(truncateDocument(doc, 10_000)).toBe(doc);
  });

  it('cuts at a segment boundary and flags the document', () => {
    const doc = pullRequestDocument(repo, pr());
    const firstTwo = doc.segments[0]!.text.length + doc.segments[1]!.text.length;
    const cut = truncateDocument(doc, firstTwo + 3);
    expect(cut.segments.map((s) => s.key)).toEqual(['body', 'c:100']);
    expect(cut.attributes.truncated).toBe(true);
    expect(cut.segments[1]!.text).toBe('Looks right.'); // whole, not cut mid-text
  });

  it('keeps the first segment even when it alone is over the limit, cut to the limit', () => {
    const cut = truncateDocument(pullRequestDocument(repo, pr({ body: 'x'.repeat(50) })), 20);
    expect(cut.segments).toHaveLength(1);
    expect(cut.segments[0]!.text).toHaveLength(20);
    expect(cut.attributes.truncated).toBe(true);
  });
});
