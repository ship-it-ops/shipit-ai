// The knowledge facet of the GitHub connector: repositories are containers;
// pull requests, issues and Markdown docs are documents. Spec:
// docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §GitHub text.
import type { Octokit } from '@octokit/rest';
import { isRunCutShort } from '@shipit-ai/connector-sdk';
import type {
  AuthResult,
  ChangeBatch,
  ConnectorConfig,
  ConnectorManifest,
  DocumentKind,
  FetchChangesOptions,
  KnowledgeConnector,
  KnowledgeDocumentInput,
  RunLimits,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import type { GitHubKnowledgeConfig } from '@shipit-ai/shared';
import { authenticateGitHubApp } from '../auth.js';
import { fetchBlobText, listDocBlobs, type TreeClient } from './docs.js';
import {
  issueDocument,
  markdownDocument,
  principalsOf,
  pullRequestDocument,
  truncateDocument,
  type RepoRef,
} from './documents.js';
import {
  GraphqlForbiddenError,
  fetchIssues,
  fetchPullRequests,
  fetchRepoHead,
  listIssueNumbers,
  listUpdated,
  type Gql,
  type UpdatedRef,
} from './graphql.js';
import { docId, issueId } from './ids.js';
import { withRateLimit, type RateLimitState } from './rate-limit.js';

export { NOTE_RATE_LIMITED } from './rate-limit.js';
export const NOTE_ISSUES_PERMISSION = 'issues_permission_missing';
export const NOTE_TREE_TRUNCATED = 'tree_truncated';

/** Items per page of the REST listings; a shorter page ends the listing. */
const PAGE_SIZE = 100;

export interface GitHubRepositorySummary {
  id: number;
  fullName: string;
  htmlUrl: string;
  visibility: string;
  archived: boolean;
}

/** Everything the connector needs from GitHub. Tests fake it. */
export interface GitHubKnowledgeClient {
  /** The installation was granted the Issues permission. */
  issuesGranted: boolean;
  graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  git: TreeClient;
  /** One page (100) of the organisation's repositories, pages numbered from 1. */
  listRepositoriesPage(
    org: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<GitHubRepositorySummary[]>;
  /** One page (100) of the organisation's members, pages numbered from 1. */
  listMembersPage(
    org: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<Array<{ id: number; login: string }>>;
}

export type ConnectResult =
  { ok: true; client: GitHubKnowledgeClient } | { ok: false; error: string };

export interface GitHubKnowledgeConnectorOptions {
  knowledge: GitHubKnowledgeConfig;
  /** knowledge.index.maxDocumentChars. */
  maxDocumentChars: number;
  /** Documents per batch, and items per GraphQL query. Default 20. */
  batchSize?: number;
  now?: () => number;
  /** Test seam. Default: the App installation in the connector config. */
  connect?: (config: ConnectorConfig) => Promise<ConnectResult>;
}

type ItemKind = 'pr' | 'issue';

interface Checkpoint {
  v: 1;
  pr: string | null;
  issue: string | null;
  tree: string | null;
  /** path → blob sha of every doc that is stored. */
  docs: Record<string, string>;
  /** The docs settings the stored docs were chosen with (see `docsKeyOf`). */
  docsKey?: string;
  /**
   * How far back each kind was backfilled: the horizon in force when its walk
   * started, or null for "everything". Absent: not recorded, nothing to compare.
   */
  since?: Partial<Record<ItemKind, string | null>>;
}

const EMPTY: Checkpoint = { v: 1, pr: null, issue: null, tree: null, docs: {} };

function parseCheckpoint(raw: string | null): Checkpoint {
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<Checkpoint>;
    if (parsed.v !== 1) return { ...EMPTY };
    return {
      v: 1,
      pr: parsed.pr ?? null,
      issue: parsed.issue ?? null,
      tree: parsed.tree ?? null,
      docs: parsed.docs ?? {},
      ...(typeof parsed.docsKey === 'string' ? { docsKey: parsed.docsKey } : {}),
      ...(parsed.since ? { since: parsed.since } : {}),
    };
  } catch {
    // A checkpoint this code cannot read starts the container over; storing
    // is idempotent, so the cost is time, not duplicates.
    return { ...EMPTY };
  }
}

/** The docs settings that decide which files are stored. A change re-reads the tree. */
function docsKeyOf(docs: GitHubKnowledgeConfig['docs']): string {
  return JSON.stringify([docs.paths, docs.maxFileBytes]);
}

/** True when the horizon now asked for is older than the one this kind was backfilled to. */
function reachesFurtherBack(horizon: string | null, covered: string | null | undefined): boolean {
  if (covered === undefined || covered === null) return false; // not recorded, or everything
  return horizon === null || Date.parse(horizon) < Date.parse(covered);
}

function repoOf(container: SelectedContainer): RepoRef {
  const [owner, name] = container.name.split('/');
  if (!owner || !name) {
    throw new Error(`container ${container.name} is not an owner/name repository`);
  }
  return { id: Number(container.externalId), owner, name };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export function clientFromOctokit(octokit: Octokit, issuesGranted: boolean): GitHubKnowledgeClient {
  const withSignal = (signal?: AbortSignal): { request?: { signal: AbortSignal } } =>
    signal ? { request: { signal } } : {};
  return {
    issuesGranted,
    graphql: (query, variables, signal) =>
      octokit.graphql(query, { ...variables, ...withSignal(signal) }),
    git: octokit.rest.git as unknown as TreeClient,
    async listRepositoriesPage(org, page, signal) {
      const { data } = await octokit.rest.repos.listForOrg({
        org,
        per_page: PAGE_SIZE,
        page,
        type: 'all',
        ...withSignal(signal),
      });
      return data.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        htmlUrl: r.html_url,
        visibility: r.visibility ?? 'private',
        archived: r.archived ?? false,
      }));
    },
    async listMembersPage(org, page, signal) {
      const { data } = await octokit.rest.orgs.listMembers({
        org,
        per_page: PAGE_SIZE,
        page,
        ...withSignal(signal),
      });
      return data.map((m) => ({ id: m.id, login: m.login }));
    },
  };
}

async function connectWithApp(config: ConnectorConfig): Promise<ConnectResult> {
  const { appId, privateKey, installationId } = config.credentials;
  if (!appId || !privateKey || !installationId) {
    return { ok: false, error: 'No GitHub App credentials provided' };
  }
  const { auth, octokit } = await authenticateGitHubApp({ appId, privateKey, installationId });
  if (!auth.success || !octokit) {
    return { ok: false, error: auth.error ?? 'GitHub App auth failed' };
  }
  // What the installation was actually granted, which can lag the App's
  // settings until an owner approves a new permission.
  const { data } = await octokit.rest.apps.getInstallation({
    installation_id: Number(installationId),
  });
  const granted = (data.permissions ?? {}) as Record<string, string | undefined>;
  return { ok: true, client: clientFromOctokit(octokit, granted.issues !== undefined) };
}

/** What one fetchChanges call carries from kind to kind. */
interface Run {
  repo: RepoRef;
  limits: RunLimits;
  gql: Gql;
  /** ISO time older than which nothing is fetched; null for everything. */
  horizon: string | null;
  cp: Checkpoint;
  /** Notes ride on the next batch; a run that produces none still reports them. */
  notes: string[];
}

export class GitHubKnowledgeConnector implements KnowledgeConnector {
  readonly manifest: ConnectorManifest = {
    name: 'github-knowledge',
    version: '1.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: [],
  };

  private client: GitHubKnowledgeClient | null = null;
  private org = '';
  // Set when GitHub refuses an issues query although the installation
  // claimed the permission; treated like a missing permission from then on.
  private issuesForbidden = false;
  // One per instance, so one per run: the next repository of a run does not
  // spend a request to learn about the limit the previous one ran into.
  private readonly rateLimit: RateLimitState = { limitedUntil: 0 };
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(private readonly options: GitHubKnowledgeConnectorOptions) {
    this.batchSize = options.batchSize ?? 20;
    this.now = options.now ?? Date.now;
  }

  async authenticate(config: ConnectorConfig): Promise<AuthResult> {
    this.org = String(config.scope['org'] ?? '');
    const result = await (this.options.connect ?? connectWithApp)(config);
    if (!result.ok) return { success: false, error: result.error };
    this.client = result.client;
    return { success: true };
  }

  private get github(): GitHubKnowledgeClient {
    if (!this.client) throw new Error('Not authenticated. Call authenticate() first.');
    return this.client;
  }

  private get issuesListable(): boolean {
    return this.options.knowledge.issues && this.github.issuesGranted && !this.issuesForbidden;
  }

  /**
   * Only issues are pruned by the id listing: pull requests cannot be deleted
   * and docs are deleted in the poll. While issues cannot be listed (switched
   * off, or the permission is missing) nothing is, so nothing already stored
   * is deleted for a reason that is not a deletion.
   */
  get prunableKinds(): DocumentKind[] {
    return this.client && this.issuesListable ? ['github_issue'] : [];
  }

  /** Every call to GitHub goes through here: rate limits are waited out, or end the run. */
  private limited<T>(limits: RunLimits, fn: () => Promise<T>): Promise<T> {
    return withRateLimit(fn, limits, { now: this.now, state: this.rateLimit });
  }

  async *listContainers(limits: RunLimits = {}): AsyncIterable<SourceContainer> {
    for (let page = 1; ; page++) {
      const repos = await this.limited(limits, () =>
        this.github.listRepositoriesPage(this.org, page, limits.signal),
      );
      for (const r of repos) {
        yield {
          externalId: String(r.id),
          kind: 'repository',
          name: r.fullName,
          url: r.htmlUrl,
          visibility: r.visibility === 'private' ? 'restricted' : 'open',
          archived: r.archived,
        };
      }
      if (repos.length < PAGE_SIZE) return;
    }
  }

  async *listPrincipals(limits: RunLimits = {}): AsyncIterable<SourcePrincipal> {
    for (let page = 1; ; page++) {
      const members = await this.limited(limits, () =>
        this.github.listMembersPage(this.org, page, limits.signal),
      );
      for (const m of members) {
        yield {
          externalId: String(m.id),
          kind: 'user',
          displayName: m.login,
          login: m.login,
          active: true,
        };
      }
      if (members.length < PAGE_SIZE) return;
    }
  }

  private gqlFor(limits: RunLimits): Gql {
    const client = this.github;
    return <T>(query: string, variables: Record<string, unknown>) =>
      this.limited(limits, () => client.graphql(query, variables, limits.signal)) as Promise<T>;
  }

  private fit(doc: KnowledgeDocumentInput): KnowledgeDocumentInput {
    return truncateDocument(doc, this.options.maxDocumentChars);
  }

  /** A batch carrying the run's current checkpoint and whatever notes are waiting. */
  private batchOf(
    run: Run,
    documents: KnowledgeDocumentInput[],
    deletedExternalIds: string[] = [],
    principals: SourcePrincipal[] = [],
  ): ChangeBatch {
    const out: ChangeBatch = {
      documents,
      deletedExternalIds,
      checkpoint: JSON.stringify(run.cp),
      ...(principals.length > 0 ? { principals } : {}),
      ...(run.notes.length > 0 ? { notes: run.notes } : {}),
    };
    run.notes = [];
    return out;
  }

  async *fetchChanges(
    container: SelectedContainer,
    checkpoint: string | null,
    options: FetchChangesOptions,
  ): AsyncIterable<ChangeBatch> {
    const cfg = this.options.knowledge;
    const limits: RunLimits = { signal: options.signal, deadline: options.deadline };
    const run: Run = {
      repo: repoOf(container),
      limits,
      gql: this.gqlFor(limits),
      horizon:
        options.historyDays > 0
          ? new Date(this.now() - options.historyDays * 86_400_000).toISOString()
          : null,
      cp: parseCheckpoint(checkpoint),
      notes: [],
    };

    const kinds: Array<() => AsyncGenerator<ChangeBatch>> = [];
    if (cfg.pullRequests) kinds.push(() => this.syncItems(run, 'pr'));
    if (cfg.issues) kinds.push(() => this.syncIssues(run));
    if (cfg.docs.enabled) kinds.push(() => this.syncDocs(run));

    // The first kind that failed. The others still run: one pull request
    // GitHub cannot serve must not keep the repository's docs from syncing.
    let failure: { error: unknown } | null = null;
    for (const kind of kinds) {
      try {
        yield* kind();
      } catch (err) {
        // GitHub asked for a wait that does not fit this run: nothing more can
        // be fetched. Say what there is to say and let the harness end the
        // run; the checkpoint holds what was stored and the next run goes on.
        if (isRunCutShort(err)) {
          if (run.notes.length > 0) yield this.batchOf(run, []);
          throw err;
        }
        failure ??= { error: err };
      }
    }
    if (run.notes.length > 0) yield this.batchOf(run, []);
    if (failure) throw failure.error;
  }

  /** Pull requests or issues updated since the cursor, oldest first. */
  private async *syncItems(run: Run, kind: ItemKind): AsyncGenerator<ChangeBatch> {
    // The horizon was moved further back than this kind was backfilled to
    // (historyDays was raised): walk again from the new one. Storing is
    // idempotent, so what is already stored costs GitHub calls, not embeddings.
    let cursor = run.cp[kind];
    if (cursor !== null && reachesFurtherBack(run.horizon, run.cp.since?.[kind])) cursor = null;
    const fromTheStart = cursor === null;

    const refs = await listUpdated(run.gql, run.repo, kind === 'pr' ? 'pullRequests' : 'issues', {
      stopBefore: cursor,
      horizon: run.horizon,
    });
    for (const chunk of chunks<UpdatedRef>(refs, this.batchSize)) {
      const numbers = chunk.map((r) => r.number);
      let documents: KnowledgeDocumentInput[];
      let principals: SourcePrincipal[];
      if (kind === 'pr') {
        const prs = await fetchPullRequests(run.gql, run.repo, numbers);
        principals = principalsOf(prs);
        documents = prs.map((pr) => {
          const doc = this.fit(pullRequestDocument(run.repo, pr));
          return pr.reviewsTruncated
            ? { ...doc, attributes: { ...doc.attributes, truncated: true } }
            : doc;
        });
      } else {
        const issues = await fetchIssues(run.gql, run.repo, numbers);
        principals = principalsOf(issues);
        documents = issues.map((issue) => this.fit(issueDocument(run.repo, issue)));
      }
      run.cp = {
        ...run.cp,
        [kind]: chunk[chunk.length - 1]!.updatedAt,
        ...(fromTheStart ? { since: { ...run.cp.since, [kind]: run.horizon } } : {}),
      };
      yield this.batchOf(run, documents, [], principals);
    }
  }

  private async *syncIssues(run: Run): AsyncGenerator<ChangeBatch> {
    if (!this.issuesListable) {
      run.notes.push(NOTE_ISSUES_PERMISSION);
      return;
    }
    try {
      yield* this.syncItems(run, 'issue');
    } catch (err) {
      if (!(err instanceof GraphqlForbiddenError)) throw err;
      this.issuesForbidden = true;
      run.notes.push(NOTE_ISSUES_PERMISSION);
    }
  }

  /** Markdown docs on the default branch: what changed, and what left the tree. */
  private async *syncDocs(run: Run): AsyncGenerator<ChangeBatch> {
    const cfg = this.options.knowledge.docs;
    const head = await fetchRepoHead(run.gql, run.repo);
    if (!head) return;
    // The tree is read again when it moved, and also when the settings that
    // choose the files changed: a new glob must not wait for the next push.
    const docsKey = docsKeyOf(cfg);
    if (head.treeOid === run.cp.tree && run.cp.docsKey === docsKey) return;

    const { blobs, truncated } = await this.limited(run.limits, () =>
      listDocBlobs(this.github.git, run.repo, head.treeOid, cfg),
    );
    if (truncated) run.notes.push(NOTE_TREE_TRUNCATED);
    const present = new Set(blobs.map((b) => b.path));
    // A truncated tree is an incomplete listing: delete nothing by it, and do
    // not record the tree as seen.
    const gone = truncated ? [] : Object.keys(run.cp.docs).filter((path) => !present.has(path));
    const changed = blobs.filter((b) => run.cp.docs[b.path] !== b.sha);
    const docs = { ...run.cp.docs };
    for (const path of gone) delete docs[path];
    const deleted = gone.map((path) => docId(run.repo.id, path));
    // Recorded only with the last batch: until then a restart must list the
    // tree again and fetch what is still missing.
    const seen = truncated ? {} : { tree: head.treeOid, docsKey };

    const groups = [...chunks(changed, this.batchSize)];
    if (groups.length === 0) {
      run.cp = { ...run.cp, docs, ...seen };
      yield this.batchOf(run, [], deleted);
      return;
    }
    for (const [i, group] of groups.entries()) {
      const documents: KnowledgeDocumentInput[] = [];
      for (const blob of group) {
        const text = await this.limited(run.limits, () =>
          fetchBlobText(this.github.git, run.repo, blob.sha),
        );
        documents.push(
          this.fit(
            markdownDocument(run.repo, {
              path: blob.path,
              sha: blob.sha,
              text,
              branch: head.branch,
              committedAt: head.committedAt,
            }),
          ),
        );
        docs[blob.path] = blob.sha;
      }
      const last = i === groups.length - 1;
      run.cp = { ...run.cp, docs: { ...docs }, ...(last ? seen : {}) };
      yield this.batchOf(run, documents, i === 0 ? deleted : []);
    }
  }

  async *listDocumentIds(
    container: SelectedContainer,
    limits: RunLimits = {},
  ): AsyncIterable<string[]> {
    if (!this.issuesListable) return;
    const repo = repoOf(container);
    for await (const numbers of listIssueNumbers(this.gqlFor(limits), repo)) {
      yield numbers.map((n) => issueId(repo.id, n));
    }
  }
}
