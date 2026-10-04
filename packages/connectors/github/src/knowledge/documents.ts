// GitHub content → KnowledgeDocumentInput. Pure: the fetchers hand in what the
// API returned, the connector hands the result to the sink.
import type {
  DocumentSegment,
  KnowledgeDocumentInput,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { docId, issueId, pullRequestId } from './ids.js';
import { splitMarkdownByHeading } from './markdown.js';

export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

export interface GqlActor {
  /** `User`, `Bot`, `Organization`, `Mannequin`, … */
  __typename?: string;
  login: string;
  /** Present for users and bots; absent for organisations and mannequins. */
  databaseId?: number | null;
}

export interface GqlComment {
  databaseId: number | null;
  url: string;
  createdAt: string;
  body: string;
  author: GqlActor | null;
}

export interface GqlReview {
  databaseId: number | null;
  url: string;
  state: string;
  submittedAt: string | null;
  body: string;
  author: GqlActor | null;
  comments: { nodes: Array<GqlComment & { path: string }> };
}

export interface GqlIssueLike {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  author: GqlActor | null;
  labels: { nodes: Array<{ name: string }> };
  comments: { nodes: GqlComment[] };
}

export interface GqlPullRequest extends GqlIssueLike {
  merged: boolean;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  reviews: { nodes: GqlReview[] };
}

const actorId = (actor: GqlActor | null): string | undefined =>
  actor?.databaseId != null ? String(actor.databaseId) : undefined;

function authored(
  key: string,
  text: string,
  actor: GqlActor | null,
  at: string | undefined,
  url: string,
): DocumentSegment {
  return {
    key,
    text,
    ...(actorId(actor) ? { authorExternalId: actorId(actor) } : {}),
    ...(actor ? { authorName: actor.login } : {}),
    ...(at ? { at } : {}),
    url,
  };
}

function commentSegments(comments: GqlComment[]): DocumentSegment[] {
  return comments
    .filter((c) => c.body.trim().length > 0)
    .map((c) => authored(`c:${c.databaseId ?? c.url}`, c.body, c.author, c.createdAt, c.url));
}

function participants(segments: DocumentSegment[]): string[] {
  return [...new Set(segments.map((s) => s.authorExternalId).filter((x): x is string => !!x))];
}

const byTime = (a: DocumentSegment, b: DocumentSegment): number =>
  (a.at ?? '').localeCompare(b.at ?? '');

function header(item: GqlIssueLike): DocumentSegment {
  // The chunker treats the first segment as the description and the rest as
  // comments, so the header exists even when the body is empty.
  return authored(
    'body',
    item.body.trim() || '(no description)',
    item.author,
    item.createdAt,
    item.url,
  );
}

/**
 * Everyone who wrote in these items, once each. The organisation's member
 * listing does not cover bots and outside contributors, and it runs only at
 * reconcile; a batch carries these so the sink can resolve authorship as it
 * writes the documents.
 */
export function principalsOf(items: Array<GqlIssueLike | GqlPullRequest>): SourcePrincipal[] {
  const seen = new Map<string, SourcePrincipal>();
  const add = (actor: GqlActor | null): void => {
    const id = actorId(actor);
    if (!actor || !id || seen.has(id)) return;
    seen.set(id, {
      externalId: id,
      kind: actor.__typename === 'Bot' ? 'bot' : 'user',
      displayName: actor.login,
      login: actor.login,
      active: true,
    });
  };
  for (const item of items) {
    add(item.author);
    for (const comment of item.comments.nodes) add(comment.author);
    if ('reviews' in item) {
      for (const review of item.reviews.nodes) {
        add(review.author);
        for (const comment of review.comments.nodes) add(comment.author);
      }
    }
  }
  return [...seen.values()];
}

export function pullRequestDocument(repo: RepoRef, pr: GqlPullRequest): KnowledgeDocumentInput {
  const rest: DocumentSegment[] = commentSegments(pr.comments.nodes);
  for (const review of pr.reviews.nodes) {
    for (const c of review.comments.nodes) {
      if (c.body.trim().length === 0) continue;
      rest.push(
        authored(
          `rc:${c.databaseId ?? c.url}`,
          `${c.path}: ${c.body}`,
          c.author,
          c.createdAt,
          c.url,
        ),
      );
    }
    // A review with neither a body nor a verdict worth keeping adds nothing.
    const verdict = review.state === 'COMMENTED' ? '' : `[${review.state}]`;
    const text = [verdict, review.body.trim()].filter(Boolean).join(' ');
    if (text) {
      rest.push(
        authored(
          `r:${review.databaseId ?? review.url}`,
          text,
          review.author,
          review.submittedAt ?? undefined,
          review.url,
        ),
      );
    }
  }
  const segments = [header(pr), ...rest.sort(byTime)];
  return {
    externalId: pullRequestId(repo.id, pr.number),
    kind: 'github_pull_request',
    title: pr.title,
    url: pr.url,
    segments,
    sourceVersion: pr.updatedAt,
    sourceCreatedAt: pr.createdAt,
    sourceUpdatedAt: pr.updatedAt,
    ...(actorId(pr.author) ? { authorExternalId: actorId(pr.author) } : {}),
    participantExternalIds: participants(segments),
    state: pr.merged ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
    attributes: {
      number: pr.number,
      labels: pr.labels.nodes.map((l) => l.name),
      draft: pr.isDraft,
      base: pr.baseRefName,
      head: pr.headRefName,
    },
    restricted: false,
  };
}

export function issueDocument(repo: RepoRef, issue: GqlIssueLike): KnowledgeDocumentInput {
  const segments = [header(issue), ...commentSegments(issue.comments.nodes).sort(byTime)];
  return {
    externalId: issueId(repo.id, issue.number),
    kind: 'github_issue',
    title: issue.title,
    url: issue.url,
    segments,
    sourceVersion: issue.updatedAt,
    sourceCreatedAt: issue.createdAt,
    sourceUpdatedAt: issue.updatedAt,
    ...(actorId(issue.author) ? { authorExternalId: actorId(issue.author) } : {}),
    participantExternalIds: participants(segments),
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    attributes: { number: issue.number, labels: issue.labels.nodes.map((l) => l.name) },
    restricted: false,
  };
}

export function markdownDocument(
  repo: RepoRef,
  file: { path: string; sha: string; text: string; branch: string; committedAt: string },
): KnowledgeDocumentInput {
  const url = `https://github.com/${repo.owner}/${repo.name}/blob/${file.branch}/${file.path}`;
  return {
    externalId: docId(repo.id, file.path),
    kind: 'github_doc',
    title: file.path,
    url,
    segments: splitMarkdownByHeading(file.text).map((s) => ({
      key: s.key,
      headingPath: s.headingPath,
      text: s.text,
      url,
    })),
    sourceVersion: file.sha,
    // A blob has no dates of its own; the head commit's date is the closest
    // honest answer to "as of when".
    sourceCreatedAt: file.committedAt,
    sourceUpdatedAt: file.committedAt,
    participantExternalIds: [],
    attributes: { path: file.path },
    restricted: false,
  };
}

/**
 * Spec §Sources: a document over the limit is cut at a segment boundary and
 * flagged. The first segment always stays; when it alone is over the limit it
 * is cut to the limit, the one place text is cut inside a segment.
 */
export function truncateDocument(
  doc: KnowledgeDocumentInput,
  maxChars: number,
): KnowledgeDocumentInput {
  const total = doc.segments.reduce((n, s) => n + s.text.length, 0);
  if (total <= maxChars) return doc;
  const kept: DocumentSegment[] = [];
  let used = 0;
  for (const segment of doc.segments) {
    if (kept.length === 0) {
      kept.push(
        segment.text.length > maxChars
          ? { ...segment, text: segment.text.slice(0, maxChars) }
          : segment,
      );
      used = kept[0]!.text.length;
      continue;
    }
    if (used + segment.text.length > maxChars) break;
    kept.push(segment);
    used += segment.text.length;
  }
  return { ...doc, segments: kept, attributes: { ...doc.attributes, truncated: true } };
}
