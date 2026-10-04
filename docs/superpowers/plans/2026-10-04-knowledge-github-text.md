# Knowledge Layer K1a: GitHub Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub connector's pull requests, issues and Markdown docs are fetched on the knowledge scheduler, stored and indexed, for the repositories an admin selected through the API.

**Architecture:** The GitHub connector package gains a second class, `GitHubKnowledgeConnector`, that implements the SDK's `KnowledgeConnector` contract from K0: repositories are containers, pull requests and issues come from GraphQL, docs come from the default branch's tree. The `github` connector type gains `buildKnowledge`, switched per instance by a new `knowledge` block in the instance config. The api-server gains container routes (list, refresh, select) and an admin gate on connector mutations. No UI and no entity linking in this plan.

**Tech Stack:** TypeScript (ESM, Node 22), `@octokit/rest` 22 (REST and `octokit.graphql`), Zod 4, Vitest 4, `pg` 8 on Postgres 17 with pgvector, BullMQ 5, Fastify 5.

**Spec:** `docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md` (§Sources → GitHub text and the shared rules, §Connector contract including the 2026-10-04 amendments, §Scheduling, §Visibility, §API container routes, §Error handling; Milestone K1). The K0 code this builds on is on `ai-agents-design` at `e0e72c6`.

## Scope: K1 is three plans

Milestone K1 in the spec covers three subsystems that each produce working, testable software on their own. This plan is the first.

| Plan         | Contents                                                                                                                                                  | Depends on |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **K1a** this | GitHub text facet, instance config, container routes, the connector role gate, the permission spike, the first live Vertex embedding.                     | K0         |
| K1b          | Alias dictionary from Neo4j, deterministic entity linking, references, people matching, the migration for links and references, timeline and document API | K1a        |
| K1c          | Web UI: the GitHub connector's Knowledge section, the container picker and acknowledgement dialog, the permission banner, the entity Knowledge tab.       | K1a, K1b   |

At the end of K1a an admin can enable knowledge on a GitHub connector with `PATCH /api/connectors/:id`, select repositories with `PUT /api/connectors/:id/containers/:containerId`, and see documents reach `indexed` in `GET /api/knowledge/status`.

## Global Constraints

- **Run commands from the repo root.** A single test file: `pnpm --filter <package> exec vitest run <path>`.
- **Verify before each commit:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`. Run `npx prettier --write <files>` on what you touch, and only on what you touch: another session works in the same tree.
- **Commits and pushes:** the owner approved committing and pushing as the work proceeds on `ai-agents-design` (2026-10-04). Stage only this plan's paths. No `Co-Authored-By` or other AI trailer.
- **ESM everywhere:** relative imports end in `.js`.
- **No new migration.** K1a adds no table and no column. If a task seems to need one, stop: the next free number is `0005` (the agents workstream holds `0003` and `0004`), and `EXPECTED_SCHEMA_VERSION` must move with it.
- **No new workspace dependency.** `@shipit-ai/connector-github` already depends on `@shipit-ai/connector-sdk` and `@shipit-ai/shared`, and api-server already depends on it. If a task adds one anyway, the consuming package's Dockerfile `COPY` list, its vitest alias list and the lockfile must agree (scar `docker-builder-copies-fixed-package-set`).
- **External ids are stable source ids, never names** (spec §Sources). Exact forms: container `String(repository.id)`; pull request `pr:<repoId>:<number>`; issue `issue:<repoId>:<number>`; doc `doc:<repoId>:<path>`.
- **Document kinds, exact:** `github_pull_request`, `github_issue`, `github_doc`. Container kind `repository`.
- **Visibility mapping, exact:** GitHub `public` and `internal` → `open`; `private` → `restricted`.
- **Instance config defaults, exact (spec §GitHub text):** `knowledge.enabled: false`; `pullRequests: true`; `issues: true`; `docs: { enabled: true, paths: ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md'], maxFileBytes: 200000 }`; `historyDays: 365`.
- **Notes, exact strings:** `issues_permission_missing`, `rate_limited`, `tree_truncated`.
- **Error codes, exact:** `FORBIDDEN` (403, not an admin), `KNOWLEDGE_UNAVAILABLE` (503), `NOT_FOUND` (404), `VISIBILITY_NOT_ACKNOWLEDGED` (409), `KNOWLEDGE_NOT_ENABLED` (409). Envelope `{ error: { code, message } }`.
- **Redaction and storage are not this plan's business.** The connector hands documents to the sink; the sink redacts and stores. Never write to Postgres or Redis from the connector package.
- **Every long call honours the run limits** the harness passes (`signal`, `deadline`): pass `signal` to Octokit as `request: { signal }`, and never sleep past `deadline`.
- **Nothing in the connector logs or returns a token, a private key or a document body.**
- **Never commit `packages/web-ui/next-env.d.ts`.**

## Review Focus

Conditions the spec implies that a person will hit. Each is pinned by a test in the task that owns the code:

1. **An installation has not approved the `issues` permission.** Pull requests and docs keep syncing, the run is a success, the run record carries `issues_permission_missing`, the connector is not marked degraded, and nothing already stored is pruned. → Task 6 (`syncs pull requests and docs and notes the missing issues permission`, `covers no kind while issues cannot be listed`).
2. **A backfill is cut off by the time budget.** The next run continues with the pull requests it had not reached; none is skipped because a newer one was stored first. → Task 4 (`returns the oldest first`), Task 6 (`a second run from the first batch's checkpoint fetches the rest`).
3. **Someone selects a private repository.** It is refused until the request acknowledges that its content becomes visible to every signed-in user. → Task 8 (`refuses a restricted container without the acknowledgement`).
4. **A doc is renamed or deleted, or nothing changed.** The old document is deleted in the same run; an unchanged tree fetches no file at all. → Task 5 (`lists only matching blobs under the size limit`), Task 6 (`deletes a doc that left the tree`, `skips the docs when the tree did not change`).
5. **One pull request is enormous.** More than 100 comments are all fetched; text over `maxDocumentChars` is cut at a segment boundary and flagged, never mid-segment. → Task 3 (`cuts at a segment boundary and flags the document`), Task 4 (`follows the comment cursor`).

One more that tests cannot fully pin and Task 9 checks by hand: GitHub answers a primary rate limit with a wait longer than the run's remaining budget. The run must end with `rate_limited` on the record, not fail, and the next run must resume.

## Spike result (done while writing this plan, 2026-10-04)

The spec left one question for a K1 spike: can `issues: read` be added to a manifest-created GitHub App without recreating it?

**Yes.** GitHub's docs make no distinction for Apps created from a manifest. The App's owner opens the App's settings, **Permissions & events**, changes the repository permission and saves. GitHub then emails each account where the App is installed; "updated permissions won't take effect on an installation … until the new permissions are approved", and until then "the GitHub App will still retain its current permissions". Sources read on 2026-10-04: `docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration` and `docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app`.

Consequences used below:

- The connector reads the installation's granted permissions at authentication (`GET /app/installations/{id}` returns `permissions`) and decides from `permissions.issues`, without provoking a 403.
- The banner text (K1c) is: "Issues are not being indexed. The GitHub App needs the Issues (read) permission: its owner adds it under the App's settings, Permissions & events, and an owner of `<org>` then approves the request GitHub emails."
- The GraphQL shapes used in Tasks 4 and 6 were run against `ship-it-ops/shipit-ai` with `gh api graphql` on 2026-10-04 and returned without errors: the light listing (`pullRequests`/`issues` ordered by `UPDATED_AT` descending with `number` and `updatedAt`), the head query (`defaultBranchRef.target` as `Commit` with `oid`, `committedDate`, `tree.oid`), and the aliased full pull-request query at cost 1.

**Not done in the spike:** nothing was called with an installation token, so the exact body of an issues query on an installation without the permission was not observed. That is why the connector decides from the installation's `permissions` and treats a `FORBIDDEN` GraphQL error on issues the same way.

## File Structure

| Path                                                           | Responsibility                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/api-server/config/github-app-manifest.json`          | Gains `issues: read` and the `issues` and `issue_comment` events.                                     |
| `packages/shared/src/config/schema.ts`                         | The `knowledge` block on the GitHub connector instance.                                               |
| `packages/connectors/github/src/knowledge/ids.ts`              | External id builders and parsers.                                                                     |
| `packages/connectors/github/src/knowledge/markdown.ts`         | `splitMarkdownByHeading`.                                                                             |
| `packages/connectors/github/src/knowledge/documents.ts`        | GraphQL node → `KnowledgeDocumentInput` for pull requests, issues and docs; `truncateDocument`.       |
| `packages/connectors/github/src/knowledge/graphql.ts`          | The queries: light listing, full pull requests and issues by number, comment paging, repository head. |
| `packages/connectors/github/src/knowledge/docs.ts`             | Glob matching, tree listing, blob fetch.                                                              |
| `packages/connectors/github/src/knowledge/rate-limit.ts`       | Recognising a rate-limit answer and waiting inside the run's limits.                                  |
| `packages/connectors/github/src/knowledge/connector.ts`        | `GitHubKnowledgeConnector`: the SDK contract over the pieces above, with the composite checkpoint.    |
| `packages/api-server/src/services/connector-types/github.ts`   | `buildKnowledge` and `knowledgeEnabled`.                                                              |
| `packages/api-server/src/services/connector-types/types.ts`    | `knowledgeEnabled?` on `ConnectorType`; `maxDocumentChars?` on `BuildContext`.                        |
| `packages/api-server/src/services/knowledge-sync-scheduler.ts` | `handles` honours `knowledgeEnabled`; `refreshContainers`.                                            |
| `packages/api-server/src/middleware/require-auth.ts`           | `requireAdmin`.                                                                                       |
| `packages/api-server/src/routes/connectors.ts`                 | The admin gate on every mutation; `knowledge` in the PATCH body.                                      |
| `packages/api-server/src/routes/connector-containers.ts`       | `GET /:id/containers`, `POST /:id/containers/refresh`, `PUT /:id/containers/:containerId`.            |
| `packages/knowledge/src/store.ts`                              | `containersWithCounts`, `getContainer`, `selectContainer`, `purgeRequested`.                          |
| `packages/knowledge-worker/src/main.ts`                        | Runs `purgeRequested` every minute.                                                                   |
| `packages/knowledge/src/chunking.ts`                           | Hard cuts never split a surrogate pair (left over from the K0 audit).                                 |

---

## Task 1: The App manifest asks for issues

**Files:**

- Modify: `packages/api-server/config/github-app-manifest.json`
- Test: `packages/api-server/src/__tests__/config/github-app-manifest.test.ts` (create)

**Interfaces:**

- Consumes: nothing.
- Produces: a manifest whose `default_permissions.issues` is `"read"` and whose `default_events` include `"issues"` and `"issue_comment"`. Apps created from now on have the permission; existing Apps follow the spike's steps. The webhook receiver already answers `202 { ok: true, ignored: <event> }` to an event it does not handle (`routes/webhooks.ts`), so the two new events need no receiver change in this plan.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api-server/src/__tests__/config/github-app-manifest.test.ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, '../../../config/github-app-manifest.json'), 'utf8'),
) as { default_permissions: Record<string, string>; default_events: string[] };

describe('GitHub App manifest', () => {
  it('asks to read issues, for the knowledge facet', () => {
    expect(manifest.default_permissions.issues).toBe('read');
    expect(manifest.default_events).toEqual(expect.arrayContaining(['issues', 'issue_comment']));
  });

  it('asks for nothing it can write', () => {
    for (const [name, level] of Object.entries(manifest.default_permissions)) {
      expect(level, name).toBe('read');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/config/github-app-manifest.test.ts`
Expected: FAIL, `expected undefined to be 'read'`.

- [ ] **Step 3: Change the manifest**

```diff
     "members": "read",
-    "pull_requests": "read"
+    "pull_requests": "read",
+    "issues": "read"
   },
   "default_events": [
     "push",
     "pull_request",
+    "issues",
+    "issue_comment",
     "workflow_run",
```

Also extend the `description` string's permission list with "issues" so the consent screen text matches: replace `Read-only access to repositories, teams, members, workflows, deployments, and branch-protection state.` with `Read-only access to repositories, pull requests, issues, teams, members, workflows, deployments, and branch-protection state.`

- [ ] **Step 4: Run the test and the existing manifest and webhook suites**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/config src/__tests__/routes/connectors.test.ts src/__tests__/routes/webhooks.test.ts`
Expected: PASS. If a connectors test pins the old `description` or the old event list, update that expectation to the new values; do not weaken it.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/api-server/config/github-app-manifest.json packages/api-server/src/__tests__/config/github-app-manifest.test.ts
git add packages/api-server/config/github-app-manifest.json packages/api-server/src/__tests__/config/github-app-manifest.test.ts
git commit -m "api-server: the GitHub App manifest asks to read issues"
```

---

## Task 2: The `knowledge` block on a GitHub connector, and a per-instance switch on the scheduler

**Files:**

- Modify: `packages/shared/src/config/schema.ts` (the GitHub connector schema, around line 139)
- Modify: `packages/shared/src/config/index.ts`, `packages/shared/src/index.ts` (export the type)
- Modify: `packages/api-server/src/services/connector-types/types.ts`
- Modify: `packages/api-server/src/services/knowledge-sync-scheduler.ts`
- Modify: `packages/api-server/src/services/connector-registry.ts` (`update`, around line 305), `packages/api-server/src/routes/connectors.ts` (`UpdateConnectorBody` and the PATCH handler)
- Test: `packages/shared/src/__tests__/github-knowledge-config.test.ts` (create), `packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts`

**Interfaces:**

- Consumes: `githubConnectorSchema`, `ConnectorType`, `KnowledgeSyncScheduler.handles`.
- Produces:
  - `GitHubKnowledgeConfig = { enabled: boolean; pullRequests: boolean; issues: boolean; docs: { enabled: boolean; paths: string[]; maxFileBytes: number }; historyDays: number }`, exported from `@shipit-ai/shared`, and `GitHubConnectorConfig['knowledge']` of that type, always present after parsing.
  - `ConnectorType.knowledgeEnabled?(cfg: C): boolean`. Absent means "on whenever `buildKnowledge` exists".
  - `KnowledgeSyncScheduler.handles(cfg)` is true only when the type has `buildKnowledge` and `knowledgeEnabled` (when present) returns true.
  - `PATCH /api/connectors/:id` accepts `knowledge` and stores it for a GitHub connector.

- [ ] **Step 1: Write the failing config test**

```ts
// packages/shared/src/__tests__/github-knowledge-config.test.ts
import { describe, it, expect } from 'vitest';
import { connectorInstanceSchema } from '../config/index.js';

const parseConnectorInstance = (value: unknown) => connectorInstanceSchema.parse(value);

const base = { id: 'gh-1', type: 'github', name: 'acme', installationId: '1', org: 'acme' };

describe('GitHub connector knowledge block', () => {
  it('is off by default, with every default the spec lists', () => {
    const cfg = parseConnectorInstance(base);
    if (cfg.type !== 'github') throw new Error('expected a github connector');
    expect(cfg.knowledge).toEqual({
      enabled: false,
      pullRequests: true,
      issues: true,
      docs: {
        enabled: true,
        paths: ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md'],
        maxFileBytes: 200000,
      },
      historyDays: 365,
    });
  });

  it('fills the rest when only a part is given', () => {
    const cfg = parseConnectorInstance({ ...base, knowledge: { enabled: true, issues: false } });
    if (cfg.type !== 'github') throw new Error('expected a github connector');
    expect(cfg.knowledge.enabled).toBe(true);
    expect(cfg.knowledge.issues).toBe(false);
    expect(cfg.knowledge.docs.maxFileBytes).toBe(200000);
  });

  it('rejects a negative history and an empty path', () => {
    expect(() => parseConnectorInstance({ ...base, knowledge: { historyDays: -1 } })).toThrow();
    expect(() =>
      parseConnectorInstance({ ...base, knowledge: { docs: { paths: [''] } } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @shipit-ai/shared exec vitest run src/__tests__/github-knowledge-config.test.ts`
Expected: FAIL, `cfg.knowledge` is `undefined`.

- [ ] **Step 3: Add the schema**

In `packages/shared/src/config/schema.ts`, above `const githubConnectorSchema`:

```ts
// ── The knowledge facet of a GitHub connector ─────────────────────────────
// Off by default: turning it on makes the connector fetch pull requests,
// issues and Markdown docs for the repositories an admin selects. Spec:
// docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §GitHub text.
const GITHUB_KNOWLEDGE_DOC_PATHS = ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md'];

const githubKnowledgeDocsSchema = z.object({
  enabled: z.boolean().default(true),
  // Globs over repository paths on the default branch. `**` crosses directories.
  paths: z.array(z.string().min(1)).default(GITHUB_KNOWLEDGE_DOC_PATHS),
  maxFileBytes: z.number().int().positive().default(200000),
});

const githubKnowledgeSchema = z.object({
  enabled: z.boolean().default(false),
  pullRequests: z.boolean().default(true),
  issues: z.boolean().default(true),
  docs: githubKnowledgeDocsSchema.default({
    enabled: true,
    paths: GITHUB_KNOWLEDGE_DOC_PATHS,
    maxFileBytes: 200000,
  }),
  // Backfill horizon in days; 0 means everything.
  historyDays: z.number().int().nonnegative().default(365),
});

export type GitHubKnowledgeConfig = z.infer<typeof githubKnowledgeSchema>;
```

and inside `githubConnectorSchema`, after `entities: githubEntitiesSchema,`:

```ts
  knowledge: githubKnowledgeSchema.default({
    enabled: false,
    pullRequests: true,
    issues: true,
    docs: { enabled: true, paths: GITHUB_KNOWLEDGE_DOC_PATHS, maxFileBytes: 200000 },
    historyDays: 365,
  }),
```

Export `GitHubKnowledgeConfig` wherever `GitHubConnectorConfig` is re-exported (`packages/shared/src/config/index.ts` and `packages/shared/src/index.ts`): add it to the same `export type { … }` lists.

- [ ] **Step 4: Run the config test, then the whole shared suite**

Run: `pnpm --filter @shipit-ai/shared test`
Expected: PASS. A snapshot or `toEqual` on a full parsed GitHub connector elsewhere in the workspace now sees the extra `knowledge` key; add the default block to that expectation.

- [ ] **Step 5: Write the failing scheduler tests**

Append inside `describe('KnowledgeSyncScheduler', …)` in `packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts`:

```ts
it('does not schedule an instance whose type says knowledge is off for it', async () => {
  const type = {
    ...fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    knowledgeEnabled: () => false,
  } as unknown as ConnectorType;
  const s = scheduler(type);
  expect(s.handles(connectorCfg)).toBe(false);
  await s.start(connectorCfg);
  expect(queue.schedulers.size).toBe(0);
});

it('drops a queued job for an instance that switched knowledge off', async () => {
  const type = {
    ...fixtureType(
      createFixtureKnowledgeConnector({
        containers: [C1],
        documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
      }),
    ),
    knowledgeEnabled: () => false,
  } as unknown as ConnectorType;
  const s = scheduler(type);
  await s.runJob('fx-1', 'poll');
  expect(stored).toBe(0);
  expect(runs).toHaveLength(0);
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/knowledge-sync-scheduler.test.ts`
Expected: FAIL: `handles` returns true, and the second test records a run.

- [ ] **Step 7: Implement**

`packages/api-server/src/services/connector-types/types.ts`, inside `ConnectorType`, after `buildKnowledge?`:

```ts
  /**
   * Whether THIS instance has its knowledge facet switched on. Absent: on for
   * every instance of a type that has `buildKnowledge` (Slack, Atlassian).
   * GitHub answers from `cfg.knowledge.enabled`.
   */
  knowledgeEnabled?(cfg: C): boolean;
```

and inside `BuildContext`, after `listConnectors()`:

```ts
  /** knowledge.index.maxDocumentChars, for knowledge connectors to truncate at. */
  maxDocumentChars?: number;
```

`packages/api-server/src/services/knowledge-sync-scheduler.ts`:

```diff
   handles(cfg: ConnectorInstanceConfig): boolean {
-    return Boolean(this.resolveType(cfg.type)?.buildKnowledge);
+    const type = this.resolveType(cfg.type);
+    if (!type?.buildKnowledge) return false;
+    return type.knowledgeEnabled ? type.knowledgeEnabled(cfg) : true;
   }
```

and in `runJobNow`, right after the `registry.get` try/catch:

```ts
// Knowledge was switched off for this instance after the job was queued.
if (!this.handles(cfg)) return;
```

then remove the now-unreachable "has no knowledge facet" `failRun` branch below it only if TypeScript reports it unreachable; otherwise leave it as the guard for a type that loses `buildKnowledge`.

`packages/api-server/src/services/connector-registry.ts`, in `update`: add `knowledge?: unknown` to `UpdateConnectorInput`, and

```diff
     if (existing.type === 'github') {
       // `app: null` clears an existing override; `app: {...}` replaces it; `app: undefined` leaves it alone.
       patch.app =
         input.app === null ? undefined : input.app !== undefined ? input.app : existing.app;
+      // The knowledge block is replaced whole, like scope and entities.
+      if (input.knowledge !== undefined) patch.knowledge = input.knowledge;
     }
```

`packages/api-server/src/routes/connectors.ts`: add `knowledge?: unknown;` to `UpdateConnectorBody` and `knowledge: request.body?.knowledge,` to the object passed to `registry.update`.

- [ ] **Step 8: Run the scheduler suite, the registry and connectors route suites**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/knowledge-sync-scheduler.test.ts src/__tests__/services/connector-registry.test.ts src/__tests__/routes/connectors.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm typecheck
git add packages/shared/src packages/api-server/src/services/connector-types/types.ts packages/api-server/src/services/knowledge-sync-scheduler.ts packages/api-server/src/services/connector-registry.ts packages/api-server/src/routes/connectors.ts packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts
git commit -m "config: knowledge block on a GitHub connector; the knowledge scheduler honours a per-instance switch"
```

---

## Task 3: Turning GitHub content into documents

Pure functions, no network. Everything a later task fetches goes through these.

**Files:**

- Create: `packages/connectors/github/src/knowledge/ids.ts`, `markdown.ts`, `documents.ts`
- Test: `packages/connectors/github/src/knowledge/__tests__/markdown.test.ts`, `documents.test.ts`

**Interfaces:**

- Consumes: `KnowledgeDocumentInput`, `DocumentSegment` from `@shipit-ai/connector-sdk`.
- Produces:
  - `ids.ts`: `pullRequestId(repoId: number, n: number): string`, `issueId(repoId: number, n: number): string`, `docId(repoId: number, path: string): string`.
  - `markdown.ts`: `splitMarkdownByHeading(markdown: string): Array<{ key: string; headingPath: string[]; text: string }>`.
  - `documents.ts`:
    - `interface RepoRef { id: number; owner: string; name: string }`
    - `interface GqlActor { login: string; databaseId?: number | null } `
    - `interface GqlComment { databaseId: number | null; url: string; createdAt: string; body: string; author: GqlActor | null }`
    - `interface GqlReview { databaseId: number | null; url: string; state: string; submittedAt: string | null; body: string; author: GqlActor | null; comments: { nodes: Array<GqlComment & { path: string }> } }`
    - `interface GqlIssueLike { number: number; title: string; body: string; url: string; state: string; createdAt: string; updatedAt: string; author: GqlActor | null; labels: { nodes: Array<{ name: string }> }; comments: { nodes: GqlComment[] } }`
    - `interface GqlPullRequest extends GqlIssueLike { merged: boolean; isDraft: boolean; baseRefName: string; headRefName: string; reviews: { nodes: GqlReview[] } }`
    - `pullRequestDocument(repo: RepoRef, pr: GqlPullRequest): KnowledgeDocumentInput`
    - `issueDocument(repo: RepoRef, issue: GqlIssueLike): KnowledgeDocumentInput`
    - `markdownDocument(repo: RepoRef, file: { path: string; sha: string; text: string; branch: string; committedAt: string }): KnowledgeDocumentInput`
    - `truncateDocument(doc: KnowledgeDocumentInput, maxChars: number): KnowledgeDocumentInput`

- [ ] **Step 1: Write the failing markdown tests**

````ts
// packages/connectors/github/src/knowledge/__tests__/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { splitMarkdownByHeading } from '../markdown.js';

describe('splitMarkdownByHeading', () => {
  it('gives each section its heading path', () => {
    const out = splitMarkdownByHeading(
      [
        'intro line',
        '# Deploy',
        'how to deploy',
        '## Rollback',
        'drain first',
        '# FAQ',
        'q and a',
      ].join('\n'),
    );
    expect(out.map((s) => [s.headingPath, s.text])).toEqual([
      [[], 'intro line'],
      [['Deploy'], 'how to deploy'],
      [['Deploy', 'Rollback'], 'drain first'],
      [['FAQ'], 'q and a'],
    ]);
  });

  it('does not read a # inside a code fence as a heading', () => {
    const out = splitMarkdownByHeading(
      ['# Setup', '```sh', '# not a heading', 'make', '```'].join('\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('# not a heading');
  });

  it('drops sections with no text and keeps keys unique', () => {
    const out = splitMarkdownByHeading(['# A', '# A', 'one', '# A', 'two'].join('\n'));
    expect(out.map((s) => s.text)).toEqual(['one', 'two']);
    expect(new Set(out.map((s) => s.key)).size).toBe(2);
  });

  it('strips closing hashes and surrounding space from a heading', () => {
    expect(splitMarkdownByHeading('##  Title ##\nbody')[0]!.headingPath).toEqual(['Title']);
  });

  it('returns nothing for an empty file', () => {
    expect(splitMarkdownByHeading('  \n\n')).toEqual([]);
  });
});
````

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/markdown.test.ts`
Expected: FAIL, cannot resolve `../markdown.js`.

- [ ] **Step 3: Implement `ids.ts` and `markdown.ts`**

```ts
// packages/connectors/github/src/knowledge/ids.ts
// External ids of GitHub knowledge documents. Built on the repository's
// numeric id, which survives a rename or a transfer; names do not.
export const pullRequestId = (repoId: number, n: number): string => `pr:${repoId}:${n}`;
export const issueId = (repoId: number, n: number): string => `issue:${repoId}:${n}`;
export const docId = (repoId: number, path: string): string => `doc:${repoId}:${path}`;
```

````ts
// packages/connectors/github/src/knowledge/markdown.ts
// Splits a Markdown file into one segment per heading section. ATX headings
// only (`# Title`); a `#` inside a fenced code block is content.
export interface MarkdownSection {
  /** Stable within the file: the heading path, numbered when it repeats. */
  key: string;
  headingPath: string[];
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

export function splitMarkdownByHeading(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const seen = new Map<string, number>();
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const headingPath = stack.map((h) => h.title);
    const base = headingPath.join(' › ') || '(top)';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    sections.push({ key: n === 1 ? base : `${base} #${n}`, headingPath, text });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line.trimStart());
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
      buffer.push(line);
      continue;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = heading[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title: heading[2]! });
  }
  flush();
  return sections;
}
````

- [ ] **Step 4: Run the markdown tests**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/markdown.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing document tests**

```ts
// packages/connectors/github/src/knowledge/__tests__/documents.test.ts
import { describe, it, expect } from 'vitest';
import {
  issueDocument,
  markdownDocument,
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
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/documents.test.ts`
Expected: FAIL, cannot resolve `../documents.js`.

- [ ] **Step 7: Implement `documents.ts`**

```ts
// packages/connectors/github/src/knowledge/documents.ts
// GitHub content → KnowledgeDocumentInput. Pure: the fetchers hand in what the
// API returned, the connector hands the result to the sink.
import type { DocumentSegment, KnowledgeDocumentInput } from '@shipit-ai/connector-sdk';
import { docId, issueId, pullRequestId } from './ids.js';
import { splitMarkdownByHeading } from './markdown.js';

export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

export interface GqlActor {
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
```

- [ ] **Step 8: Run the document tests, then the package**

Run: `pnpm --filter @shipit-ai/connector-github test`
Expected: PASS, including the three existing files.

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/connectors/github/src/knowledge
pnpm --filter @shipit-ai/connector-github typecheck
git add packages/connectors/github/src/knowledge
git commit -m "connector-github: GitHub pull requests, issues and Markdown docs as knowledge documents"
```

---

## Task 4: The GraphQL fetchers

**Files:**

- Create: `packages/connectors/github/src/knowledge/graphql.ts`
- Test: `packages/connectors/github/src/knowledge/__tests__/graphql.test.ts`

**Interfaces:**

- Consumes: `RepoRef`, `GqlPullRequest`, `GqlIssueLike`, `GqlComment` from `./documents.js` (Task 3).
- Produces:
  - `type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>`: one GraphQL call. The connector builds it over `octokit.graphql`; tests pass a fake.
  - `interface UpdatedRef { number: number; updatedAt: string }`
  - `interface RepoHead { branch: string; commitOid: string; committedAt: string; treeOid: string }`
  - `listUpdated(gql: Gql, repo: RepoRef, connection: 'pullRequests' | 'issues', opts: { stopBefore: string | null; horizon: string | null }): Promise<UpdatedRef[]>`: every item updated at or after `stopBefore` and after `horizon`, **oldest first**.
  - `listIssueNumbers(gql: Gql, repo: RepoRef): AsyncIterable<number[]>`: every issue number that exists, in pages.
  - `fetchPullRequests(gql: Gql, repo: RepoRef, numbers: number[]): Promise<Array<GqlPullRequest & { reviewsTruncated: boolean }>>` and `fetchIssues(gql: Gql, repo: RepoRef, numbers: number[]): Promise<GqlIssueLike[]>`: full items in the order asked, an item that no longer exists left out, every issue comment fetched however many there are.
  - `fetchRepoHead(gql: Gql, repo: RepoRef): Promise<RepoHead | null>`: null for an empty repository.
  - `class GraphqlForbiddenError extends Error`: thrown when GitHub answers `FORBIDDEN` for the installation.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/graphql.test.ts`
Expected: FAIL, cannot resolve `../graphql.js`.

- [ ] **Step 3: Implement `graphql.ts`**

```ts
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

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
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
    const data: { repository: { items: Connection<UpdatedRef> } } = await gql(query, {
      ...repoVars(repo),
      after,
    });
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
    const data: { repository: { items: Connection<{ number: number }> } } = await gql(query, {
      ...repoVars(repo),
      after,
    });
    const { nodes, pageInfo } = data.repository.items;
    yield nodes.map((n) => n.number);
    if (!pageInfo.hasNextPage) return;
    after = pageInfo.endCursor;
  }
}

interface GraphqlFailure {
  errors?: Array<{ type?: string }>;
  data?: { repository?: Record<string, unknown> | null } | null;
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
    const failure = err as GraphqlFailure;
    const types = (failure.errors ?? []).map((e) => e.type);
    if (types.includes('FORBIDDEN')) {
      throw new GraphqlForbiddenError(err instanceof Error ? err.message : String(err));
    }
    const partial = failure.data?.repository;
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/graphql.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/connectors/github/src/knowledge
pnpm --filter @shipit-ai/connector-github typecheck
git add packages/connectors/github/src/knowledge
git commit -m "connector-github: GraphQL fetchers for pull requests, issues and the repository head"
```

---

## Task 5: Docs from the default branch's tree, and waiting out a rate limit

**Files:**

- Create: `packages/connectors/github/src/knowledge/docs.ts`, `rate-limit.ts`
- Test: `packages/connectors/github/src/knowledge/__tests__/docs.test.ts`, `rate-limit.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `docs.ts`:
    - `globToRegExp(glob: string): RegExp`: `**/` matches any number of directories including none, `*` matches within one path segment, everything else is literal. The whole path must match.
    - `matchesAny(path: string, globs: string[]): boolean`
    - `interface TreeClient { getTree(args: { owner: string; repo: string; tree_sha: string; recursive: 'true' }): Promise<{ data: { truncated?: boolean; tree: Array<{ path?: string; type?: string; sha?: string; size?: number }> } }>; getBlob(args: { owner: string; repo: string; file_sha: string }): Promise<{ data: { content: string; encoding: string } }> }`: the two `octokit.rest.git` methods used.
    - `listDocBlobs(git: TreeClient, repo: { owner: string; name: string }, treeSha: string, cfg: { paths: string[]; maxFileBytes: number }): Promise<{ blobs: Array<{ path: string; sha: string }>; truncated: boolean }>`, blobs sorted by path.
    - `fetchBlobText(git: TreeClient, repo: { owner: string; name: string }, sha: string): Promise<string>`
  - `rate-limit.ts`:
    - `class RunBudgetEnded extends Error`: the wait GitHub asked for does not fit the run.
    - `rateLimitWaitMs(err: unknown, now: number): number | null`: milliseconds to wait when `err` is a rate-limit answer, else null.
    - `withRateLimit<T>(fn: () => Promise<T>, limits: { signal?: AbortSignal; deadline?: number }, deps?: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; maxWaits?: number }): Promise<T>`

- [ ] **Step 1: Write the failing docs tests**

```ts
// packages/connectors/github/src/knowledge/__tests__/docs.test.ts
import { describe, it, expect } from 'vitest';
import { fetchBlobText, globToRegExp, listDocBlobs, matchesAny, type TreeClient } from '../docs.js';

const DEFAULTS = ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md'];

describe('globs', () => {
  it.each([
    ['README.md', true],
    ['sub/README.md', false],
    ['docs/a.md', true],
    ['docs/deep/er/a.md', true],
    ['docs/a.txt', false],
    ['adr/0001-use-postgres.md', true],
    ['ADR-7.md', true],
    ['services/pay/ADR-12-ledger.md', true],
    ['src/readme.md', false],
    ['docsx/a.md', false],
  ])('%s → %s under the default paths', (path, expected) => {
    expect(matchesAny(path, DEFAULTS)).toBe(expected);
  });

  it('treats a dot and other regex characters literally', () => {
    expect(globToRegExp('a.md').test('axmd')).toBe(false);
    expect(globToRegExp('a+b(1).md').test('a+b(1).md')).toBe(true);
  });

  it('does not let a single star cross a directory', () => {
    expect(globToRegExp('docs/*.md').test('docs/a/b.md')).toBe(false);
  });
});

function gitWith(tree: unknown[], truncated = false, blobs: Record<string, string> = {}) {
  const calls: string[] = [];
  const git: TreeClient = {
    async getTree(args) {
      calls.push(`tree:${args.tree_sha}`);
      return { data: { truncated, tree: tree as never } };
    },
    async getBlob(args) {
      calls.push(`blob:${args.file_sha}`);
      return {
        data: {
          content: Buffer.from(blobs[args.file_sha] ?? '').toString('base64'),
          encoding: 'base64',
        },
      };
    },
  };
  return { git, calls };
}

describe('listDocBlobs', () => {
  it('lists only matching blobs under the size limit, sorted by path', async () => {
    const { git } = gitWith([
      { path: 'docs/b.md', type: 'blob', sha: 's2', size: 10 },
      { path: 'README.md', type: 'blob', sha: 's1', size: 10 },
      { path: 'docs', type: 'tree', sha: 't1' },
      { path: 'docs/huge.md', type: 'blob', sha: 's3', size: 999999 },
      { path: 'src/index.ts', type: 'blob', sha: 's4', size: 10 },
    ]);
    const out = await listDocBlobs(git, { owner: 'acme', name: 'payments' }, 'tree1', {
      paths: DEFAULTS,
      maxFileBytes: 200000,
    });
    expect(out).toEqual({
      blobs: [
        { path: 'README.md', sha: 's1' },
        { path: 'docs/b.md', sha: 's2' },
      ],
      truncated: false,
    });
  });

  it('reports a tree GitHub truncated', async () => {
    const { git } = gitWith([], true);
    const out = await listDocBlobs(git, { owner: 'a', name: 'b' }, 't', {
      paths: DEFAULTS,
      maxFileBytes: 1,
    });
    expect(out.truncated).toBe(true);
  });
});

describe('fetchBlobText', () => {
  it('decodes base64 as UTF-8', async () => {
    const { git } = gitWith([], false, { s1: '# Título\ncuerpo' });
    expect(await fetchBlobText(git, { owner: 'a', name: 'b' }, 's1')).toBe('# Título\ncuerpo');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/docs.test.ts`
Expected: FAIL, cannot resolve `../docs.js`.

- [ ] **Step 3: Implement `docs.ts`**

```ts
// packages/connectors/github/src/knowledge/docs.ts
// Markdown docs come from the default branch's tree: one listing per run, then
// one blob per file whose sha changed. Spec §GitHub text, "Docs".

// "**" followed by "/" crosses directories (including none); "*" stays inside one segment.
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      out += '(?:[^/]+/)*';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      out += '[^/]*';
    } else {
      out += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** The two octokit.rest.git methods this module calls. */
export interface TreeClient {
  getTree(args: { owner: string; repo: string; tree_sha: string; recursive: 'true' }): Promise<{
    data: {
      truncated?: boolean;
      tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
    };
  }>;
  getBlob(args: {
    owner: string;
    repo: string;
    file_sha: string;
  }): Promise<{ data: { content: string; encoding: string } }>;
}

export async function listDocBlobs(
  git: TreeClient,
  repo: { owner: string; name: string },
  treeSha: string,
  cfg: { paths: string[]; maxFileBytes: number },
): Promise<{ blobs: Array<{ path: string; sha: string }>; truncated: boolean }> {
  const { data } = await git.getTree({
    owner: repo.owner,
    repo: repo.name,
    tree_sha: treeSha,
    recursive: 'true',
  });
  const matchers = cfg.paths.map(globToRegExp);
  const blobs = data.tree
    .filter(
      (e): e is { path: string; type: string; sha: string; size?: number } =>
        e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string',
    )
    .filter((e) => (e.size ?? 0) <= cfg.maxFileBytes && matchers.some((m) => m.test(e.path)))
    .map((e) => ({ path: e.path, sha: e.sha }))
    // Code-point order, not locale order: the same on every machine.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { blobs, truncated: data.truncated === true };
}

export async function fetchBlobText(
  git: TreeClient,
  repo: { owner: string; name: string },
  sha: string,
): Promise<string> {
  const { data } = await git.getBlob({ owner: repo.owner, repo: repo.name, file_sha: sha });
  return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}
```

- [ ] **Step 4: Run the docs tests**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing rate-limit tests**

```ts
// packages/connectors/github/src/knowledge/__tests__/rate-limit.test.ts
import { describe, it, expect } from 'vitest';
import { RunBudgetEnded, rateLimitWaitMs, withRateLimit } from '../rate-limit.js';

const limited = (headers: Record<string, string>, status = 403) =>
  Object.assign(new Error('rate limited'), { status, response: { headers } });

describe('rateLimitWaitMs', () => {
  it('reads Retry-After in seconds', () => {
    expect(rateLimitWaitMs(limited({ 'retry-after': '30' }, 429), 0)).toBe(30_000);
  });

  it('reads the reset time when the primary limit is spent', () => {
    const err = limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' });
    expect(rateLimitWaitMs(err, 990_000)).toBe(11_000); // to the reset, plus a second
  });

  it('is null for a 403 that is not a rate limit, and for other errors', () => {
    expect(rateLimitWaitMs(limited({ 'x-ratelimit-remaining': '4000' }), 0)).toBeNull();
    expect(rateLimitWaitMs(Object.assign(new Error('x'), { status: 500 }), 0)).toBeNull();
    expect(rateLimitWaitMs(null, 0)).toBeNull();
  });
});

describe('withRateLimit', () => {
  it('waits and tries again', async () => {
    let n = 0;
    const slept: number[] = [];
    const out = await withRateLimit(
      async () => {
        n += 1;
        if (n === 1) throw limited({ 'retry-after': '2' }, 429);
        return 'ok';
      },
      { deadline: 100_000 },
      { now: () => 0, sleep: async (ms) => void slept.push(ms) },
    );
    expect(out).toBe('ok');
    expect(slept).toEqual([2_000]);
  });

  it('ends the run when the wait does not fit before the deadline', async () => {
    await expect(
      withRateLimit(
        async () => {
          throw limited({ 'retry-after': '600' }, 429);
        },
        { deadline: 60_000 },
        { now: () => 0, sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(RunBudgetEnded);
  });

  it('gives up after the allowed number of waits', async () => {
    let n = 0;
    await expect(
      withRateLimit(
        async () => {
          n += 1;
          throw limited({ 'retry-after': '1' }, 429);
        },
        {},
        { now: () => 0, sleep: async () => undefined, maxWaits: 2 },
      ),
    ).rejects.toThrow('rate limited');
    expect(n).toBe(3);
  });

  it('passes other errors straight through', async () => {
    await expect(
      withRateLimit(async () => {
        throw new Error('boom');
      }, {}),
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/rate-limit.test.ts`
Expected: FAIL, cannot resolve `../rate-limit.js`.

- [ ] **Step 7: Implement `rate-limit.ts`**

```ts
// packages/connectors/github/src/knowledge/rate-limit.ts
// Spec §Sources: every call honours Retry-After; a rate limit pauses the job,
// it does not fail the run; a wait that outlives the run's budget ends the run.

/** The wait GitHub asked for does not fit in what is left of the run. */
export class RunBudgetEnded extends Error {
  constructor(waitMs: number) {
    super(`GitHub asked to wait ${Math.ceil(waitMs / 1000)} s, past the end of this run`);
    this.name = 'RunBudgetEnded';
  }
}

interface HttpError {
  status?: number;
  response?: { headers?: Record<string, string | number | undefined> };
}

/** Milliseconds to wait when `err` is a rate-limit answer; null when it is something else. */
export function rateLimitWaitMs(err: unknown, now: number): number | null {
  const e = (err ?? {}) as HttpError;
  if (e.status !== 403 && e.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (String(headers['x-ratelimit-remaining']) === '0') {
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now) + 1000;
  }
  // A 429 with no hint: back off a minute.
  return e.status === 429 ? 60_000 : null;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export async function withRateLimit<T>(
  fn: () => Promise<T>,
  limits: { signal?: AbortSignal; deadline?: number },
  deps: {
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    maxWaits?: number;
  } = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const maxWaits = deps.maxWaits ?? 3;
  for (let waits = 0; ; waits++) {
    try {
      return await fn();
    } catch (err) {
      const waitMs = rateLimitWaitMs(err, now());
      if (waitMs === null || waits >= maxWaits) throw err;
      if (limits.deadline !== undefined && now() + waitMs > limits.deadline) {
        throw new RunBudgetEnded(waitMs);
      }
      await sleep(waitMs, limits.signal);
    }
  }
}
```

- [ ] **Step 8: Run both test files**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/docs.test.ts src/knowledge/__tests__/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/connectors/github/src/knowledge
pnpm --filter @shipit-ai/connector-github typecheck
git add packages/connectors/github/src/knowledge
git commit -m "connector-github: doc files from the repository tree; rate-limit waits inside the run budget"
```

---

## Task 6: `GitHubKnowledgeConnector`

**Files:**

- Create: `packages/connectors/github/src/knowledge/connector.ts`, `packages/connectors/github/src/knowledge/index.ts`
- Modify: `packages/connectors/github/src/index.ts`
- Test: `packages/connectors/github/src/knowledge/__tests__/connector.test.ts`

**Interfaces:**

- Consumes: everything Tasks 3 to 5 produce; `GitHubKnowledgeConfig` (Task 2); `authenticateGitHubApp` from `../auth.js`; from `@shipit-ai/connector-sdk`: `KnowledgeConnector`, `ChangeBatch`, `FetchChangesOptions`, `RunLimits`, `SelectedContainer`, `SourceContainer`, `SourcePrincipal`, `DocumentKind`, `ConnectorConfig`, `AuthResult`, `ConnectorManifest`.
- Produces:
  - `interface GitHubKnowledgeClient { issuesGranted: boolean; graphql(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; git: TreeClient; listRepositories(org: string): AsyncIterable<{ id: number; fullName: string; htmlUrl: string; visibility: string; archived: boolean }>; listMembers(org: string): AsyncIterable<{ id: number; login: string }> }`: everything the connector needs from GitHub. Tests fake it; `clientFromOctokit` builds it.
  - `interface GitHubKnowledgeConnectorOptions { knowledge: GitHubKnowledgeConfig; maxDocumentChars: number; batchSize?: number; now?: () => number; connect?: (config: ConnectorConfig) => Promise<{ ok: true; client: GitHubKnowledgeClient } | { ok: false; error: string }> }`
  - `class GitHubKnowledgeConnector implements KnowledgeConnector` with `manifest.name === 'github-knowledge'`.
  - Checkpoint, a JSON string: `{ v: 1, pr: string | null, issue: string | null, tree: string | null, docs: Record<string, string> }` (`docs` maps path → blob sha of what is stored). Opaque outside this file.
  - `NOTE_ISSUES_PERMISSION = 'issues_permission_missing'`, `NOTE_RATE_LIMITED = 'rate_limited'`, `NOTE_TREE_TRUNCATED = 'tree_truncated'`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/connector-github exec vitest run src/knowledge/__tests__/connector.test.ts`
Expected: FAIL, cannot resolve `../connector.js`.

- [ ] **Step 3: Implement the connector**

```ts
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
```

```ts
// packages/connectors/github/src/knowledge/index.ts
export {
  GitHubKnowledgeConnector,
  NOTE_ISSUES_PERMISSION,
  NOTE_RATE_LIMITED,
  NOTE_TREE_TRUNCATED,
  clientFromOctokit,
} from './connector.js';
export type {
  ConnectResult,
  GitHubKnowledgeClient,
  GitHubKnowledgeConnectorOptions,
} from './connector.js';
```

Append to `packages/connectors/github/src/index.ts`:

```ts
export * from './knowledge/index.js';
```

- [ ] **Step 4: Run the connector tests, then the package**

Run: `pnpm --filter @shipit-ai/connector-github test`
Expected: PASS. If `ends the run with a note…` hangs, `withRateLimit` is sleeping: the test's deadline is one minute after `now` and the wait is 600 s, so `RunBudgetEnded` must be thrown before any sleep.

- [ ] **Step 5: Typecheck, then build so api-server sees the new exports**

Run: `pnpm --filter @shipit-ai/connector-github typecheck && pnpm --filter @shipit-ai/connector-github build`
Expected: clean. `octokit.graphql`'s second parameter is typed loosely; if TypeScript rejects `{ request: { signal } }`, cast that one object as `Record<string, unknown>`, nothing wider.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/connectors/github/src
git add packages/connectors/github/src
git commit -m "connector-github: GitHubKnowledgeConnector — pull requests, issues and docs with a resumable checkpoint"
```

---

## Task 7: The `github` connector type builds the knowledge facet

**Files:**

- Modify: `packages/api-server/src/services/connector-types/github.ts`
- Modify: `packages/api-server/src/services/composite-connector-runner.ts`
- Modify: `packages/api-server/src/index.ts` (the `KnowledgeSyncScheduler` construction, around line 512)
- Test: `packages/api-server/src/__tests__/services/connector-types.test.ts`, `packages/api-server/src/__tests__/services/composite-connector-runner.test.ts`

**Interfaces:**

- Consumes: `GitHubKnowledgeConnector` (Task 6), `ConnectorType.knowledgeEnabled` and `BuildContext.maxDocumentChars` (Task 2).
- Produces:
  - `githubConnectorType.knowledgeEnabled(cfg)` returns `cfg.knowledge.enabled`.
  - `githubConnectorType.buildKnowledge(cfg, ctx)` returns `{ ok: true, connector: GitHubKnowledgeConnector, sdkConfig }` with the same credentials and scope `build` uses, or the same `APP_NOT_CONFIGURED` / `PRIVATE_KEY_UNREADABLE` failures.
  - A manual sync of a connector with both facets triggers both; a failure to start or stop one facet no longer skips the other.

- [ ] **Step 1: Write the failing tests**

Append to `describe('github connector type', …)` in `connector-types.test.ts`:

```ts
it('has its knowledge facet off until the instance switches it on', () => {
  const type = getConnectorType('github')!;
  expect(type.knowledgeEnabled!(gh)).toBe(false);
  expect(type.knowledgeEnabled!({ ...gh, knowledge: { ...gh.knowledge, enabled: true } })).toBe(
    true,
  );
});

it('builds the knowledge connector with the same credentials as the graph one', async () => {
  const c = ctx({ maxDocumentChars: 1234 });
  const built = await getConnectorType('github')!.buildKnowledge!(gh, c);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('unreachable');
  expect(built.connector.manifest.name).toBe('github-knowledge');
  expect(built.sdkConfig).toEqual({
    id: 'gh-acme',
    type: 'github',
    credentials: { appId: 'app-1', privateKey: 'PEM', installationId: '42' },
    scope: { org: 'acme' },
  });
});

it('refuses to build the knowledge connector without an App', async () => {
  const built = await getConnectorType('github')!.buildKnowledge!(
    gh,
    ctx({ globalApp: { id: '', privateKeyPath: '' } }),
  );
  expect(built).toMatchObject({ ok: false, code: 'APP_NOT_CONFIGURED' });
});
```

In `composite-connector-runner.test.ts`, replace the test `routes a manual sync to the graph facet when there is one, else to knowledge` with:

```ts
it('a manual sync reaches every facet the connector has', async () => {
  const { graph, knowledge } = fakes();
  const runner = new CompositeConnectorRunner({
    graph,
    knowledge: knowledge as never,
    hasGraphFacet: (c) => c.type === 'github',
  });
  await runner.triggerSync(gh, 'incremental');
  expect(graph.triggerSync).toHaveBeenCalledOnce();
  expect(knowledge.trigger).toHaveBeenCalledWith(gh, 'poll');
  await runner.triggerSync(slack, 'full');
  expect(knowledge.trigger).toHaveBeenCalledWith(slack, 'reconcile');
});

it('still starts and stops the knowledge facet when the graph facet throws', async () => {
  const { graph, knowledge } = fakes();
  graph.start.mockRejectedValueOnce(new Error('redis down'));
  graph.stop.mockRejectedValueOnce(new Error('redis down'));
  const runner = new CompositeConnectorRunner({
    graph,
    knowledge: knowledge as never,
    hasGraphFacet: (c) => c.type === 'github',
  });
  await expect(runner.start(gh)).rejects.toThrow('redis down');
  expect(knowledge.start).toHaveBeenCalledWith(gh);
  await expect(runner.stop('gh')).rejects.toThrow('redis down');
  expect(knowledge.stop).toHaveBeenCalledWith('gh');
});
```

The file's `fakes()` builds `graph` and `knowledge` from `vi.fn()`; its `knowledge.handles` must answer true for `gh` for the first test. If it answers by type, make it `vi.fn(() => true)`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/connector-types.test.ts src/__tests__/services/composite-connector-runner.test.ts`
Expected: FAIL: `knowledgeEnabled` and `buildKnowledge` are undefined; `knowledge.trigger` is not called for `gh`; `knowledge.start` is not called after the graph throws.

- [ ] **Step 3: Implement**

Replace `packages/api-server/src/services/connector-types/github.ts` with:

```ts
import { GitHubConnector, GitHubKnowledgeConnector } from '@shipit-ai/connector-github';
import type { ConnectorConfig } from '@shipit-ai/connector-sdk';
import { resolveAppCredentials, type GitHubConnectorConfig } from '@shipit-ai/shared';
import type { BuildContext, BuildResult, ConnectorType, KnowledgeBuildResult } from './types.js';

// knowledge.index.maxDocumentChars when the context does not carry it (tests).
const DEFAULT_MAX_DOCUMENT_CHARS = 400_000;

type SdkConfigResult =
  { ok: true; sdkConfig: ConnectorConfig } | { ok: false; code: string; message: string };

/** The App credentials and scope both facets authenticate with. */
function sdkConfigFor(cfg: GitHubConnectorConfig, ctx: BuildContext): SdkConfigResult {
  // Per-connector override wins over the global App; absence of both surfaces
  // as a structured failure (no auth attempt, no misleading 401 from GitHub).
  const resolved = resolveAppCredentials(cfg, ctx.globalApp);
  if (!resolved.id || !resolved.privateKeyPath) {
    return {
      ok: false,
      code: 'APP_NOT_CONFIGURED',
      message: resolved.overridden
        ? `Connector ${cfg.id} overrides the GitHub App but is missing app.id or app.privateKeyPath.`
        : `No GitHub App configured. Set GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_PATH or set connector.app on each instance.`,
    };
  }
  let privateKey: string;
  try {
    privateKey = ctx.readPrivateKey(resolved.privateKeyPath);
  } catch (err) {
    return {
      ok: false,
      code: 'PRIVATE_KEY_UNREADABLE',
      message: `Cannot read App private key at ${resolved.privateKeyPath}: ${(err as Error).message}`,
    };
  }
  return {
    ok: true,
    sdkConfig: {
      id: cfg.id,
      type: 'github',
      credentials: { appId: resolved.id, privateKey, installationId: cfg.installationId },
      scope: { org: cfg.org },
    },
  };
}

export const githubConnectorType: ConnectorType<GitHubConnectorConfig> = {
  type: 'github',
  pollMode: 'incremental',
  // GitHub full syncs are bounded by scope.repos.include/exclude, scope.cappedAt,
  // and the entities.* toggles — a full run is not exhaustive, so unseen nodes
  // are not necessarily gone. Never trigger the absence sweep.
  sweepsAbsent: false,

  async build(cfg, ctx): Promise<BuildResult> {
    const resolved = sdkConfigFor(cfg, ctx);
    if (!resolved.ok) return resolved;
    return { ok: true, connector: new GitHubConnector(), sdkConfig: resolved.sdkConfig };
  },

  knowledgeEnabled: (cfg) => cfg.knowledge.enabled,

  async buildKnowledge(cfg, ctx): Promise<KnowledgeBuildResult> {
    const resolved = sdkConfigFor(cfg, ctx);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      connector: new GitHubKnowledgeConnector({
        knowledge: cfg.knowledge,
        maxDocumentChars: ctx.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS,
      }),
      sdkConfig: resolved.sdkConfig,
    };
  },
};
```

`packages/api-server/src/services/composite-connector-runner.ts`:

```diff
   async start(cfg: ConnectorInstanceConfig): Promise<void> {
     this.remember(cfg);
-    if (this.opts.graph && this.opts.hasGraphFacet(cfg)) await this.opts.graph.start(cfg);
-    if (this.opts.knowledge?.handles(cfg)) await this.opts.knowledge.start(cfg);
+    // One facet failing to start must not keep the other from starting.
+    try {
+      if (this.opts.graph && this.opts.hasGraphFacet(cfg)) await this.opts.graph.start(cfg);
+    } finally {
+      if (this.opts.knowledge?.handles(cfg)) await this.opts.knowledge.start(cfg);
+    }
   }

   async stop(connectorId: string): Promise<void> {
-    await this.opts.graph?.stop(connectorId);
-    await this.opts.knowledge?.stop(connectorId);
-    this.knowledgeOnly.delete(connectorId);
+    try {
+      await this.opts.graph?.stop(connectorId);
+    } finally {
+      await this.opts.knowledge?.stop(connectorId);
+      this.knowledgeOnly.delete(connectorId);
+    }
   }
```

```diff
     this.remember(cfg);
+    // "full" for the knowledge facet is the reconcile pass; "incremental" a poll.
+    const knowledgeMode = mode === 'full' ? 'reconcile' : 'poll';
     if (this.opts.hasGraphFacet(cfg)) {
-      return this.opts.graph ? this.opts.graph.triggerSync(cfg, mode) : idle(cfg.id);
+      // A connector with both facets (GitHub) syncs both; the status the
+      // caller gets back is the graph one, as before.
+      if (this.opts.knowledge?.handles(cfg)) await this.opts.knowledge.trigger(cfg, knowledgeMode);
+      return this.opts.graph ? this.opts.graph.triggerSync(cfg, mode) : idle(cfg.id);
     }
     if (this.opts.knowledge?.handles(cfg)) {
-      // "full" for a knowledge connector is the reconcile pass; "incremental" a poll.
-      return this.opts.knowledge.trigger(cfg, mode === 'full' ? 'reconcile' : 'poll');
+      return this.opts.knowledge.trigger(cfg, knowledgeMode);
     }
```

`packages/api-server/src/index.ts`, in the `new KnowledgeSyncScheduler({ … })` options:

```diff
-        buildContext: scheduler.context,
+        // Spread keeps the SAME globalApp object (the live reference the App
+        // service mutates); only the knowledge limit is added.
+        buildContext: {
+          ...scheduler.context,
+          maxDocumentChars: config.knowledge.index.maxDocumentChars,
+        },
         budgetMs: config.knowledge.sync.maxRunMinutes * 60_000,
         reconcileCron: config.knowledge.sync.reconcileCron,
+        historyDaysOf: (cfg) => (cfg.type === 'github' ? cfg.knowledge.historyDays : 365),
```

- [ ] **Step 4: Run the two suites, the scheduler suite and the typecheck**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services && pnpm --filter @shipit-ai/api-server typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/api-server/src/services/connector-types/github.ts packages/api-server/src/services/composite-connector-runner.ts packages/api-server/src/index.ts packages/api-server/src/__tests__/services/connector-types.test.ts packages/api-server/src/__tests__/services/composite-connector-runner.test.ts
git add packages/api-server/src/services/connector-types/github.ts packages/api-server/src/services/composite-connector-runner.ts packages/api-server/src/index.ts packages/api-server/src/__tests__/services/connector-types.test.ts packages/api-server/src/__tests__/services/composite-connector-runner.test.ts
git commit -m "api-server: the github connector type builds its knowledge facet; a manual sync reaches both facets"
```

---

## Task 8: Container routes, the admin gate, and the purge

**Files:**

- Modify: `packages/knowledge/src/store.ts`, `packages/knowledge/src/index.ts` (export the new type)
- Modify: `packages/knowledge-worker/src/main.ts`
- Modify: `packages/api-server/src/middleware/require-auth.ts`
- Modify: `packages/api-server/src/routes/connectors.ts`
- Create: `packages/api-server/src/routes/connector-containers.ts`
- Modify: `packages/api-server/src/services/knowledge-sync-scheduler.ts`
- Modify: `packages/api-server/src/server.ts`, `packages/api-server/src/index.ts`
- Test: `packages/knowledge/src/__tests__/store.integration.test.ts`, `packages/api-server/src/__tests__/middleware/require-admin.test.ts` (create), `packages/api-server/src/__tests__/routes/connector-containers.test.ts` (create), `packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts`

**Interfaces:**

- Consumes: `KnowledgeStore`, `ContainerRow`, `requireKnowledge` (`routes/knowledge.ts`), `KnowledgeSyncScheduler`, `PostgresKnowledgeSink`.
- Produces:
  - `KnowledgeStore`:
    - `interface ContainerSummary extends ContainerRow { visibilityAcknowledgedBy: string | null; documents: number; indexed: number; pending: number; failed: number; restricted: number }`
    - `containersWithCounts(connectorId: string, search?: string): Promise<ContainerSummary[]>`: containers that are not gone, by name.
    - `getContainer(connectorId: string, id: string): Promise<ContainerRow | null>`: by row id.
    - `selectContainer(connectorId: string, id: string, input: { selected: boolean; by: string; acknowledged: boolean }): Promise<void>`: deselecting sets `purge_requested_at`; selecting clears it.
    - `purgeRequested(limit?: number): Promise<number>`: deletes the documents of deselected containers awaiting a purge and resets their sync state; returns documents deleted.
    - `storeBatch` now refuses a container that is not selected.
  - `requireAdmin(request, reply)`: a preHandler answering `403 { error: { code: 'FORBIDDEN', message } }` unless `request.ctx.user.role === 'admin'`.
  - `KnowledgeSyncScheduler.refreshContainers(connectorId: string): Promise<number>` and `class KnowledgeRefreshError extends Error { code: string }`.
  - Routes under `/api/connectors`: `GET /:id/containers?q=`, `POST /:id/containers/refresh`, `PUT /:id/containers/:containerId` with body `{ selected: boolean; acknowledgeVisibility?: boolean }`.
  - Every non-GET route in `routes/connectors.ts` requires an admin.

- [ ] **Step 1: Write the failing store tests**

Append inside `describe('audit fixes', …)`'s parent `describe` in `packages/knowledge/src/__tests__/store.integration.test.ts`, as a new block before `describe('state and retention', …)`:

```ts
describe('containers for the picker', () => {
  const rowOf = async (externalId: string) =>
    (await store.listContainers('slack-1')).find((c) => c.externalId === externalId)!;

  it('counts documents per container by index status', async () => {
    await sink.storeBatch(
      await selectedC1(),
      batch([doc('d1', 'a'), doc('d2', 'b'), { ...doc('d3', 'c'), restricted: true }]),
    );
    const [claimed] = await store.claimPending(1);
    await store.replaceChunks(claimed!.id, [chunk(0, 'alpha')], {
      indexedHash: claimed!.contentHash!,
      indexVersion: 1,
    });
    const rows = await store.containersWithCounts('slack-1');
    expect(rows.map((r) => r.externalId)).toEqual(['C1', 'C2']);
    expect(rows[0]).toMatchObject({
      documents: 2,
      indexed: 1,
      pending: 1,
      failed: 0,
      restricted: 1,
    });
    expect(rows[1]).toMatchObject({ documents: 0, indexed: 0, restricted: 0 });
  });

  it('searches by name and leaves out containers that are gone', async () => {
    expect((await store.containersWithCounts('slack-1', 'OPS')).map((r) => r.name)).toEqual([
      'ops',
    ]);
    await sink.upsertContainers([C1]); // C2 is no longer listed upstream
    expect((await store.containersWithCounts('slack-1')).map((r) => r.name)).toEqual(['general']);
  });

  it('records who selected a container and who acknowledged its visibility', async () => {
    const c2 = await rowOf('C2');
    await store.selectContainer('slack-1', c2.id, {
      selected: true,
      by: 'ada',
      acknowledged: true,
    });
    const [, after] = await store.containersWithCounts('slack-1');
    expect(after).toMatchObject({
      selected: true,
      selectedBy: 'ada',
      visibilityAcknowledgedBy: 'ada',
    });
    expect(await store.getContainer('slack-1', c2.id)).toMatchObject({ externalId: 'C2' });
    expect(await store.getContainer('other', c2.id)).toBeNull();
  });

  it('deselecting requests a purge; the purge deletes the content and resets the sync state', async () => {
    await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
    const c1 = await rowOf('C1');
    await store.selectContainer('slack-1', c1.id, {
      selected: false,
      by: 'ada',
      acknowledged: false,
    });
    expect((await rowOf('C1')).purgeRequestedAt).not.toBeNull();

    expect(await store.purgeRequested()).toBe(2);
    const { rows } = await database.db.query(`SELECT 1 FROM knowledge_documents`);
    expect(rows).toHaveLength(0);
    expect(await rowOf('C1')).toMatchObject({
      purgeRequestedAt: null,
      checkpoint: null,
      selected: false,
    });
    expect(await store.purgeRequested()).toBe(0);
  });

  it('selecting again before the purge ran cancels it', async () => {
    await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
    const c1 = await rowOf('C1');
    await store.selectContainer('slack-1', c1.id, {
      selected: false,
      by: 'ada',
      acknowledged: false,
    });
    await store.selectContainer('slack-1', c1.id, {
      selected: true,
      by: 'ada',
      acknowledged: false,
    });
    expect(await store.purgeRequested()).toBe(0);
    expect((await database.db.query(`SELECT 1 FROM knowledge_documents`)).rows).toHaveLength(1);
  });

  it('refuses a batch for a container that is no longer selected', async () => {
    const selected = await selectedC1();
    const c1 = await rowOf('C1');
    await store.selectContainer('slack-1', c1.id, {
      selected: false,
      by: 'ada',
      acknowledged: false,
    });
    await expect(sink.storeBatch(selected, batch([doc('d1', 'a')]))).rejects.toThrow(
      /not selected/,
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/store.integration.test.ts`
Expected: FAIL, `store.containersWithCounts is not a function` (and the rest).

- [ ] **Step 3: Implement the store methods**

In `packages/knowledge/src/store.ts`, below `ContainerRow`:

```ts
export interface ContainerSummary extends ContainerRow {
  visibilityAcknowledgedBy: string | null;
  /** Documents with content: not deleted, not restricted stubs. */
  documents: number;
  indexed: number;
  pending: number;
  failed: number;
  /** Items excluded because the source restricts them. */
  restricted: number;
}
```

In `storeBatch`, the container lookup becomes:

```diff
       const containerRowResult = await tx.query<{ id: string }>(
-        `SELECT id FROM knowledge_containers WHERE connector_id = $1 AND external_id = $2`,
+        `SELECT id, selected FROM knowledge_containers WHERE connector_id = $1 AND external_id = $2`,
         [connectorId, container.externalId],
       );
-      const containerId = containerRowResult.rows[0]?.id;
+      const found = containerRowResult.rows[0] as { id: string; selected: boolean } | undefined;
+      const containerId = found?.id;
       if (!containerId) {
         throw new Error(
           `container ${container.externalId} is not known to connector ${connectorId}`,
         );
       }
+      // Deselected while this run was fetching: storing more would refill
+      // what the purge is about to delete, or has just deleted.
+      if (!found.selected) {
+        throw new Error(`container ${container.externalId} is not selected any more`);
+      }
```

In the Containers section, after `setSelected`:

```ts
  /** The picker's rows: every container the source still has, with what is stored for it. */
  async containersWithCounts(connectorId: string, search?: string): Promise<ContainerSummary[]> {
    const columns = CONTAINER_COLUMNS.split(',')
      .map((c) => `c.${c.trim()}`)
      .join(', ');
    const live = `d.id IS NOT NULL AND d.deleted_at IS NULL`;
    const { rows } = await this.db.query<Raw>(
      `SELECT ${columns}, c.visibility_acknowledged_by,
              count(*) FILTER (WHERE ${live} AND NOT d.restricted)::int AS documents,
              count(*) FILTER (WHERE ${live} AND d.index_status = 'indexed')::int AS indexed,
              count(*) FILTER (WHERE ${live} AND d.index_status IN ('pending', 'indexing'))::int AS pending,
              count(*) FILTER (WHERE ${live} AND d.index_status = 'failed')::int AS failed,
              count(*) FILTER (WHERE ${live} AND d.restricted)::int AS restricted
         FROM knowledge_containers c
         LEFT JOIN knowledge_documents d ON d.container_id = c.id
        WHERE c.connector_id = $1 AND c.gone_at IS NULL
          AND ($2::text IS NULL OR position(lower($2) IN lower(c.name)) > 0)
        GROUP BY c.id
        ORDER BY c.name`,
      [connectorId, search?.trim() || null],
    );
    return rows.map((r) => ({
      ...containerRow(r),
      visibilityAcknowledgedBy: (r.visibility_acknowledged_by as string | null) ?? null,
      documents: Number(r.documents),
      indexed: Number(r.indexed),
      pending: Number(r.pending),
      failed: Number(r.failed),
      restricted: Number(r.restricted),
    }));
  }

  async getContainer(connectorId: string, id: string): Promise<ContainerRow | null> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${CONTAINER_COLUMNS} FROM knowledge_containers WHERE connector_id = $1 AND id = $2`,
      [connectorId, id],
    );
    return rows[0] ? containerRow(rows[0]) : null;
  }

  /**
   * Deselecting requests a purge (the worker deletes the content); selecting
   * again before it ran cancels it. `acknowledged` records who accepted that a
   * restricted container's content becomes visible to every signed-in user.
   */
  async selectContainer(
    connectorId: string,
    id: string,
    input: { selected: boolean; by: string; acknowledged: boolean },
  ): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_containers
          SET selected = $3, selected_by = $4, selected_at = now(),
              visibility_acknowledged_by = CASE
                WHEN $3 AND $5 THEN $4
                WHEN $3 THEN visibility_acknowledged_by
                ELSE NULL END,
              purge_requested_at = CASE WHEN $3 THEN NULL ELSE now() END,
              updated_at = now()
        WHERE connector_id = $1 AND id = $2`,
      [connectorId, id, input.selected, input.by, input.acknowledged],
    );
  }

  /**
   * Deletes what deselected containers hold (chunks go by cascade) and resets
   * their sync state, so selecting one again starts a fresh backfill. Returns
   * the number of documents deleted.
   */
  async purgeRequested(limit = 20): Promise<number> {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM knowledge_containers
          WHERE purge_requested_at IS NOT NULL AND NOT selected
          ORDER BY purge_requested_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      const deleted = await tx.query(
        `DELETE FROM knowledge_documents WHERE container_id = ANY($1::uuid[])`,
        [ids],
      );
      await tx.query(
        `UPDATE knowledge_containers
            SET purge_requested_at = NULL, checkpoint = NULL, last_polled_at = NULL,
                last_reconciled_at = NULL, updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return deleted.rowCount ?? 0;
    });
  }
```

`position(lower($2) IN lower(c.name))` is used instead of `ILIKE` so `%` and `_` typed into the search box are matched literally.

Export `ContainerSummary` from `packages/knowledge/src/index.ts` next to `ContainerRow`.

- [ ] **Step 4: Run the store suite**

Run: `DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/store.integration.test.ts`
Expected: PASS, including every earlier test (they all store into a selected container).

- [ ] **Step 5: The worker runs the purge**

In `packages/knowledge-worker/src/main.ts`, after the `cleanupTimer` lines:

```ts
// Content of deselected containers, once a minute. Small batches: a purge
// must not hold a transaction open for long beside the indexing loop.
const purge = async (): Promise<void> => {
  try {
    const removed = await store.purgeRequested();
    if (removed > 0) console.log(`knowledge-worker: purged ${removed} document(s)`);
  } catch (err) {
    console.error(`knowledge-worker: purge failed: ${(err as Error).message}`);
  }
};
const purgeTimer = setInterval(() => void purge(), 60_000);
purgeTimer.unref?.();
```

and in `shutdown`, next to `clearInterval(cleanupTimer);`, add `clearInterval(purgeTimer);`.

- [ ] **Step 6: Write the failing admin-gate test**

```ts
// packages/api-server/src/__tests__/middleware/require-admin.test.ts
import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../../middleware/require-auth.js';

function call(role: 'admin' | 'member') {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  const request = {
    ctx: { user: { id: 'u1', role } },
    url: '/api/connectors/gh-1?x=1',
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
  return { result: requireAdmin(request, reply), sent };
}

describe('requireAdmin', () => {
  it('lets an admin through', async () => {
    const { result, sent } = call('admin');
    expect(await result).toBeUndefined();
    expect(sent.status).toBeUndefined();
  });

  it('answers 403 FORBIDDEN to a member', async () => {
    const { result, sent } = call('member');
    await result;
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'This action requires an administrator.' },
    });
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/middleware/require-admin.test.ts`
Expected: FAIL, `requireAdmin` is not exported.

- [ ] **Step 8: Implement the gate and apply it to connector mutations**

`packages/api-server/src/middleware/require-auth.ts`, below `requireCapability`:

```ts
/**
 * preHandler for actions only an administrator may take (connector and
 * knowledge-container mutations). Run after registerRequireAuth has populated
 * `request.ctx`.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (request.ctx.user.role === 'admin') return undefined;
  request.log.warn({ path: request.url.split('?')[0], code: 'FORBIDDEN' }, 'authz: admin required');
  return reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'This action requires an administrator.' },
  });
}
```

`packages/api-server/src/routes/connectors.ts`: import `requireAdmin` from `'../middleware/require-auth.js'`, and as the first statement inside `connectorRoutes`:

```ts
// Reading connectors is open to every signed-in user; creating, changing,
// deleting, probing and triggering are an administrator's. The first-boot
// setup routes are unaffected: their allow-listed principal is an admin.
server.addHook('preHandler', async (request, reply) => {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return undefined;
  }
  return requireAdmin(request, reply);
});
```

- [ ] **Step 9: Run the gate test and the whole connectors route suite**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/middleware src/__tests__/routes/connectors.test.ts`
Expected: PASS. The route suite runs as the dev-fallback principal, which is an admin, so every existing mutation test still passes; if one runs as a member on purpose, it now expects 403.

- [ ] **Step 10: Write the failing scheduler and route tests**

Append to `knowledge-sync-scheduler.test.ts` (and add `upsertContainers: async (_c: string, list: unknown[]) => void (upserted = list.length)` to the `store` fake, with `let upserted = 0;` beside `stored` and a reset in `beforeEach`):

```ts
it('refreshContainers lists the source and stores the list', async () => {
  const s = scheduler(
    fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
  );
  expect(await s.refreshContainers('fx-1')).toBe(1);
  expect(upserted).toBe(1);
});

it('refreshContainers says why it cannot run', async () => {
  const off = {
    ...fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    knowledgeEnabled: () => false,
  } as unknown as ConnectorType;
  await expect(scheduler(off).refreshContainers('fx-1')).rejects.toMatchObject({
    code: 'KNOWLEDGE_NOT_ENABLED',
  });
  const noToken = fixtureType(
    createFixtureKnowledgeConnector({ containers: [C1], documents: {} }),
    true,
  );
  await expect(scheduler(noToken).refreshContainers('fx-1')).rejects.toMatchObject({
    code: 'NO_TOKEN',
  });
  const revoked = fixtureType(
    createFixtureKnowledgeConnector({ containers: [C1], documents: {}, authError: 'revoked' }),
  );
  await expect(scheduler(revoked).refreshContainers('fx-1')).rejects.toMatchObject({
    code: 'AUTH_FAILED',
  });
});
```

```ts
// packages/api-server/src/__tests__/routes/connector-containers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import type { KnowledgeStatusService } from '../../services/knowledge/knowledge-status-service.js';
import { KnowledgeRefreshError } from '../../services/knowledge-sync-scheduler.js';

// Same shape as routes/knowledge.test.ts: a test server, server.inject(), and
// the dev-fallback principal, which is an admin.
const ID = '11111111-1111-4111-8111-111111111111';
const container = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  connectorId: 'gh-1',
  externalId: '42',
  kind: 'repository',
  name: 'acme/payments',
  url: 'https://github.com/acme/payments',
  visibility: 'restricted',
  archived: false,
  acl: null,
  selected: false,
  selectedBy: null,
  checkpoint: '{"secret":"cursor"}',
  mappedEntityIds: [],
  lastPolledAt: null,
  lastReconciledAt: null,
  goneAt: null,
  purgeRequestedAt: null,
  visibilityAcknowledgedBy: null,
  documents: 3,
  indexed: 2,
  pending: 1,
  failed: 0,
  restricted: 0,
  ...overrides,
});

const available = {
  status: async () => ({ available: true, ingestionAvailable: true, checks: [] }),
} as unknown as KnowledgeStatusService;
const unavailable = {
  status: async () => ({
    available: false,
    ingestionAvailable: false,
    checks: [{ name: 'database', ok: false, detail: 'No database is configured.' }],
  }),
} as unknown as KnowledgeStatusService;

describe('connector container routes', () => {
  let selections: Array<Record<string, unknown>>;
  let rows: Array<ReturnType<typeof container>>;
  let refresh: () => Promise<number>;

  beforeEach(() => {
    selections = [];
    rows = [container()];
    refresh = async () => 7;
  });

  async function server(knowledgeStatus = available): Promise<FastifyInstance> {
    const config = makeTestConfig();
    config.connectors.instances = [
      { id: 'gh-1', type: 'github', name: 'acme', installationId: '1', org: 'acme' } as never,
    ];
    const s = await createServer({
      config,
      knowledgeStatus,
      knowledgeStore: {
        containersWithCounts: async (_c: string, q?: string) =>
          rows.filter((r) => !q || r.name.includes(q)),
        getContainer: async (_c: string, id: string) => rows.find((r) => r.id === id) ?? null,
        selectContainer: async (_c: string, id: string, input: Record<string, unknown>) =>
          void selections.push({ id, ...input }),
      } as never,
      knowledgeScheduler: { refreshContainers: () => refresh() } as never,
    });
    await s.ready();
    return s;
  }

  it('lists containers with counts, without the checkpoint or the ACL', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers' });
    expect(res.statusCode).toBe(200);
    expect(res.json().containers).toEqual([
      {
        id: ID,
        externalId: '42',
        kind: 'repository',
        name: 'acme/payments',
        url: 'https://github.com/acme/payments',
        visibility: 'restricted',
        archived: false,
        selected: false,
        visibilityAcknowledged: false,
        purging: false,
        lastPolledAt: null,
        lastReconciledAt: null,
        documents: 3,
        indexed: 2,
        pending: 1,
        failed: 0,
        restricted: 0,
      },
    ]);
    await s.close();
  });

  it('passes the search text through', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers?q=nope' });
    expect(res.json().containers).toEqual([]);
    await s.close();
  });

  it('answers 404 for a connector that does not exist', async () => {
    const s = await server();
    const res = await s.inject({ method: 'GET', url: '/api/connectors/missing/containers' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await s.close();
  });

  it('answers KNOWLEDGE_UNAVAILABLE with the failing checks', async () => {
    const s = await server(unavailable);
    const res = await s.inject({ method: 'GET', url: '/api/connectors/gh-1/containers' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('KNOWLEDGE_UNAVAILABLE');
    expect(res.json().checks[0].name).toBe('database');
    await s.close();
  });

  it('refuses a restricted container without the acknowledgement', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VISIBILITY_NOT_ACKNOWLEDGED');
    expect(selections).toEqual([]);
    await s.close();
  });

  it('selects a restricted container once acknowledged, recording who did', async () => {
    const s = await server();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true, acknowledgeVisibility: true },
    });
    expect(res.statusCode).toBe(200);
    expect(selections).toEqual([
      { id: ID, selected: true, by: expect.any(String), acknowledged: true },
    ]);
    await s.close();
  });

  it('selects an open container without an acknowledgement, and deselects any', async () => {
    rows = [container({ visibility: 'open' })];
    const s = await server();
    const on = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: true },
    });
    expect(on.statusCode).toBe(200);
    const off = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: false },
    });
    expect(off.statusCode).toBe(200);
    expect(selections.map((x) => x.selected)).toEqual([true, false]);
    await s.close();
  });

  it('rejects a body without a boolean `selected` and an id that is not a uuid', async () => {
    const s = await server();
    const bad = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/${ID}`,
      payload: { selected: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    const notUuid = await s.inject({
      method: 'PUT',
      url: `/api/connectors/gh-1/containers/42`,
      payload: { selected: true },
    });
    expect(notUuid.statusCode).toBe(404);
    await s.close();
  });

  it('refreshes the container list and maps a refusal to its code', async () => {
    const s = await server();
    const ok = await s.inject({ method: 'POST', url: '/api/connectors/gh-1/containers/refresh' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ containers: 7 });

    refresh = async () => {
      throw new KnowledgeRefreshError(
        'KNOWLEDGE_NOT_ENABLED',
        'Knowledge is off for this connector.',
      );
    };
    const off = await s.inject({ method: 'POST', url: '/api/connectors/gh-1/containers/refresh' });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('KNOWLEDGE_NOT_ENABLED');

    refresh = async () => {
      throw new KnowledgeRefreshError('AUTH_FAILED', 'GitHub App auth failed');
    };
    const auth = await s.inject({ method: 'POST', url: '/api/connectors/gh-1/containers/refresh' });
    expect(auth.statusCode).toBe(502);
    await s.close();
  });
});
```

If `makeTestConfig()` returns a frozen or shared object, build the instances through its own override parameter instead of assigning; read `packages/api-server/src/__tests__/test-config.ts` and use what `routes/connectors.test.ts` uses to seed a connector.

- [ ] **Step 11: Run them and watch them fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/connector-containers.test.ts src/__tests__/services/knowledge-sync-scheduler.test.ts`
Expected: FAIL: `KnowledgeRefreshError` is not exported, `createServer` does not know `knowledgeStore`, the routes answer 404.

- [ ] **Step 12: Implement `refreshContainers`**

In `packages/api-server/src/services/knowledge-sync-scheduler.ts`, above the class:

```ts
/** Why a container refresh could not run. `code` is safe to show; the route maps it to a status. */
export class KnowledgeRefreshError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeRefreshError';
  }
}
```

and as a method of the class, after `getStatus`:

```ts
  /**
   * Lists the source's containers now and stores the list, so an admin can
   * pick from it without waiting for the nightly reconcile. Returns how many
   * the source has.
   */
  async refreshContainers(connectorId: string): Promise<number> {
    const cfg = this.opts.registry.get(connectorId); // throws 404 for an unknown id
    const type = this.resolveType(cfg.type);
    if (!type?.buildKnowledge || !this.handles(cfg)) {
      throw new KnowledgeRefreshError(
        'KNOWLEDGE_NOT_ENABLED',
        'Knowledge is not switched on for this connector.',
      );
    }
    const built = await type.buildKnowledge(cfg, this.opts.buildContext);
    if (!built.ok) throw new KnowledgeRefreshError(built.code, built.message);
    const auth = await built.connector.authenticate(built.sdkConfig);
    if (!auth.success) {
      throw new KnowledgeRefreshError('AUTH_FAILED', auth.error ?? 'Authentication failed');
    }
    // The whole list first: an incomplete one must not mark anything gone.
    const all = [];
    for await (const container of built.connector.listContainers()) all.push(container);
    await new PostgresKnowledgeSink({ connectorId, store: this.opts.store }).upsertContainers(all);
    return all.length;
  }
```

- [ ] **Step 13: Implement the routes and wire them**

```ts
// packages/api-server/src/routes/connector-containers.ts
// The containers of a knowledge connector (mounted /api/connectors, beside the
// connector routes): what the source has, what an admin selected, and what is
// stored for each. Spec §API. Reading is open to every signed-in user;
// refreshing and selecting are an administrator's.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ContainerSummary, KnowledgeStore } from '@shipit-ai/knowledge';
import { requireAdmin } from '../middleware/require-auth.js';
import {
  KnowledgeRefreshError,
  type KnowledgeSyncScheduler,
} from '../services/knowledge-sync-scheduler.js';
import { requireKnowledge } from './knowledge.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledgeStore?: Pick<
      KnowledgeStore,
      'containersWithCounts' | 'getContainer' | 'selectContainer'
    >;
    knowledgeScheduler?: Pick<KnowledgeSyncScheduler, 'refreshContainers'>;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the picker shows. The checkpoint and the ACL snapshot stay server-side. */
function present(c: ContainerSummary) {
  return {
    id: c.id,
    externalId: c.externalId,
    kind: c.kind,
    name: c.name,
    url: c.url,
    visibility: c.visibility,
    archived: c.archived,
    selected: c.selected,
    visibilityAcknowledged: c.visibilityAcknowledgedBy !== null,
    purging: c.purgeRequestedAt !== null,
    lastPolledAt: c.lastPolledAt,
    lastReconciledAt: c.lastReconciledAt,
    documents: c.documents,
    indexed: c.indexed,
    pending: c.pending,
    failed: c.failed,
    restricted: c.restricted,
  };
}

const notFound = (reply: FastifyReply, message: string): FastifyReply =>
  reply.status(404).send({ error: { code: 'NOT_FOUND', message } });

const notWired = (reply: FastifyReply): FastifyReply =>
  reply.status(503).send({
    error: {
      code: 'KNOWLEDGE_UNAVAILABLE',
      message: 'The knowledge layer is not available on this server.',
    },
  });

const connectorContainerRoutes: FastifyPluginAsync = async (server) => {
  const available = requireKnowledge(server);
  const connectorExists = (id: string): boolean => {
    try {
      server.connectorRegistry.get(id);
      return true;
    } catch {
      return false;
    }
  };

  server.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/:id/containers',
    { preHandler: available },
    async (request, reply) => {
      if (!connectorExists(request.params.id)) return notFound(reply, 'No such connector.');
      if (!server.knowledgeStore) return notWired(reply);
      const rows = await server.knowledgeStore.containersWithCounts(
        request.params.id,
        typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : undefined,
      );
      return { containers: rows.map(present) };
    },
  );

  server.post<{ Params: { id: string } }>(
    '/:id/containers/refresh',
    { preHandler: [requireAdmin, available] },
    async (request, reply) => {
      if (!connectorExists(request.params.id)) return notFound(reply, 'No such connector.');
      if (!server.knowledgeScheduler) return notWired(reply);
      try {
        return { containers: await server.knowledgeScheduler.refreshContainers(request.params.id) };
      } catch (err) {
        if (!(err instanceof KnowledgeRefreshError)) throw err;
        const status =
          err.code === 'KNOWLEDGE_NOT_ENABLED' ? 409 : err.code === 'AUTH_FAILED' ? 502 : 400;
        return reply.status(status).send({ error: { code: err.code, message: err.message } });
      }
    },
  );

  server.put<{
    Params: { id: string; containerId: string };
    Body: { selected?: unknown; acknowledgeVisibility?: unknown };
  }>(
    '/:id/containers/:containerId',
    { preHandler: [requireAdmin, available] },
    async (request, reply) => {
      const { id, containerId } = request.params;
      if (!connectorExists(id)) return notFound(reply, 'No such connector.');
      if (!server.knowledgeStore) return notWired(reply);
      const selected = request.body?.selected;
      if (typeof selected !== 'boolean') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: '`selected` must be true or false.' },
        });
      }
      const container = UUID.test(containerId)
        ? await server.knowledgeStore.getContainer(id, containerId)
        : null;
      if (!container) return notFound(reply, 'No such container.');
      const acknowledged = request.body?.acknowledgeVisibility === true;
      // Everything indexed is visible to every signed-in user (spec
      // §Visibility), so content the source restricts needs an explicit yes.
      if (selected && container.visibility !== 'open' && !acknowledged) {
        return reply.status(409).send({
          error: {
            code: 'VISIBILITY_NOT_ACKNOWLEDGED',
            message:
              'This container is not open to everyone at the source. Indexing it makes its content visible to every signed-in user; send acknowledgeVisibility: true to accept that.',
          },
        });
      }
      await server.knowledgeStore.selectContainer(id, containerId, {
        selected,
        by: request.ctx.user.email ?? request.ctx.user.id,
        acknowledged,
      });
      return { ok: true };
    },
  );
};

export default connectorContainerRoutes;
```

`packages/api-server/src/server.ts`:

```diff
   knowledgeStatus?: KnowledgeStatusService;
+  /** The knowledge store and scheduler, for the container routes. Optional like the status. */
+  knowledgeStore?: FastifyInstance['knowledgeStore'];
+  knowledgeScheduler?: FastifyInstance['knowledgeScheduler'];
```

```diff
   if (opts.knowledgeStatus) {
     server.decorate('knowledgeStatus', opts.knowledgeStatus);
   }
+  if (opts.knowledgeStore) server.decorate('knowledgeStore', opts.knowledgeStore);
+  if (opts.knowledgeScheduler) server.decorate('knowledgeScheduler', opts.knowledgeScheduler);
```

```diff
   await server.register(knowledgeRoutes, { prefix: '/api/knowledge' });
+  await server.register(connectorContainerRoutes, { prefix: '/api/connectors' });
```

with `import connectorContainerRoutes from './routes/connector-containers.js';` beside the `knowledgeRoutes` import.

`packages/api-server/src/index.ts`, in the `createServer({ … })` call that already passes `knowledgeStatus`:

```diff
     knowledgeStatus,
+    knowledgeStore: knowledgeStore ?? undefined,
+    knowledgeScheduler: knowledgeScheduler ?? undefined,
```

- [ ] **Step 14: Run the api-server suites and the typecheck**

Run: `pnpm --filter @shipit-ai/knowledge build && pnpm --filter @shipit-ai/api-server test && pnpm typecheck`
Expected: PASS and clean.

- [ ] **Step 15: Commit**

```bash
npx prettier --write packages/knowledge/src packages/knowledge-worker/src/main.ts packages/api-server/src/middleware/require-auth.ts packages/api-server/src/routes/connectors.ts packages/api-server/src/routes/connector-containers.ts packages/api-server/src/services/knowledge-sync-scheduler.ts packages/api-server/src/server.ts packages/api-server/src/index.ts packages/api-server/src/__tests__/middleware packages/api-server/src/__tests__/routes/connector-containers.test.ts packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts
git add packages/knowledge/src packages/knowledge-worker/src/main.ts packages/api-server/src
git commit -m "knowledge: container routes (list, refresh, select with a visibility acknowledgement), an admin gate on connector mutations, and the purge of deselected containers"
```

`git add packages/api-server/src` is safe only if `git status` shows no other session's files under it; if it does, add this task's paths one by one.

---

## Task 9: Leftovers from the K0 audit, docs, and the hands-on check

**Files:**

- Modify: `packages/knowledge/src/chunking.ts`, `packages/knowledge/src/__tests__/chunking.test.ts`
- Modify: `packages/knowledge/package.json`, `pnpm-lock.yaml`
- Modify: `docs/local-development.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`
- Modify: `docs/agent/plans/knowledge-connectors.md`, `docs/agent/status/knowledge-k0-foundations.md`, `docs/agent/MANIFEST.md`

**Interfaces:**

- Consumes: everything above.
- Produces: `splitLongText` never returns a part that ends in half a surrogate pair; `@shipit-ai/knowledge` declares only the dependencies it imports; docs that match the code.

- [ ] **Step 1: Write the failing chunking test**

Append to `packages/knowledge/src/__tests__/chunking.test.ts` (import `splitLongText` from `'../chunking.js'` if the file does not already):

```ts
describe('splitLongText hard cuts', () => {
  it('never cuts an emoji in half', () => {
    // One character, then two-unit emoji: a cut every 16 units lands inside a pair.
    const parts = splitLongText('a' + '😀'.repeat(200), 4);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const last = part.charCodeAt(part.length - 1);
      const first = part.charCodeAt(0);
      expect(last >= 0xd800 && last <= 0xdbff, 'ends with a lone high surrogate').toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff, 'starts with a lone low surrogate').toBe(false);
      expect(part.length).toBeLessThanOrEqual(16);
    }
    expect(parts.join('')).toBe('a' + '😀'.repeat(200));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/chunking.test.ts`
Expected: FAIL, `ends with a lone high surrogate`.

- [ ] **Step 3: Fix the hard cut**

In `splitLongText` in `packages/knowledge/src/chunking.ts`:

```diff
       if (unit.length > maxChars) {
         flush();
-        for (let i = 0; i < unit.length; i += maxChars) out.push(unit.slice(i, i + maxChars));
+        for (let i = 0; i < unit.length; ) {
+          let end = Math.min(i + maxChars, unit.length);
+          // Do not leave half of a surrogate pair (an emoji, a rare CJK
+          // character) at the end of a part: it would be stored as U+FFFD.
+          const last = unit.charCodeAt(end - 1);
+          if (end < unit.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
+          out.push(unit.slice(i, end));
+          i = end;
+        }
         continue;
       }
```

- [ ] **Step 4: Run the chunking tests**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/chunking.test.ts`
Expected: PASS.

- [ ] **Step 5: Drop the dependencies `@shipit-ai/knowledge` does not import**

Run: `grep -rn "from '@shipit-ai/shared'\|from 'zod'" packages/knowledge/src`
Expected: no output. If there is output, a later commit started using one of them: leave that one in `package.json` and remove only the other.

Remove `"@shipit-ai/shared": "workspace:*"` and `"zod": …` from `dependencies` in `packages/knowledge/package.json`, then:

Run: `pnpm install && pnpm --filter @shipit-ai/knowledge typecheck && pnpm --filter @shipit-ai/knowledge-worker build && pnpm --filter @shipit-ai/api-server build`
Expected: the lockfile's `packages/knowledge` importer loses the two entries and everything builds. No Dockerfile changes: `packages/knowledge-worker/Dockerfile` and `packages/api-server/Dockerfile` copy `packages/shared` for their own imports.

- [ ] **Step 6: Docs**

`docs/local-development.md`, after the paragraph that ends "`knowledge.enabled` is true there." in the Postgres section, add:

````markdown
To index a GitHub connector's text, switch its knowledge facet on, list its repositories
and select the ones to index. All three need an admin (the local dev user is one):

```bash
API=http://localhost:3001/api/connectors/<connector-id>
curl -s -X PATCH $API -H 'content-type: application/json' -d '{"knowledge":{"enabled":true}}'
curl -s -X POST $API/containers/refresh
curl -s $API/containers | jq '.containers[] | {id, name, visibility, selected, documents}'
# A private repository needs "acknowledgeVisibility": true: its content becomes
# visible to every signed-in user.
curl -s -X PUT $API/containers/<container-id> -H 'content-type: application/json' \
  -d '{"selected":true,"acknowledgeVisibility":true}'
curl -s -X POST $API/sync -H 'content-type: application/json' -d '{"mode":"incremental"}'
```

Pull requests and docs need nothing new from the GitHub App. Issues need the App's
**Issues: read** permission: the App's owner adds it under the App's settings, Permissions
& events, and an owner of the organisation approves the request GitHub emails. Until then
runs succeed with the note `issues_permission_missing` in the connector's run history.
````

`docs/architecture.md`: in the Knowledge Layer paragraph, after "stores in Postgres through a redacting sink (`@shipit-ai/knowledge`);", insert "the first source is the GitHub connector's text facet (pull requests, issues and Markdown docs of the repositories an admin selects);". In the route-prefix list of the API Server section, add `/api/knowledge` (status) and note under `/api/connectors` that it also serves `/:id/containers`.

`docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`, at the end of §GitHub text, add:

```markdown
**As built in K1a (2026-10-04).** The spike's answer is yes: `issues: read` is added in the
App's settings (Permissions & events) and each installation approves it; nothing is
recreated. The connector reads the installation's granted permissions at authentication and
skips issues with the note `issues_permission_missing` while the permission is absent.
Pull requests and issues are listed newest first down to the checkpoint and then stored
oldest first, so a run cut short resumes without skipping anything. The checkpoint also
holds the path and blob sha of every stored doc, which is how a file that left the tree is
deleted in the same run. The id listing covers issues only (`prunableKinds`). A tree GitHub
truncates deletes nothing and is listed again next run (`tree_truncated`). A rate-limit
wait that outlives the run ends the run with `rate_limited`. External ids are built on the
repository's numeric id: `pr:<repoId>:<number>`, `issue:<repoId>:<number>`,
`doc:<repoId>:<path>`. Selecting a container that is not `open` at the source needs
`acknowledgeVisibility: true` on the API; the dialog is K1c.
```

- [ ] **Step 7: Hands-on check (Docker running, `gcloud auth application-default login` done)**

```bash
pnpm stop && pnpm start:infra
pnpm start:backend
GOOGLE_CLOUD_PROJECT=<project> pnpm --filter @shipit-ai/knowledge-worker dev   # second terminal
```

With `knowledge: { enabled: true }` in `shipit.config.local.yaml` and a GitHub connector configured:

1. Run the five `curl` commands from Step 6 against a small repository. Expected: the `PATCH` answers the connector with `knowledge.enabled: true`; `refresh` answers `{ "containers": <n> }`; the `PUT` on a private repository without the acknowledgement answers 409 `VISIBILITY_NOT_ACKNOWLEDGED`, with it 200.
2. `curl -s localhost:3001/api/knowledge/status | jq .counts` within two minutes of the sync: `indexed` rises to the number of pull requests, issues and docs, and `failed` stays absent or 0. **This is the first live Vertex embedding in the project.** If documents go to `failed`, read `index_error` (`SELECT external_id, index_error FROM knowledge_documents WHERE index_status = 'failed'`) before changing anything: the provider option names in `packages/knowledge-worker/src/vertex-embedder.ts` were typechecked, never called.
3. `psql` check that content was stored as designed: `SELECT kind, count(*) FROM knowledge_documents GROUP BY 1;` and `SELECT prefix, left(text, 80) FROM knowledge_chunks LIMIT 5;`.
4. The connector's run history (`GET /api/connectors/<id>/runs`) shows runs with `facet: "knowledge"`; on an installation without the Issues permission, `notes` contains `issues_permission_missing` and `status` is `success`.
5. Deselect the repository (`PUT … {"selected":false}`): within a minute the worker logs `purged <n> document(s)` and the counts drop.
6. Stop the worker and `pnpm start:backend` with the `ai.database` block removed from `shipit.config.local.yaml`: `/api/connectors` behaves as before and `/api/connectors/<id>/containers` answers 503 `KNOWLEDGE_UNAVAILABLE`. Restore the block.

Record what each step showed in the plan note in Step 8. Do not record a step as passed if it was not run.

- [ ] **Step 8: Notes**

`docs/agent/plans/knowledge-connectors.md` → Status: K1 is three plans (K1a, K1b, K1c); K1a implemented (list the commits by reading `git log`, never from memory); what each hands-on step showed, including whether the live embedding worked; the deferred minors this plan closed (the composite runner's facet handling, a deselected container receiving batches, surrogate pairs at hard cuts, the unused dependencies); next is the K1b plan. Set `updated:` to the day you write it. `docs/agent/status/knowledge-k0-foundations.md`: add the files this plan touched to Scope and point at K1b as next. `docs/agent/MANIFEST.md`: update the two rows' summaries and `Last updated`.

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/knowledge/src/chunking.ts packages/knowledge/src/__tests__/chunking.test.ts packages/knowledge/package.json docs/local-development.md docs/architecture.md docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md docs/agent
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge/src/chunking.ts packages/knowledge/src/__tests__/chunking.test.ts packages/knowledge/package.json pnpm-lock.yaml docs/local-development.md docs/architecture.md docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md docs/agent
git commit -m "knowledge: K1a docs and hands-on record; hard cuts keep surrogate pairs whole; drop two unused dependencies"
```

---

## Self-review notes

**Spec coverage (K1a scope).** §GitHub text: instance config → Task 2; containers and visibility → Task 6; pull requests and issues (title, body, state, labels, author, comments, reviews, review comments; GraphQL by `UPDATED_AT`; `sourceVersion` is `updatedAt`) → Tasks 3, 4, 6; docs (tree listed once, unchanged tree skipped, blob sha as version, deletion in the same run) → Tasks 5, 6; deletion of issues through `listDocumentIds` → Task 6 with `prunableKinds`; auth with the App's installation token → Tasks 6, 7; the permission change, the note and the manifest → Tasks 1, 6, and the spike section. §Sources shared rules: stable external ids → Task 3; `maxDocumentChars` at a segment boundary with `attributes.truncated` → Task 3; `Retry-After` and a rate limit that does not fail the run → Task 5; `historyDays` → Tasks 4, 6, 7. §Scheduling: a type with both facets → Tasks 2, 7. §Visibility: private repositories are `restricted` and need an acknowledgement → Tasks 6, 8. §API: the three container routes and the purge on deselect → Task 8. "The connector role gate" → Task 8.

**Not in K1a, on purpose.** Entity linking, references, people matching, the timeline and document routes and their migration are K1b. Every screen is K1c; until then the facet is driven with the API calls in Task 9. `mapped_entity_ids` on the container `PUT` arrives with linking in K1b. Text normalisation of GitHub Markdown beyond what GitHub returns (mentions are already `@login`) is not attempted. Reviews beyond the first fifty per pull request, and review comments beyond the first fifty per review, are not fetched; the document is flagged `truncated` when reviews overflow. Webhook-driven freshness stays deferred (spec, Deferred work 4): the two new events are subscribed and ignored.

**Type consistency.** `Gql` takes `(query, variables)` everywhere; the connector adds the signal when it builds one. `RepoRef` is `{ id, owner, name }` in documents, GraphQL and the connector; `listDocBlobs` and `fetchBlobText` take the structural subset `{ owner, name }`. `GqlPullRequest` gains `reviewsTruncated` only on what `fetchPullRequests` returns, and `pullRequestDocument` does not read it. `fetchChanges` yields `ChangeBatch` with `notes` as the SDK defines it (2026-10-04 amendment). `KnowledgeStore.selectContainer` takes the container's row id; the SDK-facing `setSelected` (by external id) stays for tests. `ContainerSummary` is what `containersWithCounts` returns and what the route's `present` reads. `KnowledgeRefreshError.code` is what the route switches on. `ConnectorType.knowledgeEnabled` is read in exactly one place, `KnowledgeSyncScheduler.handles`.

**Review Focus pins.** 1 → Task 6 `syncs pull requests and docs and notes the missing issues permission`, `covers no kind while issues cannot be listed`. 2 → Task 4 `returns the oldest first`, Task 6 `a second run from the first batch's checkpoint fetches the rest`. 3 → Task 8 `refuses a restricted container without the acknowledgement`. 4 → Task 5 `lists only matching blobs under the size limit, sorted by path`, Task 6 `fetches only the blob that changed and deletes a doc that left the tree`, `skips the docs when the tree did not change`. 5 → Task 3 `cuts at a segment boundary and flags the document`, Task 4 `follows the comment cursor until every comment is in`.

**What was run while writing this plan, and what was not.** Run: the three GraphQL query shapes against github.com with a user token; the two GitHub docs pages for the spike. The code of Tasks 3 to 6 (every file under `packages/connectors/github/src/knowledge/`, with its tests) and the Task 2 schema and its test were written into the tree exactly as printed here, typechecked and run on 2026-10-04, then removed: 66 new connector tests and the 3 config tests passed, the package's 46 existing tests still passed, and `tsc --noEmit` and `prettier --check` were clean. Not run: the api-server and store code of Tasks 2 (scheduler part), 7 and 8, the worker change, and Task 9; no installation token was used, so the body GitHub returns for an issues query without the permission is not observed. An executor should expect to fix small type errors at the typecheck steps of Tasks 7 and 8, and must not weaken a test to get past one.

**Things an executor must check rather than trust.** The name and shape of the helper `routes/connectors.test.ts` uses to seed a connector (Task 8 Step 10); whether `fakes()` in the composite runner test answers `handles` for `gh` (Task 7 Step 1); that `octokit.rest.git` is assignable to `TreeClient` through the cast in `clientFromOctokit` and that `octokit.graphql` accepts the `request` option as written (Task 6 Step 5); that no fixture writes a secret-shaped string into source (the pre-commit hook scans every staged file).
