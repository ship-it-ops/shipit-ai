// packages/connectors/github/src/knowledge/connector.ts
// The knowledge facet of the GitHub connector: repositories are containers;
// pull requests, issues and Markdown docs are documents. Spec:
// docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §GitHub text.
import type { Octokit } from '@octokit/rest';
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
import { RunBudgetEnded, withRateLimit } from './rate-limit.js';

export const NOTE_ISSUES_PERMISSION = 'issues_permission_missing';
export const NOTE_RATE_LIMITED = 'rate_limited';
export const NOTE_TREE_TRUNCATED = 'tree_truncated';

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
  listRepositories(org: string): AsyncIterable<{
    id: number;
    fullName: string;
    htmlUrl: string;
    visibility: string;
    archived: boolean;
  }>;
  listMembers(org: string): AsyncIterable<{ id: number; login: string }>;
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

interface Checkpoint {
  v: 1;
  pr: string | null;
  issue: string | null;
  tree: string | null;
  /** path → blob sha of every doc that is stored. */
  docs: Record<string, string>;
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
    };
  } catch {
    // A checkpoint this code cannot read starts the container over; storing
    // is idempotent, so the cost is time, not duplicates.
    return { ...EMPTY };
  }
}

function repoOf(container: SelectedContainer): RepoRef {
  const [owner, name] = container.name.split('/');
  if (!owner || !name)
    throw new Error(`container ${container.name} is not an owner/name repository`);
  return { id: Number(container.externalId), owner, name };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export function clientFromOctokit(octokit: Octokit, issuesGranted: boolean): GitHubKnowledgeClient {
  return {
    issuesGranted,
    graphql: (query, variables, signal) =>
      octokit.graphql(query, { ...variables, ...(signal ? { request: { signal } } : {}) }),
    git: octokit.rest.git as unknown as TreeClient,
    async *listRepositories(org) {
      const pages = octokit.paginate.iterator(octokit.rest.repos.listForOrg, {
        org,
        per_page: 100,
        type: 'all',
      });
      for await (const { data } of pages) {
        for (const r of data) {
          yield {
            id: r.id,
            fullName: r.full_name,
            htmlUrl: r.html_url,
            visibility: r.visibility ?? 'private',
            archived: r.archived ?? false,
          };
        }
      }
    },
    async *listMembers(org) {
      const pages = octokit.paginate.iterator(octokit.rest.orgs.listMembers, {
        org,
        per_page: 100,
      });
      for await (const { data } of pages) {
        for (const m of data) yield { id: m.id, login: m.login };
      }
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

  async *listContainers(): AsyncIterable<SourceContainer> {
    for await (const r of this.github.listRepositories(this.org)) {
      yield {
        externalId: String(r.id),
        kind: 'repository',
        name: r.fullName,
        url: r.htmlUrl,
        visibility: r.visibility === 'private' ? 'restricted' : 'open',
        archived: r.archived,
      };
    }
  }

  async *listPrincipals(): AsyncIterable<SourcePrincipal> {
    for await (const m of this.github.listMembers(this.org)) {
      yield {
        externalId: String(m.id),
        kind: 'user',
        displayName: m.login,
        login: m.login,
        active: true,
      };
    }
  }

  private gqlFor(limits: RunLimits): Gql {
    const client = this.github;
    return <T>(query: string, variables: Record<string, unknown>) =>
      withRateLimit(() => client.graphql(query, variables, limits.signal), limits, {
        now: this.now,
      }) as Promise<T>;
  }

  private fit(doc: KnowledgeDocumentInput): KnowledgeDocumentInput {
    return truncateDocument(doc, this.options.maxDocumentChars);
  }

  async *fetchChanges(
    container: SelectedContainer,
    checkpoint: string | null,
    options: FetchChangesOptions,
  ): AsyncIterable<ChangeBatch> {
    const cfg = this.options.knowledge;
    const repo = repoOf(container);
    const limits: RunLimits = { signal: options.signal, deadline: options.deadline };
    const gql = this.gqlFor(limits);
    const horizon =
      options.historyDays > 0
        ? new Date(this.now() - options.historyDays * 86_400_000).toISOString()
        : null;

    let cp = parseCheckpoint(checkpoint);
    // Notes ride on the next batch; a run that produces none still reports them.
    let notes: string[] = [];
    const batch = (
      documents: KnowledgeDocumentInput[],
      deletedExternalIds: string[] = [],
    ): ChangeBatch => {
      const out: ChangeBatch = {
        documents,
        deletedExternalIds,
        checkpoint: JSON.stringify(cp),
        ...(notes.length > 0 ? { notes } : {}),
      };
      notes = [];
      return out;
    };

    try {
      if (cfg.pullRequests) {
        const refs = await listUpdated(gql, repo, 'pullRequests', { stopBefore: cp.pr, horizon });
        for (const chunk of chunks<UpdatedRef>(refs, this.batchSize)) {
          const prs = await fetchPullRequests(
            gql,
            repo,
            chunk.map((r) => r.number),
          );
          const documents = prs.map((pr) => {
            const doc = this.fit(pullRequestDocument(repo, pr));
            return pr.reviewsTruncated
              ? { ...doc, attributes: { ...doc.attributes, truncated: true } }
              : doc;
          });
          cp = { ...cp, pr: chunk[chunk.length - 1]!.updatedAt };
          yield batch(documents);
        }
      }

      if (cfg.issues) {
        if (!this.issuesListable) {
          notes.push(NOTE_ISSUES_PERMISSION);
        } else {
          try {
            const refs = await listUpdated(gql, repo, 'issues', { stopBefore: cp.issue, horizon });
            for (const chunk of chunks<UpdatedRef>(refs, this.batchSize)) {
              const issues = await fetchIssues(
                gql,
                repo,
                chunk.map((r) => r.number),
              );
              cp = { ...cp, issue: chunk[chunk.length - 1]!.updatedAt };
              yield batch(issues.map((issue) => this.fit(issueDocument(repo, issue))));
            }
          } catch (err) {
            if (!(err instanceof GraphqlForbiddenError)) throw err;
            this.issuesForbidden = true;
            notes.push(NOTE_ISSUES_PERMISSION);
          }
        }
      }

      if (cfg.docs.enabled) {
        const head = await fetchRepoHead(gql, repo);
        if (head && head.treeOid !== cp.tree) {
          const rest = <T>(fn: () => Promise<T>): Promise<T> =>
            withRateLimit(fn, limits, { now: this.now });
          const { blobs, truncated } = await rest(() =>
            listDocBlobs(this.github.git, repo, head.treeOid, cfg.docs),
          );
          if (truncated) notes.push(NOTE_TREE_TRUNCATED);
          const present = new Set(blobs.map((b) => b.path));
          // A truncated tree is an incomplete listing: delete nothing by it,
          // and do not record the tree as seen.
          const gone = truncated ? [] : Object.keys(cp.docs).filter((path) => !present.has(path));
          const changed = blobs.filter((b) => cp.docs[b.path] !== b.sha);
          const docs = { ...cp.docs };
          for (const path of gone) delete docs[path];
          const deleted = gone.map((path) => docId(repo.id, path));
          const groups = [...chunks(changed, this.batchSize)];
          if (groups.length === 0) {
            cp = { ...cp, docs, tree: truncated ? cp.tree : head.treeOid };
            yield batch([], deleted);
          }
          for (const [i, group] of groups.entries()) {
            const documents: KnowledgeDocumentInput[] = [];
            for (const blob of group) {
              const text = await rest(() => fetchBlobText(this.github.git, repo, blob.sha));
              documents.push(
                this.fit(
                  markdownDocument(repo, {
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
            // The tree is recorded only with the last batch: until then a
            // restart must list it again and fetch what is still missing.
            cp = { ...cp, docs: { ...docs }, tree: last && !truncated ? head.treeOid : cp.tree };
            yield batch(documents, i === 0 ? deleted : []);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof RunBudgetEnded)) throw err;
      // GitHub asked for a wait that does not fit this run. Not a failure:
      // the checkpoint holds what was stored and the next run continues.
      notes.push(NOTE_RATE_LIMITED);
    }

    if (notes.length > 0) yield batch([]);
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
