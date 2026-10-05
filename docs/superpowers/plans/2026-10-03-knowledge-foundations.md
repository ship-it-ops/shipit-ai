# Knowledge Layer Foundations (K0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A knowledge connector's documents travel end to end — fetched on the connector scheduler, redacted and stored in Postgres, chunked and embedded by a new worker — with a status endpoint that says exactly what is missing when they cannot.

**Architecture:** The connector SDK gains a second contract, `KnowledgeConnector`, and a `KnowledgeHarness` that drives it. A new library, `@shipit-ai/knowledge`, owns the Postgres tables, the sink that stores documents (with secret redaction), the chunkers and the index pipeline. A new process, `knowledge-worker`, claims pending documents straight from Postgres, embeds them through Vertex AI and writes the chunks. The api-server gains a second scheduler for knowledge connectors and a status service. No real source connector ships in this milestone: a fixture connector in the SDK proves the pipeline, and K1 (GitHub text) is the first real one.

**Tech Stack:** TypeScript (ESM, Node 22), `pg` 8 with pgvector 0.8 on Postgres 17, Zod 4, BullMQ 5 Job Schedulers, Vitest 4, secretlint 13 as a library, Vercel AI SDK 7 with `@ai-sdk/google-vertex` (worker only).

**Spec:** `docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md` (§Packages and processes, §Connector contract, §Scheduling, §Data model, §Visibility, §Index pipeline, §Config, §Feature gating, §Error handling, §Testing; Milestone K0). The agents foundation this builds on is already on the branch: `packages/agents` (pool, `Db`, migration runner, `pnpm db:migrate`), `db/migrations/0001_agents.sql`, Postgres in `docker/docker-compose.yml` and in the CI `integration` job.

## Global Constraints

- **Run commands from the repo root.** A single test file: `pnpm --filter <package> exec vitest run <path>`.
- **Verify before each commit:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`. `pnpm format:check` is a CI gate; run `npx prettier --write <files>` on anything you touch.
- **Commits need the owner's go-ahead.** Each "Commit" step marks where a commit belongs. Ask before running `git commit`, and separately before any `git push`. No `Co-Authored-By` or other AI-attribution trailer. Commit on the current branch, `ai-agents-design`.
- **ESM everywhere:** relative imports end in `.js`.
- **The app never migrates at boot.** Migrations are applied by `pnpm db:migrate` locally and in CI, and by the infra repo's deploy step on GKE.
- **Migration files (exact contract, shared with the infra repo):** `db/migrations/NNNN_description.sql`, four digits, lower-case description with underscores, forward-only. An applied file is never edited. The planner in `packages/agents/src/migrate.ts` rejects a pending file numbered below the newest applied one, so **the knowledge migration takes the next free number at merge time**. This plan writes it as `0002_knowledge.sql`; if another `0002` has landed on the branch by then, rename it to the next number and update `KNOWLEDGE_MIGRATIONS` and `EXPECTED_SCHEMA_VERSION` together.
- **When you add a migration, bump `EXPECTED_SCHEMA_VERSION`** in `packages/agents/src/schema-version.ts` in the same change; `packages/agents/src/__tests__/migrate.test.ts` enforces that the last file in `db/migrations/` equals it.
- **pgvector is a baseline requirement of the Postgres instance** (spec decision 10). The extension is not trusted, so only a superuser can create it. `pnpm db:bootstrap` does that locally (the compose `shipit` user is the superuser); the test harness does it for suites; the infra repo does it on GKE. **Never put `CREATE EXTENSION` in a migration file**: `shipit_migrator` cannot run it there.
- **Every query that names a pgvector type or operator needs `public` on the `search_path`.** The test harness sets `search_path=<private schema>,public`; production uses the default `"$user", public`.
- **`DATABASE_URL` is a plain env var**, surfaced as `ai.database.url`. Never add it to the secrets registry (the 2026-09-16 boot crash). The knowledge layer shares that one setting and that one pool.
- **A new workspace dependency must agree in three places** (scar `docker-builder-copies-fixed-package-set`): the consuming package's Dockerfile `COPY` list, its vitest alias list, and the lockfile. No tsconfig `references`; types resolve through `node_modules`.
- **Postgres-backed suites are gated on `DATABASE_TEST_URL`** and named `*.integration.test.ts`. They run with `--no-file-parallelism` (scar `integration-tests-sharing-a-db-must-run-serially`).
- **No document content, segment, chunk or id list ever enters Redis** (spec decision 8; scar `redis-memory-limit-below-dataset-oomkills`). Redis carries a connector id and a mode in a job, a heartbeat key, and an empty wake-up message.
- **Queue and key names, exact:** BullMQ queue `shipit-knowledge-sync`; Job Scheduler ids `knowledge~<connectorId>~poll` and `knowledge~<connectorId>~reconcile` (no colons: scar `bullmq-5-forbids-colons-in-queue-names-and-job-ids`); Redis heartbeat key `shipit-knowledge-worker-heartbeat` (written every 15s, 60s TTL); Redis pub/sub channel `shipit-knowledge-wake`.
- **Config defaults, exact (spec §Config):** `knowledge.enabled: true`; `embedding: { model: 'gemini-embedding-2', dimensions: 768 }`; `sync: { maxRunMinutes: 10, reconcileCron: '0 3 * * *' }`; `worker: { concurrency: 8, batchSize: 16 }`; `index: { maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 }`; `linking: { labels: ['LogicalService', 'Repository', 'Team'], stopList: [] }`; `search: { defaultLimit: 8, maxLimit: 25, candidatesPerLeg: 50, resultChars: 1500 }`; `suggestions: { enabled: true, minSupport: 3, extraction: { enabled: false, model: '', dailyTokens: 2000000 } }`; `agents: { askWritesAfterRead: true }`; `retention: { tombstoneDays: 30 }`.
- **Other exact values:** embedding column `halfvec(768)`; `INDEX_VERSION = 1`; claim batch stale after 10 minutes; a failed document is retried at most 5 times with a backoff of 4^attempts minutes; `estimateTokens(text) = ceil(text.length / 4)`; chunk target 600 tokens, maximum 800; Slack day documents split at gaps over 10 minutes; error code `KNOWLEDGE_UNAVAILABLE` (503); error envelope `{ error: { code, message } }` with `checks` as an extra top-level field where stated.
- **Local database:** `postgres://shipit:shipit-dev@localhost:5432/shipit`. **CI database:** `postgres://shipit:testpassword@localhost:5432/shipit_test`. Use these two URLs exactly as written; `.secretlintrc.json` allows only them, and secretlint runs in the pre-commit hook and in CI.
- **Never commit `packages/web-ui/next-env.d.ts`.**

## Review Focus

Conditions the spec implies that a person will hit. Each is pinned by a test in the task that owns the code:

1. **api-server restarts in the middle of a backfill.** The next run resumes from the last committed checkpoint, and the documents the interrupted batch already stored are not duplicated. → Task 4 (`resumes from the stored checkpoint`), Task 7 (`storing the same batch twice changes nothing`).
2. **Someone pasted a credential into a message.** It is replaced before the text is stored, so neither Postgres nor Vertex ever sees it, and the document records how many redactions happened. → Task 5 (`replaces an AWS access key id`, `replaces every match and counts them`), Task 7 (`redacts before storing`).
3. **The extension is missing, the schema is behind, or the worker is dead.** The status endpoint names the failing check, sync jobs do not run, nothing returns a 500 and nothing crashes. → Task 2 (`fails with a readable message when the vector extension is missing`), Task 11 (`skips the run when the layer is unavailable`), Task 12 (every check in the status service tests; `KNOWLEDGE_UNAVAILABLE` from the route).
4. **The worker dies while holding a claim.** The document is picked up again after 10 minutes instead of staying `indexing` forever; a document that fails five times stays visible as failed and does not block the others. → Task 7 (`reclaims a stale claim`, `stops retrying after five failures`), Task 9 (`a failing document does not stop the batch`).
5. **A source listing is cut short, or an item is deleted upstream.** An incomplete listing never prunes anything; a confirmed deletion removes the chunks in the same transaction and leaves a tombstone. → Task 4 (`does not prune when the id listing throws`), Task 7 (`pruneMissing tombstones the rest and removes their chunks`).

Two more that tests cannot fully pin and that Task 13 checks by hand: a deployment with **no** database or **no** worker must boot and serve exactly as it does today, and the compose stack must come up with the pgvector image on an existing `postgres_data` volume.

## File Structure

| Path                                                                     | Responsibility                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `packages/connector-sdk/src/knowledge/types.ts`                          | The `KnowledgeConnector` contract: containers, principals, documents, batches, the sink interface, run results.      |
| `packages/connector-sdk/src/knowledge/harness.ts`                        | `KnowledgeHarness`: poll and reconcile runs, checkpoints, time budget, error isolation per container.                |
| `packages/connector-sdk/src/knowledge/fixture.ts`                        | `createFixtureKnowledgeConnector`: an in-memory connector for tests in every package.                                |
| `db/migrations/0002_knowledge.sql`                                       | Tables `knowledge_containers`, `knowledge_principals`, `knowledge_documents`, `knowledge_chunks`, `knowledge_state`. |
| `packages/knowledge/src/schema-version.ts`                               | `KNOWLEDGE_MIGRATIONS` (the versions this build needs present) and `INDEX_VERSION`.                                  |
| `packages/knowledge/src/bootstrap.ts`, `src/bootstrap-cli.ts`            | `hasVectorExtension`, `ensureVectorExtension`, `pnpm db:bootstrap`.                                                  |
| `packages/knowledge/src/hash.ts`, `src/vector.ts`                        | `sha256Hex`, `contentHashOf`, `toPgVector`.                                                                          |
| `packages/knowledge/src/redaction.ts`                                    | `redactText` and `redactSegments` on secretlint's recommended preset.                                                |
| `packages/knowledge/src/chunking.ts`                                     | `estimateTokens`, `chunkDocument` per document kind.                                                                 |
| `packages/knowledge/src/store.ts`                                        | `KnowledgeStore`: every SQL statement, grouped by table. Containers, principals, documents, chunks, claims, state.   |
| `packages/knowledge/src/sink.ts`                                         | `PostgresKnowledgeSink`: the SDK's `KnowledgeSink` on top of the store, with redaction and the Redis wake-up.        |
| `packages/knowledge/src/embedder.ts`                                     | `Embedder` interface, `FakeEmbedder`, `withRetry`.                                                                   |
| `packages/knowledge/src/index-pipeline.ts`                               | `indexDocument`: skip, chunk, embed what changed, replace chunks.                                                    |
| `packages/knowledge/src/index-loop.ts`                                   | `IndexLoop`: claim, process with bounded concurrency, wake-up, poll, heartbeat.                                      |
| `packages/knowledge/src/status.ts`                                       | `missingKnowledgeMigrations`, the pieces the api-server status service composes.                                     |
| `packages/knowledge/src/__tests__/test-db.ts`                            | Per-suite private schema on a real pgvector Postgres, migrated.                                                      |
| `packages/knowledge-worker/src/main.ts`                                  | Process boot: config, pool, Redis, Vertex embedder, the loop, shutdown.                                              |
| `packages/knowledge-worker/src/vertex-embedder.ts`                       | `VertexEmbedder` on the AI SDK's Vertex provider.                                                                    |
| `packages/shared/src/config/schema.ts`                                   | The `knowledge` config section; `facet` on run history.                                                              |
| `packages/api-server/src/services/connector-types/types.ts`              | `build` becomes optional; `buildKnowledge` is added.                                                                 |
| `packages/api-server/src/services/knowledge-sync-scheduler.ts`           | Poll and reconcile jobs on `shipit-knowledge-sync`, Job Schedulers, run records with `facet: 'knowledge'`.           |
| `packages/api-server/src/services/composite-connector-runner.ts`         | One `ConnectorRunner` that fans registry start/stop/trigger out to the graph and knowledge schedulers.               |
| `packages/api-server/src/services/knowledge/knowledge-status-service.ts` | Live prerequisite checks.                                                                                            |
| `packages/api-server/src/routes/knowledge.ts`                            | `GET /api/knowledge/status`.                                                                                         |
| `packages/api-server/src/index.ts`                                       | Shares the pool with agents, wires the store, scheduler and status service.                                          |

---

## Task 1: The `@shipit-ai/knowledge` package, the extension bootstrap, and pgvector in compose, CI and the infra script

**Files:**

- Create: `packages/knowledge/package.json`, `packages/knowledge/tsconfig.json`, `packages/knowledge/vitest.config.ts`
- Create: `packages/knowledge/src/bootstrap.ts`, `packages/knowledge/src/bootstrap-cli.ts`, `packages/knowledge/src/index.ts`
- Create: `packages/knowledge/src/__tests__/bootstrap.test.ts`
- Create: `docker/postgres-init/01-vector.sql`
- Modify: `docker/docker-compose.yml`, `.github/workflows/ci.yml`, `scripts/infra.sh`, `package.json` (root), `vitest.config.ts` (root)

**Interfaces:**

- Consumes: `Db`, `SqlClient`, `createPool`, `createDb` from `@shipit-ai/agents`.
- Produces: `hasVectorExtension(db: SqlClient): Promise<boolean>`, `ensureVectorExtension(db: SqlClient): Promise<'created' | 'present'>`, `pnpm db:bootstrap`; a `postgres` compose service and CI service running `pgvector/pgvector:0.8.7-pg17`.

- [ ] **Step 1: Create the package skeleton**

`packages/knowledge/package.json`:

```json
{
  "name": "@shipit-ai/knowledge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run .integration --no-file-parallelism",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@secretlint/core": "^13.0.4",
    "@secretlint/secretlint-rule-preset-recommend": "^13.0.4",
    "@shipit-ai/agents": "workspace:*",
    "@shipit-ai/connector-sdk": "workspace:*",
    "@shipit-ai/shared": "workspace:*",
    "pg": "^8.23.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "@types/pg": "^8.23.1",
    "typescript": "^6.0.3",
    "vitest": "^4.1.11"
  }
}
```

`packages/knowledge/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

`packages/knowledge/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Workspace packages resolve to their TypeScript SOURCE, not `dist/`: the CI
// `integration` job runs vitest straight after `pnpm install` with no build
// step. Same fix as packages/api-server/vitest.config.ts.
const r = (...p: string[]) => resolve(__dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/agents': r('agents/src/index.ts'),
      '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
      '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
    },
  },
  test: {
    // Vitest 4 no longer excludes `dist` by default; scope to TS sources.
    include: ['src/**/*.test.ts'],
  },
});
```

Root `vitest.config.ts` — add the project after `packages/agents`:

```diff
     projects: [
       'packages/shared',
       'packages/agents',
+      'packages/knowledge',
       'packages/event-bus',
```

Root `package.json` — add the script after `db:migrate`:

```diff
     "db:migrate": "tsx packages/agents/src/migrate-cli.ts",
+    "db:bootstrap": "tsx packages/knowledge/src/bootstrap-cli.ts",
```

Then:

```bash
pnpm install
```

Expected: the lockfile gains `packages/knowledge` with `@secretlint/core`, `@secretlint/secretlint-rule-preset-recommend`, `pg` and `zod` resolved from the store (all four are already there for other packages).

- [ ] **Step 2: Write the failing unit test**

Create `packages/knowledge/src/__tests__/bootstrap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@shipit-ai/agents';
import { ensureVectorExtension, hasVectorExtension } from '../bootstrap.js';

function fakeDb(extensionPresent: boolean): { db: SqlClient; statements: string[] } {
  const statements: string[] = [];
  const db: SqlClient = {
    async query<R extends object>(text: string) {
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('pg_extension')) {
        return { rows: (extensionPresent ? [{ extversion: '0.8.7' }] : []) as R[], rowCount: 0 };
      }
      return { rows: [] as R[], rowCount: 0 };
    },
  };
  return { db, statements };
}

describe('vector extension bootstrap', () => {
  it('reports the extension present or absent from pg_extension', async () => {
    expect(await hasVectorExtension(fakeDb(true).db)).toBe(true);
    expect(await hasVectorExtension(fakeDb(false).db)).toBe(false);
  });

  it('creates the extension only when it is absent', async () => {
    const absent = fakeDb(false);
    expect(await ensureVectorExtension(absent.db)).toBe('created');
    expect(absent.statements).toContain('CREATE EXTENSION IF NOT EXISTS vector');

    const present = fakeDb(true);
    expect(await ensureVectorExtension(present.db)).toBe('present');
    expect(present.statements.some((s) => s.startsWith('CREATE EXTENSION'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/bootstrap.test.ts`
Expected: FAIL — cannot find module `../bootstrap.js`.

- [ ] **Step 4: Implement the bootstrap module, the CLI and the package index**

Create `packages/knowledge/src/bootstrap.ts`:

```ts
// pgvector is a baseline requirement of the Postgres instance (spec decision
// 10). The extension is NOT trusted, so only a superuser can create it: the
// infra repo does so on GKE, `pnpm db:bootstrap` locally (the compose `shipit`
// user is the superuser), and the test harness per suite. Never from a
// migration file — shipit_migrator owns the schema and nothing more.
import type { SqlClient } from '@shipit-ai/agents';

export const VECTOR_EXTENSION = 'vector';

export async function hasVectorExtension(db: SqlClient): Promise<boolean> {
  const { rows } = await db.query<{ extversion: string }>(
    'SELECT extversion FROM pg_extension WHERE extname = $1',
    [VECTOR_EXTENSION],
  );
  return rows.length > 0;
}

export async function ensureVectorExtension(db: SqlClient): Promise<'created' | 'present'> {
  if (await hasVectorExtension(db)) return 'present';
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  return 'created';
}
```

Create `packages/knowledge/src/bootstrap-cli.ts`:

```ts
// `pnpm db:bootstrap`: creates the pgvector extension as a superuser. Run once
// per database, before `pnpm db:migrate`. Safe to re-run.
import { createDb, createPool } from '@shipit-ai/agents';
import { ensureVectorExtension } from './bootstrap.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_SUPERUSER_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('db:bootstrap needs DATABASE_URL (or DATABASE_SUPERUSER_URL) to be set.');
    process.exitCode = 2;
    return;
  }
  const pool = createPool({ connectionString, max: 1 });
  try {
    const outcome = await ensureVectorExtension(createDb(pool));
    console.log(
      outcome === 'created'
        ? 'Created the "vector" extension (pgvector).'
        : 'The "vector" extension (pgvector) is already present.',
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // 42501 = insufficient_privilege: the role is not a superuser.
    if (e.code === '42501') {
      console.error(
        'Creating the "vector" extension needs a superuser. Run db:bootstrap with a superuser ' +
          'connection string (DATABASE_SUPERUSER_URL), or ask the database operator to run ' +
          '`CREATE EXTENSION vector;` once.',
      );
    } else {
      console.error(e.message ?? String(err));
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
```

Create `packages/knowledge/src/index.ts` (later tasks append to it):

```ts
export { VECTOR_EXTENSION, ensureVectorExtension, hasVectorExtension } from './bootstrap.js';
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/bootstrap.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Put pgvector under compose, the infra script and CI**

Create `docker/postgres-init/01-vector.sql` (runs once, on a fresh volume, as the compose superuser):

```sql
-- Fresh local volumes get pgvector at first boot. Existing volumes are covered
-- by `pnpm db:bootstrap`, which scripts/infra.sh runs before migrations.
CREATE EXTENSION IF NOT EXISTS vector;
```

`docker/docker-compose.yml`:

```diff
-  # Postgres holds agent definitions and (later) run history. Optional for the
-  # rest of the product: without it the AI pages show setup guidance.
+  # Postgres holds agent definitions, run history and the knowledge layer's
+  # documents and embeddings. The image ships pgvector (a baseline requirement:
+  # the extension is not trusted, so a superuser must create it; see
+  # docker/postgres-init and `pnpm db:bootstrap`). Optional for the rest of the
+  # product: without it the AI pages show setup guidance.
   postgres:
-    image: postgres:17-alpine
+    image: pgvector/pgvector:0.8.7-pg17
     ports:
       - '5432:5432'
     environment:
       POSTGRES_USER: shipit
       POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-shipit-dev}
       POSTGRES_DB: shipit
     volumes:
       - postgres_data:/var/lib/postgresql/data
+      - ./postgres-init:/docker-entrypoint-initdb.d:ro
```

If `docker compose pull postgres` cannot find `0.8.7-pg17`, use the floating `pgvector/pgvector:pg17` tag and note the version `SELECT extversion FROM pg_extension` reports in the commit message.

`scripts/infra.sh` — bootstrap before migrating:

```diff
-    echo "Applying database migrations..."
-    (cd "$ROOT_DIR" && DATABASE_URL="${DATABASE_URL:-postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@localhost:5432/shipit}" pnpm --silent db:migrate)
+    # pgvector first (needs the superuser, which the compose `shipit` user is),
+    # then schema changes. Both are safe to re-run.
+    echo "Ensuring the pgvector extension and applying database migrations..."
+    (cd "$ROOT_DIR" && DATABASE_URL="${DATABASE_URL:-postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@localhost:5432/shipit}" pnpm --silent db:bootstrap)
+    (cd "$ROOT_DIR" && DATABASE_URL="${DATABASE_URL:-postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@localhost:5432/shipit}" pnpm --silent db:migrate)
```

`.github/workflows/ci.yml` — the integration job's service:

```diff
       postgres:
-        image: postgres:17-alpine
+        image: pgvector/pgvector:0.8.7-pg17
         env:
           POSTGRES_USER: shipit
```

The CI database user `shipit` is the container's superuser, and the knowledge test harness (Task 2) creates the extension itself, so CI needs no bootstrap step.

- [ ] **Step 7: Check it by hand (Docker must be running)**

```bash
pnpm stop && pnpm start:infra
```

Expected, at the end:

```
Postgres: healthy
Ensuring the pgvector extension and applying database migrations...
The "vector" extension (pgvector) is already present.
Nothing to apply (1 already applied) from <repo>/db/migrations.
Infrastructure ready!
```

(`already present` because the init script ran on the fresh volume — or `Created` if the volume existed from before.) Then confirm the type resolves:

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U shipit -d shipit -c "select '[1,2,3]'::halfvec(3) <=> '[1,2,3]'::halfvec(3) as distance"
```

Expected: `distance | 0`.

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/knowledge docker/docker-compose.yml .github/workflows/ci.yml vitest.config.ts package.json
bash -n scripts/infra.sh
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge docker/postgres-init docker/docker-compose.yml .github/workflows/ci.yml scripts/infra.sh package.json vitest.config.ts pnpm-lock.yaml
git commit -m "knowledge: package skeleton, pgvector image and the db:bootstrap step"
```

---

## Task 2: The knowledge migration, the schema-version bump, and the pgvector test harness

**Files:**

- Create: `db/migrations/0002_knowledge.sql`
- Create: `packages/knowledge/src/schema-version.ts`, `packages/knowledge/src/status.ts`
- Create: `packages/knowledge/src/__tests__/test-db.ts`, `packages/knowledge/src/__tests__/migration.test.ts`, `packages/knowledge/src/__tests__/migration.integration.test.ts`
- Modify: `packages/agents/src/schema-version.ts`, `packages/knowledge/src/index.ts`, `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `runMigrations`, `createPool`, `createDb` from `@shipit-ai/agents`; `ensureVectorExtension` from Task 1.
- Produces: the five tables; `KNOWLEDGE_MIGRATIONS: readonly string[]`, `INDEX_VERSION: number`; `missingKnowledgeMigrations(db): Promise<string[]>`; `createMigratedTestDatabase(): Promise<{ db: Db; drop(): Promise<void> }>` for every later integration suite.

- [ ] **Step 1: Write the migration**

Create `db/migrations/0002_knowledge.sql`:

```sql
-- 0002_knowledge.sql: the knowledge layer — containers an admin selects,
-- source principals, documents, their chunks and embeddings, and a small
-- key/value state table. Design:
-- docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §Data model.
--
-- Applied by the migration step (infra at deploy; `pnpm db:migrate` locally and
-- in CI), never by the app at boot. Forward-only.

-- pgvector must already be installed by a superuser (`pnpm db:bootstrap`; on
-- GKE the infra bootstrap step). Fail with the reason, not with
-- "type halfvec does not exist" three statements later.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'The "vector" extension (pgvector) is not installed in this database.',
      HINT = 'A superuser must run CREATE EXTENSION vector; (locally: pnpm db:bootstrap). See docs/agent/briefs/infra-pgvector-for-knowledge.md.';
  END IF;
END
$$;

CREATE TABLE knowledge_containers (
  id                         uuid PRIMARY KEY,
  connector_id               text NOT NULL,
  external_id                text NOT NULL,
  kind                       text NOT NULL,
  name                       text NOT NULL,
  url                        text,
  visibility                 text NOT NULL DEFAULT 'unknown',
  archived                   boolean NOT NULL DEFAULT false,
  acl                        jsonb,
  selected                   boolean NOT NULL DEFAULT false,
  selected_by                text,
  selected_at                timestamptz,
  visibility_acknowledged_by text,
  mapped_entity_ids          text[] NOT NULL DEFAULT '{}',
  checkpoint                 text,
  backfill_done              boolean NOT NULL DEFAULT false,
  oldest_fetched_at          timestamptz,
  last_polled_at             timestamptz,
  last_reconciled_at         timestamptz,
  purge_requested_at         timestamptz,
  gone_at                    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_containers_kind CHECK (kind IN ('channel', 'space', 'project', 'repository')),
  CONSTRAINT knowledge_containers_visibility CHECK (visibility IN ('open', 'restricted', 'unknown')),
  CONSTRAINT knowledge_containers_connector_external_key UNIQUE (connector_id, external_id)
);
CREATE INDEX knowledge_containers_selected_idx ON knowledge_containers (connector_id) WHERE selected;

CREATE TABLE knowledge_principals (
  id           uuid PRIMARY KEY,
  connector_id text NOT NULL,
  external_id  text NOT NULL,
  kind         text NOT NULL,
  display_name text NOT NULL,
  email        text,
  login        text,
  active       boolean NOT NULL DEFAULT true,
  person_id    text,
  match_method text,
  matched_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_principals_kind CHECK (kind IN ('user', 'bot', 'group', 'external')),
  CONSTRAINT knowledge_principals_match_method CHECK (match_method IS NULL OR match_method IN ('email', 'login', 'manual')),
  CONSTRAINT knowledge_principals_connector_external_key UNIQUE (connector_id, external_id)
);
CREATE INDEX knowledge_principals_email_idx ON knowledge_principals (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX knowledge_principals_person_idx ON knowledge_principals (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE knowledge_documents (
  id                        uuid PRIMARY KEY,
  connector_id              text NOT NULL,
  container_id              uuid NOT NULL REFERENCES knowledge_containers (id) ON DELETE CASCADE,
  external_id               text NOT NULL,
  kind                      text NOT NULL,
  title                     text NOT NULL DEFAULT '',
  url                       text NOT NULL DEFAULT '',
  segments                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash              text,
  source_version            text,
  source_created_at         timestamptz,
  source_updated_at         timestamptz,
  author_principal_id       uuid REFERENCES knowledge_principals (id) ON DELETE SET NULL,
  participant_principal_ids uuid[] NOT NULL DEFAULT '{}',
  state                     text,
  attributes                jsonb NOT NULL DEFAULT '{}'::jsonb,
  restricted                boolean NOT NULL DEFAULT false,
  acl                       jsonb,
  redactions                integer NOT NULL DEFAULT 0,
  index_status              text NOT NULL DEFAULT 'pending',
  index_claimed_at          timestamptz,
  index_attempts            integer NOT NULL DEFAULT 0,
  index_error               text,
  indexed_hash              text,
  index_version             integer,
  extraction_status         text NOT NULL DEFAULT 'none',
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_documents_kind CHECK (kind IN (
    'slack_thread', 'slack_channel_day', 'confluence_page', 'jira_issue',
    'github_pull_request', 'github_issue', 'github_doc')),
  CONSTRAINT knowledge_documents_index_status CHECK (index_status IN ('pending', 'indexing', 'indexed', 'failed', 'skipped')),
  CONSTRAINT knowledge_documents_extraction_status CHECK (extraction_status IN ('none', 'pending', 'done', 'skipped')),
  CONSTRAINT knowledge_documents_state CHECK (state IS NULL OR state IN ('open', 'closed', 'merged', 'resolved', 'archived')),
  CONSTRAINT knowledge_documents_connector_external_key UNIQUE (connector_id, external_id)
);
-- The worker's claim query: everything not yet in a terminal state.
CREATE INDEX knowledge_documents_claimable_idx ON knowledge_documents (updated_at)
  WHERE index_status IN ('pending', 'indexing', 'failed');
CREATE INDEX knowledge_documents_container_updated_idx ON knowledge_documents (container_id, source_updated_at DESC);
CREATE INDEX knowledge_documents_kind_state_idx ON knowledge_documents (kind, state, source_updated_at DESC);
CREATE INDEX knowledge_documents_participants_idx ON knowledge_documents USING GIN (participant_principal_ids);

CREATE TABLE knowledge_chunks (
  id              uuid PRIMARY KEY,
  document_id     uuid NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  segment_keys    text[] NOT NULL DEFAULT '{}',
  url             text,
  occurred_at     timestamptz,
  prefix          text NOT NULL DEFAULT '',
  text            text NOT NULL,
  text_hash       text NOT NULL,
  token_estimate  integer NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', prefix || ' ' || text)) STORED,
  embedding       halfvec(768),
  embedding_model text,
  CONSTRAINT knowledge_chunks_document_seq_key UNIQUE (document_id, seq)
);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);
CREATE INDEX knowledge_chunks_text_hash_idx ON knowledge_chunks (document_id, text_hash);

CREATE TABLE knowledge_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`packages/agents/src/schema-version.ts`:

```diff
-export const EXPECTED_SCHEMA_VERSION = '0001';
+export const EXPECTED_SCHEMA_VERSION = '0002';
```

- [ ] **Step 2: Write the failing unit test**

Create `packages/knowledge/src/__tests__/migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_VERSION, KNOWLEDGE_MIGRATIONS } from '../schema-version.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

describe('knowledge migrations', () => {
  it('names versions that exist as files', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    for (const version of KNOWLEDGE_MIGRATIONS) {
      expect(files.some((f) => f.startsWith(`${version}_`))).toBe(true);
    }
  });

  it('guards on the vector extension before touching any type', () => {
    const file = readdirSync(MIGRATIONS_DIR).find((f) =>
      f.startsWith(`${KNOWLEDGE_MIGRATIONS[0]}_`),
    )!;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const guardAt = sql.indexOf("pg_extension WHERE extname = 'vector'");
    const halfvecAt = sql.indexOf('halfvec(768)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(halfvecAt).toBeGreaterThan(guardAt);
  });

  it('starts the index version at 1', () => {
    expect(INDEX_VERSION).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/migration.test.ts`
Expected: FAIL — cannot find module `../schema-version.js`.

- [ ] **Step 4: Implement the version constants and the status helper**

Create `packages/knowledge/src/schema-version.ts`:

```ts
// Migration versions this build of the knowledge layer needs PRESENT in
// schema_migrations. Presence, not "max >= X": two workstreams share one
// migration sequence, so the highest applied number proves nothing about ours.
// Add a version here in the same change that adds its file to db/migrations/.
export const KNOWLEDGE_MIGRATIONS: readonly string[] = ['0002'];

// Bumped when the chunker changes shape. Documents indexed under an older
// version are re-indexed by an admin action (never automatically at boot).
export const INDEX_VERSION = 1;
```

Create `packages/knowledge/src/status.ts`:

```ts
import type { SqlClient } from '@shipit-ai/agents';
import { KNOWLEDGE_MIGRATIONS } from './schema-version.js';

/** Versions from KNOWLEDGE_MIGRATIONS that schema_migrations does not have. */
export async function missingKnowledgeMigrations(db: SqlClient): Promise<string[]> {
  const { rows } = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
    [[...KNOWLEDGE_MIGRATIONS]],
  );
  const present = new Set(rows.map((r) => r.version));
  return KNOWLEDGE_MIGRATIONS.filter((v) => !present.has(v));
}
```

Append to `packages/knowledge/src/index.ts`:

```ts
export { INDEX_VERSION, KNOWLEDGE_MIGRATIONS } from './schema-version.js';
export { missingKnowledgeMigrations } from './status.js';
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/migration.test.ts`
Expected: PASS — 3 tests. Also run the agents guard: `pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/migrate.test.ts` — PASS (the last file is now `0002_knowledge.sql` and matches `EXPECTED_SCHEMA_VERSION`).

- [ ] **Step 6: Add the pgvector test harness and the integration suite**

Create `packages/knowledge/src/__tests__/test-db.ts`:

```ts
// Harness for the Postgres-backed knowledge suites. Like packages/agents'
// harness it gives each suite a private schema, with two additions: the
// pgvector extension is created first (the CI and compose `shipit` user is the
// container's superuser), and `public` stays on the search_path so the
// extension's types and operators (`halfvec`, `<=>`) resolve from the private
// schema. Suites still run serially (--no-file-parallelism): migrations take
// one database-wide advisory lock.
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, runMigrations, type Db } from '@shipit-ai/agents';
import { ensureVectorExtension } from '../bootstrap.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Set in CI and when Postgres is running locally. Unset: the suites skip. */
export const DATABASE_TEST_URL: string | undefined = process.env.DATABASE_TEST_URL;

/** <repo root>/db/migrations */
export const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

export interface TestDatabase {
  db: Db;
  schema: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!DATABASE_TEST_URL) throw new Error('DATABASE_TEST_URL is not set');
  const schema = `ktest_${randomBytes(6).toString('hex')}`;

  const admin = createPool({ connectionString: DATABASE_TEST_URL, max: 1 });
  try {
    await ensureVectorExtension(createDb(admin));
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    max: 4,
    searchPath: `${schema},public`,
    // HNSW index creation and the first embeddings insert can exceed the
    // 10 s default on a cold CI runner.
    statementTimeoutMs: 60_000,
  });
  return {
    db: createDb(pool),
    schema,
    async drop() {
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}

/** A private schema with every file in db/migrations/ applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  try {
    await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
  } catch (err) {
    await database.drop();
    throw err;
  }
  return database;
}
```

Create `packages/knowledge/src/__tests__/migration.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DATABASE_TEST_URL, createMigratedTestDatabase, type TestDatabase } from './test-db.js';
import { missingKnowledgeMigrations } from '../status.js';
import { hasVectorExtension } from '../bootstrap.js';

describe.skipIf(!DATABASE_TEST_URL)('0002_knowledge on a real pgvector Postgres', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  it('applies and leaves nothing missing', async () => {
    expect(await hasVectorExtension(database.db)).toBe(true);
    expect(await missingKnowledgeMigrations(database.db)).toEqual([]);
  });

  it('creates the embedding column as halfvec(768) with an hnsw index', async () => {
    const { rows } = await database.db.query<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'knowledge_chunks' AND a.attname = 'embedding'`,
      [database.schema],
    );
    expect(rows[0]?.format_type).toBe('halfvec(768)');

    const idx = await database.db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'knowledge_chunks_embedding_idx'`,
      [database.schema],
    );
    expect(idx.rows[0]?.indexdef).toContain('USING hnsw');
  });

  it('resolves the cosine operator from the private schema', async () => {
    const { rows } = await database.db.query<{ distance: number }>(
      `SELECT '[1,0,0]'::halfvec(3) <=> '[0,1,0]'::halfvec(3) AS distance`,
    );
    expect(Number(rows[0]!.distance)).toBeCloseTo(1, 5);
  });

  it('rejects an unknown document kind and an unknown index status', async () => {
    await expect(
      database.db.query(
        `INSERT INTO knowledge_containers (id, connector_id, external_id, kind, name)
         VALUES (gen_random_uuid(), 'c1', 'x', 'bucket', 'x')`,
      ),
    ).rejects.toThrow(/knowledge_containers_kind/);
  });
});
```

`.github/workflows/ci.yml` — after the agents integration step:

```diff
       - name: agents integration (Postgres)
         run: pnpm --filter @shipit-ai/agents run test:integration
+
+      - name: knowledge integration (Postgres + pgvector)
+        run: pnpm --filter @shipit-ai/knowledge run test:integration
```

- [ ] **Step 7: Run the integration suite against the local pgvector Postgres**

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/knowledge run test:integration
```

Expected: PASS — 1 file, 4 tests. Then confirm the suite cleaned up:

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U shipit -d shipit -c "select count(*) from information_schema.schemata where schema_name like 'ktest_%'"
```

Expected: `0`. Also re-run `pnpm --filter @shipit-ai/agents run test:integration` with the same `DATABASE_TEST_URL` — PASS; its suites now apply `0002` too.

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/knowledge .github/workflows/ci.yml
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add db/migrations/0002_knowledge.sql packages/agents/src/schema-version.ts packages/knowledge .github/workflows/ci.yml
git commit -m "knowledge: 0002 migration (containers, principals, documents, chunks, state) and the pgvector test harness"
```

---

## Task 3: The `knowledge` config section and `facet` on run history

**Files:**

- Modify: `packages/shared/src/config/schema.ts`, `packages/shared/src/config/index.ts`, `packages/shared/src/index.ts`
- Modify: `shipit.config.yaml`, `packages/api-server/src/__tests__/test-config.ts`
- Create: `packages/shared/src/__tests__/knowledge-config.test.ts` (next to the existing `ai-config-schema.test.ts`)

**Interfaces:**

- Produces: `Config['knowledge']` = `KnowledgeConfig` with the exact defaults in Global Constraints; `KNOWLEDGE_EMBEDDING_DIMENSIONS = 768`; `LastRun.facet?: 'graph' | 'knowledge'`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/knowledge-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { configSchema } from '../config/schema.js';

// The smallest config the schema accepts, so the test exercises defaults only.
function parse(knowledge?: Record<string, unknown>) {
  const result = configSchema.safeParse({
    backend: {
      neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'x' },
      redis: { url: 'redis://localhost:6379' },
      api: { url: 'http://localhost:3001' },
    },
    ...(knowledge ? { knowledge } : {}),
  });
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data.knowledge;
}

describe('knowledge config section', () => {
  it('fills every default when the section is absent', () => {
    const k = parse();
    expect(k.enabled).toBe(true);
    expect(k.embedding).toEqual({ model: 'gemini-embedding-2', dimensions: 768 });
    expect(k.sync).toEqual({ maxRunMinutes: 10, reconcileCron: '0 3 * * *' });
    expect(k.worker).toEqual({ concurrency: 8, batchSize: 16 });
    expect(k.index).toEqual({ maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 });
    expect(k.linking).toEqual({ labels: ['LogicalService', 'Repository', 'Team'], stopList: [] });
    expect(k.search).toEqual({
      defaultLimit: 8,
      maxLimit: 25,
      candidatesPerLeg: 50,
      resultChars: 1500,
    });
    expect(k.suggestions).toEqual({
      enabled: true,
      minSupport: 3,
      extraction: { enabled: false, model: '', dailyTokens: 2000000 },
    });
    expect(k.agents).toEqual({ askWritesAfterRead: true });
    expect(k.retention).toEqual({ tombstoneDays: 30 });
  });

  it('accepts partial overrides and keeps the rest', () => {
    const k = parse({ enabled: false, worker: { concurrency: 2 } });
    expect(k.enabled).toBe(false);
    expect(k.worker).toEqual({ concurrency: 2, batchSize: 16 });
  });

  it('rejects a malformed reconcile cron', () => {
    expect(() => parse({ sync: { reconcileCron: 'every day' } })).toThrow(/5-field crontab/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/shared exec vitest run src/__tests__/knowledge-config.test.ts`
Expected: FAIL — `k` is `undefined` (no `knowledge` key on the parsed config).

- [ ] **Step 3: Add the section and the `facet` field**

`packages/shared/src/config/schema.ts` — extend `lastRunSchema`:

```diff
   notes: z.array(z.string()).optional(),
+  /**
+   * Which half of a connector produced this run. Absent on runs recorded
+   * before knowledge connectors existed, which were all graph runs.
+   */
+  facet: z.enum(['graph', 'knowledge']).optional(),
 });
```

Add the knowledge section directly after `aiConfigSchema` / its type exports (before `const baseConfigSchema`):

```ts
// ── Knowledge layer ───────────────────────────────────────────────────────
// Ingested text (Slack, Confluence, Jira, GitHub discussions) indexed in
// Postgres with pgvector. Design: docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md.
// Shares `ai.database.url` and `ai.vertex` with the agent platform.

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 768;

const knowledgeConfigSchema = z.object({
  // Master switch. False hides the feature without touching stored data.
  enabled: z.boolean().default(true),
  embedding: z
    .object({
      model: z.string().default('gemini-embedding-2'),
      // Must match the halfvec(768) column; a mismatch disables indexing.
      dimensions: z.number().int().positive().default(KNOWLEDGE_EMBEDDING_DIMENSIONS),
    })
    .default({ model: 'gemini-embedding-2', dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }),
  sync: z
    .object({
      // A poll run yields after this long; the next run resumes from the checkpoint.
      maxRunMinutes: z.number().int().positive().default(10),
      reconcileCron: z.string().default('0 3 * * *').refine(isCrontabShape, {
        message: 'Invalid cron schedule — expected a 5-field crontab string, e.g. "0 3 * * *".',
      }),
    })
    .default({ maxRunMinutes: 10, reconcileCron: '0 3 * * *' }),
  worker: z
    .object({
      concurrency: z.number().int().positive().default(8),
      batchSize: z.number().int().positive().default(16),
    })
    .default({ concurrency: 8, batchSize: 16 }),
  index: z
    .object({
      maxDocumentChars: z.number().int().positive().default(400000),
      chunkTokens: z.number().int().positive().default(600),
      maxChunkTokens: z.number().int().positive().default(800),
    })
    .default({ maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 }),
  linking: z
    .object({
      labels: z.array(z.string()).default(['LogicalService', 'Repository', 'Team']),
      stopList: z.array(z.string()).default([]),
    })
    .default({ labels: ['LogicalService', 'Repository', 'Team'], stopList: [] }),
  search: z
    .object({
      defaultLimit: z.number().int().positive().default(8),
      maxLimit: z.number().int().positive().default(25),
      candidatesPerLeg: z.number().int().positive().default(50),
      resultChars: z.number().int().positive().default(1500),
    })
    .default({ defaultLimit: 8, maxLimit: 25, candidatesPerLeg: 50, resultChars: 1500 }),
  suggestions: z
    .object({
      enabled: z.boolean().default(true),
      minSupport: z.number().int().positive().default(3),
      extraction: z
        .object({
          enabled: z.boolean().default(false),
          model: z.string().default(''),
          dailyTokens: z.number().int().positive().default(2000000),
        })
        .default({ enabled: false, model: '', dailyTokens: 2000000 }),
    })
    .default({
      enabled: true,
      minSupport: 3,
      extraction: { enabled: false, model: '', dailyTokens: 2000000 },
    }),
  agents: z
    .object({
      // After a run reads knowledge content, `allow` becomes `ask` for writes.
      askWritesAfterRead: z.boolean().default(true),
    })
    .default({ askWritesAfterRead: true }),
  retention: z
    .object({
      tombstoneDays: z.number().int().positive().default(30),
    })
    .default({ tombstoneDays: 30 }),
});
export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;
```

In `baseConfigSchema`, after the `ai:` entry:

```ts
  knowledge: knowledgeConfigSchema.default({
    enabled: true,
    embedding: { model: 'gemini-embedding-2', dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS },
    sync: { maxRunMinutes: 10, reconcileCron: '0 3 * * *' },
    worker: { concurrency: 8, batchSize: 16 },
    index: { maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 },
    linking: { labels: ['LogicalService', 'Repository', 'Team'], stopList: [] },
    search: { defaultLimit: 8, maxLimit: 25, candidatesPerLeg: 50, resultChars: 1500 },
    suggestions: {
      enabled: true,
      minSupport: 3,
      extraction: { enabled: false, model: '', dailyTokens: 2000000 },
    },
    agents: { askWritesAfterRead: true },
    retention: { tombstoneDays: 30 },
  }),
```

`packages/shared/src/config/index.ts`: add `KNOWLEDGE_EMBEDDING_DIMENSIONS` to the value exports and `KnowledgeConfig` to the type exports. `packages/shared/src/index.ts`: mirror both next to `AiConfig` / `KUBERNETES_WORKLOAD_KINDS`.

`shipit.config.yaml` — after the `ai:` block:

```yaml
# Knowledge layer: ingested text from Slack, Confluence, Jira and GitHub,
# indexed in the same Postgres as the agent platform (needs pgvector). Shares
# ai.database.url and ai.vertex. Everything below is the default; the block
# exists so operators can find the knobs.
knowledge:
  enabled: true
  embedding:
    model: gemini-embedding-2
    dimensions: 768
  sync:
    maxRunMinutes: 10
    reconcileCron: '0 3 * * *'
  worker:
    concurrency: 8
    batchSize: 16
```

`packages/api-server/src/__tests__/test-config.ts` — `makeTestConfig` builds a full `Config` literal, so add the section after `ai:` with the same defaults:

```ts
    knowledge: {
      enabled: true,
      embedding: { model: 'gemini-embedding-2', dimensions: 768 },
      sync: { maxRunMinutes: 10, reconcileCron: '0 3 * * *' },
      worker: { concurrency: 8, batchSize: 16 },
      index: { maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 },
      linking: { labels: ['LogicalService', 'Repository', 'Team'], stopList: [] },
      search: { defaultLimit: 8, maxLimit: 25, candidatesPerLeg: 50, resultChars: 1500 },
      suggestions: {
        enabled: true,
        minSupport: 3,
        extraction: { enabled: false, model: '', dailyTokens: 2000000 },
      },
      agents: { askWritesAfterRead: true },
      retention: { tombstoneDays: 30 },
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/shared exec vitest run src/__tests__/knowledge-config.test.ts`
Expected: PASS — 3 tests. Then `pnpm typecheck` — every package that constructs a `Config` literal compiles (only `test-config.ts` does).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/shared packages/api-server/src/__tests__/test-config.ts shipit.config.yaml
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/shared packages/api-server/src/__tests__/test-config.ts shipit.config.yaml
git commit -m "config: knowledge section with defaults; facet on connector run history"
```

---

## Task 4: The `KnowledgeConnector` contract, the harness and the fixture connector

**Files:**

- Create: `packages/connector-sdk/src/knowledge/types.ts`, `packages/connector-sdk/src/knowledge/harness.ts`, `packages/connector-sdk/src/knowledge/fixture.ts`, `packages/connector-sdk/src/knowledge/index.ts`
- Create: `packages/connector-sdk/src/knowledge/__tests__/harness.test.ts`
- Modify: `packages/connector-sdk/src/index.ts`

**Interfaces:**

- Consumes: `ConnectorConfig`, `AuthResult` from `./interface.js`.
- Produces (every later task imports these from `@shipit-ai/connector-sdk`):

```ts
type ContainerKind = 'channel' | 'space' | 'project' | 'repository';
type DocumentKind =
  | 'slack_thread'
  | 'slack_channel_day'
  | 'confluence_page'
  | 'jira_issue'
  | 'github_pull_request'
  | 'github_issue'
  | 'github_doc';
interface SourceAcl {
  open: boolean;
  principals: string[];
  capturedAt: string;
}
interface SourceContainer {
  externalId;
  kind;
  name;
  url?;
  visibility: 'open' | 'restricted' | 'unknown';
  archived: boolean;
  acl?;
}
interface SourcePrincipal {
  externalId;
  kind: 'user' | 'bot' | 'group' | 'external';
  displayName;
  email?;
  login?;
  active: boolean;
}
interface DocumentSegment {
  key;
  headingPath?: string[];
  authorExternalId?;
  authorName?;
  at?;
  url?;
  text;
}
interface KnowledgeDocumentInput {
  externalId;
  kind;
  title;
  url;
  segments;
  sourceVersion;
  sourceCreatedAt;
  sourceUpdatedAt;
  authorExternalId?;
  participantExternalIds: string[];
  state?;
  attributes;
  restricted: boolean;
  acl?;
}
interface ChangeBatch {
  documents: KnowledgeDocumentInput[];
  deletedExternalIds: string[];
  checkpoint: string;
}
interface SelectedContainer extends SourceContainer {
  checkpoint: string | null;
}
interface KnowledgeConnector {
  manifest;
  authenticate(config);
  listContainers();
  listPrincipals();
  fetchChanges(container, checkpoint, { historyDays });
  listDocumentIds(container);
  reconcile?(container, { days });
}
interface KnowledgeSink {
  upsertContainers(containers);
  upsertPrincipals(principals);
  selectedContainers();
  storeBatch(container, batch): Promise<{ changed: number; deleted: number }>;
  pruneMissing(container, presentIds: string[]): Promise<number>;
}
type KnowledgeRunMode = 'poll' | 'reconcile';
interface KnowledgeRunResult {
  status: 'success' | 'partial' | 'failed';
  documentsSynced;
  documentsDeleted;
  containersProcessed;
  errors: string[];
  authFailed: boolean;
  budgetExhausted: boolean;
  durationMs;
}
class KnowledgeHarness {
  constructor(
    connector,
    sink,
    config,
    options: { historyDays: number; rescanDays?: number; budgetMs: number; now?: () => number },
  );
  run(mode): Promise<KnowledgeRunResult>;
}
function createFixtureKnowledgeConnector(seed: FixtureSeed): FixtureKnowledgeConnector;
```

- [ ] **Step 1: Write the types**

Create `packages/connector-sdk/src/knowledge/types.ts`:

```ts
// The second connector contract: a KnowledgeConnector produces documents for
// the knowledge layer, never graph entities. Spec:
// docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §Connector contract.
import type { AuthResult, ConnectorConfig, ConnectorManifest } from '../interface.js';

export type ContainerKind = 'channel' | 'space' | 'project' | 'repository';

export type DocumentKind =
  | 'slack_thread'
  | 'slack_channel_day'
  | 'confluence_page'
  | 'jira_issue'
  | 'github_pull_request'
  | 'github_issue'
  | 'github_doc';

export type ContainerVisibility = 'open' | 'restricted' | 'unknown';

export type DocumentState = 'open' | 'closed' | 'merged' | 'resolved' | 'archived';

/** A snapshot of who may read something in the source. Recorded, not enforced, in v1. */
export interface SourceAcl {
  /** True when every member of the source can read it. */
  open: boolean;
  /** Source ids of users and groups with read access, when the API gives them cheaply. */
  principals: string[];
  capturedAt: string;
}

export interface SourceContainer {
  externalId: string;
  kind: ContainerKind;
  name: string;
  url?: string;
  visibility: ContainerVisibility;
  archived: boolean;
  acl?: SourceAcl;
}

/** A container the admin selected, with the sync checkpoint the sink holds for it. */
export interface SelectedContainer extends SourceContainer {
  checkpoint: string | null;
}

export interface SourcePrincipal {
  externalId: string;
  kind: 'user' | 'bot' | 'group' | 'external';
  displayName: string;
  email?: string;
  /** GitHub login, when the source has one. */
  login?: string;
  active: boolean;
}

export interface DocumentSegment {
  /** Stable within the document: a message ts, a comment id, a heading path. */
  key: string;
  headingPath?: string[];
  authorExternalId?: string;
  /** Display name at fetch time; the chunker renders it, the principal table resolves identity. */
  authorName?: string;
  at?: string;
  url?: string;
  text: string;
}

export interface KnowledgeDocumentInput {
  externalId: string;
  kind: DocumentKind;
  title: string;
  url: string;
  segments: DocumentSegment[];
  /** Opaque. Equal to the stored value means the content is unchanged. */
  sourceVersion: string;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  authorExternalId?: string;
  participantExternalIds: string[];
  state?: DocumentState;
  /** Source-specific, typed per kind in @shipit-ai/knowledge (status, labels, links, …). */
  attributes: Record<string, unknown>;
  /** True when the item carries its own restriction. Segments must then be empty. */
  restricted: boolean;
  acl?: SourceAcl;
}

export interface ChangeBatch {
  documents: KnowledgeDocumentInput[];
  deletedExternalIds: string[];
  /** The checkpoint to store once this batch is committed. Opaque to the harness. */
  checkpoint: string;
}

export interface FetchChangesOptions {
  /** Backfill horizon in days; 0 means everything. */
  historyDays: number;
}

export interface ReconcileOptions {
  /** How far back a source-specific reconcile looks for edits and deletions. */
  days: number;
}

export interface KnowledgeConnector {
  readonly manifest: ConnectorManifest;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  listContainers(): AsyncIterable<SourceContainer>;
  listPrincipals(): AsyncIterable<SourcePrincipal>;
  /** Changes since the checkpoint, oldest first. A null checkpoint starts the backfill. */
  fetchChanges(
    container: SelectedContainer,
    checkpoint: string | null,
    options: FetchChangesOptions,
  ): AsyncIterable<ChangeBatch>;
  /** Every external id that currently exists in the container, in pages. Drives pruning. */
  listDocumentIds(container: SelectedContainer): AsyncIterable<string[]>;
  /** Source-specific edit and deletion detection beyond listDocumentIds (Slack). */
  reconcile?(container: SelectedContainer, options: ReconcileOptions): AsyncIterable<ChangeBatch>;
}

/** Storage behind the harness. Implemented with Postgres in @shipit-ai/knowledge. */
export interface KnowledgeSink {
  /** Replaces the known container list; containers missing from a COMPLETE list are marked gone. */
  upsertContainers(containers: SourceContainer[]): Promise<void>;
  upsertPrincipals(principals: SourcePrincipal[]): Promise<void>;
  selectedContainers(): Promise<SelectedContainer[]>;
  /** Stores documents, tombstones deletions and saves the checkpoint in ONE transaction. */
  storeBatch(
    container: SelectedContainer,
    batch: ChangeBatch,
  ): Promise<{ changed: number; deleted: number }>;
  /** Tombstones every document in the container whose external id is not listed. */
  pruneMissing(container: SelectedContainer, presentIds: string[]): Promise<number>;
}

export type KnowledgeRunMode = 'poll' | 'reconcile';

export interface KnowledgeRunResult {
  status: 'success' | 'partial' | 'failed';
  documentsSynced: number;
  documentsDeleted: number;
  containersProcessed: number;
  errors: string[];
  /** authenticate() refused, or a call answered 401/403. Sticky: the scheduler marks `degraded`. */
  authFailed: boolean;
  /** The time budget ran out before every selected container was visited. */
  budgetExhausted: boolean;
  durationMs: number;
}
```

- [ ] **Step 2: Write the failing harness tests**

Create `packages/connector-sdk/src/knowledge/__tests__/harness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { KnowledgeHarness } from '../harness.js';
import { createFixtureKnowledgeConnector, type FixtureSeed } from '../fixture.js';
import type {
  ChangeBatch,
  KnowledgeSink,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '../types.js';

// A sink that remembers everything in memory, the way the tests want to read it.
class MemorySink implements KnowledgeSink {
  containers = new Map<string, SelectedContainer>();
  principals: SourcePrincipal[] = [];
  stored: Array<{ container: string; batch: ChangeBatch }> = [];
  pruned: Array<{ container: string; presentIds: string[] }> = [];
  docs = new Map<string, Set<string>>(); // container → external ids present
  failStoreOn: string | null = null; // container externalId whose storeBatch throws

  select(container: SourceContainer, checkpoint: string | null = null): void {
    this.containers.set(container.externalId, { ...container, checkpoint });
  }
  async upsertContainers(containers: SourceContainer[]): Promise<void> {
    const seen = new Set(containers.map((c) => c.externalId));
    for (const c of containers) {
      const existing = this.containers.get(c.externalId);
      this.containers.set(c.externalId, { ...c, checkpoint: existing?.checkpoint ?? null });
    }
    for (const id of [...this.containers.keys()]) if (!seen.has(id)) this.containers.delete(id);
  }
  async upsertPrincipals(principals: SourcePrincipal[]): Promise<void> {
    this.principals.push(...principals);
  }
  async selectedContainers(): Promise<SelectedContainer[]> {
    return [...this.containers.values()];
  }
  async storeBatch(container: SelectedContainer, batch: ChangeBatch) {
    if (this.failStoreOn === container.externalId) throw new Error('disk full');
    this.stored.push({ container: container.externalId, batch });
    const ids = this.docs.get(container.externalId) ?? new Set<string>();
    for (const d of batch.documents) ids.add(d.externalId);
    for (const d of batch.deletedExternalIds) ids.delete(d);
    this.docs.set(container.externalId, ids);
    const current = this.containers.get(container.externalId)!;
    this.containers.set(container.externalId, { ...current, checkpoint: batch.checkpoint });
    return { changed: batch.documents.length, deleted: batch.deletedExternalIds.length };
  }
  async pruneMissing(container: SelectedContainer, presentIds: string[]): Promise<number> {
    this.pruned.push({ container: container.externalId, presentIds });
    const ids = this.docs.get(container.externalId) ?? new Set<string>();
    let n = 0;
    for (const id of [...ids]) if (!presentIds.includes(id)) (ids.delete(id), n++);
    return n;
  }
}

const config = { id: 'fx-1', type: 'fixture', credentials: {}, scope: {} };

function seed(): FixtureSeed {
  return {
    containers: [
      { externalId: 'C1', kind: 'channel', name: 'general', visibility: 'open', archived: false },
      { externalId: 'C2', kind: 'channel', name: 'ops', visibility: 'open', archived: false },
    ],
    principals: [
      {
        externalId: 'U1',
        kind: 'user',
        displayName: 'Ada',
        email: 'ada@example.com',
        active: true,
      },
    ],
    documents: {
      C1: [
        doc('C1', 'd1', '2026-01-01T00:00:00Z'),
        doc('C1', 'd2', '2026-01-02T00:00:00Z'),
        doc('C1', 'd3', '2026-01-03T00:00:00Z'),
      ],
      C2: [doc('C2', 'e1', '2026-01-01T00:00:00Z')],
    },
    batchSize: 2,
  };
}

function doc(container: string, id: string, at: string) {
  return {
    externalId: `${container}/${id}`,
    kind: 'slack_thread' as const,
    title: id,
    url: `https://example.test/${container}/${id}`,
    segments: [{ key: 'm1', text: `hello from ${id}`, at }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    participantExternalIds: ['U1'],
    attributes: {},
    restricted: false,
  };
}

function harness(
  connector: ReturnType<typeof createFixtureKnowledgeConnector>,
  sink: KnowledgeSink,
  budgetMs = 60_000,
  now?: () => number,
) {
  return new KnowledgeHarness(connector, sink, config, { historyDays: 365, budgetMs, now });
}

describe('KnowledgeHarness poll', () => {
  it('stores every batch of every selected container and reports success', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('success');
    expect(result.documentsSynced).toBe(4);
    expect(result.containersProcessed).toBe(2);
    // C1 has 3 docs at batch size 2 → 2 batches; C2 → 1 batch.
    expect(sink.stored.map((s) => s.container)).toEqual(['C1', 'C1', 'C2']);
  });

  it('resumes from the stored checkpoint instead of refetching', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    // Pretend the first batch of C1 (d1, d2) was stored by an earlier, interrupted run.
    sink.select(seed().containers[0]!, '2026-01-02T00:00:00Z');

    const result = await harness(connector, sink).run('poll');

    expect(result.documentsSynced).toBe(1);
    expect(sink.stored[0]!.batch.documents.map((d) => d.externalId)).toEqual(['C1/d3']);
  });

  it('stops when the time budget is spent and says so', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    let t = 0;
    const clock = () => (t += 40_000); // every look at the clock costs 40 s

    const result = await harness(connector, sink, 50_000, clock).run('poll');

    expect(result.budgetExhausted).toBe(true);
    expect(result.status).toBe('success'); // nothing failed; the next run continues
    expect(sink.stored.length).toBeLessThan(3);
  });

  it('isolates a failing container and reports partial', async () => {
    const sink = new MemorySink();
    sink.failStoreOn = 'C1';
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('partial');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('C1');
    expect(sink.stored.map((s) => s.container)).toEqual(['C2']);
  });

  it('reports failed with authFailed when authentication is refused', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({ ...seed(), authError: 'token revoked' });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.status).toBe('failed');
    expect(result.authFailed).toBe(true);
    expect(sink.stored).toHaveLength(0);
  });

  it('marks authFailed when a fetch answers 403 and keeps the other containers', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      fetchErrors: { C1: Object.assign(new Error('forbidden'), { status: 403 }) },
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('poll');

    expect(result.authFailed).toBe(true);
    expect(result.status).toBe('partial');
    expect(sink.stored.map((s) => s.container)).toEqual(['C2']);
  });
});

describe('KnowledgeHarness reconcile', () => {
  it('refreshes containers and principals, then prunes by the id listing', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector(seed());
    for (const c of seed().containers) sink.select(c);
    await harness(connector, sink).run('poll');
    // Upstream deleted C1/d2 after the poll.
    connector.deleteDocument('C1', 'C1/d2');

    const result = await harness(connector, sink).run('reconcile');

    expect(result.status).toBe('success');
    expect(sink.principals.map((p) => p.externalId)).toEqual(['U1']);
    expect(sink.pruned.find((p) => p.container === 'C1')!.presentIds).toEqual(['C1/d1', 'C1/d3']);
    expect(result.documentsDeleted).toBe(1);
  });

  it('does not prune when the id listing throws', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      listIdErrors: { C1: new Error('rate limited') },
    });
    for (const c of seed().containers) sink.select(c);
    await harness(connector, sink).run('poll');

    const result = await harness(connector, sink).run('reconcile');

    expect(result.status).toBe('partial');
    expect(sink.pruned.map((p) => p.container)).toEqual(['C2']);
  });

  it('keeps the container list when listing containers throws midway', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      listContainersError: new Error('boom'),
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('reconcile');

    expect(result.errors[0]).toContain('boom');
    expect([...sink.containers.keys()]).toEqual(['C1', 'C2']);
  });

  it('runs the connector reconcile hook when present', async () => {
    const sink = new MemorySink();
    const connector = createFixtureKnowledgeConnector({
      ...seed(),
      reconcileBatches: {
        C1: [
          {
            documents: [doc('C1', 'd9', '2026-01-09T00:00:00Z')],
            deletedExternalIds: [],
            checkpoint: 'kept',
          },
        ],
      },
    });
    for (const c of seed().containers) sink.select(c);

    const result = await harness(connector, sink).run('reconcile');

    expect(result.documentsSynced).toBe(1);
    expect(sink.stored.some((s) => s.batch.documents[0]?.externalId === 'C1/d9')).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/connector-sdk exec vitest run src/knowledge/__tests__/harness.test.ts`
Expected: FAIL — cannot find module `../harness.js`.

- [ ] **Step 4: Implement the harness, the fixture and the exports**

Create `packages/connector-sdk/src/knowledge/harness.ts`:

```ts
// Drives a KnowledgeConnector the way ConnectorHarness drives a ShipItConnector,
// with two differences the knowledge layer needs: a per-batch checkpoint the
// sink commits with the batch (so an interrupted backfill resumes), and a time
// budget (so one container's backfill cannot hold a job for hours).
import type { ConnectorConfig } from '../interface.js';
import type {
  KnowledgeConnector,
  KnowledgeRunMode,
  KnowledgeRunResult,
  KnowledgeSink,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from './types.js';

export interface KnowledgeHarnessOptions {
  /** Backfill horizon in days; 0 means everything. */
  historyDays: number;
  /** Window for the connector's own reconcile hook. Default 14. */
  rescanDays?: number;
  /** Wall-clock budget for one run. The run yields between batches once it is spent. */
  budgetMs: number;
  /** Test seam. */
  now?: () => number;
  log?: (line: string) => void;
}

const PRINCIPAL_BATCH = 500;

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number };
  return e.status ?? e.statusCode;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class KnowledgeHarness {
  private readonly now: () => number;

  constructor(
    private readonly connector: KnowledgeConnector,
    private readonly sink: KnowledgeSink,
    private readonly config: ConnectorConfig,
    private readonly options: KnowledgeHarnessOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async run(mode: KnowledgeRunMode): Promise<KnowledgeRunResult> {
    const startedAt = this.now();
    const deadline = startedAt + this.options.budgetMs;
    const result: KnowledgeRunResult = {
      status: 'success',
      documentsSynced: 0,
      documentsDeleted: 0,
      containersProcessed: 0,
      errors: [],
      authFailed: false,
      budgetExhausted: false,
      durationMs: 0,
    };
    const finish = (): KnowledgeRunResult => {
      result.durationMs = Math.max(0, this.now() - startedAt);
      if (result.errors.length === 0) result.status = 'success';
      else result.status = result.containersProcessed > 0 ? 'partial' : 'failed';
      return result;
    };
    const budgetLeft = (): boolean => {
      if (this.now() < deadline) return true;
      result.budgetExhausted = true;
      return false;
    };
    const recordError = (scope: string, err: unknown): void => {
      result.errors.push(`${scope}: ${messageOf(err)}`);
      const status = statusOf(err);
      if (status === 401 || status === 403) result.authFailed = true;
    };

    let auth;
    try {
      auth = await this.connector.authenticate(this.config);
    } catch (err) {
      recordError('authenticate', err);
      result.authFailed = true;
      return finish();
    }
    if (!auth.success) {
      result.errors.push(auth.error ?? 'Authentication failed');
      result.authFailed = true;
      return finish();
    }

    if (mode === 'reconcile') {
      await this.refreshContainers(recordError);
      await this.refreshPrincipals(recordError);
    }

    const containers = await this.sink.selectedContainers();
    for (const container of containers) {
      if (!budgetLeft()) break;
      const scope = `container ${container.name} (${container.externalId})`;
      try {
        if (mode === 'poll') {
          await this.pollContainer(container, result, budgetLeft);
        } else {
          await this.reconcileContainer(container, result, budgetLeft);
        }
        result.containersProcessed += 1;
      } catch (err) {
        recordError(scope, err);
      }
    }
    return finish();
  }

  private async pollContainer(
    container: SelectedContainer,
    result: KnowledgeRunResult,
    budgetLeft: () => boolean,
  ): Promise<void> {
    const batches = this.connector.fetchChanges(container, container.checkpoint, {
      historyDays: this.options.historyDays,
    });
    for await (const batch of batches) {
      const stored = await this.sink.storeBatch(container, batch);
      result.documentsSynced += stored.changed;
      result.documentsDeleted += stored.deleted;
      container.checkpoint = batch.checkpoint;
      if (!budgetLeft()) break; // `break` runs the generator's return(): the connector stops fetching
    }
  }

  private async reconcileContainer(
    container: SelectedContainer,
    result: KnowledgeRunResult,
    budgetLeft: () => boolean,
  ): Promise<void> {
    if (this.connector.reconcile) {
      const batches = this.connector.reconcile(container, { days: this.options.rescanDays ?? 14 });
      for await (const batch of batches) {
        const stored = await this.sink.storeBatch(container, batch);
        result.documentsSynced += stored.changed;
        result.documentsDeleted += stored.deleted;
        if (!budgetLeft()) return;
      }
    }
    // Collect the WHOLE listing before pruning: a listing that throws halfway
    // must never delete anything (spec §Error handling).
    const presentIds: string[] = [];
    for await (const page of this.connector.listDocumentIds(container)) {
      presentIds.push(...page);
    }
    result.documentsDeleted += await this.sink.pruneMissing(container, presentIds);
  }

  private async refreshContainers(
    recordError: (scope: string, err: unknown) => void,
  ): Promise<void> {
    const all: SourceContainer[] = [];
    try {
      for await (const c of this.connector.listContainers()) all.push(c);
    } catch (err) {
      recordError('listContainers', err);
      return; // an incomplete list must not mark anything gone
    }
    await this.sink.upsertContainers(all);
  }

  private async refreshPrincipals(
    recordError: (scope: string, err: unknown) => void,
  ): Promise<void> {
    let page: SourcePrincipal[] = [];
    try {
      for await (const p of this.connector.listPrincipals()) {
        page.push(p);
        if (page.length >= PRINCIPAL_BATCH) {
          await this.sink.upsertPrincipals(page);
          page = [];
        }
      }
      if (page.length > 0) await this.sink.upsertPrincipals(page);
    } catch (err) {
      recordError('listPrincipals', err);
    }
  }
}
```

Create `packages/connector-sdk/src/knowledge/fixture.ts`:

```ts
// An in-memory KnowledgeConnector for tests across the workspace: the SDK, the
// knowledge store, the api-server scheduler and the worker all drive it.
import type { ConnectorConfig, AuthResult, ConnectorManifest } from '../interface.js';
import type {
  ChangeBatch,
  FetchChangesOptions,
  KnowledgeConnector,
  KnowledgeDocumentInput,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from './types.js';

export interface FixtureSeed {
  containers: SourceContainer[];
  principals?: SourcePrincipal[];
  /** Documents per container external id, in sourceUpdatedAt order. */
  documents: Record<string, KnowledgeDocumentInput[]>;
  /** Documents per fetchChanges batch. Default 50. */
  batchSize?: number;
  /** authenticate() refuses with this message. */
  authError?: string;
  /** fetchChanges throws this for the container. */
  fetchErrors?: Record<string, Error>;
  /** listDocumentIds throws this for the container. */
  listIdErrors?: Record<string, Error>;
  /** listContainers yields the first container, then throws this. */
  listContainersError?: Error;
  /** Batches the reconcile hook yields per container. Absent: no hook. */
  reconcileBatches?: Record<string, ChangeBatch[]>;
}

export interface FixtureKnowledgeConnector extends KnowledgeConnector {
  /** Simulate an upstream deletion. */
  deleteDocument(containerId: string, externalId: string): void;
  /** Simulate an upstream edit or arrival. */
  putDocument(containerId: string, doc: KnowledgeDocumentInput): void;
  readonly calls: { fetchChanges: Array<{ container: string; checkpoint: string | null }> };
}

export function createFixtureKnowledgeConnector(seed: FixtureSeed): FixtureKnowledgeConnector {
  const documents = new Map<string, KnowledgeDocumentInput[]>();
  for (const [container, docs] of Object.entries(seed.documents))
    documents.set(container, [...docs]);
  const batchSize = seed.batchSize ?? 50;
  const calls = { fetchChanges: [] as Array<{ container: string; checkpoint: string | null }> };

  const manifest: ConnectorManifest = {
    name: 'fixture',
    version: '0.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: [],
  };

  const connector: FixtureKnowledgeConnector = {
    manifest,
    calls,
    async authenticate(_config: ConnectorConfig): Promise<AuthResult> {
      return seed.authError ? { success: false, error: seed.authError } : { success: true };
    },
    async *listContainers() {
      for (const [i, c] of seed.containers.entries()) {
        if (i === 1 && seed.listContainersError) throw seed.listContainersError;
        yield c;
      }
    },
    async *listPrincipals() {
      for (const p of seed.principals ?? []) yield p;
    },
    async *fetchChanges(
      container: SelectedContainer,
      checkpoint: string | null,
      _options: FetchChangesOptions,
    ) {
      calls.fetchChanges.push({ container: container.externalId, checkpoint });
      const error = seed.fetchErrors?.[container.externalId];
      if (error) throw error;
      const all = documents.get(container.externalId) ?? [];
      // The checkpoint is the sourceUpdatedAt of the last stored document.
      const pending = all.filter((d) => checkpoint === null || d.sourceUpdatedAt > checkpoint);
      for (let i = 0; i < pending.length; i += batchSize) {
        const slice = pending.slice(i, i + batchSize);
        yield {
          documents: slice,
          deletedExternalIds: [],
          checkpoint: slice[slice.length - 1]!.sourceUpdatedAt,
        };
      }
    },
    async *listDocumentIds(container: SelectedContainer) {
      const error = seed.listIdErrors?.[container.externalId];
      if (error) throw error;
      const ids = (documents.get(container.externalId) ?? []).map((d) => d.externalId);
      for (let i = 0; i < ids.length; i += batchSize) yield ids.slice(i, i + batchSize);
    },
    deleteDocument(containerId, externalId) {
      documents.set(
        containerId,
        (documents.get(containerId) ?? []).filter((d) => d.externalId !== externalId),
      );
    },
    putDocument(containerId, doc) {
      const list = (documents.get(containerId) ?? []).filter(
        (d) => d.externalId !== doc.externalId,
      );
      list.push(doc);
      list.sort((a, b) => a.sourceUpdatedAt.localeCompare(b.sourceUpdatedAt));
      documents.set(containerId, list);
    },
  };

  if (seed.reconcileBatches) {
    const batches = seed.reconcileBatches;
    connector.reconcile = async function* (container: SelectedContainer) {
      for (const b of batches[container.externalId] ?? []) yield b;
    };
  }
  return connector;
}
```

Create `packages/connector-sdk/src/knowledge/index.ts`:

```ts
export type {
  ChangeBatch,
  ContainerKind,
  ContainerVisibility,
  DocumentKind,
  DocumentSegment,
  DocumentState,
  FetchChangesOptions,
  KnowledgeConnector,
  KnowledgeDocumentInput,
  KnowledgeRunMode,
  KnowledgeRunResult,
  KnowledgeSink,
  ReconcileOptions,
  SelectedContainer,
  SourceAcl,
  SourceContainer,
  SourcePrincipal,
} from './types.js';
export { KnowledgeHarness } from './harness.js';
export type { KnowledgeHarnessOptions } from './harness.js';
export { createFixtureKnowledgeConnector } from './fixture.js';
export type { FixtureKnowledgeConnector, FixtureSeed } from './fixture.js';
```

Append to `packages/connector-sdk/src/index.ts`:

```ts
// Knowledge connectors (documents, not graph entities)
export * from './knowledge/index.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/connector-sdk exec vitest run src/knowledge/__tests__/harness.test.ts`
Expected: PASS — 10 tests. If `stops when the time budget is spent` stores all three batches, check that `budgetLeft()` is evaluated after every `storeBatch` and before every container.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/connector-sdk
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/connector-sdk
git commit -m "connector-sdk: KnowledgeConnector contract, KnowledgeHarness and a fixture connector"
```

---

## Task 5: Secret redaction

**Files:**

- Create: `packages/knowledge/src/redaction.ts`, `packages/knowledge/src/hash.ts`
- Create: `packages/knowledge/src/__tests__/redaction.test.ts`, `packages/knowledge/src/__tests__/hash.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**

- Produces: `redactText(text: string): Promise<{ text: string; count: number }>`; `redactSegments(segments: DocumentSegment[]): Promise<{ segments: DocumentSegment[]; count: number }>`; `sha256Hex(text: string): string`; `contentHashOf(title: string, segments: DocumentSegment[]): string`.

- [ ] **Step 1: Write the failing tests**

Create `packages/knowledge/src/__tests__/redaction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { redactSegments, redactText } from '../redaction.js';

// Shapes secretlint's recommended preset flags. Built by concatenation so the
// repo's own secret scan (pre-commit hook and CI) does not trip on this file:
// neither the AWS prefix nor the PEM header appears contiguously in the source.
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const PEM = (kind: string) => `-----${kind} RSA ` + 'PRIVATE KEY-----';
const PRIVATE_KEY = `${PEM('BEGIN')}\nMIIBOgIBAAJBAK3vXyz0000000000000000000000000000000000000000000000\n${PEM('END')}`;

describe('redactText', () => {
  it('leaves ordinary text alone', async () => {
    const out = await redactText('deploy went fine, payments-api is back at 14:02');
    expect(out).toEqual({ text: 'deploy went fine, payments-api is back at 14:02', count: 0 });
  });

  it('replaces an AWS access key id and names the rule', async () => {
    const out = await redactText(`creds are ${AWS_KEY} please rotate`);
    expect(out.count).toBe(1);
    expect(out.text).not.toContain(AWS_KEY);
    expect(out.text).toMatch(/creds are \[redacted:[a-z0-9-]+\] please rotate/);
  });

  it('replaces every match and counts them', async () => {
    const out = await redactText(`${AWS_KEY}\n${PRIVATE_KEY}\n${AWS_KEY}`);
    expect(out.count).toBeGreaterThanOrEqual(2);
    expect(out.text).not.toContain(AWS_KEY);
    expect(out.text).not.toContain(PEM('BEGIN'));
  });

  it('returns empty text unchanged without calling the linter', async () => {
    expect(await redactText('')).toEqual({ text: '', count: 0 });
  });
});

describe('redactSegments', () => {
  it('redacts each segment and sums the counts', async () => {
    const out = await redactSegments([
      { key: 'a', text: `one ${AWS_KEY}` },
      { key: 'b', text: 'clean' },
      { key: 'c', text: `two ${AWS_KEY}` },
    ]);
    expect(out.count).toBe(2);
    expect(out.segments.map((s) => s.key)).toEqual(['a', 'b', 'c']);
    expect(out.segments[1]!.text).toBe('clean');
    expect(out.segments[0]!.text).not.toContain(AWS_KEY);
  });
});
```

Create `packages/knowledge/src/__tests__/hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { contentHashOf, sha256Hex } from '../hash.js';

describe('hashing', () => {
  it('is stable for the same input', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).toHaveLength(64);
  });

  it('changes when a segment changes and ignores author display names', () => {
    const a = contentHashOf('T', [{ key: 'k', text: 'x', authorName: 'Ada' }]);
    const b = contentHashOf('T', [{ key: 'k', text: 'x', authorName: 'A. Lovelace' }]);
    const c = contentHashOf('T', [{ key: 'k', text: 'y', authorName: 'Ada' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/redaction.test.ts src/__tests__/hash.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `packages/knowledge/src/hash.ts`:

```ts
import { createHash } from 'node:crypto';
import type { DocumentSegment } from '@shipit-ai/connector-sdk';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The content fingerprint that decides whether a document is re-indexed. It
 * covers what the chunker reads (title, structure, authorship, time, text) and
 * ignores display names, which drift without the content changing.
 */
export function contentHashOf(title: string, segments: DocumentSegment[]): string {
  const canonical = JSON.stringify({
    title,
    segments: segments.map((s) => ({
      key: s.key,
      headingPath: s.headingPath ?? null,
      authorExternalId: s.authorExternalId ?? null,
      at: s.at ?? null,
      url: s.url ?? null,
      text: s.text,
    })),
  });
  return sha256Hex(canonical);
}
```

Create `packages/knowledge/src/redaction.ts`:

```ts
// Secrets are redacted BEFORE a segment is stored or embedded (spec decision
// 14), so neither Postgres nor Vertex ever sees them. The rule set is the same
// secretlint recommended preset the repo's pre-commit hook runs, used as a
// library. The repo's .secretlintrc.json allow-list (local dev database URLs)
// is deliberately NOT applied here: content is not our source tree.
import { lintSource } from '@secretlint/core';
import { creator as recommendedPreset } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';
import type { DocumentSegment } from '@shipit-ai/connector-sdk';

const CONFIG: SecretLintCoreConfig = {
  rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommendedPreset }],
};

const RULE_PREFIX = '@secretlint/secretlint-rule-';

function shortRule(ruleId: string): string {
  return ruleId.startsWith(RULE_PREFIX) ? ruleId.slice(RULE_PREFIX.length) : ruleId;
}

export interface Redacted {
  text: string;
  count: number;
}

export async function redactText(text: string): Promise<Redacted> {
  if (text.length === 0) return { text, count: 0 };
  const result = await lintSource({
    source: { content: text, filePath: 'segment.txt', ext: '.txt', contentType: 'text' },
    options: { config: CONFIG, locale: 'en', maskSecrets: false, noPhysicFilePath: true },
  });
  const ranges = result.messages
    .filter((m) => m.type === 'message')
    .map((m) => ({ start: m.range[0], end: m.range[1], rule: shortRule(m.ruleId) }))
    .sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return { text, count: 0 };

  // Merge overlaps (two rules can flag the same bytes), then splice from the end
  // so earlier offsets stay valid.
  const merged: typeof ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = text;
  for (const r of [...merged].reverse()) {
    out = `${out.slice(0, r.start)}[redacted:${r.rule}]${out.slice(r.end)}`;
  }
  return { text: out, count: merged.length };
}

export async function redactSegments(
  segments: DocumentSegment[],
): Promise<{ segments: DocumentSegment[]; count: number }> {
  let count = 0;
  const out: DocumentSegment[] = [];
  for (const segment of segments) {
    const redacted = await redactText(segment.text);
    count += redacted.count;
    out.push(redacted.count > 0 ? { ...segment, text: redacted.text } : segment);
  }
  return { segments: out, count };
}
```

Add `@secretlint/types` to the package's `dependencies` (`"@secretlint/types": "^13.0.4"`) and run `pnpm install`.

Append to `packages/knowledge/src/index.ts`:

```ts
export { contentHashOf, sha256Hex } from './hash.js';
export { redactSegments, redactText } from './redaction.js';
export type { Redacted } from './redaction.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/redaction.test.ts src/__tests__/hash.test.ts`
Expected: PASS — 7 tests. If `replaces an AWS access key id` fails because the preset does not flag that exact string, swap `AWS_KEY` for the private-key block in that test (the `privatekey` rule matches any `BEGIN … PRIVATE KEY` block) and keep the assertions; secretlint's patterns, not ours, decide what is a secret.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/knowledge
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge pnpm-lock.yaml
git commit -m "knowledge: secret redaction on secretlint's recommended preset; content hashing"
```

---

## Task 6: Chunkers

**Files:**

- Create: `packages/knowledge/src/chunking.ts`
- Create: `packages/knowledge/src/__tests__/chunking.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**

- Produces:

```ts
interface ChunkingOptions {
  chunkTokens: number;
  maxChunkTokens: number;
  gapMinutes?: number;
}
interface ChunkableDocument {
  kind: DocumentKind;
  title: string;
  segments: DocumentSegment[];
  attributes: Record<string, unknown>;
  containerName: string;
}
interface ChunkDraft {
  seq: number;
  segmentKeys: string[];
  url?: string;
  occurredAt?: string;
  prefix: string;
  text: string;
  textHash: string;
  tokenEstimate: number;
}
function estimateTokens(text: string): number;
function chunkDocument(doc: ChunkableDocument, options: ChunkingOptions): ChunkDraft[];
```

- [ ] **Step 1: Write the failing tests**

Create `packages/knowledge/src/__tests__/chunking.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DocumentSegment } from '@shipit-ai/connector-sdk';
import { chunkDocument, estimateTokens, type ChunkableDocument } from '../chunking.js';

const opts = { chunkTokens: 600, maxChunkTokens: 800 };
const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');

function docOf(
  kind: ChunkableDocument['kind'],
  segments: DocumentSegment[],
  extra: Partial<ChunkableDocument> = {},
): ChunkableDocument {
  return { kind, title: 'Title', segments, attributes: {}, containerName: 'general', ...extra };
}

describe('estimateTokens', () => {
  it('is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('chunkDocument: pages and docs', () => {
  it('packs consecutive segments under one heading and prefixes the heading path', () => {
    const doc = docOf('confluence_page', [
      { key: 'h1-1', headingPath: ['Overview'], text: words(100) },
      { key: 'h1-2', headingPath: ['Overview'], text: words(100) },
      { key: 'h2-1', headingPath: ['Overview', 'Rollout'], text: words(100) },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks.map((c) => c.prefix)).toEqual(['Title › Overview', 'Title › Overview › Rollout']);
    expect(chunks[0]!.segmentKeys).toEqual(['h1-1', 'h1-2']);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
  });

  it('splits a heading group at the target size', () => {
    const doc = docOf('github_doc', [
      { key: 'a', headingPath: ['A'], text: words(500, 'abcd') }, // ~625 tokens
      { key: 'b', headingPath: ['A'], text: words(500, 'abcd') },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.tokenEstimate <= 800)).toBe(true);
  });

  it('splits one oversized segment into several chunks that keep its key', () => {
    const doc = docOf('github_doc', [
      { key: 'big', headingPath: ['A'], text: words(3000, 'abcd') },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.tokenEstimate <= 800)).toBe(true);
    expect(chunks.every((c) => c.segmentKeys.includes('big'))).toBe(true);
  });
});

describe('chunkDocument: issues and pull requests', () => {
  it('keeps the header on its own, then windows the comments with key and title in the prefix', () => {
    const doc = docOf(
      'jira_issue',
      [
        { key: 'header', text: 'Payments API returns 502 after deploy' },
        { key: 'c1', authorName: 'Ada', at: '2026-01-01T10:00:00Z', text: words(50) },
        { key: 'c2', authorName: 'Bob', at: '2026-01-01T11:00:00Z', text: words(50) },
      ],
      { attributes: { key: 'PAY-123' }, containerName: 'Payments' },
    );
    const chunks = chunkDocument(doc, opts);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.segmentKeys).toEqual(['header']);
    expect(chunks[0]!.prefix).toBe('PAY-123 Title · Payments');
    expect(chunks[1]!.segmentKeys).toEqual(['c1', 'c2']);
    expect(chunks[1]!.text).toContain('Ada (2026-01-01 10:00):');
  });

  it('uses the pull request number when there is no key', () => {
    const doc = docOf('github_pull_request', [{ key: 'header', text: 'x' }], {
      attributes: { number: 42 },
      containerName: 'acme/api',
    });
    expect(chunkDocument(doc, opts)[0]!.prefix).toBe('#42 Title · acme/api');
  });
});

describe('chunkDocument: Slack', () => {
  const at = (h: number, m = 0) =>
    `2026-03-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

  it('keeps a short thread whole, renders Name (HH:MM): text, and prefixes channel, date and first line', () => {
    const doc = docOf('slack_thread', [
      { key: '1', authorName: 'Ada', at: at(9, 5), text: 'payments-api is 502ing' },
      { key: '2', authorName: 'Bob', at: at(9, 6), text: 'rolling back' },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.prefix).toBe('#general · 2026-03-04 · payments-api is 502ing');
    expect(chunks[0]!.text).toBe('Ada (09:05): payments-api is 502ing\nBob (09:06): rolling back');
    expect(chunks[0]!.occurredAt).toBe(at(9, 5));
  });

  it('windows a long thread with one message of overlap', () => {
    const segments = Array.from({ length: 40 }, (_, i) => ({
      key: String(i),
      authorName: 'A',
      at: at(10, i),
      text: words(30, 'abcd'),
    }));
    const chunks = chunkDocument(docOf('slack_thread', segments), opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevLast = chunks[i - 1]!.segmentKeys.at(-1);
      expect(chunks[i]!.segmentKeys[0]).toBe(prevLast);
    }
  });

  it('splits a channel day where the conversation pauses for more than ten minutes', () => {
    const doc = docOf('slack_channel_day', [
      { key: '1', authorName: 'Ada', at: at(9, 0), text: 'morning' },
      { key: '2', authorName: 'Bob', at: at(9, 4), text: 'hi' },
      { key: '3', authorName: 'Ada', at: at(9, 30), text: 'deploying' },
      { key: '4', authorName: 'Bob', at: at(9, 31), text: 'ack' },
    ]);
    const chunks = chunkDocument(doc, opts);
    expect(chunks.map((c) => c.segmentKeys)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(chunks[0]!.prefix).toBe('#general · 2026-03-04');
  });

  it('carries the first message permalink of each chunk', () => {
    const doc = docOf('slack_channel_day', [
      { key: '1', at: at(9, 0), url: 'https://s/1', text: 'a' },
      { key: '2', at: at(9, 1), url: 'https://s/2', text: 'b' },
    ]);
    expect(chunkDocument(doc, opts)[0]!.url).toBe('https://s/1');
  });
});

describe('chunkDocument: hashes', () => {
  it('gives equal text the same hash across documents', () => {
    const a = chunkDocument(
      docOf('github_doc', [{ key: 'k', headingPath: ['A'], text: 'same' }]),
      opts,
    )[0]!;
    const b = chunkDocument(
      docOf('github_doc', [{ key: 'k', headingPath: ['A'], text: 'same' }]),
      opts,
    )[0]!;
    expect(a.textHash).toBe(b.textHash);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/chunking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/knowledge/src/chunking.ts`:

```ts
// Splits a document into the units that are embedded and searched. Shapes per
// kind follow spec §Index pipeline, "Chunking". Everything here is pure: no I/O,
// no model calls. The structural prefix (title, heading path, channel, date) is
// embedded and indexed with the text, which gives each chunk its context
// without a model call.
import type { DocumentKind, DocumentSegment } from '@shipit-ai/connector-sdk';
import { sha256Hex } from './hash.js';

export interface ChunkingOptions {
  /** Target size. A chunk is closed once the next segment would exceed it. */
  chunkTokens: number;
  /** Hard ceiling. A single segment above it is split. */
  maxChunkTokens: number;
  /** Slack channel days split where messages pause longer than this. Default 10. */
  gapMinutes?: number;
}

export interface ChunkableDocument {
  kind: DocumentKind;
  title: string;
  segments: DocumentSegment[];
  attributes: Record<string, unknown>;
  containerName: string;
}

export interface ChunkDraft {
  seq: number;
  segmentKeys: string[];
  url?: string;
  occurredAt?: string;
  prefix: string;
  text: string;
  textHash: string;
  tokenEstimate: number;
}

/** Four characters per token: cheap, no tokenizer dependency, stable across models. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// A rendered segment: what goes into the chunk text for one source segment.
interface Piece {
  key: string;
  url?: string;
  at?: string;
  text: string;
}

interface Group {
  prefix: string;
  pieces: Piece[];
  /** Pieces carried from the previous window into the next (Slack threads: 1). */
  overlap: number;
}

export function chunkDocument(doc: ChunkableDocument, options: ChunkingOptions): ChunkDraft[] {
  const groups = groupSegments(doc, options);
  const drafts: Omit<ChunkDraft, 'seq'>[] = [];
  for (const group of groups) {
    for (const window of pack(group.pieces, options, group.overlap)) {
      const text = window.map((p) => p.text).join('\n');
      drafts.push({
        segmentKeys: [...new Set(window.map((p) => p.key))],
        url: window.find((p) => p.url)?.url,
        occurredAt: window.find((p) => p.at)?.at,
        prefix: group.prefix,
        text,
        textHash: sha256Hex(text),
        tokenEstimate: estimateTokens(text),
      });
    }
  }
  return drafts.map((d, seq) => ({ seq, ...d }));
}

// ── Grouping per kind ──────────────────────────────────────────────────────

function groupSegments(doc: ChunkableDocument, options: ChunkingOptions): Group[] {
  switch (doc.kind) {
    case 'confluence_page':
    case 'github_doc':
      return groupByHeading(doc);
    case 'jira_issue':
    case 'github_pull_request':
    case 'github_issue':
      return groupIssue(doc);
    case 'slack_thread':
      return groupThread(doc);
    case 'slack_channel_day':
      return groupChannelDay(doc, options.gapMinutes ?? 10);
  }
}

function groupByHeading(doc: ChunkableDocument): Group[] {
  const groups: Group[] = [];
  let currentPath: string | null = null;
  for (const segment of doc.segments) {
    const path = (segment.headingPath ?? []).join(' › ');
    if (path !== currentPath || groups.length === 0) {
      groups.push({
        prefix: [doc.title, ...(segment.headingPath ?? [])].join(' › '),
        pieces: [],
        overlap: 0,
      });
      currentPath = path;
    }
    groups[groups.length - 1]!.pieces.push(piece(segment, segment.text));
  }
  return groups;
}

function issuePrefix(doc: ChunkableDocument): string {
  const key = doc.attributes.key;
  const number = doc.attributes.number;
  const ref =
    typeof key === 'string' && key ? key : number !== undefined ? `#${String(number)}` : '';
  return [ref, doc.title].filter(Boolean).join(' ') + ` · ${doc.containerName}`;
}

function groupIssue(doc: ChunkableDocument): Group[] {
  const prefix = issuePrefix(doc);
  const [header, ...comments] = doc.segments;
  const groups: Group[] = [];
  if (header) groups.push({ prefix, pieces: [piece(header, header.text)], overlap: 0 });
  if (comments.length > 0) {
    groups.push({
      prefix,
      pieces: comments.map((c) => piece(c, renderAuthored(c, 'date-time'))),
      overlap: 0,
    });
  }
  return groups;
}

function groupThread(doc: ChunkableDocument): Group[] {
  const first = doc.segments[0];
  const date = first?.at ? first.at.slice(0, 10) : '';
  const firstLine = (first?.text ?? '').split('\n')[0]!.slice(0, 80);
  const prefix = [`#${doc.containerName}`, date, firstLine].filter(Boolean).join(' · ');
  return [
    { prefix, pieces: doc.segments.map((s) => piece(s, renderAuthored(s, 'time'))), overlap: 1 },
  ];
}

function groupChannelDay(doc: ChunkableDocument, gapMinutes: number): Group[] {
  const date = doc.segments[0]?.at ? doc.segments[0].at.slice(0, 10) : '';
  const prefix = [`#${doc.containerName}`, date].filter(Boolean).join(' · ');
  const groups: Group[] = [];
  let lastAt: number | null = null;
  for (const segment of doc.segments) {
    const at = segment.at ? Date.parse(segment.at) : null;
    const pause = lastAt !== null && at !== null && at - lastAt > gapMinutes * 60_000;
    if (groups.length === 0 || pause) groups.push({ prefix, pieces: [], overlap: 0 });
    groups[groups.length - 1]!.pieces.push(piece(segment, renderAuthored(segment, 'time')));
    if (at !== null) lastAt = at;
  }
  return groups;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function piece(segment: DocumentSegment, text: string): Piece {
  return { key: segment.key, url: segment.url, at: segment.at, text };
}

/** `Name (HH:MM): text` for chat, `Name (YYYY-MM-DD HH:MM):\ntext` for comments. */
function renderAuthored(segment: DocumentSegment, style: 'time' | 'date-time'): string {
  const stamp = segment.at ? formatStamp(segment.at, style) : '';
  const who = segment.authorName ?? '';
  if (!who && !stamp) return segment.text;
  const head = `${who}${stamp ? ` (${stamp})` : ''}:`;
  return style === 'time' ? `${head} ${segment.text}` : `${head}\n${segment.text}`;
}

function formatStamp(iso: string, style: 'time' | 'date-time'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return style === 'time' ? `${hh}:${mm}` : `${iso.slice(0, 10)} ${hh}:${mm}`;
}

// ── Packing ────────────────────────────────────────────────────────────────

function pack(pieces: Piece[], options: ChunkingOptions, overlap: number): Piece[][] {
  // First make every piece fit under the ceiling on its own.
  const fitted: Piece[] = [];
  for (const p of pieces) {
    if (estimateTokens(p.text) <= options.maxChunkTokens) fitted.push(p);
    else
      for (const part of splitLongText(p.text, options.maxChunkTokens))
        fitted.push({ ...p, text: part });
  }

  const windows: Piece[][] = [];
  let current: Piece[] = [];
  let tokens = 0;
  for (const p of fitted) {
    const t = estimateTokens(p.text) + 1; // the joining newline
    if (current.length > 0 && tokens + t > options.chunkTokens) {
      windows.push(current);
      const carried = overlap > 0 ? current.slice(-overlap) : [];
      current = [...carried];
      tokens = carried.reduce((n, c) => n + estimateTokens(c.text) + 1, 0);
    }
    current.push(p);
    tokens += t;
  }
  if (current.length > 0 && !(overlap > 0 && windows.length > 0 && current.length === overlap)) {
    windows.push(current);
  }
  return windows;
}

/** Paragraphs first, then sentences, then a hard cut. Every part fits under maxTokens. */
export function splitLongText(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  const out: string[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer.trim().length > 0) out.push(buffer.trim());
    buffer = '';
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    const units = paragraph.length <= maxChars ? [paragraph] : paragraph.split(/(?<=[.!?])\s+/);
    for (const unit of units) {
      if (unit.length > maxChars) {
        flush();
        for (let i = 0; i < unit.length; i += maxChars) out.push(unit.slice(i, i + maxChars));
        continue;
      }
      if ((buffer + '\n\n' + unit).length > maxChars) flush();
      buffer = buffer ? `${buffer}\n\n${unit}` : unit;
    }
  }
  flush();
  return out;
}
```

Append to `packages/knowledge/src/index.ts`:

```ts
export { chunkDocument, estimateTokens, splitLongText } from './chunking.js';
export type { ChunkDraft, ChunkableDocument, ChunkingOptions } from './chunking.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/chunking.test.ts`
Expected: PASS — 12 tests. If `windows a long thread with one message of overlap` fails on the last window, the final `if` in `pack` is dropping a trailing window that holds only the carried message by design; check the window before it still ends with that key.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/knowledge
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge
git commit -m "knowledge: chunkers for pages, issues, threads and channel days"
```

---

## Task 7: The Postgres store and the sink

**Files:**

- Create: `packages/knowledge/src/vector.ts`, `packages/knowledge/src/store.ts`, `packages/knowledge/src/sink.ts`
- Create: `packages/knowledge/src/__tests__/vector.test.ts`, `packages/knowledge/src/__tests__/store.integration.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**

- Consumes: `Db`, `SqlClient` from `@shipit-ai/agents`; SDK types from Task 4; `redactSegments`, `contentHashOf` from Task 5.
- Produces:

```ts
function toPgVector(values: ArrayLike<number>): string; // '[0.1,0.2]'
class KnowledgeStore {
  constructor(db: Db);
  upsertContainers(connectorId, containers: SourceContainer[]): Promise<void>;
  listContainers(connectorId): Promise<ContainerRow[]>;
  selectedContainers(connectorId): Promise<SelectedContainer[]>;
  setSelected(connectorId, externalId, selected: boolean, by: string): Promise<void>;
  upsertPrincipals(connectorId, principals: SourcePrincipal[]): Promise<void>;
  storeBatch(
    connectorId,
    container: SelectedContainer,
    batch: ChangeBatch,
    redactions: Map<string, number>,
  ): Promise<{ changed: number; deleted: number }>;
  pruneMissing(connectorId, container: SelectedContainer, presentIds: string[]): Promise<number>;
  claimPending(limit: number, staleAfterMs?: number): Promise<DocumentRow[]>;
  getDocument(id): Promise<DocumentRow | null>;
  existingChunkEmbeddings(documentId, model): Promise<Map<string, string>>;
  replaceChunks(
    documentId,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ): Promise<void>;
  markUnchanged(documentId, indexVersion): Promise<void>;
  markSkipped(documentId): Promise<void>;
  markFailed(documentId, error: string): Promise<void>;
  countsByIndexStatus(): Promise<Record<string, number>>;
  deleteTombstonesOlderThan(days): Promise<number>;
  getState<T>(key): Promise<T | null>;
  setState(key, value): Promise<void>;
}
class PostgresKnowledgeSink implements KnowledgeSink {
  constructor(opts: { connectorId: string; store: KnowledgeStore; wake?: () => Promise<void> });
}
```

- [ ] **Step 1: Write the failing unit test for the vector literal**

Create `packages/knowledge/src/__tests__/vector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toPgVector } from '../vector.js';

describe('toPgVector', () => {
  it('formats a pgvector literal', () => {
    expect(toPgVector([0.5, -1, 2.25])).toBe('[0.5,-1,2.25]');
    expect(toPgVector(new Float32Array([1, 0]))).toBe('[1,0]');
  });
  it('rejects NaN and Infinity', () => {
    expect(() => toPgVector([1, Number.NaN])).toThrow(/finite/);
  });
});
```

- [ ] **Step 2: Write the failing integration suite**

Create `packages/knowledge/src/__tests__/store.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type {
  ChangeBatch,
  KnowledgeDocumentInput,
  SourceContainer,
} from '@shipit-ai/connector-sdk';
import { DATABASE_TEST_URL, createMigratedTestDatabase, type TestDatabase } from './test-db.js';
import { KnowledgeStore } from '../store.js';
import { PostgresKnowledgeSink } from '../sink.js';
import { toPgVector } from '../vector.js';

const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const C1: SourceContainer = {
  externalId: 'C1',
  kind: 'channel',
  name: 'general',
  visibility: 'open',
  archived: false,
};
const C2: SourceContainer = {
  externalId: 'C2',
  kind: 'channel',
  name: 'ops',
  visibility: 'restricted',
  archived: false,
};

function doc(id: string, text: string, at = '2026-01-01T00:00:00Z'): KnowledgeDocumentInput {
  return {
    externalId: id,
    kind: 'slack_thread',
    title: id,
    url: `https://example.test/${id}`,
    segments: [{ key: 'm1', text, at, authorExternalId: 'U1' }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    authorExternalId: 'U1',
    participantExternalIds: ['U1', 'U9'],
    attributes: { n: 1 },
    restricted: false,
  };
}

const batch = (
  documents: KnowledgeDocumentInput[],
  deletedExternalIds: string[] = [],
  checkpoint = 'cp1',
): ChangeBatch => ({
  documents,
  deletedExternalIds,
  checkpoint,
});

describe.skipIf(!DATABASE_TEST_URL)('KnowledgeStore and PostgresKnowledgeSink', () => {
  let database: TestDatabase;
  let store: KnowledgeStore;
  let sink: PostgresKnowledgeSink;
  const wakes: number[] = [];

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = new KnowledgeStore(database.db);
  });
  afterAll(async () => {
    await database?.drop();
  });
  beforeEach(async () => {
    await database.db.query(
      'TRUNCATE knowledge_chunks, knowledge_documents, knowledge_principals, knowledge_containers, knowledge_state',
    );
    wakes.length = 0;
    sink = new PostgresKnowledgeSink({
      connectorId: 'slack-1',
      store,
      wake: async () => void wakes.push(1),
    });
    await sink.upsertContainers([C1, C2]);
    await sink.upsertPrincipals([
      {
        externalId: 'U1',
        kind: 'user',
        displayName: 'Ada',
        email: 'ada@example.com',
        active: true,
      },
    ]);
    await store.setSelected('slack-1', 'C1', true, 'admin@example.com');
  });

  const selectedC1 = async () =>
    (await sink.selectedContainers()).find((c) => c.externalId === 'C1')!;

  describe('containers', () => {
    it('lists only selected, present containers with their checkpoint', async () => {
      const selected = await sink.selectedContainers();
      expect(selected.map((c) => c.externalId)).toEqual(['C1']);
      expect(selected[0]!.checkpoint).toBeNull();
    });

    it('marks containers missing from a complete list as gone, and back when they return', async () => {
      await sink.upsertContainers([C2]);
      expect(await sink.selectedContainers()).toEqual([]);
      await sink.upsertContainers([C1, C2]);
      expect((await sink.selectedContainers()).map((c) => c.externalId)).toEqual(['C1']);
      // Selection survived the round trip.
      const rows = await store.listContainers('slack-1');
      expect(rows.find((r) => r.externalId === 'C1')!.selected).toBe(true);
    });

    it('is scoped by connector id', async () => {
      const other = new PostgresKnowledgeSink({ connectorId: 'slack-2', store });
      await other.upsertContainers([C1]);
      expect((await other.selectedContainers()).length).toBe(0);
      expect((await store.listContainers('slack-2')).length).toBe(1);
    });
  });

  describe('storeBatch', () => {
    it('stores documents as pending, maps principals, saves the checkpoint and wakes the worker', async () => {
      const result = await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'hello'), doc('d2', 'world')]),
      );
      expect(result).toEqual({ changed: 2, deleted: 0 });
      expect((await selectedC1()).checkpoint).toBe('cp1');
      expect(wakes).toHaveLength(1);

      const claimed = await store.claimPending(10);
      expect(claimed.map((d) => d.externalId).sort()).toEqual(['d1', 'd2']);
      const d1 = claimed.find((d) => d.externalId === 'd1')!;
      expect(d1.indexStatus).toBe('indexing');
      expect(d1.authorPrincipalId).not.toBeNull();
      // U9 is unknown: not invented, just absent.
      expect(d1.participantPrincipalIds).toHaveLength(1);
      expect(d1.segments[0]!.text).toBe('hello');
    });

    it('storing the same batch twice changes nothing', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello')]));
      await database.db.query(
        `UPDATE knowledge_documents SET index_status = 'indexed', indexed_hash = content_hash`,
      );
      const again = await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'hello')], [], 'cp2'),
      );
      expect(again.changed).toBe(0);
      const { rows } = await database.db.query<{ index_status: string }>(
        `SELECT index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(rows[0]!.index_status).toBe('indexed');
      expect((await selectedC1()).checkpoint).toBe('cp2');
    });

    it('a changed document becomes pending again', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello')]));
      await database.db.query(
        `UPDATE knowledge_documents SET index_status = 'indexed', indexed_hash = content_hash`,
      );
      const result = await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello, edited')]));
      expect(result.changed).toBe(1);
      const { rows } = await database.db.query<{ index_status: string }>(
        `SELECT index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(rows[0]!.index_status).toBe('pending');
    });

    it('redacts before storing and counts it on the document', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', `token ${AWS_KEY} here`)]));
      const { rows } = await database.db.query<{
        segments: Array<{ text: string }>;
        redactions: number;
      }>(`SELECT segments, redactions FROM knowledge_documents WHERE external_id = 'd1'`);
      expect(rows[0]!.segments[0]!.text).not.toContain(AWS_KEY);
      expect(rows[0]!.segments[0]!.text).toMatch(/\[redacted:/);
      expect(rows[0]!.redactions).toBe(1);
    });

    it('stores a restricted item as a content-free stub that is never claimed', async () => {
      const restricted = { ...doc('r1', ''), segments: [], restricted: true };
      await sink.storeBatch(await selectedC1(), batch([restricted]));
      const { rows } = await database.db.query<{ index_status: string; restricted: boolean }>(
        `SELECT index_status, restricted FROM knowledge_documents WHERE external_id = 'r1'`,
      );
      expect(rows[0]).toEqual({ index_status: 'skipped', restricted: true });
      expect(await store.claimPending(10)).toEqual([]);
    });

    it('tombstones deletions in the same batch and removes their chunks', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'hello')]));
      const [d1] = await store.claimPending(10);
      await store.replaceChunks(d1!.id, [chunk(0, 'hello')], {
        indexedHash: d1!.contentHash!,
        indexVersion: 1,
      });
      const result = await sink.storeBatch(await selectedC1(), batch([], ['d1'], 'cp3'));
      expect(result).toEqual({ changed: 0, deleted: 1 });
      const docs = await database.db.query<{
        deleted_at: string | null;
        segments: unknown[];
        index_status: string;
      }>(
        `SELECT deleted_at, segments, index_status FROM knowledge_documents WHERE external_id = 'd1'`,
      );
      expect(docs.rows[0]!.deleted_at).not.toBeNull();
      expect(docs.rows[0]!.segments).toEqual([]);
      expect(docs.rows[0]!.index_status).toBe('skipped');
      const chunks = await database.db.query(`SELECT 1 FROM knowledge_chunks`);
      expect(chunks.rows).toHaveLength(0);
    });

    it('rolls the whole batch back when one row is invalid', async () => {
      const bad = { ...doc('d2', 'x'), kind: 'not-a-kind' as 'slack_thread' };
      await expect(
        sink.storeBatch(await selectedC1(), batch([doc('d1', 'ok'), bad])),
      ).rejects.toThrow();
      const { rows } = await database.db.query(`SELECT 1 FROM knowledge_documents`);
      expect(rows).toHaveLength(0);
      expect((await selectedC1()).checkpoint).toBeNull();
    });
  });

  describe('pruneMissing', () => {
    it('tombstones the rest and removes their chunks', async () => {
      await sink.storeBatch(
        await selectedC1(),
        batch([doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'c')]),
      );
      const pruned = await sink.pruneMissing(await selectedC1(), ['d1', 'd3']);
      expect(pruned).toBe(1);
      const { rows } = await database.db.query<{ external_id: string }>(
        `SELECT external_id FROM knowledge_documents WHERE deleted_at IS NOT NULL`,
      );
      expect(rows.map((r) => r.external_id)).toEqual(['d2']);
      // A second prune with the same list deletes nothing more.
      expect(await sink.pruneMissing(await selectedC1(), ['d1', 'd3'])).toBe(0);
    });
  });

  describe('claims and chunks', () => {
    it('reclaims a stale claim and leaves a fresh one alone', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      const first = await store.claimPending(1);
      expect(first).toHaveLength(1);
      // Age the claim past the stale window.
      await database.db.query(
        `UPDATE knowledge_documents SET index_claimed_at = now() - interval '11 minutes' WHERE id = $1`,
        [first[0]!.id],
      );
      const next = await store.claimPending(10);
      expect(next.map((d) => d.externalId).sort()).toEqual(['d1', 'd2']);
      // Both are now freshly claimed: nothing left.
      expect(await store.claimPending(10)).toEqual([]);
    });

    it('stops retrying after five failures and backs off before that', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      for (let attempt = 1; attempt <= 5; attempt++) {
        const [d] = await store.claimPending(10);
        expect(d, `attempt ${attempt}`).toBeDefined();
        await store.markFailed(d!.id, `boom ${attempt}`);
        // Just failed: not claimable until the backoff passes.
        expect(await store.claimPending(10)).toEqual([]);
        await database.db.query(
          `UPDATE knowledge_documents SET index_claimed_at = now() - interval '2 days'`,
        );
      }
      expect(await store.claimPending(10)).toEqual([]);
      const counts = await store.countsByIndexStatus();
      expect(counts.failed).toBe(1);
    });

    it('replaces chunks, reuses embeddings by text hash and marks the document indexed', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await store.replaceChunks(d!.id, [chunk(0, 'alpha'), chunk(1, 'beta')], {
        indexedHash: d!.contentHash!,
        indexVersion: 1,
      });

      const reusable = await store.existingChunkEmbeddings(d!.id, 'fake-model');
      expect([...reusable.keys()]).toHaveLength(2);

      await store.replaceChunks(d!.id, [chunk(0, 'beta')], { indexedHash: 'h2', indexVersion: 1 });
      const { rows } = await database.db.query<{ text: string; embedding: string }>(
        `SELECT text, embedding::text AS embedding FROM knowledge_chunks ORDER BY seq`,
      );
      expect(rows.map((r) => r.text)).toEqual(['beta']);
      // halfvec stores 16-bit floats, so compare with tolerance, not as text.
      const stored = JSON.parse(rows[0]!.embedding) as number[];
      const expected = vectorFor('beta');
      expect(stored).toHaveLength(768);
      for (let i = 0; i < 768; i++) expect(stored[i]).toBeCloseTo(expected[i]!, 2);

      const after = await store.getDocument(d!.id);
      expect(after!.indexStatus).toBe('indexed');
      expect(after!.indexedHash).toBe('h2');
      expect(after!.indexVersion).toBe(1);
      expect(after!.indexAttempts).toBe(0);
    });

    it('searches by cosine distance through the hnsw index', async () => {
      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a')]));
      const [d] = await store.claimPending(10);
      await store.replaceChunks(d!.id, [chunk(0, 'alpha'), chunk(1, 'beta')], {
        indexedHash: 'h',
        indexVersion: 1,
      });
      const { rows } = await database.db.query<{ text: string }>(
        `SELECT text FROM knowledge_chunks ORDER BY embedding <=> $1::halfvec LIMIT 1`,
        [toPgVector(vectorFor('beta'))],
      );
      expect(rows[0]!.text).toBe('beta');
    });
  });

  describe('state and retention', () => {
    it('round-trips state and deletes old tombstones only', async () => {
      await store.setState('dictionary', { version: 3 });
      expect(await store.getState<{ version: number }>('dictionary')).toEqual({ version: 3 });
      expect(await store.getState('missing')).toBeNull();

      await sink.storeBatch(await selectedC1(), batch([doc('d1', 'a'), doc('d2', 'b')]));
      await sink.pruneMissing(await selectedC1(), ['d2']);
      await database.db.query(
        `UPDATE knowledge_documents SET deleted_at = now() - interval '40 days' WHERE external_id = 'd1'`,
      );
      expect(await store.deleteTombstonesOlderThan(30)).toBe(1);
      const { rows } = await database.db.query<{ external_id: string }>(
        `SELECT external_id FROM knowledge_documents ORDER BY external_id`,
      );
      expect(rows.map((r) => r.external_id)).toEqual(['d2']);
    });
  });
});

// A deterministic 768-dim vector per text so the tests can predict distances.
function vectorFor(text: string): number[] {
  const v = new Array<number>(768).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 768] += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function chunk(seq: number, text: string) {
  return {
    seq,
    segmentKeys: ['m1'],
    url: undefined,
    occurredAt: undefined,
    prefix: 'p',
    text,
    textHash: `hash:${text}`,
    tokenEstimate: 1,
    embedding: toPgVector(vectorFor(text)),
    embeddingModel: 'fake-model',
  };
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/vector.test.ts` — FAIL (module not found). With `DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit`, `pnpm --filter @shipit-ai/knowledge run test:integration` — FAIL (module not found).

- [ ] **Step 4: Implement the vector helper, the store and the sink**

Create `packages/knowledge/src/vector.ts`:

```ts
/** pgvector's text input form. Pass it as `$n::halfvec`; no driver extension needed. */
export function toPgVector(values: ArrayLike<number>): string {
  const parts: string[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) throw new Error(`embedding value at ${i} is not finite`);
    parts[i] = String(v);
  }
  return `[${parts.join(',')}]`;
}
```

Create `packages/knowledge/src/store.ts`:

```ts
// Every SQL statement of the knowledge layer, grouped by table. Callers never
// write SQL. Ids are UUIDs minted here; timestamps are set by Postgres.
import { randomUUID } from 'node:crypto';
import type { Db, SqlClient } from '@shipit-ai/agents';
import type {
  ChangeBatch,
  ContainerKind,
  ContainerVisibility,
  DocumentKind,
  DocumentSegment,
  DocumentState,
  SelectedContainer,
  SourceAcl,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { contentHashOf } from './hash.js';

export const CLAIM_STALE_MS = 10 * 60_000;
export const MAX_INDEX_ATTEMPTS = 5;

export interface ContainerRow {
  id: string;
  connectorId: string;
  externalId: string;
  kind: ContainerKind;
  name: string;
  url: string | null;
  visibility: ContainerVisibility;
  archived: boolean;
  acl: SourceAcl | null;
  selected: boolean;
  selectedBy: string | null;
  checkpoint: string | null;
  mappedEntityIds: string[];
  lastPolledAt: string | null;
  lastReconciledAt: string | null;
  goneAt: string | null;
  purgeRequestedAt: string | null;
}

export interface DocumentRow {
  id: string;
  connectorId: string;
  containerId: string;
  externalId: string;
  kind: DocumentKind;
  title: string;
  url: string;
  segments: DocumentSegment[];
  contentHash: string | null;
  sourceVersion: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  authorPrincipalId: string | null;
  participantPrincipalIds: string[];
  state: DocumentState | null;
  attributes: Record<string, unknown>;
  restricted: boolean;
  redactions: number;
  indexStatus: 'pending' | 'indexing' | 'indexed' | 'failed' | 'skipped';
  indexAttempts: number;
  indexError: string | null;
  indexedHash: string | null;
  indexVersion: number | null;
  deletedAt: string | null;
}

export interface StoredChunkInput {
  seq: number;
  segmentKeys: string[];
  url?: string;
  occurredAt?: string;
  prefix: string;
  text: string;
  textHash: string;
  tokenEstimate: number;
  /** pgvector literal from toPgVector(). */
  embedding: string;
  embeddingModel: string;
}

const CONTAINER_COLUMNS = `id, connector_id, external_id, kind, name, url, visibility, archived, acl,
  selected, selected_by, checkpoint, mapped_entity_ids, last_polled_at, last_reconciled_at, gone_at, purge_requested_at`;

const DOCUMENT_COLUMNS = `id, connector_id, container_id, external_id, kind, title, url, segments, content_hash,
  source_version, source_created_at, source_updated_at, author_principal_id, participant_principal_ids, state,
  attributes, restricted, redactions, index_status, index_attempts, index_error, indexed_hash, index_version, deleted_at`;

type Raw = Record<string, unknown>;
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);

function containerRow(r: Raw): ContainerRow {
  return {
    id: r.id as string,
    connectorId: r.connector_id as string,
    externalId: r.external_id as string,
    kind: r.kind as ContainerKind,
    name: r.name as string,
    url: (r.url as string | null) ?? null,
    visibility: r.visibility as ContainerVisibility,
    archived: r.archived as boolean,
    acl: (r.acl as SourceAcl | null) ?? null,
    selected: r.selected as boolean,
    selectedBy: (r.selected_by as string | null) ?? null,
    checkpoint: (r.checkpoint as string | null) ?? null,
    mappedEntityIds: (r.mapped_entity_ids as string[]) ?? [],
    lastPolledAt: iso(r.last_polled_at),
    lastReconciledAt: iso(r.last_reconciled_at),
    goneAt: iso(r.gone_at),
    purgeRequestedAt: iso(r.purge_requested_at),
  };
}

function documentRow(r: Raw): DocumentRow {
  return {
    id: r.id as string,
    connectorId: r.connector_id as string,
    containerId: r.container_id as string,
    externalId: r.external_id as string,
    kind: r.kind as DocumentKind,
    title: r.title as string,
    url: r.url as string,
    segments: (r.segments as DocumentSegment[]) ?? [],
    contentHash: (r.content_hash as string | null) ?? null,
    sourceVersion: (r.source_version as string | null) ?? null,
    sourceCreatedAt: iso(r.source_created_at),
    sourceUpdatedAt: iso(r.source_updated_at),
    authorPrincipalId: (r.author_principal_id as string | null) ?? null,
    participantPrincipalIds: (r.participant_principal_ids as string[]) ?? [],
    state: (r.state as DocumentState | null) ?? null,
    attributes: (r.attributes as Record<string, unknown>) ?? {},
    restricted: r.restricted as boolean,
    redactions: Number(r.redactions ?? 0),
    indexStatus: r.index_status as DocumentRow['indexStatus'],
    indexAttempts: Number(r.index_attempts ?? 0),
    indexError: (r.index_error as string | null) ?? null,
    indexedHash: (r.indexed_hash as string | null) ?? null,
    indexVersion: r.index_version == null ? null : Number(r.index_version),
    deletedAt: iso(r.deleted_at),
  };
}

function toSelected(row: ContainerRow): SelectedContainer {
  return {
    externalId: row.externalId,
    kind: row.kind,
    name: row.name,
    url: row.url ?? undefined,
    visibility: row.visibility,
    archived: row.archived,
    acl: row.acl ?? undefined,
    checkpoint: row.checkpoint,
  };
}

export class KnowledgeStore {
  constructor(private readonly db: Db) {}

  // ── Containers ───────────────────────────────────────────────────────────

  /** A COMPLETE listing from the source: present ones are upserted, the rest marked gone. */
  async upsertContainers(connectorId: string, containers: SourceContainer[]): Promise<void> {
    await this.db.tx(async (tx) => {
      for (const c of containers) {
        await tx.query(
          `INSERT INTO knowledge_containers (id, connector_id, external_id, kind, name, url, visibility, archived, acl)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (connector_id, external_id) DO UPDATE SET
             kind = EXCLUDED.kind, name = EXCLUDED.name, url = EXCLUDED.url, visibility = EXCLUDED.visibility,
             archived = EXCLUDED.archived, acl = COALESCE(EXCLUDED.acl, knowledge_containers.acl),
             gone_at = NULL, updated_at = now()`,
          [
            randomUUID(),
            connectorId,
            c.externalId,
            c.kind,
            c.name,
            c.url ?? null,
            c.visibility,
            c.archived,
            c.acl ? JSON.stringify(c.acl) : null,
          ],
        );
      }
      await tx.query(
        `UPDATE knowledge_containers SET gone_at = now(), updated_at = now()
          WHERE connector_id = $1 AND gone_at IS NULL AND NOT (external_id = ANY($2::text[]))`,
        [connectorId, containers.map((c) => c.externalId)],
      );
    });
  }

  async listContainers(connectorId: string): Promise<ContainerRow[]> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${CONTAINER_COLUMNS} FROM knowledge_containers WHERE connector_id = $1 ORDER BY name`,
      [connectorId],
    );
    return rows.map(containerRow);
  }

  async selectedContainers(connectorId: string): Promise<SelectedContainer[]> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${CONTAINER_COLUMNS} FROM knowledge_containers
        WHERE connector_id = $1 AND selected AND gone_at IS NULL AND purge_requested_at IS NULL
        ORDER BY name`,
      [connectorId],
    );
    return rows.map(containerRow).map(toSelected);
  }

  async setSelected(
    connectorId: string,
    externalId: string,
    selected: boolean,
    by: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_containers
          SET selected = $3, selected_by = $4, selected_at = now(), updated_at = now()
        WHERE connector_id = $1 AND external_id = $2`,
      [connectorId, externalId, selected, by],
    );
  }

  // ── Principals ───────────────────────────────────────────────────────────

  async upsertPrincipals(connectorId: string, principals: SourcePrincipal[]): Promise<void> {
    if (principals.length === 0) return;
    await this.db.tx(async (tx) => {
      for (const p of principals) {
        await tx.query(
          `INSERT INTO knowledge_principals (id, connector_id, external_id, kind, display_name, email, login, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (connector_id, external_id) DO UPDATE SET
             kind = EXCLUDED.kind, display_name = EXCLUDED.display_name,
             email = COALESCE(EXCLUDED.email, knowledge_principals.email),
             login = COALESCE(EXCLUDED.login, knowledge_principals.login),
             active = EXCLUDED.active, updated_at = now()`,
          [
            randomUUID(),
            connectorId,
            p.externalId,
            p.kind,
            p.displayName,
            p.email ?? null,
            p.login ?? null,
            p.active,
          ],
        );
      }
    });
  }

  private async principalIds(
    tx: SqlClient,
    connectorId: string,
    externalIds: string[],
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map();
    const { rows } = await tx.query<{ external_id: string; id: string }>(
      `SELECT external_id, id FROM knowledge_principals WHERE connector_id = $1 AND external_id = ANY($2::text[])`,
      [connectorId, externalIds],
    );
    return new Map(rows.map((r) => [r.external_id, r.id]));
  }

  // ── Documents: the sink side ─────────────────────────────────────────────

  /**
   * One transaction: upsert documents (pending when their content changed),
   * tombstone deletions, save the checkpoint. `redactions` is keyed by external
   * id; the sink computed it while redacting segments before calling here.
   */
  async storeBatch(
    connectorId: string,
    container: SelectedContainer,
    batch: ChangeBatch,
    redactions: Map<string, number>,
  ): Promise<{ changed: number; deleted: number }> {
    return this.db.tx(async (tx) => {
      const containerRowResult = await tx.query<{ id: string }>(
        `SELECT id FROM knowledge_containers WHERE connector_id = $1 AND external_id = $2`,
        [connectorId, container.externalId],
      );
      const containerId = containerRowResult.rows[0]?.id;
      if (!containerId)
        throw new Error(
          `container ${container.externalId} is not known to connector ${connectorId}`,
        );

      const externalIds = batch.documents.map((d) => d.externalId);
      const existing = await tx.query<{ external_id: string; content_hash: string | null }>(
        `SELECT external_id, content_hash FROM knowledge_documents WHERE connector_id = $1 AND external_id = ANY($2::text[])`,
        [connectorId, externalIds],
      );
      const previousHash = new Map(existing.rows.map((r) => [r.external_id, r.content_hash]));

      const allPrincipals = new Set<string>();
      for (const d of batch.documents) {
        if (d.authorExternalId) allPrincipals.add(d.authorExternalId);
        for (const p of d.participantExternalIds) allPrincipals.add(p);
      }
      const principalIds = await this.principalIds(tx, connectorId, [...allPrincipals]);

      let changed = 0;
      for (const d of batch.documents) {
        const hash = d.restricted ? null : contentHashOf(d.title, d.segments);
        const isChanged =
          !previousHash.has(d.externalId) || previousHash.get(d.externalId) !== hash;
        if (isChanged && !d.restricted) changed += 1;
        const participants = d.participantExternalIds
          .map((p) => principalIds.get(p))
          .filter((x): x is string => Boolean(x));
        await tx.query(
          `INSERT INTO knowledge_documents (
             id, connector_id, container_id, external_id, kind, title, url, segments, content_hash,
             source_version, source_created_at, source_updated_at, author_principal_id, participant_principal_ids,
             state, attributes, restricted, acl, redactions, index_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::uuid[], $15, $16::jsonb, $17, $18::jsonb, $19, $20)
           ON CONFLICT (connector_id, external_id) DO UPDATE SET
             container_id = EXCLUDED.container_id, kind = EXCLUDED.kind, title = EXCLUDED.title, url = EXCLUDED.url,
             segments = EXCLUDED.segments, content_hash = EXCLUDED.content_hash, source_version = EXCLUDED.source_version,
             source_created_at = EXCLUDED.source_created_at, source_updated_at = EXCLUDED.source_updated_at,
             author_principal_id = EXCLUDED.author_principal_id, participant_principal_ids = EXCLUDED.participant_principal_ids,
             state = EXCLUDED.state, attributes = EXCLUDED.attributes, restricted = EXCLUDED.restricted,
             acl = COALESCE(EXCLUDED.acl, knowledge_documents.acl), redactions = EXCLUDED.redactions,
             index_status = CASE
               WHEN EXCLUDED.restricted THEN 'skipped'
               WHEN knowledge_documents.deleted_at IS NOT NULL
                 OR EXCLUDED.content_hash IS DISTINCT FROM knowledge_documents.content_hash THEN 'pending'
               ELSE knowledge_documents.index_status END,
             index_claimed_at = NULL, deleted_at = NULL, updated_at = now()`,
          [
            randomUUID(),
            connectorId,
            containerId,
            d.externalId,
            d.kind,
            d.title,
            d.url,
            JSON.stringify(d.restricted ? [] : d.segments),
            hash,
            d.sourceVersion,
            d.sourceCreatedAt,
            d.sourceUpdatedAt,
            d.authorExternalId ? (principalIds.get(d.authorExternalId) ?? null) : null,
            participants,
            d.state ?? null,
            JSON.stringify(d.attributes),
            d.restricted,
            d.acl ? JSON.stringify(d.acl) : null,
            redactions.get(d.externalId) ?? 0,
            d.restricted ? 'skipped' : 'pending',
          ],
        );
        if (d.restricted) {
          // A stub never keeps chunks from a time before it became restricted.
          await tx.query(
            `DELETE FROM knowledge_chunks WHERE document_id IN (SELECT id FROM knowledge_documents WHERE connector_id = $1 AND external_id = $2)`,
            [connectorId, d.externalId],
          );
        }
      }

      const deleted = await this.tombstone(tx, connectorId, batch.deletedExternalIds);

      await tx.query(
        `UPDATE knowledge_containers SET checkpoint = $3, last_polled_at = now(), updated_at = now()
          WHERE connector_id = $1 AND external_id = $2`,
        [connectorId, container.externalId, batch.checkpoint],
      );
      return { changed, deleted };
    });
  }

  private async tombstone(
    tx: SqlClient,
    connectorId: string,
    externalIds: string[],
  ): Promise<number> {
    if (externalIds.length === 0) return 0;
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE knowledge_documents
          SET deleted_at = now(), segments = '[]'::jsonb, title = '', attributes = '{}'::jsonb,
              participant_principal_ids = '{}', author_principal_id = NULL, content_hash = NULL,
              index_status = 'skipped', index_claimed_at = NULL, updated_at = now()
        WHERE connector_id = $1 AND external_id = ANY($2::text[]) AND deleted_at IS NULL
        RETURNING id`,
      [connectorId, externalIds],
    );
    if (rows.length > 0) {
      await tx.query(`DELETE FROM knowledge_chunks WHERE document_id = ANY($1::uuid[])`, [
        rows.map((r) => r.id),
      ]);
    }
    return rows.length;
  }

  async pruneMissing(
    connectorId: string,
    container: SelectedContainer,
    presentIds: string[],
  ): Promise<number> {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ external_id: string }>(
        `SELECT d.external_id FROM knowledge_documents d
           JOIN knowledge_containers c ON c.id = d.container_id
          WHERE d.connector_id = $1 AND c.external_id = $2 AND d.deleted_at IS NULL
            AND NOT (d.external_id = ANY($3::text[]))`,
        [connectorId, container.externalId, presentIds],
      );
      const deleted = await this.tombstone(
        tx,
        connectorId,
        rows.map((r) => r.external_id),
      );
      await tx.query(
        `UPDATE knowledge_containers SET last_reconciled_at = now(), updated_at = now()
          WHERE connector_id = $1 AND external_id = $2`,
        [connectorId, container.externalId],
      );
      return deleted;
    });
  }

  // ── Documents: the worker side ───────────────────────────────────────────

  /**
   * Claims up to `limit` documents for indexing: pending ones, claims older than
   * `staleAfterMs` (a crashed worker), and failed ones whose backoff has passed
   * (4^attempts minutes, at most MAX_INDEX_ATTEMPTS attempts).
   */
  async claimPending(limit: number, staleAfterMs: number = CLAIM_STALE_MS): Promise<DocumentRow[]> {
    const { rows } = await this.db.query<Raw>(
      `UPDATE knowledge_documents SET index_status = 'indexing', index_claimed_at = now()
        WHERE id IN (
          SELECT id FROM knowledge_documents
           WHERE deleted_at IS NULL AND (
                 index_status = 'pending'
              OR (index_status = 'indexing' AND index_claimed_at < now() - ($2::int * interval '1 millisecond'))
              OR (index_status = 'failed' AND index_attempts < $3
                  AND index_claimed_at < now() - (power(4, index_attempts)::int * interval '1 minute')))
           ORDER BY updated_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING ${DOCUMENT_COLUMNS}`,
      [limit, staleAfterMs, MAX_INDEX_ATTEMPTS],
    );
    return rows.map(documentRow);
  }

  async getDocument(id: string): Promise<DocumentRow | null> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE id = $1`,
      [id],
    );
    return rows[0] ? documentRow(rows[0]) : null;
  }

  /** text_hash → pgvector literal, for chunks already embedded with this model. */
  async existingChunkEmbeddings(documentId: string, model: string): Promise<Map<string, string>> {
    const { rows } = await this.db.query<{ text_hash: string; embedding: string }>(
      `SELECT text_hash, embedding::text AS embedding FROM knowledge_chunks
        WHERE document_id = $1 AND embedding IS NOT NULL AND embedding_model = $2`,
      [documentId, model],
    );
    return new Map(rows.map((r) => [r.text_hash, r.embedding]));
  }

  async replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      await tx.query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [documentId]);
      for (const c of chunks) {
        await tx.query(
          `INSERT INTO knowledge_chunks (id, document_id, seq, segment_keys, url, occurred_at, prefix, text, text_hash,
                                         token_estimate, embedding, embedding_model)
           VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11::halfvec, $12)`,
          [
            randomUUID(),
            documentId,
            c.seq,
            c.segmentKeys,
            c.url ?? null,
            c.occurredAt ?? null,
            c.prefix,
            c.text,
            c.textHash,
            c.tokenEstimate,
            c.embedding,
            c.embeddingModel,
          ],
        );
      }
      await tx.query(
        `UPDATE knowledge_documents
            SET index_status = 'indexed', indexed_hash = $2, index_version = $3, index_attempts = 0,
                index_error = NULL, index_claimed_at = NULL, updated_at = now()
          WHERE id = $1`,
        [documentId, meta.indexedHash, meta.indexVersion],
      );
    });
  }

  async markUnchanged(documentId: string, indexVersion: number): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_documents SET index_status = 'indexed', index_version = $2, index_claimed_at = NULL, updated_at = now() WHERE id = $1`,
      [documentId, indexVersion],
    );
  }

  async markSkipped(documentId: string): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_documents SET index_status = 'skipped', index_claimed_at = NULL, updated_at = now() WHERE id = $1`,
      [documentId],
    );
  }

  async markFailed(documentId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_documents
          SET index_status = 'failed', index_attempts = index_attempts + 1, index_error = left($2, 2000),
              index_claimed_at = now(), updated_at = now()
        WHERE id = $1`,
      [documentId, error],
    );
  }

  async countsByIndexStatus(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ index_status: string; n: string }>(
      `SELECT index_status, count(*)::text AS n FROM knowledge_documents WHERE deleted_at IS NULL GROUP BY index_status`,
    );
    return Object.fromEntries(rows.map((r) => [r.index_status, Number(r.n)]));
  }

  async deleteTombstonesOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM knowledge_documents WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return rowCount ?? 0;
  }

  // ── State ────────────────────────────────────────────────────────────────

  async getState<T>(key: string): Promise<T | null> {
    const { rows } = await this.db.query<{ value: T }>(
      `SELECT value FROM knowledge_state WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}
```

Create `packages/knowledge/src/sink.ts`:

```ts
// The SDK's KnowledgeSink on Postgres. Redacts every segment before anything is
// stored (spec decision 14), then hands the batch to the store, which commits
// documents, tombstones and the checkpoint together. After a commit it pokes
// the worker through Redis pub/sub; the poke is best-effort because the worker
// polls anyway.
import type {
  ChangeBatch,
  KnowledgeSink,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { redactSegments } from './redaction.js';
import type { KnowledgeStore } from './store.js';

export interface PostgresKnowledgeSinkOptions {
  connectorId: string;
  store: KnowledgeStore;
  /** Publishes the wake-up. Absent in tests and when Redis is down. */
  wake?: () => Promise<void>;
  log?: (line: string) => void;
}

export class PostgresKnowledgeSink implements KnowledgeSink {
  constructor(private readonly opts: PostgresKnowledgeSinkOptions) {}

  upsertContainers(containers: SourceContainer[]): Promise<void> {
    return this.opts.store.upsertContainers(this.opts.connectorId, containers);
  }

  upsertPrincipals(principals: SourcePrincipal[]): Promise<void> {
    return this.opts.store.upsertPrincipals(this.opts.connectorId, principals);
  }

  selectedContainers(): Promise<SelectedContainer[]> {
    return this.opts.store.selectedContainers(this.opts.connectorId);
  }

  async storeBatch(
    container: SelectedContainer,
    batch: ChangeBatch,
  ): Promise<{ changed: number; deleted: number }> {
    const redactions = new Map<string, number>();
    const documents = [];
    for (const doc of batch.documents) {
      if (doc.restricted) {
        documents.push({ ...doc, segments: [] });
        continue;
      }
      const redacted = await redactSegments(doc.segments);
      if (redacted.count > 0) redactions.set(doc.externalId, redacted.count);
      documents.push({ ...doc, segments: redacted.segments });
    }
    const result = await this.opts.store.storeBatch(
      this.opts.connectorId,
      container,
      { ...batch, documents },
      redactions,
    );
    if (result.changed > 0 && this.opts.wake) {
      try {
        await this.opts.wake();
      } catch (err) {
        this.opts.log?.(
          `knowledge sink: wake-up failed (worker polls anyway): ${(err as Error).message}`,
        );
      }
    }
    return result;
  }

  pruneMissing(container: SelectedContainer, presentIds: string[]): Promise<number> {
    return this.opts.store.pruneMissing(this.opts.connectorId, container, presentIds);
  }
}
```

Append to `packages/knowledge/src/index.ts`:

```ts
export { toPgVector } from './vector.js';
export { CLAIM_STALE_MS, KnowledgeStore, MAX_INDEX_ATTEMPTS } from './store.js';
export type { ContainerRow, DocumentRow, StoredChunkInput } from './store.js';
export { PostgresKnowledgeSink } from './sink.js';
export type { PostgresKnowledgeSinkOptions } from './sink.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/vector.test.ts
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/knowledge run test:integration
```

Expected: PASS — vector 2 tests; integration 2 files, 20 tests. Two things to check if a test fails:

- `rolls the whole batch back` relies on the `knowledge_documents_kind` CHECK constraint raising inside `db.tx`; if it passes silently, the kind cast is missing.
- `stops retrying after five failures`: `markFailed` must set `index_claimed_at = now()` (the backoff anchor), and the claim query must read `power(4, index_attempts)::int * interval '1 minute'`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/knowledge
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge
git commit -m "knowledge: Postgres store (containers, principals, documents, chunks, claims) and the redacting sink"
```

---

## Task 8: The embedder interface, the fake, and retry

**Files:**

- Create: `packages/knowledge/src/embedder.ts`
- Create: `packages/knowledge/src/__tests__/embedder.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**

- Produces:

```ts
interface Embedder { readonly model: string; readonly dimensions: number; embedDocuments(texts: string[], options?: { title?: string }): Promise<number[][]>; embedQuery(text: string): Promise<number[]> }
class FakeEmbedder implements Embedder { constructor(dimensions = 768, model = 'fake-embedding'); calls: number }
class EmbeddingDimensionError extends Error
function assertDimensions(vectors: number[][], expected: number): void
function withRetry<T>(fn: () => Promise<T>, options: { attempts?: number; baseDelayMs?: number; isRetryable?: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void> }): Promise<T>
function isRetryableEmbeddingError(err: unknown): boolean   // 429, 408, 5xx, network codes
```

- [ ] **Step 1: Write the failing tests**

Create `packages/knowledge/src/__tests__/embedder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FakeEmbedder,
  assertDimensions,
  isRetryableEmbeddingError,
  withRetry,
} from '../embedder.js';

describe('FakeEmbedder', () => {
  it('is deterministic, unit-length and of the configured dimension', async () => {
    const e = new FakeEmbedder(8);
    const [a] = await e.embedDocuments(['alpha']);
    const [b] = await e.embedDocuments(['alpha']);
    const q = await e.embedQuery('alpha');
    expect(a).toEqual(b);
    expect(a).toEqual(q);
    expect(a).toHaveLength(8);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
    expect(e.calls).toBe(3);
  });

  it('ranks the same text closest', async () => {
    const e = new FakeEmbedder(64);
    const [x, y] = await e.embedDocuments(['payments api outage', 'lunch menu']);
    const q = await e.embedQuery('payments api outage');
    const dot = (p: number[], r: number[]) => p.reduce((s, v, i) => s + v * r[i]!, 0);
    expect(dot(q, x!)).toBeGreaterThan(dot(q, y!));
  });
});

describe('assertDimensions', () => {
  it('throws when a vector has the wrong length', () => {
    expect(() => assertDimensions([[1, 2, 3]], 3)).not.toThrow();
    expect(() => assertDimensions([[1, 2]], 3)).toThrow(/expected 3/);
  });
});

describe('withRetry', () => {
  const retryable = Object.assign(new Error('rate limited'), { status: 429 });
  const fatal = Object.assign(new Error('bad request'), { status: 400 });

  it('retries retryable errors with growing delays and returns the eventual value', async () => {
    const delays: number[] = [];
    let n = 0;
    const value = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw retryable;
        return 'ok';
      },
      {
        attempts: 5,
        baseDelayMs: 100,
        isRetryable: isRetryableEmbeddingError,
        sleep: async (ms) => void delays.push(ms),
      },
    );
    expect(value).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  it('gives up after the configured attempts', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw retryable;
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          isRetryable: isRetryableEmbeddingError,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow('rate limited');
    expect(n).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw fatal;
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          isRetryable: isRetryableEmbeddingError,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow('bad request');
    expect(n).toBe(1);
  });
});

describe('isRetryableEmbeddingError', () => {
  it('classifies by status and network code', () => {
    expect(isRetryableEmbeddingError({ status: 429 })).toBe(true);
    expect(isRetryableEmbeddingError({ statusCode: 503 })).toBe(true);
    expect(isRetryableEmbeddingError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableEmbeddingError({ status: 401 })).toBe(false);
    expect(isRetryableEmbeddingError(new Error('x'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/embedder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/knowledge/src/embedder.ts`:

```ts
// The model seam. The library knows the interface, a deterministic fake for
// tests, and how to retry; the Vertex implementation lives in knowledge-worker
// so the AI SDK never enters api-server's dependency closure.
import { createHash } from 'node:crypto';

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Document-side embeddings (RETRIEVAL_DOCUMENT). One vector per text, same order. */
  embedDocuments(texts: string[], options?: { title?: string }): Promise<number[][]>;
  /** Query-side embedding (RETRIEVAL_QUERY). */
  embedQuery(text: string): Promise<number[]>;
}

export class EmbeddingDimensionError extends Error {
  constructor(expected: number, actual: number) {
    super(`embedding has ${actual} dimensions, expected ${expected}`);
    this.name = 'EmbeddingDimensionError';
  }
}

export function assertDimensions(vectors: number[][], expected: number): void {
  for (const v of vectors)
    if (v.length !== expected) throw new EmbeddingDimensionError(expected, v.length);
}

/**
 * Hash-bucketed term vectors: deterministic, unit-length, and texts that share
 * words land closer together, which is all the tests need from similarity.
 */
export class FakeEmbedder implements Embedder {
  calls = 0;
  constructor(
    readonly dimensions: number = 768,
    readonly model: string = 'fake-embedding',
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    this.calls += 1;
    return this.vector(text);
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const term of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      const h = createHash('sha1').update(term).digest();
      const idx = h.readUInt32BE(0) % this.dimensions;
      v[idx] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);

export function isRetryableEmbeddingError(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; code?: string };
  const status = e?.status ?? e?.statusCode;
  if (status === 429 || status === 408) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return typeof e?.code === 'string' && RETRYABLE_CODES.has(e.code);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff: baseDelay × 2^(attempt−1), only for errors `isRetryable` accepts. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const base = options.baseDelayMs ?? 500;
  const isRetryable = options.isRetryable ?? isRetryableEmbeddingError;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
```

Append to `packages/knowledge/src/index.ts`:

```ts
export {
  EmbeddingDimensionError,
  FakeEmbedder,
  assertDimensions,
  isRetryableEmbeddingError,
  withRetry,
} from './embedder.js';
export type { Embedder, RetryOptions } from './embedder.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/embedder.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/knowledge
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge
git commit -m "knowledge: Embedder interface, deterministic fake, retry with backoff"
```

---

## Task 9: The index pipeline and the worker loop

**Files:**

- Create: `packages/knowledge/src/index-pipeline.ts`, `packages/knowledge/src/index-loop.ts`
- Create: `packages/knowledge/src/__tests__/index-pipeline.test.ts`, `packages/knowledge/src/__tests__/index-loop.integration.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**

- Consumes: `KnowledgeStore`, `DocumentRow`, `StoredChunkInput` (Task 7); `chunkDocument` (Task 6); `Embedder`, `withRetry` (Task 8); `INDEX_VERSION` (Task 2).
- Produces:

```ts
type IndexOutcome = 'indexed' | 'unchanged' | 'skipped';
interface IndexPipelineDeps {
  store: IndexStore;
  embedder: Embedder;
  chunking: ChunkingOptions;
  indexVersion: number;
  containerNameOf(containerId: string): Promise<string>;
}
interface IndexStore {
  existingChunkEmbeddings;
  replaceChunks;
  markUnchanged;
  markSkipped;
} // the slice of KnowledgeStore the pipeline uses
function indexDocument(deps: IndexPipelineDeps, doc: DocumentRow): Promise<IndexOutcome>;
class IndexLoop {
  constructor(opts: {
    store: KnowledgeStore;
    pipeline: IndexPipelineDeps;
    batchSize: number;
    concurrency: number;
    pollIntervalMs?: number;
    heartbeat?: {
      set(key: string, value: string, ttlSeconds: number): Promise<void>;
      key: string;
      ttlSeconds: number;
      everyMs: number;
    };
    log?: (line: string) => void;
  });
  runOnce(): Promise<{
    claimed: number;
    indexed: number;
    unchanged: number;
    skipped: number;
    failed: number;
  }>;
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing pipeline tests**

Create `packages/knowledge/src/__tests__/index-pipeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeEmbedder } from '../embedder.js';
import { indexDocument, type IndexStore } from '../index-pipeline.js';
import type { DocumentRow, StoredChunkInput } from '../store.js';

class MemoryIndexStore implements IndexStore {
  existing = new Map<string, Map<string, string>>(); // documentId → textHash → embedding literal
  replaced: Array<{
    documentId: string;
    chunks: StoredChunkInput[];
    meta: { indexedHash: string; indexVersion: number };
  }> = [];
  unchanged: string[] = [];
  skipped: string[] = [];

  async existingChunkEmbeddings(documentId: string, _model: string) {
    return new Map(this.existing.get(documentId) ?? []);
  }
  async replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ) {
    this.replaced.push({ documentId, chunks, meta });
  }
  async markUnchanged(documentId: string) {
    this.unchanged.push(documentId);
  }
  async markSkipped(documentId: string) {
    this.skipped.push(documentId);
  }
}

function row(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc-1',
    connectorId: 'c',
    containerId: 'cont-1',
    externalId: 'x',
    kind: 'slack_thread',
    title: 'T',
    url: 'https://e/x',
    segments: [
      { key: '1', authorName: 'Ada', at: '2026-01-01T09:00:00Z', text: 'payments api is down' },
      { key: '2', authorName: 'Bob', at: '2026-01-01T09:01:00Z', text: 'rolling back now' },
    ],
    contentHash: 'h1',
    sourceVersion: 'v',
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    authorPrincipalId: null,
    participantPrincipalIds: [],
    state: null,
    attributes: {},
    restricted: false,
    redactions: 0,
    indexStatus: 'indexing',
    indexAttempts: 0,
    indexError: null,
    indexedHash: null,
    indexVersion: null,
    deletedAt: null,
    ...overrides,
  };
}

const deps = (store: MemoryIndexStore, embedder = new FakeEmbedder(8)) => ({
  store,
  embedder,
  chunking: { chunkTokens: 600, maxChunkTokens: 800 },
  indexVersion: 1,
  containerNameOf: async () => 'general',
});

describe('indexDocument', () => {
  it('chunks, embeds and replaces, then marks the content hash as indexed', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    expect(await indexDocument(deps(store, embedder), row())).toBe('indexed');
    expect(store.replaced).toHaveLength(1);
    const { chunks, meta } = store.replaced[0]!;
    expect(meta).toEqual({ indexedHash: 'h1', indexVersion: 1 });
    expect(chunks[0]!.embeddingModel).toBe('fake-embedding');
    expect(chunks[0]!.embedding.startsWith('[')).toBe(true);
    expect(chunks[0]!.prefix).toContain('#general');
    expect(embedder.calls).toBe(1);
  });

  it('skips a deleted, restricted or empty document', async () => {
    const store = new MemoryIndexStore();
    expect(await indexDocument(deps(store), row({ deletedAt: '2026-01-01T00:00:00Z' }))).toBe(
      'skipped',
    );
    expect(await indexDocument(deps(store), row({ restricted: true, segments: [] }))).toBe(
      'skipped',
    );
    expect(await indexDocument(deps(store), row({ segments: [] }))).toBe('skipped');
    expect(store.skipped).toEqual(['doc-1', 'doc-1', 'doc-1']);
    expect(store.replaced).toHaveLength(0);
  });

  it('reports unchanged when the hash and index version match, without embedding', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    expect(
      await indexDocument(deps(store, embedder), row({ indexedHash: 'h1', indexVersion: 1 })),
    ).toBe('unchanged');
    expect(store.unchanged).toEqual(['doc-1']);
    expect(embedder.calls).toBe(0);
  });

  it('re-indexes when the index version moved even if the hash matches', async () => {
    const store = new MemoryIndexStore();
    expect(
      await indexDocument(
        { ...deps(store), indexVersion: 2 },
        row({ indexedHash: 'h1', indexVersion: 1 }),
      ),
    ).toBe('indexed');
  });

  it('reuses embeddings for chunks whose text did not change', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    await indexDocument(deps(store, embedder), row());
    const first = store.replaced[0]!.chunks;
    store.existing.set('doc-1', new Map(first.map((c) => [c.textHash, c.embedding])));

    // Add a reply: the thread still fits in one chunk, so its text changes and
    // one embedding call happens; a second document with two chunks where only
    // one changed would reuse the other. Assert the reuse path directly:
    const doc = row({
      contentHash: 'h2',
      segments: [
        ...row().segments,
        { key: '3', authorName: 'Ada', at: '2026-01-01T09:02:00Z', text: 'fixed' },
      ],
    });
    embedder.calls = 0;
    await indexDocument(deps(store, embedder), doc);
    expect(embedder.calls).toBe(1);

    // Same content again: every chunk hash is known → zero embedding calls.
    store.existing.set(
      'doc-1',
      new Map(store.replaced.at(-1)!.chunks.map((c) => [c.textHash, c.embedding])),
    );
    embedder.calls = 0;
    await indexDocument(deps(store, embedder), { ...doc, indexedHash: null });
    expect(embedder.calls).toBe(0);
  });

  it('fails loudly when the embedder returns vectors of a different dimension than it claims', async () => {
    const store = new MemoryIndexStore();
    // Claims 8 dimensions, returns 7: the pipeline must not store it.
    const lying = Object.assign(new FakeEmbedder(7), { dimensions: 8 });
    await expect(indexDocument(deps(store, lying), row())).rejects.toThrow(/expected 8/);
    expect(store.replaced).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/index-pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pipeline and the loop**

Create `packages/knowledge/src/index-pipeline.ts`:

```ts
// One document through the index: skip what has no content, do nothing when
// nothing changed, otherwise chunk, embed only the chunks whose text is new,
// and replace the stored chunks in one transaction (spec §Index pipeline).
import { chunkDocument, type ChunkingOptions } from './chunking.js';
import { assertDimensions, withRetry, type Embedder } from './embedder.js';
import type { DocumentRow, StoredChunkInput } from './store.js';
import { toPgVector } from './vector.js';

export type IndexOutcome = 'indexed' | 'unchanged' | 'skipped';

/** The slice of KnowledgeStore the pipeline uses; tests fake it in memory. */
export interface IndexStore {
  existingChunkEmbeddings(documentId: string, model: string): Promise<Map<string, string>>;
  replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ): Promise<void>;
  markUnchanged(documentId: string, indexVersion: number): Promise<void>;
  markSkipped(documentId: string): Promise<void>;
}

export interface IndexPipelineDeps {
  store: IndexStore;
  embedder: Embedder;
  chunking: ChunkingOptions;
  indexVersion: number;
  /** Container display name for the chunk prefix. Cached by the caller. */
  containerNameOf(containerId: string): Promise<string>;
}

export async function indexDocument(
  deps: IndexPipelineDeps,
  doc: DocumentRow,
): Promise<IndexOutcome> {
  if (doc.deletedAt || doc.restricted || doc.segments.length === 0 || !doc.contentHash) {
    await deps.store.markSkipped(doc.id);
    return 'skipped';
  }
  if (doc.indexedHash === doc.contentHash && doc.indexVersion === deps.indexVersion) {
    await deps.store.markUnchanged(doc.id, deps.indexVersion);
    return 'unchanged';
  }

  const drafts = chunkDocument(
    {
      kind: doc.kind,
      title: doc.title,
      segments: doc.segments,
      attributes: doc.attributes,
      containerName: await deps.containerNameOf(doc.containerId),
    },
    deps.chunking,
  );

  const reusable = await deps.store.existingChunkEmbeddings(doc.id, deps.embedder.model);
  const toEmbed = drafts.filter((d) => !reusable.has(d.textHash));
  const byHash = new Map(reusable);
  if (toEmbed.length > 0) {
    const vectors = await withRetry(() =>
      deps.embedder.embedDocuments(
        toEmbed.map((d) => `${d.prefix}\n${d.text}`),
        { title: doc.title },
      ),
    );
    if (vectors.length !== toEmbed.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${toEmbed.length} chunks`);
    }
    assertDimensions(vectors, deps.embedder.dimensions);
    toEmbed.forEach((d, i) => byHash.set(d.textHash, toPgVector(vectors[i]!)));
  }

  await deps.store.replaceChunks(
    doc.id,
    drafts.map((d) => ({
      seq: d.seq,
      segmentKeys: d.segmentKeys,
      url: d.url,
      occurredAt: d.occurredAt,
      prefix: d.prefix,
      text: d.text,
      textHash: d.textHash,
      tokenEstimate: d.tokenEstimate,
      embedding: byHash.get(d.textHash)!,
      embeddingModel: deps.embedder.model,
    })),
    { indexedHash: doc.contentHash, indexVersion: deps.indexVersion },
  );
  return 'indexed';
}
```

Create `packages/knowledge/src/index-loop.ts`:

```ts
// The worker's main loop. Postgres is the queue: claim a batch with
// FOR UPDATE SKIP LOCKED, process it with bounded concurrency, repeat. A Redis
// wake-up shortens the wait after a sink commit; the poll interval is the
// floor. The heartbeat is what /api/knowledge/status reads for `worker`.
import { indexDocument, type IndexPipelineDeps } from './index-pipeline.js';
import type { KnowledgeStore } from './store.js';

export interface HeartbeatSink {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface IndexLoopOptions {
  store: KnowledgeStore;
  pipeline: IndexPipelineDeps;
  batchSize: number;
  concurrency: number;
  /** Floor between claim attempts when no wake-up arrives. Default 10 000. */
  pollIntervalMs?: number;
  heartbeat?: { sink: HeartbeatSink; key: string; ttlSeconds: number; everyMs: number };
  log?: (line: string) => void;
}

export interface LoopStats {
  claimed: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export class IndexLoop {
  private running = false;
  private wakeResolve: (() => void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly opts: IndexLoopOptions) {}

  /** Claims one batch and processes it. Returns what happened; tests call this directly. */
  async runOnce(): Promise<LoopStats> {
    const stats: LoopStats = { claimed: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0 };
    const docs = await this.opts.store.claimPending(this.opts.batchSize);
    stats.claimed = docs.length;
    await mapWithConcurrency(docs, this.opts.concurrency, async (doc) => {
      try {
        const outcome = await indexDocument(this.opts.pipeline, doc);
        stats[outcome] += 1;
      } catch (err) {
        stats.failed += 1;
        const message = (err as Error).message ?? String(err);
        this.opts.log?.(`index failed for ${doc.externalId} (${doc.id}): ${message}`);
        await this.opts.store
          .markFailed(doc.id, message)
          .catch((e: Error) =>
            this.opts.log?.(`could not record the failure for ${doc.id}: ${e.message}`),
          );
      }
    });
    return stats;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.opts.heartbeat) {
      const hb = this.opts.heartbeat;
      const beat = (): void => {
        void hb.sink
          .set(hb.key, new Date().toISOString(), hb.ttlSeconds)
          .catch((err: Error) => this.opts.log?.(`heartbeat failed: ${err.message}`));
      };
      beat();
      this.heartbeatTimer = setInterval(beat, hb.everyMs);
    }
    this.loopPromise = this.loop();
  }

  /** Called on a Redis wake-up: cut the current wait short. */
  kick(): void {
    this.wakeResolve?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.kick();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 10_000;
    while (this.running) {
      let stats: LoopStats | null = null;
      try {
        stats = await this.runOnce();
      } catch (err) {
        // Postgres unavailable, most likely. Wait a full interval and try again.
        this.opts.log?.(`claim failed: ${(err as Error).message}`);
      }
      if (!this.running) break;
      // A full batch means more is probably waiting: go straight back.
      if (stats && stats.claimed >= this.opts.batchSize) continue;
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        const timer = setTimeout(resolve, interval);
        timer.unref?.();
      });
      this.wakeResolve = null;
    }
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
```

Append to `packages/knowledge/src/index.ts`:

```ts
export { indexDocument } from './index-pipeline.js';
export type { IndexOutcome, IndexPipelineDeps, IndexStore } from './index-pipeline.js';
export { IndexLoop } from './index-loop.js';
export type { HeartbeatSink, IndexLoopOptions, LoopStats } from './index-loop.js';
```

- [ ] **Step 4: Run the pipeline tests to verify they pass**

Run: `pnpm --filter @shipit-ai/knowledge exec vitest run src/__tests__/index-pipeline.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Add the end-to-end integration test**

Create `packages/knowledge/src/__tests__/index-loop.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { KnowledgeHarness, createFixtureKnowledgeConnector } from '@shipit-ai/connector-sdk';
import { DATABASE_TEST_URL, createMigratedTestDatabase, type TestDatabase } from './test-db.js';
import { KnowledgeStore } from '../store.js';
import { PostgresKnowledgeSink } from '../sink.js';
import { FakeEmbedder, type Embedder } from '../embedder.js';
import { IndexLoop } from '../index-loop.js';
import { INDEX_VERSION } from '../schema-version.js';
import { toPgVector } from '../vector.js';

const config = { id: 'fx-1', type: 'fixture', credentials: {}, scope: {} };
const container = {
  externalId: 'C1',
  kind: 'channel' as const,
  name: 'general',
  visibility: 'open' as const,
  archived: false,
};

function doc(id: string, text: string, at: string) {
  return {
    externalId: id,
    kind: 'slack_thread' as const,
    title: id,
    url: `https://e/${id}`,
    segments: [{ key: '1', authorName: 'Ada', at, text }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    participantExternalIds: [],
    attributes: {},
    restricted: false,
  };
}

describe.skipIf(!DATABASE_TEST_URL)('harness → sink → loop end to end', () => {
  let database: TestDatabase;
  let store: KnowledgeStore;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = new KnowledgeStore(database.db);
  });
  afterAll(async () => {
    await database?.drop();
  });
  beforeEach(async () => {
    await database.db.query(
      'TRUNCATE knowledge_chunks, knowledge_documents, knowledge_principals, knowledge_containers',
    );
  });

  function loopWith(embedder: Embedder, log: string[] = []) {
    return new IndexLoop({
      store,
      pipeline: {
        store,
        embedder,
        chunking: { chunkTokens: 600, maxChunkTokens: 800 },
        indexVersion: INDEX_VERSION,
        containerNameOf: async () => 'general',
      },
      batchSize: 16,
      concurrency: 4,
      log: (l) => log.push(l),
    });
  }

  it('indexes everything the harness stored and makes it searchable', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [container],
      documents: {
        C1: [
          doc('t1', 'payments api outage postmortem', '2026-01-01T00:00:00Z'),
          doc('t2', 'lunch menu for friday', '2026-01-02T00:00:00Z'),
        ],
      },
    });
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    const run = await new KnowledgeHarness(connector, sink, config, {
      historyDays: 0,
      budgetMs: 60_000,
    }).run('poll');
    expect(run.status).toBe('success');

    const embedder = new FakeEmbedder(768);
    const stats = await loopWith(embedder).runOnce();
    expect(stats).toEqual({ claimed: 2, indexed: 2, unchanged: 0, skipped: 0, failed: 0 });
    expect(await store.countsByIndexStatus()).toEqual({ indexed: 2 });

    const q = toPgVector(await embedder.embedQuery('payments api outage'));
    const { rows } = await database.db.query<{ external_id: string }>(
      `SELECT d.external_id FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        ORDER BY c.embedding <=> $1::halfvec LIMIT 1`,
      [q],
    );
    expect(rows[0]!.external_id).toBe('t1');

    // Nothing left to claim; a second pass is a no-op.
    expect((await loopWith(embedder).runOnce()).claimed).toBe(0);
  });

  it('a failing document does not stop the batch, and is retried later', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [container],
      documents: {
        C1: [
          doc('ok', 'fine', '2026-01-01T00:00:00Z'),
          doc('bad', 'EXPLODE', '2026-01-02T00:00:00Z'),
        ],
      },
    });
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    await new KnowledgeHarness(connector, sink, config, { historyDays: 0, budgetMs: 60_000 }).run(
      'poll',
    );

    const flaky: Embedder = {
      model: 'flaky',
      dimensions: 768,
      async embedDocuments(texts) {
        if (texts.some((t) => t.includes('EXPLODE')))
          throw Object.assign(new Error('bad request'), { status: 400 });
        return new FakeEmbedder(768).embedDocuments(texts);
      },
      async embedQuery(text) {
        return new FakeEmbedder(768).embedQuery(text);
      },
    };
    const log: string[] = [];
    const stats = await loopWith(flaky, log).runOnce();
    expect(stats.indexed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(log[0]).toContain('bad');
    expect(await store.countsByIndexStatus()).toEqual({ indexed: 1, failed: 1 });

    // Within the backoff: nothing is reclaimed.
    expect((await loopWith(flaky).runOnce()).claimed).toBe(0);
    // After it: the failed one comes back.
    await database.db.query(
      `UPDATE knowledge_documents SET index_claimed_at = now() - interval '1 day' WHERE index_status = 'failed'`,
    );
    expect((await loopWith(flaky).runOnce()).claimed).toBe(1);
  });

  it('an edited document is re-indexed with one embedding call for the changed chunk', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [container],
      documents: { C1: [doc('t1', 'first version', '2026-01-01T00:00:00Z')] },
    });
    const sink = new PostgresKnowledgeSink({ connectorId: 'fx-1', store });
    await sink.upsertContainers([container]);
    await store.setSelected('fx-1', 'C1', true, 'tests');
    const harness = new KnowledgeHarness(connector, sink, config, {
      historyDays: 0,
      budgetMs: 60_000,
    });
    await harness.run('poll');
    const embedder = new FakeEmbedder(768);
    await loopWith(embedder).runOnce();

    connector.putDocument('C1', doc('t1', 'second version', '2026-01-03T00:00:00Z'));
    await harness.run('poll');
    embedder.calls = 0;
    const stats = await loopWith(embedder).runOnce();
    expect(stats.indexed).toBe(1);
    expect(embedder.calls).toBe(1);
    const { rows } = await database.db.query<{ text: string }>(`SELECT text FROM knowledge_chunks`);
    expect(rows.map((r) => r.text).join()).toContain('second version');
  });
});
```

- [ ] **Step 6: Run the integration suite**

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/knowledge run test:integration
```

Expected: PASS — 3 files, 23 tests.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/knowledge
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge
git commit -m "knowledge: index pipeline and the claim loop, end to end with the fixture connector"
```

---

## Task 10: The `knowledge-worker` process

**Files:**

- Create: `packages/knowledge-worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `Dockerfile`
- Create: `packages/knowledge-worker/src/main.ts`, `packages/knowledge-worker/src/vertex-embedder.ts`, `packages/knowledge-worker/src/index.ts`
- Create: `packages/knowledge-worker/src/__tests__/vertex-embedder.test.ts`
- Modify: `.github/workflows/ci.yml` (docker matrix), `docker/docker-compose.yml`, `vitest.config.ts` (root)

**Interfaces:**

- Consumes: `IndexLoop`, `KnowledgeStore`, `Embedder`, `assertDimensions`, `INDEX_VERSION` from `@shipit-ai/knowledge`; `createPool`, `createDb` from `@shipit-ai/agents`; `loadConfig` from `@shipit-ai/shared`.
- Produces: `VertexEmbedder` (`new VertexEmbedder({ project, location, model, dimensions, embed? })`), the process, image `knowledge-worker`.

- [ ] **Step 1: Spike the AI SDK embedding call (15 minutes, throwaway)**

In a scratch file under `/tmp`, with `ai` and `@ai-sdk/google-vertex` installed in the worker package (Step 2), run `pnpm --filter @shipit-ai/knowledge-worker exec tsc --noEmit` against this shape and read `node_modules/@ai-sdk/google-vertex/dist/index.d.ts`:

```ts
import { createVertex } from '@ai-sdk/google-vertex';
import { embedMany } from 'ai';
const vertex = createVertex({ project: 'p', location: 'global' });
const model = vertex.embeddingModel('gemini-embedding-2'); // if this does not exist, use vertex.textEmbeddingModel(...)
const { embeddings } = await embedMany({
  model,
  values: ['a', 'b'],
  providerOptions: { vertex: { outputDimensionality: 768, taskType: 'RETRIEVAL_DOCUMENT' } }, // if the d.ts names the key `google`, use that
});
```

Record in the task's commit message which method name and which provider-options key the installed version uses, and write `vertex-embedder.ts` with those names. If `GOOGLE_CLOUD_PROJECT` and ADC are available locally (`gcloud auth application-default login`), also run it once for real and check `embeddings[0].length === 768`; otherwise note that the live check waits for the agents workstream's Vertex probe.

- [ ] **Step 2: Create the package**

`packages/knowledge-worker/package.json`:

```json
{
  "name": "@shipit-ai/knowledge-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@ai-sdk/google-vertex": "^5.0.101",
    "@shipit-ai/agents": "workspace:*",
    "@shipit-ai/knowledge": "workspace:*",
    "@shipit-ai/shared": "workspace:*",
    "ai": "^7.0.126",
    "ioredis": "^5.11.1"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "typescript": "^6.0.3",
    "vitest": "^4.1.11"
  }
}
```

If the agents workstream has pinned different `ai` / `@ai-sdk/google-vertex` versions by the time this runs, use theirs; one version per package across the workspace.

`packages/knowledge-worker/tsconfig.json`: same as `packages/knowledge/tsconfig.json`.

`packages/knowledge-worker/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (...p: string[]) => resolve(__dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/agents': r('agents/src/index.ts'),
      '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
      '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
      '@shipit-ai/knowledge': r('knowledge/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

Root `vitest.config.ts`: add `'packages/knowledge-worker'` after `'packages/knowledge'`. Then `pnpm install`.

- [ ] **Step 3: Write the failing embedder test**

Create `packages/knowledge-worker/src/__tests__/vertex-embedder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { VertexEmbedder, type EmbedCall } from '../vertex-embedder.js';

function fakeEmbed(dimensions: number) {
  const calls: EmbedCall[] = [];
  const embed = async (call: EmbedCall) => {
    calls.push(call);
    return call.values.map(() => new Array<number>(dimensions).fill(0.1));
  };
  return { calls, embed };
}

describe('VertexEmbedder', () => {
  it('sends documents with RETRIEVAL_DOCUMENT, the title and the dimension', async () => {
    const { calls, embed } = fakeEmbed(768);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'gemini-embedding-2',
      dimensions: 768,
      embed,
    });
    const out = await e.embedDocuments(['a', 'b'], { title: 'T' });
    expect(out).toHaveLength(2);
    expect(calls[0]).toEqual({
      model: 'gemini-embedding-2',
      values: ['a', 'b'],
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
      title: 'T',
    });
  });

  it('sends queries with RETRIEVAL_QUERY and no title', async () => {
    const { calls, embed } = fakeEmbed(768);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'm',
      dimensions: 768,
      embed,
    });
    await e.embedQuery('q');
    expect(calls[0]!.taskType).toBe('RETRIEVAL_QUERY');
    expect(calls[0]!.title).toBeUndefined();
  });

  it('rejects vectors of the wrong dimension', async () => {
    const { embed } = fakeEmbed(3);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'm',
      dimensions: 768,
      embed,
    });
    await expect(e.embedDocuments(['a'])).rejects.toThrow(/expected 768/);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/knowledge-worker exec vitest run src/__tests__/vertex-embedder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the embedder and the process**

Create `packages/knowledge-worker/src/vertex-embedder.ts` (adjust the two names the Step 1 spike settled):

```ts
// Embeddings through Vertex AI with Application Default Credentials. The AI
// SDK call is behind `embed` so tests pass a fake; the default sends one
// request per batch of values (the provider itself batches as the model
// allows).
import { createVertex } from '@ai-sdk/google-vertex';
import { embedMany } from 'ai';
import { assertDimensions, type Embedder } from '@shipit-ai/knowledge';

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbedCall {
  model: string;
  values: string[];
  taskType: EmbeddingTaskType;
  outputDimensionality: number;
  title?: string;
}

export interface VertexEmbedderOptions {
  project: string;
  location: string;
  model: string;
  dimensions: number;
  /** Test seam. Defaults to the AI SDK. */
  embed?: (call: EmbedCall) => Promise<number[][]>;
}

export class VertexEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly embed: (call: EmbedCall) => Promise<number[][]>;

  constructor(opts: VertexEmbedderOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.embed = opts.embed ?? makeAiSdkEmbed(opts.project, opts.location);
  }

  async embedDocuments(texts: string[], options?: { title?: string }): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors = await this.embed({
      model: this.model,
      values: texts,
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: this.dimensions,
      title: options?.title,
    });
    assertDimensions(vectors, this.dimensions);
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed({
      model: this.model,
      values: [text],
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: this.dimensions,
    });
    assertDimensions([vector!], this.dimensions);
    return vector!;
  }
}

function makeAiSdkEmbed(
  project: string,
  location: string,
): (call: EmbedCall) => Promise<number[][]> {
  const vertex = createVertex({ project, location });
  return async (call) => {
    const { embeddings } = await embedMany({
      model: vertex.embeddingModel(call.model),
      values: call.values,
      providerOptions: {
        vertex: {
          outputDimensionality: call.outputDimensionality,
          taskType: call.taskType,
          ...(call.title ? { title: call.title } : {}),
        },
      },
    });
    return embeddings.map((e) => Array.from(e));
  };
}
```

Create `packages/knowledge-worker/src/main.ts`:

```ts
// Entry point for the knowledge-worker process: claims pending documents from
// Postgres, chunks and embeds them through Vertex AI, writes the chunks back,
// and heartbeats to Redis so /api/knowledge/status can see it. Boots like
// core-writer: thin, fails loudly on a missing prerequisite, degrades on a
// transient one.
import { Redis } from 'ioredis';
import { createDb, createPool } from '@shipit-ai/agents';
import {
  INDEX_VERSION,
  IndexLoop,
  KnowledgeStore,
  hasVectorExtension,
  missingKnowledgeMigrations,
} from '@shipit-ai/knowledge';
import { loadConfig } from '@shipit-ai/shared';
import { VertexEmbedder } from './vertex-embedder.js';

export const HEARTBEAT_KEY = 'shipit-knowledge-worker-heartbeat';
export const WAKE_CHANNEL = 'shipit-knowledge-wake';

async function main(): Promise<void> {
  const config = loadConfig();
  const { knowledge, ai } = config;

  if (!knowledge.enabled) {
    console.log('knowledge-worker: knowledge.enabled is false; idling so the pod stays healthy.');
    await new Promise(() => undefined);
    return;
  }
  if (!ai.database.url) {
    console.error('knowledge-worker: ai.database.url (DATABASE_URL) is empty. Exiting.');
    process.exit(1);
  }
  if (!ai.vertex.project) {
    console.error('knowledge-worker: ai.vertex.project (GOOGLE_CLOUD_PROJECT) is empty. Exiting.');
    process.exit(1);
  }
  if (knowledge.embedding.dimensions !== 768) {
    console.error(
      `knowledge-worker: knowledge.embedding.dimensions is ${knowledge.embedding.dimensions}; the schema is halfvec(768). Exiting.`,
    );
    process.exit(1);
  }

  const pool = createPool({
    connectionString: ai.database.url,
    max: knowledge.worker.concurrency + 2,
    // Chunk inserts for a long document and HNSW maintenance can exceed 10 s.
    statementTimeoutMs: 60_000,
    onError: (err) => console.error(`knowledge-worker: postgres pool error: ${err.message}`),
  });
  const db = createDb(pool);

  const missing = await missingKnowledgeMigrations(db).catch((err: Error) => {
    console.error(`knowledge-worker: cannot read schema_migrations: ${err.message}`);
    return null;
  });
  if (missing === null || missing.length > 0 || !(await hasVectorExtension(db))) {
    console.error(
      `knowledge-worker: the database is not ready (missing migrations: ${missing?.join(', ') || 'none'}; ` +
        `vector extension: ${await hasVectorExtension(db).catch(() => false)}). Exiting; the deployment will restart me after the migration step.`,
    );
    await pool.end();
    process.exit(1);
  }

  const store = new KnowledgeStore(db);
  const embedder = new VertexEmbedder({
    project: ai.vertex.project,
    location: ai.vertex.location,
    model: knowledge.embedding.model,
    dimensions: knowledge.embedding.dimensions,
  });

  // Container names for chunk prefixes, cached per process.
  const containerNames = new Map<string, string>();
  const containerNameOf = async (containerId: string): Promise<string> => {
    const cached = containerNames.get(containerId);
    if (cached) return cached;
    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM knowledge_containers WHERE id = $1',
      [containerId],
    );
    const name = rows[0]?.name ?? '';
    containerNames.set(containerId, name);
    return name;
  };

  let redis: Redis | null = null;
  let subscriber: Redis | null = null;
  if (config.backend.redis.url) {
    redis = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
    subscriber = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
    for (const client of [redis, subscriber]) {
      client.on('error', (err: Error) =>
        console.warn(`knowledge-worker: redis error (degraded, polling continues): ${err.message}`),
      );
    }
  } else {
    console.warn(
      'knowledge-worker: backend.redis.url is empty; no heartbeat and no wake-ups, polling only.',
    );
  }

  const loop = new IndexLoop({
    store,
    pipeline: {
      store,
      embedder,
      chunking: {
        chunkTokens: knowledge.index.chunkTokens,
        maxChunkTokens: knowledge.index.maxChunkTokens,
      },
      indexVersion: INDEX_VERSION,
      containerNameOf,
    },
    batchSize: knowledge.worker.batchSize,
    concurrency: knowledge.worker.concurrency,
    heartbeat: redis
      ? {
          sink: { set: async (key, value, ttl) => void (await redis!.set(key, value, 'EX', ttl)) },
          key: HEARTBEAT_KEY,
          ttlSeconds: 60,
          everyMs: 15_000,
        }
      : undefined,
    log: (line) => console.warn(`knowledge-worker: ${line}`),
  });

  if (subscriber) {
    await subscriber
      .subscribe(WAKE_CHANNEL)
      .catch((err: Error) =>
        console.warn(`knowledge-worker: could not subscribe to ${WAKE_CHANNEL}: ${err.message}`),
      );
    subscriber.on('message', () => loop.kick());
  }

  loop.start();
  console.log(
    `knowledge-worker: indexing with ${knowledge.embedding.model} (${knowledge.embedding.dimensions}d), ` +
      `batch ${knowledge.worker.batchSize}, concurrency ${knowledge.worker.concurrency}`,
  );

  // Tombstones older than the retention window, once a day.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cleanup = async (): Promise<void> => {
    try {
      const removed = await store.deleteTombstonesOlderThan(knowledge.retention.tombstoneDays);
      if (removed > 0) console.log(`knowledge-worker: removed ${removed} tombstone(s)`);
    } catch (err) {
      console.error(`knowledge-worker: tombstone cleanup failed: ${(err as Error).message}`);
    }
  };
  void cleanup();
  const cleanupTimer = setInterval(() => void cleanup(), DAY_MS);
  cleanupTimer.unref?.();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`knowledge-worker received ${signal}, shutting down...`);
    try {
      clearInterval(cleanupTimer);
      await loop.stop();
      subscriber?.disconnect();
      redis?.disconnect();
      await pool.end();
    } catch (err) {
      console.error(`knowledge-worker shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('knowledge-worker crashed during startup:', err);
  process.exit(1);
});
```

Create `packages/knowledge-worker/src/index.ts`:

```ts
export { VertexEmbedder } from './vertex-embedder.js';
export type { EmbedCall, EmbeddingTaskType, VertexEmbedderOptions } from './vertex-embedder.js';
```

- [ ] **Step 6: Run the test and typecheck**

Run: `pnpm --filter @shipit-ai/knowledge-worker exec vitest run` — PASS, 3 tests. Run `pnpm --filter @shipit-ai/knowledge-worker typecheck` — clean. A type error on `vertex.embeddingModel` or on the `vertex` provider-options key means the Step 1 spike's names were not carried over.

- [ ] **Step 7: Dockerfile, CI matrix, compose service**

Create `packages/knowledge-worker/Dockerfile`:

```dockerfile
FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# knowledge-worker's workspace closure, least-changing first:
#   shared → agents → event-bus → connector-sdk → knowledge → knowledge-worker
# (connector-sdk depends on event-bus; knowledge depends on connector-sdk for its types.)
COPY packages/shared/ packages/shared/
COPY packages/agents/ packages/agents/
COPY packages/event-bus/ packages/event-bus/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/knowledge/ packages/knowledge/
COPY packages/knowledge-worker/ packages/knowledge-worker/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/knowledge-worker
# Self-contained prod bundle: dist + real (de-symlinked) node_modules.
RUN pnpm --filter=@shipit-ai/knowledge-worker deploy --legacy --prod /out

FROM node:22-alpine
# Runtime-stage hygiene, same as core-writer: Alpine security patches, and the
# bundled npm CLI removed because its vendored deps fail the image gate.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /out ./
CMD ["node", "dist/main.js"]
```

`.github/workflows/ci.yml` — docker matrix:

```diff
           - service: mcp-server
             dockerfile: packages/mcp-server/Dockerfile
+          - service: knowledge-worker
+            dockerfile: packages/knowledge-worker/Dockerfile
```

`docker/docker-compose.yml` — after `core-writer`:

```yaml
# Chunks and embeds knowledge documents. Needs Postgres (with pgvector) and
# Vertex AI credentials: mount ADC and set GOOGLE_CLOUD_PROJECT, or leave it
# out of `up` and let documents wait as `pending`.
knowledge-worker:
  build:
    context: ..
    dockerfile: packages/knowledge-worker/Dockerfile
  volumes:
    - ../shipit.config.yaml:/app/shipit.config.yaml:ro
  environment:
    REDIS_URL: redis://redis:6379
    NEO4J_URI: bolt://neo4j:7687
    NEO4J_PASSWORD: ${NEO4J_PASSWORD:-shipit-dev}
    DATABASE_URL: postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@postgres:5432/shipit
    GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT:-}
    GOOGLE_CLOUD_LOCATION: ${GOOGLE_CLOUD_LOCATION:-global}
  depends_on:
    redis:
      condition: service_healthy
    migrate:
      condition: service_completed_successfully
  profiles: ['knowledge']
```

The `knowledge` profile keeps `docker compose up` unchanged for everyone else; `docker compose --profile knowledge up` adds the worker. `NEO4J_*` are passed only because `loadConfig()` requires the placeholders; the worker opens no Neo4j connection in K0.

Build the image once locally to prove the `COPY` closure:

```bash
docker build -f packages/knowledge-worker/Dockerfile -t shipit-knowledge-worker:dev .
docker run --rm shipit-knowledge-worker:dev node -e "import('@shipit-ai/knowledge').then(m => console.log(Object.keys(m).length, 'exports'))"
```

Expected: the build succeeds and the second command prints a count. A `Cannot find module` here means a workspace dependency is missing from the `COPY` list (the scar).

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/knowledge-worker docker/docker-compose.yml .github/workflows/ci.yml vitest.config.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/knowledge-worker docker/docker-compose.yml .github/workflows/ci.yml vitest.config.ts pnpm-lock.yaml
git commit -m "knowledge-worker: process, Vertex embedder, Dockerfile, CI image and compose profile"
```

---

## Task 11: Knowledge connectors on the scheduler

**Files:**

- Modify: `packages/api-server/src/services/connector-types/types.ts`, `packages/api-server/src/services/sync-scheduler.ts`, `packages/api-server/package.json`, `packages/api-server/vitest.config.ts`, `packages/api-server/Dockerfile`
- Create: `packages/api-server/src/services/knowledge-sync-scheduler.ts`, `packages/api-server/src/services/composite-connector-runner.ts`
- Create: `packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts`, `packages/api-server/src/__tests__/services/composite-connector-runner.test.ts`

**Interfaces:**

- Consumes: `KnowledgeConnector`, `KnowledgeHarness`, `KnowledgeRunMode`, `ConnectorConfig` from `@shipit-ai/connector-sdk`; `KnowledgeStore`, `PostgresKnowledgeSink` from `@shipit-ai/knowledge`; `ConnectorRegistry`, `ConnectorRunner`, `SyncRuntimeStatus`; `LastRun` with `facet`.
- Produces:

```ts
// connector-types/types.ts
type KnowledgeBuildResult = { ok: true; connector: KnowledgeConnector; sdkConfig: ConnectorConfig } | { ok: false; code: string; message: string }
interface ConnectorType<C> { type; pollMode; sweepsAbsent; build?(cfg, ctx): Promise<BuildResult>; buildKnowledge?(cfg, ctx): Promise<KnowledgeBuildResult>; probe?(…) }
// knowledge-sync-scheduler.ts
class KnowledgeSyncScheduler {
  constructor(opts: { redisUrl: string; registry: ConnectorRegistry; store: KnowledgeStore; buildContext: BuildContext; historyDaysOf?: (cfg) => number; budgetMs: number; reconcileCron: string; isAvailable: () => Promise<boolean>; resolveType?: (type: string) => ConnectorType | undefined; queueName?: string; wake?: () => Promise<void> })
  handles(cfg: ConnectorInstanceConfig): boolean
  start(cfg): Promise<void>; stop(connectorId): Promise<void>; trigger(cfg, mode: KnowledgeRunMode): Promise<SyncRuntimeStatus>; getStatus(connectorId): SyncRuntimeStatus
  runJob(connectorId: string, mode: KnowledgeRunMode): Promise<void>   // the processor body, callable without BullMQ in tests
  close(): Promise<void>
}
// composite-connector-runner.ts
class CompositeConnectorRunner implements ConnectorRunner { constructor(opts: { graph: ConnectorRunner | null; knowledge: KnowledgeSyncScheduler | null; hasGraphFacet: (cfg) => boolean }) }
```

- [ ] **Step 1: Make `build` optional and add `buildKnowledge`**

`packages/api-server/src/services/connector-types/types.ts`:

```diff
-import type { ConnectorConfig, ShipItConnector } from '@shipit-ai/connector-sdk';
+import type { ConnectorConfig, KnowledgeConnector, ShipItConnector } from '@shipit-ai/connector-sdk';
```

```diff
+export type KnowledgeBuildResult =
+  | { ok: true; connector: KnowledgeConnector; sdkConfig: ConnectorConfig }
+  | { ok: false; code: string; message: string };
+
 export interface ConnectorType<C extends ConnectorInstanceConfig = ConnectorInstanceConfig> {
   readonly type: C['type'];
@@
   readonly sweepsAbsent: boolean;
-  build(cfg: C, ctx: BuildContext): Promise<BuildResult>;
+  /** The graph facet. Absent for a knowledge-only type (Slack, Confluence, Jira). */
+  build?(cfg: C, ctx: BuildContext): Promise<BuildResult>;
+  /** The knowledge facet. Absent for a graph-only type (Kubernetes). GitHub has both. */
+  buildKnowledge?(cfg: C, ctx: BuildContext): Promise<KnowledgeBuildResult>;
```

Export `KnowledgeBuildResult` from `connector-types/index.ts` next to `BuildResult`.

`packages/api-server/src/services/sync-scheduler.ts` — the two places that assume `build`:

```diff
   async start(connector: ConnectorInstanceConfig): Promise<void> {
     if (!connector.enabled) return;
+    // Knowledge-only types are scheduled by KnowledgeSyncScheduler.
+    if (!getConnectorType(connector.type)?.build) return;
```

```diff
-    const built = await type.build(cfg, this.buildContext);
+    if (!type.build) {
+      await this.failRun(connectorId, startedAt, startTime, `Connector type "${cfg.type}" has no graph sync.`);
+      return;
+    }
+    const built = await type.build(cfg, this.buildContext);
```

And expose the build context for the knowledge scheduler:

```diff
   private readonly buildContext: BuildContext;
+
+  /** The same context the knowledge scheduler needs (live App, key reader, lookups). */
+  get context(): BuildContext {
+    return this.buildContext;
+  }
```

Run `pnpm --filter @shipit-ai/api-server typecheck` — any other call site of `type.build(` the compiler finds gets the same `if (!type.build)` guard.

- [ ] **Step 2: Add the workspace dependency in its three places**

`packages/api-server/package.json` dependencies: `"@shipit-ai/knowledge": "workspace:*"`. `packages/api-server/vitest.config.ts` aliases: `'@shipit-ai/knowledge': r('knowledge/src/index.ts'),`. `packages/api-server/Dockerfile`: `COPY packages/knowledge/ packages/knowledge/` after the `packages/agents/` line. Then `pnpm install`.

- [ ] **Step 3: Write the failing scheduler tests**

Create `packages/api-server/src/__tests__/services/knowledge-sync-scheduler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFixtureKnowledgeConnector, type KnowledgeConnector } from '@shipit-ai/connector-sdk';
import type { ConnectorInstanceConfig, LastRun } from '@shipit-ai/shared';
import {
  KnowledgeSyncScheduler,
  type KnowledgeSyncSchedulerOptions,
} from '../../services/knowledge-sync-scheduler.js';
import type { ConnectorType } from '../../services/connector-types/types.js';

// The unit tests drive `runJob` directly and never open a BullMQ connection:
// `queueFactory` hands back a recording fake.
class FakeQueue {
  schedulers = new Map<string, { pattern: string; data: unknown }>();
  added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  async upsertJobScheduler(id: string, repeat: { pattern: string }, job: { data: unknown }) {
    this.schedulers.set(id, { pattern: repeat.pattern, data: job.data });
  }
  async removeJobScheduler(id: string) {
    return this.schedulers.delete(id);
  }
  async add(name: string, data: unknown, opts: unknown) {
    this.added.push({ name, data, opts });
  }
  on() {
    return this;
  }
  async close() {}
}

const C1 = {
  externalId: 'C1',
  kind: 'channel' as const,
  name: 'general',
  visibility: 'open' as const,
  archived: false,
};
const connectorCfg = {
  id: 'fx-1',
  type: 'fixture',
  enabled: true,
  name: 'Fixture',
  schedule: '*/15 * * * *',
} as unknown as ConnectorInstanceConfig;

function fixtureType(connector: KnowledgeConnector, fail = false): ConnectorType {
  return {
    type: 'fixture',
    pollMode: 'incremental',
    sweepsAbsent: false,
    async buildKnowledge() {
      if (fail) return { ok: false, code: 'NO_TOKEN', message: 'no token on file' };
      return {
        ok: true,
        connector,
        sdkConfig: { id: 'fx-1', type: 'fixture', credentials: {}, scope: {} },
      };
    },
  } as unknown as ConnectorType;
}

describe('KnowledgeSyncScheduler', () => {
  let queue: FakeQueue;
  let runs: LastRun[];
  let selected: Array<typeof C1 & { checkpoint: string | null }>;
  let stored: number;
  let available: boolean;

  const registry = {
    get: (id: string) => {
      if (id !== 'fx-1') throw new Error('not found');
      return connectorCfg;
    },
    list: () => [connectorCfg],
    recordRun: async (_id: string, run: LastRun) => void runs.push(run),
  };

  // A store fake that only knows what the scheduler touches through the sink.
  const store = {
    selectedContainers: async () => selected,
    upsertContainers: async () => undefined,
    upsertPrincipals: async () => undefined,
    storeBatch: async (_c: string, _container: unknown, batch: { documents: unknown[] }) => {
      stored += batch.documents.length;
      return { changed: batch.documents.length, deleted: 0 };
    },
    pruneMissing: async () => 0,
  };

  function scheduler(type: ConnectorType, overrides: Partial<KnowledgeSyncSchedulerOptions> = {}) {
    return new KnowledgeSyncScheduler({
      redisUrl: 'redis://unused:6379',
      registry: registry as never,
      store: store as never,
      buildContext: {} as never,
      budgetMs: 60_000,
      reconcileCron: '0 3 * * *',
      isAvailable: async () => available,
      resolveType: () => type,
      queueFactory: () => queue as never,
      ...overrides,
    });
  }

  beforeEach(() => {
    queue = new FakeQueue();
    runs = [];
    selected = [{ ...C1, checkpoint: null }];
    stored = 0;
    available = true;
  });

  it('schedules a poll and a reconcile job per enabled knowledge connector, and removes both on stop', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: { C1: [] } })),
    );
    await s.start(connectorCfg);
    expect([...queue.schedulers.keys()]).toEqual([
      'knowledge~fx-1~poll',
      'knowledge~fx-1~reconcile',
    ]);
    expect(queue.schedulers.get('knowledge~fx-1~poll')!.pattern).toBe('*/15 * * * *');
    expect(queue.schedulers.get('knowledge~fx-1~reconcile')!.pattern).toBe('0 3 * * *');
    await s.stop('fx-1');
    expect(queue.schedulers.size).toBe(0);
  });

  it('does not schedule a type without a knowledge facet, or a disabled connector', async () => {
    const graphOnly = {
      type: 'kubernetes',
      pollMode: 'full',
      sweepsAbsent: true,
      build: async () => ({ ok: false, code: 'x', message: 'x' }),
    } as unknown as ConnectorType;
    const s = scheduler(graphOnly);
    expect(s.handles(connectorCfg)).toBe(false);
    await s.start(connectorCfg);
    await scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    ).start({ ...connectorCfg, enabled: false } as ConnectorInstanceConfig);
    expect(queue.schedulers.size).toBe(0);
  });

  it('runs a poll through the harness and records a knowledge run', async () => {
    const connector = createFixtureKnowledgeConnector({
      containers: [C1],
      documents: { C1: [docAt('2026-01-01T00:00:00Z'), docAt('2026-01-02T00:00:00Z')] },
    });
    const s = scheduler(fixtureType(connector));
    await s.runJob('fx-1', 'poll');
    expect(stored).toBe(2);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'success',
      entitiesSynced: 2,
      facet: 'knowledge',
      errors: [],
    });
    expect(s.getStatus('fx-1').state).toBe('idle');
  });

  it('records a failed run when the type cannot be built', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} }), true),
    );
    await s.runJob('fx-1', 'poll');
    expect(runs[0]).toMatchObject({ status: 'failed', facet: 'knowledge' });
    expect(runs[0]!.errors[0]).toContain('no token on file');
    expect(s.getStatus('fx-1')).toMatchObject({ state: 'failed' });
  });

  it('marks degraded when authentication fails', async () => {
    const s = scheduler(
      fixtureType(
        createFixtureKnowledgeConnector({ containers: [C1], documents: {}, authError: 'revoked' }),
      ),
    );
    await s.runJob('fx-1', 'poll');
    expect(runs[0]!.status).toBe('failed');
    expect(s.getStatus('fx-1').state).toBe('degraded');
  });

  it('skips the run when the layer is unavailable, recording nothing', async () => {
    available = false;
    const s = scheduler(
      fixtureType(
        createFixtureKnowledgeConnector({
          containers: [C1],
          documents: { C1: [docAt('2026-01-01T00:00:00Z')] },
        }),
      ),
    );
    await s.runJob('fx-1', 'poll');
    expect(stored).toBe(0);
    expect(runs).toHaveLength(0);
    expect(s.getStatus('fx-1').state).toBe('idle');
  });

  it('drops a job for a connector that no longer exists', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    );
    await expect(s.runJob('gone', 'poll')).resolves.toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it('enqueues a one-shot job on trigger and reports running', async () => {
    const s = scheduler(
      fixtureType(createFixtureKnowledgeConnector({ containers: [C1], documents: {} })),
    );
    const status = await s.trigger(connectorCfg, 'reconcile');
    expect(status.state).toBe('running');
    expect(queue.added[0]).toMatchObject({
      name: 'knowledge-manual',
      data: { connectorId: 'fx-1', mode: 'reconcile' },
    });
    expect(String((queue.added[0]!.opts as { jobId: string }).jobId)).toMatch(
      /^knowledge~fx-1~manual~\d+$/,
    );
  });
});

function docAt(at: string) {
  return {
    externalId: `d-${at}`,
    kind: 'slack_thread' as const,
    title: 't',
    url: 'https://e/t',
    segments: [{ key: '1', text: 'hello', at }],
    sourceVersion: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    participantExternalIds: [],
    attributes: {},
    restricted: false,
  };
}
```

Create `packages/api-server/src/__tests__/services/composite-connector-runner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { CompositeConnectorRunner } from '../../services/composite-connector-runner.js';

const gh = { id: 'gh', type: 'github', enabled: true } as unknown as ConnectorInstanceConfig;
const slack = { id: 'sl', type: 'slack', enabled: true } as unknown as ConnectorInstanceConfig;

function fakes() {
  const graph = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    triggerSync: vi.fn(async (c: ConnectorInstanceConfig) => ({
      connectorId: c.id,
      state: 'running' as const,
    })),
    getStatus: vi.fn((id: string) => ({ connectorId: id, state: 'idle' as const })),
  };
  const knowledge = {
    handles: vi.fn((c: ConnectorInstanceConfig) => c.type !== 'kubernetes'),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    trigger: vi.fn(async (c: ConnectorInstanceConfig) => ({
      connectorId: c.id,
      state: 'running' as const,
    })),
    getStatus: vi.fn((id: string) => ({
      connectorId: id,
      state: 'degraded' as const,
      lastError: 'token expired',
    })),
  };
  return { graph, knowledge };
}

describe('CompositeConnectorRunner', () => {
  it('starts and stops both facets', async () => {
    const { graph, knowledge } = fakes();
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    await runner.start(gh);
    await runner.stop('gh');
    expect(graph.start).toHaveBeenCalledWith(gh);
    expect(knowledge.start).toHaveBeenCalledWith(gh);
    expect(graph.stop).toHaveBeenCalledWith('gh');
    expect(knowledge.stop).toHaveBeenCalledWith('gh');
  });

  it('routes a manual sync to the graph facet when there is one, else to knowledge', async () => {
    const { graph, knowledge } = fakes();
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    await runner.triggerSync(gh, 'incremental');
    expect(graph.triggerSync).toHaveBeenCalledOnce();
    await runner.triggerSync(slack, 'full');
    expect(knowledge.trigger).toHaveBeenCalledWith(slack, 'reconcile');
  });

  it('reports the knowledge status for knowledge-only types and the graph status otherwise', () => {
    const { graph, knowledge } = fakes();
    const runner = new CompositeConnectorRunner({
      graph,
      knowledge: knowledge as never,
      hasGraphFacet: (c) => c.type === 'github',
    });
    expect(runner.getStatus('gh').state).toBe('idle');
    runner.remember(slack);
    expect(runner.getStatus('sl')).toMatchObject({ state: 'degraded', lastError: 'token expired' });
  });

  it('is inert for a facet that is not wired', async () => {
    const runner = new CompositeConnectorRunner({
      graph: null,
      knowledge: null,
      hasGraphFacet: () => true,
    });
    await runner.start(gh);
    expect((await runner.triggerSync(gh, 'full')).state).toBe('idle');
    expect(runner.getStatus('gh').state).toBe('idle');
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/knowledge-sync-scheduler.test.ts src/__tests__/services/composite-connector-runner.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement the scheduler and the composite runner**

Create `packages/api-server/src/services/knowledge-sync-scheduler.ts`:

```ts
// BullMQ-backed runner for the KNOWLEDGE facet of connectors. Its own queue, so
// a long backfill never delays a graph sync; Job Schedulers (not legacy
// repeatable jobs), per the agents spec's note that new scheduling code should
// use them. Jobs carry a connector id and a mode, nothing else.
//
//   poll      — on the connector's own schedule; KnowledgeHarness poll mode
//   reconcile — on knowledge.sync.reconcileCron; KnowledgeHarness reconcile mode
//
// Each job builds a fresh connector through the connector-type factory, runs
// the harness against a PostgresKnowledgeSink and records the outcome in the
// registry's run history with facet: 'knowledge'.
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { KnowledgeHarness, type KnowledgeRunMode } from '@shipit-ai/connector-sdk';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import { PostgresKnowledgeSink, type KnowledgeStore } from '@shipit-ai/knowledge';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { getConnectorType } from './connector-types/index.js';
import type { BuildContext, ConnectorType } from './connector-types/types.js';
import type { ConnectorRegistry, SyncRuntimeStatus } from './connector-registry.js';

export const KNOWLEDGE_QUEUE = 'shipit-knowledge-sync';

interface KnowledgeJobData {
  connectorId: string;
  mode: KnowledgeRunMode;
}

/** The slice of a BullMQ Queue this class uses; tests pass a fake. */
export interface KnowledgeQueueLike {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string },
    job: { name: string; data: KnowledgeJobData },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<boolean>;
  add(name: string, data: KnowledgeJobData, opts: { jobId: string }): Promise<unknown>;
  on(event: 'error', handler: (err: Error) => void): unknown;
  close(): Promise<void>;
}

export interface KnowledgeSyncSchedulerOptions {
  redisUrl: string;
  registry: Pick<ConnectorRegistry, 'get' | 'list' | 'recordRun'>;
  store: KnowledgeStore;
  buildContext: BuildContext;
  /** Per-run wall-clock budget (knowledge.sync.maxRunMinutes). */
  budgetMs: number;
  reconcileCron: string;
  /** Backfill horizon for a connector. Default 365 days. */
  historyDaysOf?: (cfg: ConnectorInstanceConfig) => number;
  /** Status gate: false means "do not fetch now" (database, schema or extension missing). */
  isAvailable: () => Promise<boolean>;
  /** Publishes the worker wake-up after a batch commits. */
  wake?: () => Promise<void>;
  /** Test seams. */
  resolveType?: (type: string) => ConnectorType | undefined;
  queueFactory?: (name: string, connection: ConnectionOptions) => KnowledgeQueueLike;
  /** false (tests): no BullMQ Worker is started; runJob is called directly. */
  startWorker?: boolean;
  queueName?: string;
  concurrency?: number;
  log?: (line: string) => void;
}

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}

export class KnowledgeSyncScheduler {
  private readonly queue: KnowledgeQueueLike;
  private readonly worker: Worker | null;
  private readonly statuses = new Map<string, SyncRuntimeStatus>();
  private readonly resolveType: (type: string) => ConnectorType | undefined;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: KnowledgeSyncSchedulerOptions) {
    this.resolveType = opts.resolveType ?? getConnectorType;
    this.log = opts.log ?? ((line) => console.warn(line));
    const queueName = opts.queueName ?? KNOWLEDGE_QUEUE;
    const connection = parseRedisUrl(opts.redisUrl);
    const factory =
      opts.queueFactory ??
      ((name, conn) =>
        new Queue(name, {
          connection: conn,
          defaultJobOptions: {
            removeOnComplete: COMPLETED_JOB_RETENTION,
            removeOnFail: FAILED_JOB_RETENTION,
          },
        }) as unknown as KnowledgeQueueLike);
    this.queue = factory(queueName, connection);
    // No listener on 'error' = a process-killing uncaughtException when Redis is
    // at maxmemory (scar apiserver-crashloop-unhandled-bullmq-error-on-oom-redis).
    this.queue.on('error', (err) =>
      this.log(
        `KnowledgeSyncScheduler queue Redis error (knowledge syncs degraded, API stays up): ${err.message}`,
      ),
    );

    if (opts.startWorker === false || opts.queueFactory) {
      this.worker = null;
    } else {
      this.worker = new Worker(
        queueName,
        async (job: Job) => {
          const data = job.data as KnowledgeJobData;
          await this.runJob(data.connectorId, data.mode);
        },
        { connection, concurrency: opts.concurrency ?? 2 },
      );
      this.worker.on('error', (err: Error) =>
        this.log(
          `KnowledgeSyncScheduler worker Redis error (knowledge syncs degraded, API stays up): ${err.message}`,
        ),
      );
      this.worker.on('failed', (job: Job | undefined, err: Error) => {
        const id = (job?.data as KnowledgeJobData | undefined)?.connectorId;
        if (id) this.statuses.set(id, { connectorId: id, state: 'failed', lastError: err.message });
      });
    }
  }

  /** True when the connector's type has a knowledge facet. */
  handles(cfg: ConnectorInstanceConfig): boolean {
    return Boolean(this.resolveType(cfg.type)?.buildKnowledge);
  }

  async start(cfg: ConnectorInstanceConfig): Promise<void> {
    if (!cfg.enabled || !this.handles(cfg)) return;
    await this.queue.upsertJobScheduler(
      `knowledge~${cfg.id}~poll`,
      { pattern: cfg.schedule },
      { name: 'knowledge-poll', data: { connectorId: cfg.id, mode: 'poll' } },
    );
    await this.queue.upsertJobScheduler(
      `knowledge~${cfg.id}~reconcile`,
      { pattern: this.opts.reconcileCron },
      { name: 'knowledge-reconcile', data: { connectorId: cfg.id, mode: 'reconcile' } },
    );
    if (!this.statuses.has(cfg.id))
      this.statuses.set(cfg.id, { connectorId: cfg.id, state: 'idle' });
  }

  async stop(connectorId: string): Promise<void> {
    await this.queue.removeJobScheduler(`knowledge~${connectorId}~poll`);
    await this.queue.removeJobScheduler(`knowledge~${connectorId}~reconcile`);
    this.statuses.delete(connectorId);
  }

  async trigger(cfg: ConnectorInstanceConfig, mode: KnowledgeRunMode): Promise<SyncRuntimeStatus> {
    await this.queue.add(
      'knowledge-manual',
      { connectorId: cfg.id, mode },
      { jobId: `knowledge~${cfg.id}~manual~${Date.now()}` },
    );
    const status: SyncRuntimeStatus = {
      connectorId: cfg.id,
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    this.statuses.set(cfg.id, status);
    return status;
  }

  getStatus(connectorId: string): SyncRuntimeStatus {
    return this.statuses.get(connectorId) ?? { connectorId, state: 'idle' };
  }

  /** The job body. Public so tests (and a future admin "run now") can call it without BullMQ. */
  async runJob(connectorId: string, mode: KnowledgeRunMode): Promise<void> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    let cfg: ConnectorInstanceConfig;
    try {
      cfg = this.opts.registry.get(connectorId);
    } catch {
      return; // deleted while queued; do not resurrect its status
    }
    if (!(await this.opts.isAvailable())) {
      this.log(`knowledge sync for ${connectorId} skipped: the knowledge layer is unavailable`);
      return;
    }
    this.statuses.set(connectorId, { connectorId, state: 'running', startedAt });

    const type = this.resolveType(cfg.type);
    if (!type?.buildKnowledge) {
      await this.failRun(
        connectorId,
        startedAt,
        startTime,
        `Connector type "${cfg.type}" has no knowledge facet.`,
      );
      return;
    }
    const built = await type.buildKnowledge(cfg, this.opts.buildContext);
    if (!built.ok) {
      await this.failRun(connectorId, startedAt, startTime, built.message);
      return;
    }

    const sink = new PostgresKnowledgeSink({
      connectorId,
      store: this.opts.store,
      wake: this.opts.wake,
      log: this.log,
    });
    const harness = new KnowledgeHarness(built.connector, sink, built.sdkConfig, {
      historyDays: this.opts.historyDaysOf?.(cfg) ?? 365,
      budgetMs: this.opts.budgetMs,
    });
    const result = await harness.run(mode);

    try {
      await this.opts.registry.recordRun(connectorId, {
        startedAt,
        durationMs: result.durationMs,
        status: result.status,
        entitiesSynced: result.documentsSynced,
        errors: result.errors,
        facet: 'knowledge',
        ...(result.budgetExhausted
          ? { notes: ['Time budget spent; the next poll continues the backfill.'] }
          : {}),
      });
    } catch (err) {
      this.log(
        `failed to persist knowledge run history for ${connectorId}: ${(err as Error).message}`,
      );
    }

    this.statuses.set(connectorId, {
      connectorId,
      startedAt,
      state:
        result.status === 'success'
          ? 'idle'
          : result.authFailed || result.status === 'partial'
            ? 'degraded'
            : 'failed',
      lastError: result.errors[0],
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  private async failRun(
    connectorId: string,
    startedAt: string,
    startTime: number,
    message: string,
  ): Promise<void> {
    try {
      await this.opts.registry.recordRun(connectorId, {
        startedAt,
        durationMs: Date.now() - startTime,
        status: 'failed',
        entitiesSynced: 0,
        errors: [message],
        facet: 'knowledge',
      });
    } catch (err) {
      this.log(
        `failed to persist knowledge run history for ${connectorId}: ${(err as Error).message}`,
      );
    }
    this.statuses.set(connectorId, { connectorId, state: 'failed', startedAt, lastError: message });
  }
}
```

Create `packages/api-server/src/services/composite-connector-runner.ts`:

```ts
// The registry knows one ConnectorRunner. This one fans each call out to the
// graph scheduler (SyncScheduler) and the knowledge scheduler, so a connector
// with both facets (GitHub) is scheduled twice and a knowledge-only connector
// (Slack) still answers start/stop/trigger/status through the same contract.
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import type { ConnectorRunner, SyncRuntimeStatus } from './connector-registry.js';
import type { KnowledgeSyncScheduler } from './knowledge-sync-scheduler.js';

export interface CompositeConnectorRunnerOptions {
  graph: ConnectorRunner | null;
  knowledge: Pick<
    KnowledgeSyncScheduler,
    'handles' | 'start' | 'stop' | 'trigger' | 'getStatus'
  > | null;
  hasGraphFacet: (cfg: ConnectorInstanceConfig) => boolean;
}

export class CompositeConnectorRunner implements ConnectorRunner {
  // Which connectors are knowledge-only, so getStatus(id) can route without a config.
  private readonly knowledgeOnly = new Set<string>();

  constructor(private readonly opts: CompositeConnectorRunnerOptions) {}

  /** Record the facet split for a connector; start() does this, tests call it directly. */
  remember(cfg: ConnectorInstanceConfig): void {
    if (this.opts.hasGraphFacet(cfg)) this.knowledgeOnly.delete(cfg.id);
    else this.knowledgeOnly.add(cfg.id);
  }

  async start(cfg: ConnectorInstanceConfig): Promise<void> {
    this.remember(cfg);
    if (this.opts.graph && this.opts.hasGraphFacet(cfg)) await this.opts.graph.start(cfg);
    if (this.opts.knowledge?.handles(cfg)) await this.opts.knowledge.start(cfg);
  }

  async stop(connectorId: string): Promise<void> {
    await this.opts.graph?.stop(connectorId);
    await this.opts.knowledge?.stop(connectorId);
    this.knowledgeOnly.delete(connectorId);
  }

  async triggerSync(
    cfg: ConnectorInstanceConfig,
    mode: 'full' | 'incremental',
  ): Promise<SyncRuntimeStatus> {
    this.remember(cfg);
    if (this.opts.hasGraphFacet(cfg)) {
      return this.opts.graph ? this.opts.graph.triggerSync(cfg, mode) : idle(cfg.id);
    }
    if (this.opts.knowledge?.handles(cfg)) {
      // "full" for a knowledge connector is the reconcile pass; "incremental" a poll.
      return this.opts.knowledge.trigger(cfg, mode === 'full' ? 'reconcile' : 'poll');
    }
    return idle(cfg.id);
  }

  getStatus(connectorId: string): SyncRuntimeStatus {
    if (this.knowledgeOnly.has(connectorId))
      return this.opts.knowledge?.getStatus(connectorId) ?? idle(connectorId);
    return this.opts.graph?.getStatus(connectorId) ?? idle(connectorId);
  }
}

function idle(connectorId: string): SyncRuntimeStatus {
  return { connectorId, state: 'idle', startedAt: new Date().toISOString() };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/knowledge-sync-scheduler.test.ts src/__tests__/services/composite-connector-runner.test.ts`
Expected: PASS — 12 tests. Then the whole api-server suite (`pnpm --filter @shipit-ai/api-server test`) — the existing `sync-scheduler` and `sync-runtime` tests still pass with `build` optional.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/api-server
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/api-server pnpm-lock.yaml
git commit -m "api-server: knowledge facet on connector types, KnowledgeSyncScheduler on its own queue, composite runner"
```

---

## Task 12: Status service, `/api/knowledge/status`, and boot wiring

**Files:**

- Create: `packages/api-server/src/services/knowledge/knowledge-status-service.ts`, `packages/api-server/src/routes/knowledge.ts`
- Create: `packages/api-server/src/__tests__/services/knowledge/knowledge-status-service.test.ts`, `packages/api-server/src/__tests__/routes/knowledge.test.ts`
- Modify: `packages/api-server/src/server.ts`, `packages/api-server/src/index.ts`

**Interfaces:**

- Consumes: `KnowledgeConfig`, `AiConfig`; `Db`; `missingKnowledgeMigrations`, `hasVectorExtension`, `KnowledgeStore` (counts); `RedisConnectorRunStore`'s Redis client for the heartbeat read.
- Produces:

```ts
type KnowledgeCheckName = 'enabled' | 'database' | 'schema' | 'extension' | 'embedding' | 'worker'
interface KnowledgeCheck { name; ok: boolean; detail: string }
interface KnowledgeStatus { available: boolean; ingestionAvailable: boolean; checks: KnowledgeCheck[]; counts?: Record<string, number> }
class KnowledgeStatusService { constructor(opts: { knowledge: KnowledgeConfig; ai: AiConfig; db: Db | null; store: KnowledgeStore | null; redis: { get(key): Promise<string | null> } | null; cacheMs?; now?; log? }); status(): Promise<KnowledgeStatus>; ingestionAvailable(): Promise<boolean> }
const WORKER_HEARTBEAT_KEY = 'shipit-knowledge-worker-heartbeat'
GET /api/knowledge/status → KnowledgeStatus (any signed-in user); 503 KNOWLEDGE_UNAVAILABLE is the shape later knowledge routes use
```

- [ ] **Step 1: Write the failing service test**

Create `packages/api-server/src/__tests__/services/knowledge/knowledge-status-service.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Db } from '@shipit-ai/agents';
import {
  KnowledgeStatusService,
  WORKER_HEARTBEAT_KEY,
  type KnowledgeStatus,
} from '../../../services/knowledge/knowledge-status-service.js';
import { makeTestConfig } from '../../test-config.js';

const cfg = makeTestConfig();

function dbAnswering(answer: (sql: string) => { rows: unknown[] } | Error): Db {
  const query = async (sql: string) => {
    const a = answer(sql);
    if (a instanceof Error) throw a;
    return { rows: a.rows as never[], rowCount: a.rows.length };
  };
  return {
    query,
    tx: async (fn) => fn({ query } as never),
    withClient: async (fn) => fn({ query } as never),
  } as unknown as Db;
}

const healthyDb = dbAnswering((sql) => {
  if (sql.includes('schema_migrations')) return { rows: [{ version: '0002' }] };
  if (sql.includes('pg_extension')) return { rows: [{ extversion: '0.8.7' }] };
  return { rows: [] };
});
const redisWith = (beat: string | null) => ({
  get: async (key: string) => (key === WORKER_HEARTBEAT_KEY ? beat : null),
});
const check = (s: KnowledgeStatus, name: string) => s.checks.find((c) => c.name === name)!;

function service(overrides: Partial<ConstructorParameters<typeof KnowledgeStatusService>[0]> = {}) {
  return new KnowledgeStatusService({
    knowledge: cfg.knowledge,
    ai: { ...cfg.ai, database: { url: 'postgres://x' } },
    db: healthyDb,
    store: null,
    redis: redisWith('2026-10-03T00:00:00Z'),
    cacheMs: 0,
    ...overrides,
  });
}

describe('KnowledgeStatusService', () => {
  it('is available when every check passes', async () => {
    const s = await service().status();
    expect(s.available).toBe(true);
    expect(s.ingestionAvailable).toBe(true);
    expect(s.checks.map((c) => c.name)).toEqual([
      'enabled',
      'database',
      'schema',
      'extension',
      'embedding',
      'worker',
    ]);
  });

  it('names the master switch', async () => {
    const s = await service({ knowledge: { ...cfg.knowledge, enabled: false } }).status();
    expect(s.available).toBe(false);
    expect(check(s, 'enabled').detail).toContain('knowledge.enabled');
  });

  it('reports no database without leaking a URL or driver message', async () => {
    const s = await service({ db: null, ai: { ...cfg.ai, database: { url: '' } } }).status();
    expect(check(s, 'database').ok).toBe(false);
    expect(check(s, 'schema').ok).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/postgres:\/\//);
  });

  it('reports an unreachable database as not reachable, without the driver text', async () => {
    const s = await service({
      db: dbAnswering(() => new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    }).status();
    expect(check(s, 'database')).toEqual({
      name: 'database',
      ok: false,
      detail: 'The database is not reachable.',
    });
    expect(JSON.stringify(s)).not.toContain('10.0.0.5');
  });

  it('names the missing migration versions', async () => {
    const behind = dbAnswering((sql) =>
      sql.includes('schema_migrations') ? { rows: [] } : { rows: [{ extversion: '0.8.7' }] },
    );
    const s = await service({ db: behind }).status();
    expect(check(s, 'schema').ok).toBe(false);
    expect(check(s, 'schema').detail).toContain('0002');
    expect(s.ingestionAvailable).toBe(false);
  });

  it('reports the missing extension with the bootstrap hint', async () => {
    const noExt = dbAnswering((sql) =>
      sql.includes('pg_extension') ? { rows: [] } : { rows: [{ version: '0002' }] },
    );
    const s = await service({ db: noExt }).status();
    expect(check(s, 'extension').ok).toBe(false);
    expect(check(s, 'extension').detail).toContain('pgvector');
  });

  it('needs a Vertex project and the right dimension', async () => {
    const noProject = await service({
      ai: {
        ...cfg.ai,
        database: { url: 'postgres://x' },
        vertex: { project: '', location: 'global' },
      },
    }).status();
    expect(check(noProject, 'embedding').detail).toContain('ai.vertex.project');
    const wrongDims = await service({
      knowledge: { ...cfg.knowledge, embedding: { model: 'm', dimensions: 1536 } },
    }).status();
    expect(check(wrongDims, 'embedding').detail).toContain('768');
  });

  it('needs a worker heartbeat for available, not for ingestion', async () => {
    const s = await service({ redis: redisWith(null) }).status();
    expect(check(s, 'worker').ok).toBe(false);
    expect(s.available).toBe(false);
    expect(s.ingestionAvailable).toBe(true);
  });

  it('includes document counts when a store is wired', async () => {
    const store = { countsByIndexStatus: async () => ({ indexed: 10, pending: 2 }) };
    const s = await service({ store: store as never }).status();
    expect(s.counts).toEqual({ indexed: 10, pending: 2 });
  });

  it('caches for cacheMs', async () => {
    let calls = 0;
    const counting = dbAnswering((sql) => {
      calls += 1;
      return sql.includes('pg_extension')
        ? { rows: [{ extversion: '1' }] }
        : { rows: [{ version: '0002' }] };
    });
    let t = 0;
    const s = service({ db: counting, cacheMs: 5000, now: () => t });
    await s.status();
    await s.status();
    expect(calls).toBe(2); // one schema query + one extension query, once
    t = 6000;
    await s.status();
    expect(calls).toBe(4);
  });
});
```

- [ ] **Step 2: Write the failing route test**

Create `packages/api-server/src/__tests__/routes/knowledge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { requireKnowledge } from '../../routes/knowledge.js';
import type {
  KnowledgeStatus,
  KnowledgeStatusService,
} from '../../services/knowledge/knowledge-status-service.js';

// Same shape as routes/ai.test.ts: a test server from makeTestConfig() and
// server.inject(); the test principal is signed in by default.

const unavailable: KnowledgeStatus = {
  available: false,
  ingestionAvailable: false,
  checks: [
    {
      name: 'database',
      ok: false,
      detail: 'No database is configured (ai.database.url is empty).',
    },
  ],
};

describe('GET /api/knowledge/status', () => {
  it('reports "not set up" on a server built without the service', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/knowledge/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, ingestionAvailable: false });
    expect(res.json().checks[0].detail).toMatch(/not set up/);
    await server.close();
  });

  it('returns the wired status service result as is', async () => {
    const knowledgeStatus = {
      status: async () => unavailable,
    } as unknown as KnowledgeStatusService;
    const server = await createServer({ config: makeTestConfig(), knowledgeStatus });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/knowledge/status' });
    expect(res.json()).toEqual(unavailable);
    await server.close();
  });
});

describe('requireKnowledge', () => {
  function reply() {
    const sent: { status?: number; body?: unknown } = {};
    const r = {
      status(code: number) {
        sent.status = code;
        return r;
      },
      send(body: unknown) {
        sent.body = body;
        return r;
      },
    };
    return { r, sent };
  }

  it('answers 503 KNOWLEDGE_UNAVAILABLE with the failing checks', async () => {
    const gate = requireKnowledge({
      knowledgeStatus: { status: async () => unavailable } as unknown as KnowledgeStatusService,
    });
    const { r, sent } = reply();
    await gate({} as never, r as never);
    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({
      error: {
        code: 'KNOWLEDGE_UNAVAILABLE',
        message: 'The knowledge layer is not available on this server.',
      },
      checks: unavailable.checks,
    });
  });

  it('lets the request through when ingestion is available', async () => {
    const ok: KnowledgeStatus = { available: false, ingestionAvailable: true, checks: [] };
    const gate = requireKnowledge({
      knowledgeStatus: { status: async () => ok } as unknown as KnowledgeStatusService,
    });
    const { r, sent } = reply();
    expect(await gate({} as never, r as never)).toBeUndefined();
    expect(sent.status).toBeUndefined();
  });

  it('refuses on a server with no service', async () => {
    const { r, sent } = reply();
    await requireKnowledge({})({} as never, r as never);
    expect(sent.status).toBe(503);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/knowledge src/__tests__/routes/knowledge.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the service, the route, and the wiring**

Create `packages/api-server/src/services/knowledge/knowledge-status-service.ts`:

```ts
// Feature gating for the knowledge layer, the way AiStatusService gates agents:
// live checks with a short cache, details safe to show any signed-in user,
// never a host, URL or driver message.
import type { Db } from '@shipit-ai/agents';
import {
  hasVectorExtension,
  missingKnowledgeMigrations,
  type KnowledgeStore,
} from '@shipit-ai/knowledge';
import type { AiConfig, KnowledgeConfig } from '@shipit-ai/shared';

/** Written by knowledge-worker every 15s with a 60s TTL. Absent = no worker. */
export const WORKER_HEARTBEAT_KEY = 'shipit-knowledge-worker-heartbeat';
export const EXPECTED_EMBEDDING_DIMENSIONS = 768;

export type KnowledgeCheckName =
  'enabled' | 'database' | 'schema' | 'extension' | 'embedding' | 'worker';

export interface KnowledgeCheck {
  name: KnowledgeCheckName;
  ok: boolean;
  detail: string;
}

export interface KnowledgeStatus {
  /** Everything, including a live worker: content can be fetched, indexed and searched. */
  available: boolean;
  /** Enough to fetch and store documents; indexing waits for the worker. */
  ingestionAvailable: boolean;
  checks: KnowledgeCheck[];
  /** Documents by index status, when a store is wired and the schema is present. */
  counts?: Record<string, number>;
}

export interface KnowledgeStatusServiceOptions {
  knowledge: KnowledgeConfig;
  ai: AiConfig;
  /** null when no database URL is configured. */
  db: Db | null;
  /** null when the schema is not there yet or in tests. Only counts are read. */
  store: Pick<KnowledgeStore, 'countsByIndexStatus'> | null;
  /** null when Redis is not configured. Only `get` is used. */
  redis: { get(key: string): Promise<string | null> } | null;
  cacheMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const pass = (name: KnowledgeCheckName, detail: string): KnowledgeCheck => ({
  name,
  ok: true,
  detail,
});
const fail = (name: KnowledgeCheckName, detail: string): KnowledgeCheck => ({
  name,
  ok: false,
  detail,
});

export class KnowledgeStatusService {
  private cached: { at: number; status: KnowledgeStatus } | null = null;

  constructor(private readonly opts: KnowledgeStatusServiceOptions) {}

  async status(): Promise<KnowledgeStatus> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheMs ?? 5_000;
    if (this.cached && now - this.cached.at < ttl) return this.cached.status;
    const status = await this.compute();
    this.cached = { at: now, status };
    return status;
  }

  async ingestionAvailable(): Promise<boolean> {
    return (await this.status()).ingestionAvailable;
  }

  private async compute(): Promise<KnowledgeStatus> {
    const enabled = this.opts.knowledge.enabled
      ? pass('enabled', 'The knowledge layer is switched on.')
      : fail('enabled', 'The knowledge layer is switched off (knowledge.enabled is false).');
    const [database, schema, extension] = await this.checkDatabase();
    const embedding = this.checkEmbedding();
    const worker = await this.checkWorker();
    const checks = [enabled, database, schema, extension, embedding, worker];
    const ingestionAvailable = enabled.ok && database.ok && schema.ok && extension.ok;
    const status: KnowledgeStatus = {
      available: checks.every((c) => c.ok),
      ingestionAvailable,
      checks,
    };
    if (ingestionAvailable && this.opts.store) {
      try {
        status.counts = await this.opts.store.countsByIndexStatus();
      } catch (err) {
        this.opts.log?.(`knowledge-status: counts failed: ${(err as Error).message}`);
      }
    }
    return status;
  }

  private async checkDatabase(): Promise<[KnowledgeCheck, KnowledgeCheck, KnowledgeCheck]> {
    const { db } = this.opts;
    if (!db) {
      return [
        fail('database', 'No database is configured (ai.database.url is empty).'),
        fail('schema', 'No database to check.'),
        fail('extension', 'No database to check.'),
      ];
    }
    let missing: string[];
    try {
      missing = await missingKnowledgeMigrations(db);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // 42P01 = undefined_table: connected, nothing migrated yet.
      if (e.code === '42P01') missing = ['(none applied)'];
      else {
        this.opts.log?.(`knowledge-status: database check failed: ${e.message ?? String(err)}`);
        const down = 'The database is not reachable.';
        return [fail('database', down), fail('schema', down), fail('extension', down)];
      }
    }
    const database = pass('database', 'Connected.');
    const schema =
      missing.length === 0
        ? pass('schema', 'The knowledge tables are present.')
        : fail(
            'schema',
            `Knowledge migrations missing: ${missing.join(', ')}. Run the migration step.`,
          );
    let extension: KnowledgeCheck;
    try {
      extension = (await hasVectorExtension(db))
        ? pass('extension', 'pgvector is installed.')
        : fail(
            'extension',
            'The pgvector extension is not installed. A superuser must run the bootstrap step (pnpm db:bootstrap locally).',
          );
    } catch (err) {
      this.opts.log?.(`knowledge-status: extension check failed: ${(err as Error).message}`);
      extension = fail('extension', 'The pgvector extension could not be checked.');
    }
    return [database, schema, extension];
  }

  private checkEmbedding(): KnowledgeCheck {
    if (!this.opts.ai.vertex.project)
      return fail('embedding', 'No Vertex AI project is configured (ai.vertex.project).');
    const { model, dimensions } = this.opts.knowledge.embedding;
    if (dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) {
      return fail(
        'embedding',
        `knowledge.embedding.dimensions is ${dimensions}; the schema stores ${EXPECTED_EMBEDDING_DIMENSIONS}.`,
      );
    }
    return pass('embedding', `${model} at ${dimensions} dimensions.`);
  }

  private async checkWorker(): Promise<KnowledgeCheck> {
    const { redis } = this.opts;
    if (!redis) return fail('worker', 'Redis is not configured, so no worker can be seen.');
    try {
      const beat = await redis.get(WORKER_HEARTBEAT_KEY);
      return beat
        ? pass('worker', 'The knowledge worker is alive.')
        : fail('worker', 'No heartbeat from the knowledge worker in the last minute.');
    } catch (err) {
      this.opts.log?.(`knowledge-status: worker check failed: ${(err as Error).message}`);
      return fail('worker', 'The knowledge worker could not be checked.');
    }
  }
}
```

Create `packages/api-server/src/routes/knowledge.ts`:

```ts
// Instance-level facts about the knowledge layer (mounted /api/knowledge).
// Later milestones add containers, documents, search and suggestions here;
// every one of them answers 503 KNOWLEDGE_UNAVAILABLE through `requireKnowledge`
// when a prerequisite is missing.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  KnowledgeStatus,
  KnowledgeStatusService,
} from '../services/knowledge/knowledge-status-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledgeStatus?: KnowledgeStatusService;
  }
}

export const KNOWLEDGE_NOT_WIRED: KnowledgeStatus = {
  available: false,
  ingestionAvailable: false,
  checks: [
    { name: 'enabled', ok: false, detail: 'The knowledge layer is not set up on this server.' },
  ],
};

/** preHandler for routes that need the layer: 503 with the failing checks. */
export function requireKnowledge(server: { knowledgeStatus?: KnowledgeStatusService }) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const status = server.knowledgeStatus
      ? await server.knowledgeStatus.status()
      : KNOWLEDGE_NOT_WIRED;
    if (status.ingestionAvailable) return undefined;
    return reply.status(503).send({
      error: {
        code: 'KNOWLEDGE_UNAVAILABLE',
        message: 'The knowledge layer is not available on this server.',
      },
      checks: status.checks.filter((c) => !c.ok),
    });
  };
}

const knowledgeRoutes: FastifyPluginAsync = async (server) => {
  // Any signed-in user: the Connector Hub reads this to enable or explain the knowledge connectors.
  server.get('/status', async () =>
    server.knowledgeStatus ? server.knowledgeStatus.status() : KNOWLEDGE_NOT_WIRED,
  );
};

export default knowledgeRoutes;
```

`packages/api-server/src/server.ts` — alongside `aiStatus`:

```diff
   aiStatus?: AiStatusService;
+  // Live prerequisite checks for the knowledge layer. Optional for the same reason.
+  knowledgeStatus?: KnowledgeStatusService;
 }
```

```diff
   if (opts.aiStatus) {
     server.decorate('aiStatus', opts.aiStatus);
   }
+  if (opts.knowledgeStatus) {
+    server.decorate('knowledgeStatus', opts.knowledgeStatus);
+  }
```

```diff
   await server.register(aiRoutes, { prefix: '/api/ai' });
+  await server.register(knowledgeRoutes, { prefix: '/api/knowledge' });
```

with the two imports (`KnowledgeStatusService` type, `knowledgeRoutes`) next to their `ai` counterparts.

`packages/api-server/src/index.ts` — share the pool and wire everything:

```diff
-import { AgentStore, createDb, createPool, type Db } from '@shipit-ai/agents';
+import { AgentStore, createDb, createPool, type Db } from '@shipit-ai/agents';
+import { KnowledgeStore } from '@shipit-ai/knowledge';
 import { AiStatusService } from './services/ai/ai-status-service.js';
+import { KnowledgeStatusService } from './services/knowledge/knowledge-status-service.js';
+import { KnowledgeSyncScheduler } from './services/knowledge-sync-scheduler.js';
+import { CompositeConnectorRunner } from './services/composite-connector-runner.js';
+import { getConnectorType } from './services/connector-types/index.js';
```

```diff
-  const agentPool =
-    config.ai.enabled && config.ai.database.url
-      ? createPool({ connectionString: config.ai.database.url })
-      : null;
+  // One pool for agents and the knowledge layer. Opened when either feature is
+  // on and a database URL is configured.
+  const agentPool =
+    (config.ai.enabled || config.knowledge.enabled) && config.ai.database.url
+      ? createPool({ connectionString: config.ai.database.url })
+      : null;
   const agentDb: Db | null = agentPool ? createDb(agentPool) : null;
```

After the `AiStatusService` construction:

```ts
// Knowledge layer. Same optionality as agents: without a database the status
// route explains what is missing and nothing is scheduled.
const knowledgeStore = agentDb && config.knowledge.enabled ? new KnowledgeStore(agentDb) : null;
const knowledgeStatus = new KnowledgeStatusService({
  knowledge: config.knowledge,
  ai: config.ai,
  db: agentDb,
  store: knowledgeStore,
  redis: runStoreRedis,
  log: (message) => console.warn(message),
});
console.log(
  knowledgeStore
    ? 'Knowledge layer: database configured.'
    : 'Knowledge layer: off (knowledge.enabled is false or ai.database.url is empty).',
);
```

Pass `knowledgeStatus` into `createServer({ … })` next to `aiStatus`.

After `wireSyncRuntime(...)` returns, before `schemaService.loadSchema()`:

```ts
// Knowledge connectors are scheduled on their own queue; the registry sees
// one runner that fans out to both. Needs Redis (the queue) and the store.
let knowledgeScheduler: KnowledgeSyncScheduler | null = null;
if (knowledgeStore && scheduler && config.backend.redis.url) {
  try {
    knowledgeScheduler = new KnowledgeSyncScheduler({
      redisUrl: config.backend.redis.url,
      registry: connectorRegistry,
      store: knowledgeStore,
      buildContext: scheduler.context,
      budgetMs: config.knowledge.sync.maxRunMinutes * 60_000,
      reconcileCron: config.knowledge.sync.reconcileCron,
      isAvailable: () => knowledgeStatus.ingestionAvailable(),
      wake: runStoreRedis
        ? async () => void (await runStoreRedis!.publish('shipit-knowledge-wake', ''))
        : undefined,
    });
    connectorRegistry.setRunner(
      new CompositeConnectorRunner({
        graph: scheduler,
        knowledge: knowledgeScheduler,
        hasGraphFacet: (cfg) => Boolean(getConnectorType(cfg.type)?.build),
      }),
    );
  } catch (err) {
    console.warn(
      `Knowledge scheduling failed to start (knowledge syncs off, API stays up): ${(err as Error).message}`,
    );
  }
}
```

And in `shutdown`, before `if (webhookRefetch)`: `if (knowledgeScheduler) await knowledgeScheduler.close();`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/knowledge src/__tests__/routes/knowledge.test.ts`
Expected: PASS — 15 tests. Then `pnpm --filter @shipit-ai/api-server test` — the full suite, including the existing boot and `sync-runtime` tests, still passes.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/api-server
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/api-server
git commit -m "api-server: knowledge status service and /api/knowledge/status; shared pool and scheduler wiring at boot"
```

---

## Task 13: Compose bootstrap, docs, infra brief 2, and the hands-on check

**Files:**

- Modify: `docker/docker-compose.yml` (the `migrate` service), `docs/local-development.md`, `docs/architecture.md`
- Create: `docs/agent/briefs/infra-knowledge-worker-deploy.md`
- Modify: `docs/agent/plans/knowledge-connectors.md` (Status), `docs/agent/MANIFEST.md`

- [ ] **Step 1: Bootstrap inside the compose migrate step**

Now that the api-server image carries `@shipit-ai/knowledge` (Task 11), the one-shot `migrate` service can run the bootstrap first:

```diff
   migrate:
     build:
       context: ..
       dockerfile: packages/api-server/Dockerfile
-    command: ['node', 'node_modules/@shipit-ai/agents/dist/migrate-cli.js']
+    # pgvector first (the compose `shipit` user is the superuser), then schema.
+    command:
+      - sh
+      - -c
+      - node node_modules/@shipit-ai/knowledge/dist/bootstrap-cli.js && node node_modules/@shipit-ai/agents/dist/migrate-cli.js
```

- [ ] **Step 2: Docs**

`docs/local-development.md`: in the scripts table add `pnpm db:bootstrap` ("Create the pgvector extension; `start:infra` runs it before migrations") and a line under the compose section: "`docker compose --profile knowledge up` also starts `knowledge-worker`; it needs `GOOGLE_CLOUD_PROJECT` and Application Default Credentials." In the manual-paths block, insert `DATABASE_URL=… pnpm db:bootstrap` before the `db:migrate` line.

`docs/architecture.md`: add a short "Knowledge layer" subsection: documents from knowledge connectors are stored in Postgres (pgvector), indexed by `knowledge-worker`, status at `GET /api/knowledge/status`; link the spec.

- [ ] **Step 3: Infra brief 2**

Create `docs/agent/briefs/infra-knowledge-worker-deploy.md`:

```markdown
# Infra brief — `knowledge-worker` Deployment

**For:** `Ship-It-Ops/shipit-ai-infra`. **From:** app repo, <date>. **Follows:**
`infra-pgvector-for-knowledge.md` (the pgvector instance, the superuser bootstrap
step, the KSA/GSA). **Enables:** indexing for the knowledge layer
(`docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`).

## What exists now

- Image: `knowledge-worker`, built from `packages/knowledge-worker/Dockerfile`
  (same shape as `core-writer`). Add it to `build-images.yml`.
- It reads the mounted `shipit.config.yaml` like every other backend service and
  needs these env vars: `DATABASE_URL` (ESO, the `shipit_app` role), `REDIS_URL`,
  `NEO4J_URI` and `NEO4J_PASSWORD` (config placeholders; no Neo4j connection is
  opened yet), `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`.
- It calls Vertex AI embeddings with Application Default Credentials: run it as
  KSA `shipit/knowledge-worker`, bound to the GSA with `roles/aiplatform.user`.

## Deployment

- `Deployment`, no `Service`, `replicas: 1`. Requests around `200m / 512Mi` to
  start; embedding is network-bound.
- No readiness probe is needed; liveness can be a process check. The app's
  `/api/knowledge/status` reports a `worker` check from a Redis heartbeat
  (`shipit-knowledge-worker-heartbeat`, 60 s TTL).
- Start order does not matter: with the schema missing the pod exits non-zero
  and restarts; with no documents it idles.
- Egress: Google APIs only. It does not call Slack, Atlassian or GitHub.

## Done when

1. The pod is `Running` and `kubectl logs` shows `knowledge-worker: indexing with …`.
2. `GET /api/knowledge/status` on portal-demo reports `worker: ok`.
3. The image is produced by `build-images.yml` and deployed by `deploy.yml` with
   the other services.
```

Fill in the date when the brief is written.

- [ ] **Step 4: Hands-on check (Docker running)**

```bash
pnpm stop && pnpm start:infra          # pgvector image, bootstrap, 0001 + 0002 applied
pnpm start:backend                     # api-server + core-writer + mcp-server
```

In another terminal, signed in as any user (the API Keys tab issues a token):

```bash
curl -s -H "Authorization: Bearer <token>" localhost:3001/api/knowledge/status | jq
```

Expected: `ingestionAvailable: true`, `available: false`, and the `worker` check failing with "No heartbeat". Then:

```bash
GOOGLE_CLOUD_PROJECT=<project> pnpm --filter @shipit-ai/knowledge-worker dev
```

(needs `gcloud auth application-default login`; without it the worker still boots, heartbeats, and only fails when a document arrives). Re-run the status call: `available: true`. Stop the worker; within 60 s the status flips back.

Then the regression checks the Review Focus calls for:

1. Remove the `ai.database` block from `shipit.config.local.yaml`, restart api-server: `/api/knowledge/status` reports `database` failing, `/api/connectors` and the rest of the API behave as before, nothing in the logs says `knowledge` after the one boot line. Restore the block.
2. `docker compose -f docker/docker-compose.yml up -d postgres` on the pre-existing `postgres_data` volume starts cleanly on the pgvector image (the data directory format is the same Postgres 17), and `pnpm db:bootstrap` reports `Created` the first time.

- [ ] **Step 5: Update the plan note and the manifest**

`docs/agent/plans/knowledge-connectors.md` → Status: K0 implemented on `ai-agents-design` (list the commits by reading `git log`, never from memory); what the hands-on check showed; next is the K1 plan (GitHub text). `docs/agent/MANIFEST.md`: bump the plan's summary and `Last updated`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write docker/docker-compose.yml docs
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add docker/docker-compose.yml docs/local-development.md docs/architecture.md docs/agent/briefs/infra-knowledge-worker-deploy.md docs/agent/plans/knowledge-connectors.md docs/agent/MANIFEST.md
git commit -m "knowledge: compose bootstrap step, docs, knowledge-worker infra brief; K0 status"
```

---

## Self-review notes

**Spec coverage (K0 scope).** §Connector contract → Task 4. §Scheduling → Task 11 (own queue, Job Schedulers, facet on run records, gate on availability). §Data model: the five K0 tables → Task 2; entity links, references, relation mentions and suggestions arrive with K1 and K5 in their own migrations. §Visibility: `visibility`, `acl` and `visibility_acknowledged_by` columns exist; the acknowledgement UI is K3. §Index pipeline → Tasks 6, 7, 8, 9 (claim query, stale claims, five attempts with 4^n backoff, embedding reuse by text hash, `INDEX_VERSION`). §Config → Task 3. §Feature gating → Task 12 (six checks, `KNOWLEDGE_UNAVAILABLE`, nothing crashes). §Error handling rows covered: 429 (embedder retry; the connector side arrives with the first connector), 401/403 (harness `authFailed` → `degraded`), one container failing (harness), incomplete listing (harness), api-server restart (checkpoint per batch), embedding failure (markFailed, backoff), worker crash (stale claim), Redis unavailable (poll floor, best-effort wake), Postgres unavailable (loop logs and waits). Decision 14 (redaction before storage) → Tasks 5, 7. Decision 8 (Postgres as queue) → Tasks 7, 9. Decision 10 (pgvector baseline, superuser bootstrap) → Tasks 1, 2.

**Not in K0, on purpose.** No source connector, no UI, no retrieval, no linking: those are K1 and K2. The `wake` publish uses the run-store Redis client; if that client is absent the sink runs without wake-ups, which the loop tolerates.

**Type consistency.** `pruneMissing` takes `string[]` everywhere (SDK type, harness, store, sink, tests). `storeBatch` returns `{ changed, deleted }` everywhere. `KnowledgeRunResult.documentsSynced` maps to `LastRun.entitiesSynced`. `IndexStore` is the four-method slice the pipeline uses and `KnowledgeStore` satisfies it structurally. `Embedder.model` is what `existingChunkEmbeddings` filters on and what `StoredChunkInput.embeddingModel` stores. `CompositeConnectorRunner` expects `KnowledgeSyncScheduler.handles/start/stop/trigger/getStatus`, all present.

**Review Focus pins.** 1 → Task 4 `resumes from the stored checkpoint`, Task 7 `storing the same batch twice changes nothing`. 2 → Task 5 (both redaction tests), Task 7 `redacts before storing`. 3 → Task 2 `guards on the vector extension` (file test) and the integration apply, Task 11 `skips the run when the layer is unavailable`, Task 12 every check plus the route's not-wired shape. 4 → Task 7 `reclaims a stale claim`, `stops retrying after five failures`; Task 9 `a failing document does not stop the batch`. 5 → Task 4 `does not prune when the id listing throws`; Task 7 `pruneMissing tombstones the rest`, `tombstones deletions in the same batch`.

**Things an executor must check rather than trust.** The pgvector image tag (Task 1 Step 6); the AI SDK embedding method and provider-options key (Task 10 Step 1); secretlint's exact match on the AWS fixture (Task 5 Step 4); whether another `0002` migration landed first (Global Constraints); and that no test fixture writes a secret-shaped string contiguously into source, because the pre-commit hook scans every staged file.
