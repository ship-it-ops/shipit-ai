// packages/connectors/github/src/knowledge/graphql.ts
// Every GraphQL query of the knowledge facet. The shapes were run against
// github.com on 2026-10-04 (see the plan's spike section). `Gql` is one call;
// the connector builds it over octokit.graphql with rate-limit handling.
import type { GqlComment, GqlIssueLike, GqlPullRequest, RepoRef } from './documents.js';

export type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

export interface UpdatedRef {
  number: number;
  updatedAt: string;
}

export interface RepoHead {
  branch: string;
  commitOid: string;
  committedAt: string;
  treeOid: string;
}

/** GitHub refused the query for this installation (a permission it was not granted). */
export class GraphqlForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphqlForbiddenError';
  }
}

/** What octokit.graphql throws on an error answer: the errors, and whatever data came with them. */
interface GraphqlFailure {
  errors?: Array<{ type?: string }>;
  data?: { repository?: Record<string, unknown> | null } | null;
}

const errorTypes = (err: unknown): Array<string | undefined> =>
  (((err ?? {}) as GraphqlFailure).errors ?? []).map((e) => e.type);

/**
 * FORBIDDEN means the installation lacks the permission, whichever query met
 * it. The listings are the first issues calls a run makes, so they convert it
 * too: the connector then reports a missing permission instead of failing.
 */
function rethrowForbidden(err: unknown): never {
  if (errorTypes(err).includes('FORBIDDEN')) {
    throw new GraphqlForbiddenError(err instanceof Error ? err.message : String(err));
  }
  throw err;
}

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** The answer to a listing query, whose connection is aliased `items`. */
interface Listing<T> {
  repository: { items: Connection<T> };
}

const ACTOR = `author { login ... on User { databaseId } ... on Bot { databaseId } }`;
const COMMENT = `databaseId url createdAt body ${ACTOR}`;
const COMMENTS = `comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } }`;
const ISSUE_FIELDS = `number title body url state createdAt updatedAt ${ACTOR}
  labels(first: 50) { nodes { name } }
  ${COMMENTS}`;
const PR_FIELDS = `${ISSUE_FIELDS}
  merged isDraft baseRefName headRefName
  reviews(first: 50) {
    pageInfo { hasNextPage }
    nodes {
      databaseId url state submittedAt body ${ACTOR}
      comments(first: 50) { nodes { databaseId url createdAt body path ${ACTOR} } }
    }
  }`;

const repoVars = (repo: RepoRef): { owner: string; name: string } => ({
  owner: repo.owner,
  name: repo.name,
});

/**
 * GitHub orders by UPDATED_AT but offers no "since" for pull requests, so the
 * listing walks newest first and stops at the checkpoint. It returns OLDEST
 * first: the connector stores in that order and moves the checkpoint with each
 * batch, so a run cut short resumes with what it had not reached. Storing
 * newest first would move the checkpoint past everything older.
 */
export async function listUpdated(
  gql: Gql,
  repo: RepoRef,
  connection: 'pullRequests' | 'issues',
  opts: { stopBefore: string | null; horizon: string | null },
): Promise<UpdatedRef[]> {
  const stopBefore = opts.stopBefore ? Date.parse(opts.stopBefore) : null;
  const horizon = opts.horizon ? Date.parse(opts.horizon) : null;
  const query = `query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      items: ${connection}(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { number updatedAt }
      }
    }
  }`;
  const found: UpdatedRef[] = [];
  let after: string | null = null;
  for (;;) {
    // Annotated: `after` feeds the call and is assigned from its result.
    const data: Listing<UpdatedRef> = await gql<Listing<UpdatedRef>>(query, {
      ...repoVars(repo),
      after,
    }).catch(rethrowForbidden);
    const { nodes, pageInfo } = data.repository.items;
    for (const node of nodes) {
      const at = Date.parse(node.updatedAt);
      if ((stopBefore !== null && at < stopBefore) || (horizon !== null && at < horizon)) {
        return found.reverse();
      }
      found.push(node);
    }
    if (!pageInfo.hasNextPage) return found.reverse();
    after = pageInfo.endCursor;
  }
}

export async function* listIssueNumbers(gql: Gql, repo: RepoRef): AsyncIterable<number[]> {
  const query = `query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      items: issues(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes { number }
      }
    }
  }`;
  let after: string | null = null;
  for (;;) {
    const data: Listing<{ number: number }> = await gql<Listing<{ number: number }>>(query, {
      ...repoVars(repo),
      after,
    }).catch(rethrowForbidden);
    const { nodes, pageInfo } = data.repository.items;
    yield nodes.map((n) => n.number);
    if (!pageInfo.hasNextPage) return;
    after = pageInfo.endCursor;
  }
}

/**
 * One query, one alias per number. An item deleted since the listing comes
 * back null with a NOT_FOUND error; octokit throws but attaches the partial
 * data, which is what we want. FORBIDDEN means the installation lacks the
 * permission.
 */
async function fetchByNumber<T extends { number: number }>(
  gql: Gql,
  repo: RepoRef,
  field: 'pullRequest' | 'issue',
  fields: string,
  numbers: number[],
): Promise<T[]> {
  if (numbers.length === 0) return [];
  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${numbers.map((n) => `n${n}: ${field}(number: ${n}) { ${fields} }`).join('\n      ')}
    }
  }`;
  let repository: Record<string, unknown>;
  try {
    const data: { repository: Record<string, unknown> } = await gql(query, repoVars(repo));
    repository = data.repository;
  } catch (err) {
    const types = errorTypes(err);
    if (types.includes('FORBIDDEN')) rethrowForbidden(err);
    const partial = ((err ?? {}) as GraphqlFailure).data?.repository;
    if (!partial || types.length === 0 || types.some((t) => t !== 'NOT_FOUND')) throw err;
    repository = partial;
  }
  return numbers.map((n) => repository[`n${n}`] as T | null).filter((x): x is T => x != null);
}

/** Issue comments beyond the first hundred, appended in place. */
async function completeComments(
  gql: Gql,
  repo: RepoRef,
  field: 'pullRequest' | 'issue',
  item: { number: number; comments: Connection<GqlComment> },
): Promise<void> {
  const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      item: ${field}(number: $number) {
        comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } }
      }
    }
  }`;
  while (item.comments.pageInfo.hasNextPage) {
    const data: { repository: { item: { comments: Connection<GqlComment> } | null } } = await gql(
      query,
      { ...repoVars(repo), number: item.number, after: item.comments.pageInfo.endCursor },
    );
    const more = data.repository.item?.comments;
    if (!more) return;
    item.comments.nodes.push(...more.nodes);
    item.comments.pageInfo = more.pageInfo;
  }
}

type Paged<T extends GqlIssueLike> = T & { comments: Connection<GqlComment> };

export async function fetchPullRequests(
  gql: Gql,
  repo: RepoRef,
  numbers: number[],
): Promise<Array<GqlPullRequest & { reviewsTruncated: boolean }>> {
  type Raw = Paged<GqlPullRequest> & { reviews: { pageInfo: { hasNextPage: boolean } } };
  const items = await fetchByNumber<Raw>(gql, repo, 'pullRequest', PR_FIELDS, numbers);
  for (const item of items) await completeComments(gql, repo, 'pullRequest', item);
  // Reviews past the first fifty are rare; the document is flagged, not paged.
  return items.map((item) => ({ ...item, reviewsTruncated: item.reviews.pageInfo.hasNextPage }));
}

export async function fetchIssues(
  gql: Gql,
  repo: RepoRef,
  numbers: number[],
): Promise<GqlIssueLike[]> {
  const items = await fetchByNumber<Paged<GqlIssueLike>>(gql, repo, 'issue', ISSUE_FIELDS, numbers);
  for (const item of items) await completeComments(gql, repo, 'issue', item);
  return items;
}

export async function fetchRepoHead(gql: Gql, repo: RepoRef): Promise<RepoHead | null> {
  const data: {
    repository: {
      defaultBranchRef: {
        name: string;
        target: { oid: string; committedDate: string; tree: { oid: string } } | null;
      } | null;
    };
  } = await gql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef { name target { ... on Commit { oid committedDate tree { oid } } } }
      }
    }`,
    repoVars(repo),
  );
  const ref = data.repository.defaultBranchRef;
  if (!ref?.target) return null;
  return {
    branch: ref.name,
    commitOid: ref.target.oid,
    committedAt: ref.target.committedDate,
    treeOid: ref.target.tree.oid,
  };
}
