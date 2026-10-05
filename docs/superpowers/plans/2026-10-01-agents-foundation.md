# Agent Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent definitions can be created, edited, published and archived through the API and stored in Postgres, with a status endpoint that says exactly what is missing when they cannot.

**Architecture:** A new library package, `@shipit-ai/agents`, owns the Postgres access layer, the plain-SQL migration runner, and the agent-definition schema. The api-server gains a status service, `/api/ai/*` and `/api/agents/*` routes, and opens a connection pool only when a database URL is configured. Nothing calls a model yet: this is the storage and API half of Milestone 1. The runner, the model layer and the UI are the next plan, which starts from the Vertex probe at the end of this one.

**Tech Stack:** TypeScript (ESM, Node 22), `pg` 8, Zod 4, Fastify 5, Vitest 4, Postgres 17 (docker-compose locally, a service container in CI).

**Spec:** `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md` (§Packages and processes, §Data model, §Agent definition, §API, §Config, §Secrets, §Feature gating, §Testing; Milestone 1, first half)

**How this plan was checked.** Every code block below was first written and run in an isolated clone of this branch. There, `pnpm turbo typecheck` passes across the workspace, `pnpm turbo test` passes with no regressions (api-server 674 passed, of which 56 are new), and `pnpm format:check` is clean. The store and migration SQL was exercised against an embedded Postgres engine through a test adapter: 22 of the 23 integration tests passed there. The remaining one (two migrators at once) needs separate connections and first runs in Task 2. Three things were **not** run, because Docker was not available: the `pg`-driver test harness against a real Postgres (Task 2 is its first real run), the api-server image build (Task 8), and the Vertex probe (Task 9, which needs GCP credentials).

## Global Constraints

- **Run commands from the repo root.** A single test file: `pnpm --filter <package> exec vitest run <path>`.
- **Verify before each commit:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`. `pnpm format:check` is a CI gate; run `npx prettier --write <files>` on anything you touch.
- **Commits need the owner's go-ahead.** Each "Commit" step marks where a commit belongs. Ask before running `git commit`, and separately before any `git push`. No `Co-Authored-By` or other AI-attribution trailer.
- **ESM everywhere:** relative imports end in `.js`.
- **The app never migrates at boot.** Migrations are applied by `pnpm db:migrate` locally and in CI, and by the infra repo's deploy step on GKE.
- **Migration files (exact contract, shared with the infra repo):** `db/migrations/NNNN_description.sql`, four digits, lower-case description with underscores, forward-only. An applied file is never edited. Tracking table: `schema_migrations(version text primary key, applied_at timestamptz not null default now())`, where `version` is the four-digit prefix.
- **When you add a migration, bump `EXPECTED_SCHEMA_VERSION`** in `packages/agents/src/schema-version.ts` in the same change. A unit test enforces it.
- **`DATABASE_URL` is a plain env var**, surfaced as `ai.database.url` through a `${DATABASE_URL:-}` placeholder. **Never add it to `LOGICAL_SECRETS` or the `secrets:` registry.** Boot hydration reads every registry entry from GSM when its env var is unset, and the api-server holds no grant on that container: that is the 2026-09-16 boot crash.
- **A new workspace dependency must agree in three places** (scar `docker-builder-copies-fixed-package-set`): the consuming package's Dockerfile `COPY` list, its vitest alias list, and the lockfile. Do **not** add a tsconfig `references` entry for `packages/agents`; types resolve through `node_modules`.
- **Postgres-backed suites are gated on `DATABASE_TEST_URL`** and named `*.integration.test.ts`. They run with `--no-file-parallelism`.
- **Error envelope:** `{ error: { code, message } }`, with extra top-level fields (`issues`, `checks`, `serverRevision`) where stated.
- **Exact values:**
  - Agent slug: `/^[a-z0-9][a-z0-9-]{0,62}$/`
  - Capabilities: `agents:read`, `agents:write`, `agents:run`, `ai:admin`. Members hold `agents:read` and `agents:run`; admins hold `*`.
  - Instance ceilings (defaults): `maxSteps: 25`, `maxTokens: 400000`, `timeoutSeconds: 900`, `dailyTokens: 4000000`.
  - Error codes: `AI_UNAVAILABLE` (503), `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `SLUG_TAKEN` (409), `VERSION_CONFLICT` (409), `BUILTIN_PROTECTED` (409), `FORBIDDEN` (403), `GRANT_EXCEEDS_CAPABILITY` (403).
  - Runner heartbeat key: `shipit-agent-runner-heartbeat`.
  - Local database: `postgres://shipit:shipit-dev@localhost:5432/shipit`. CI database: `postgres://shipit:testpassword@localhost:5432/shipit_test`.
- **Use those two database URLs exactly as written.** secretlint runs in the pre-commit hook and in CI, and flags any Postgres URL with an inline password. `.secretlintrc.json` allows only user `shipit`, passwords `shipit-dev` and `testpassword`, hosts `localhost`, `127.0.0.1` and `postgres`, port `5432`. Any other literal fails the commit; do not widen the allow-list without the owner's say-so.
- **Never commit `packages/web-ui/next-env.d.ts`.**

## Review Focus

Conditions the spec implies that a person will hit. Each is pinned by a test in the task that owns the code:

1. **Two people save the same agent.** The second gets `409 VERSION_CONFLICT` with the server's revision and nothing is overwritten. → Task 4 (`rejects a stale revision`, `lets exactly one of two writers … win`), Task 7 (`answers 409 VERSION_CONFLICT`).
2. **The database is down, never migrated, or behind the code.** The answer is `503 AI_UNAVAILABLE` naming the failing check. It is never a 500, it never shows a host or driver message, and the rest of the API keeps working. → Task 6 (status service), Task 7 (`names the failing prerequisites`, `turns a store failure into 503`).
3. **A migration fails halfway, runs twice, or two deploys run it at once.** Each file is all-or-nothing, a re-run applies nothing, and two migrators cannot interleave. → Task 1 (`rolls a failing file back completely`, `applies each file once when two migrators start together`).
4. **A hostile or sloppy definition:** unknown keys, `allow` on delete, 50,001 characters of instructions, a limit above the ceiling, a model the instance does not offer, a body that is not an object. Each is a 400 with the field path, and nothing is stored. → Task 3, Task 7.
5. **An author grants an agent more than they hold themselves.** `403 GRANT_EXCEEDS_CAPABILITY`, naming the capability. → Task 7.

Two more that tests cannot fully pin and that Task 8 checks by hand: an idle Postgres connection dropping must not crash the api-server (the pool has an `error` listener; Task 1 tests the listener), and a deployment with **no** database must boot and serve exactly as it does today.

## File Structure

| Path                                                       | Responsibility                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `db/migrations/0001_agents.sql`                            | Tables `agents` and `agent_versions`.                                                              |
| `packages/agents/src/db.ts`                                | `createPool` (with the `error` listener) and the small `Db` interface everything else talks to.    |
| `packages/agents/src/migrate.ts`                           | Filename parsing, planning, and applying migrations. Pure planning is separate from I/O.           |
| `packages/agents/src/migrate-cli.ts`                       | `pnpm db:migrate`.                                                                                 |
| `packages/agents/src/schema-version.ts`                    | `EXPECTED_SCHEMA_VERSION`.                                                                         |
| `packages/agents/src/definition.ts`                        | Zod schema for an agent definition, instance-policy check, and the granted (service, effect) list. |
| `packages/agents/src/agent-store.ts`                       | `AgentStore`: create, read, list, update, publish, archive, with optimistic concurrency.           |
| `packages/agents/src/__tests__/test-db.ts`                 | Per-suite private schema on a real Postgres.                                                       |
| `packages/shared/src/config/schema.ts`                     | The `ai` config section.                                                                           |
| `packages/api-server/src/services/ai/ai-status-service.ts` | Live prerequisite checks.                                                                          |
| `packages/api-server/src/routes/ai.ts`                     | `GET /api/ai/status`, `GET /api/ai/models`.                                                        |
| `packages/api-server/src/routes/agents.ts`                 | `/api/agents` CRUD, publish, versions.                                                             |
| `packages/api-server/src/index.ts`                         | Opens the pool when configured and wires the store.                                                |

---

## Task 1: The `agents` package, the first migration, and the migration runner

**Files:**

- Create: `db/migrations/0001_agents.sql`
- Create: `packages/agents/package.json`, `packages/agents/tsconfig.json`, `packages/agents/vitest.config.ts`
- Create: `packages/agents/src/schema-version.ts`, `src/db.ts`, `src/migrate.ts`, `src/migrate-cli.ts`, `src/index.ts`
- Test: `packages/agents/src/__tests__/db.test.ts`, `migrate.test.ts`, `migrate.integration.test.ts`, `test-db.ts` (harness)
- Modify: `package.json` (root), `vitest.config.ts` (root)

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `createPool(opts: { connectionString: string; max?: number; searchPath?: string; onError?: (err: Error) => void }): Pool`
  - `createDb(pool: Pool): Db`, where `Db` has `query<R>(text, params?)`, `tx<T>(fn)`, `withClient<T>(fn)`, each handing `fn` a `SqlClient` with `query`.
  - `runMigrations(opts: { db: Db; dir: string; log?: (line: string) => void }): Promise<{ applied: string[]; alreadyApplied: string[] }>`
  - `planMigrations(filenames, applied): { pending: string[]; unknownApplied: string[] }`, `parseMigrationFilename(name)`, `listMigrationFiles(dir)`, `MigrationPlanError`, `MIGRATION_LOCK_KEY`
  - `EXPECTED_SCHEMA_VERSION: string` (`'0001'`)
  - Test harness: `createTestDatabase(): Promise<{ db: Db; drop(): Promise<void> }>`, `DATABASE_TEST_URL`, `MIGRATIONS_DIR`
  - Root script `pnpm db:migrate`

- [ ] **Step 1: Create the package skeleton**

`packages/agents/package.json`:

```json
{
  "name": "@shipit-ai/agents",
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

`packages/agents/tsconfig.json`:

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

`packages/agents/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// This package has no @shipit-ai/* workspace dependencies, so unlike its
// siblings it needs no source aliases for the unbuilt CI `integration` job.
export default defineConfig({
  test: {
    // Vitest 4 no longer excludes `dist` by default; scope to TS sources so the
    // compiled dist/**/*.test.js copies aren't collected after a build.
    include: ['src/**/*.test.ts'],
  },
});
```

Register the package with the root test runner and add the migrate script. Root `vitest.config.ts`:

```diff
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -8,6 +8,7 @@ export default defineConfig({
   test: {
     projects: [
       'packages/shared',
+      'packages/agents',
       'packages/event-bus',
       'packages/core-writer',
       'packages/connector-sdk',
```

Root `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -21,6 +21,7 @@
     "start:all": "bash scripts/preflight.sh && bash scripts/infra.sh && bash scripts/maybe-seed.sh && turbo dev",
     "seed": "tsx scripts/seed-demo.ts",
     "seed:reset": "tsx scripts/seed-reset.ts",
+    "db:migrate": "tsx packages/agents/src/migrate-cli.ts",
     "stop": "docker compose -f docker/docker-compose.yml down",
     "stop:clean": "docker compose -f docker/docker-compose.yml down -v",
     "format": "prettier --write \"**/*.{ts,tsx,js,jsx,json,md,mdx,css,yml,yaml}\"",
```

Then install, which also updates `pnpm-lock.yaml`:

```bash
pnpm install
```

- [ ] **Step 2: Write the first migration**

Create `db/migrations/0001_agents.sql`:

```sql
-- 0001_agents.sql: agent definitions and their published versions.
--
-- Applied by the migration step (infra at deploy; `pnpm db:migrate` locally and
-- in CI), never by the app at boot. Forward-only: an applied file is never
-- edited; changes arrive as a new numbered file.

CREATE TABLE agents (
  id                uuid PRIMARY KEY,
  slug              text NOT NULL,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  owner_team_id     text,
  enabled           boolean NOT NULL DEFAULT true,
  builtin           boolean NOT NULL DEFAULT false,
  draft_definition  jsonb NOT NULL,
  published_version integer,
  revision          integer NOT NULL DEFAULT 1,
  created_by        text NOT NULL,
  updated_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT agents_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT agents_revision_positive CHECK (revision >= 1)
);

-- A slug is unique among live agents; archiving an agent frees its slug.
CREATE UNIQUE INDEX agents_slug_live_key ON agents (slug) WHERE archived_at IS NULL;
CREATE INDEX agents_updated_at_idx ON agents (updated_at DESC);

CREATE TABLE agent_versions (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  definition jsonb NOT NULL,
  note       text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version),
  CONSTRAINT agent_versions_version_positive CHECK (version >= 1)
);
```

`draft_definition` holds the editable draft; `agent_versions` holds what was published. The slug index is partial so that archiving an agent frees its slug.

- [ ] **Step 3: Write the failing unit tests**

Create `packages/agents/src/__tests__/migrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MigrationPlanError,
  listMigrationFiles,
  parseMigrationFilename,
  planMigrations,
} from '../migrate.js';
import { EXPECTED_SCHEMA_VERSION } from '../schema-version.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

describe('parseMigrationFilename', () => {
  it('accepts NNNN_description.sql', () => {
    expect(parseMigrationFilename('0001_agents.sql')).toEqual({
      version: '0001',
      description: 'agents',
    });
    expect(parseMigrationFilename('0012_run_steps_v2.sql')).toEqual({
      version: '0012',
      description: 'run_steps_v2',
    });
  });

  it.each(['1_agents.sql', '00001_agents.sql', '0001-agents.sql', '0001_Agents.sql', '0001_.sql'])(
    'rejects %s',
    (name) => {
      expect(parseMigrationFilename(name)).toBeNull();
    },
  );
});

describe('planMigrations', () => {
  it('returns unapplied files in version order, whatever order they were listed in', () => {
    const plan = planMigrations(['0003_c.sql', '0001_a.sql', '0002_b.sql'], ['0001']);
    expect(plan.pending).toEqual(['0002_b.sql', '0003_c.sql']);
    expect(plan.unknownApplied).toEqual([]);
  });

  it('plans nothing when everything is applied', () => {
    expect(planMigrations(['0001_a.sql'], ['0001']).pending).toEqual([]);
  });

  it('ignores files that are not .sql', () => {
    expect(planMigrations(['README.md', '.gitkeep', '0001_a.sql'], []).pending).toEqual([
      '0001_a.sql',
    ]);
  });

  it('refuses a .sql file with a malformed name rather than skipping it', () => {
    expect(() => planMigrations(['0001_a.sql', '2_oops.sql'], [])).toThrow(MigrationPlanError);
  });

  it('refuses two files with the same version', () => {
    expect(() => planMigrations(['0001_a.sql', '0001_b.sql'], [])).toThrow(/share version 0001/);
  });

  it('refuses a pending file older than the newest applied version', () => {
    expect(() =>
      planMigrations(['0001_a.sql', '0002_b.sql', '0003_c.sql'], ['0001', '0003']),
    ).toThrow(/forward-only/);
  });

  it('reports applied versions that have no file, without failing', () => {
    const plan = planMigrations(['0001_a.sql'], ['0001', '0002']);
    expect(plan.pending).toEqual([]);
    expect(plan.unknownApplied).toEqual(['0002']);
  });
});

describe('listMigrationFiles', () => {
  it('returns an empty list for a directory that does not exist', async () => {
    await expect(listMigrationFiles(resolve(here, 'no-such-dir'))).resolves.toEqual([]);
  });
});

describe('db/migrations', () => {
  it('is a valid, gap-free sequence', () => {
    const plan = planMigrations(readdirSync(MIGRATIONS_DIR), []);
    const versions = plan.pending.map((f) => parseMigrationFilename(f)!.version);
    expect(versions).toEqual(versions.map((_, i) => String(i + 1).padStart(4, '0')));
  });

  it('ends at EXPECTED_SCHEMA_VERSION, so the code and the schema move together', () => {
    const plan = planMigrations(readdirSync(MIGRATIONS_DIR), []);
    const last = parseMigrationFilename(plan.pending.at(-1)!)!.version;
    expect(last).toBe(EXPECTED_SCHEMA_VERSION);
  });
});
```

Create `packages/agents/src/__tests__/db.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createPool } from '../db.js';

// No connection is opened here: pg connects lazily, on the first query.
const URL = 'postgres://user:pw@127.0.0.1:1/none';

describe('createPool', () => {
  it('survives an idle-client error instead of crashing the process', async () => {
    const onError = vi.fn();
    const pool = createPool({ connectionString: URL, onError });
    expect(pool.listenerCount('error')).toBe(1);
    // With no listener, emitting 'error' on an EventEmitter throws.
    expect(() => pool.emit('error', new Error('server closed the connection'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'server closed the connection' }),
    );
    await pool.end();
  });

  it('logs by default when no handler is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = createPool({ connectionString: URL });
    pool.emit('error', new Error('boom'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    spy.mockRestore();
    await pool.end();
  });

  it('applies the pool size and search path it is given', async () => {
    const pool = createPool({ connectionString: URL, max: 3, searchPath: 'itest_abc' });
    expect(pool.options.max).toBe(3);
    expect(pool.options.options).toBe('-c search_path=itest_abc');
    await pool.end();
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/migrate.test.ts src/__tests__/db.test.ts`
Expected: FAIL — both files fail to import (`../migrate.js`, `../schema-version.js`, `../db.js` do not exist).

- [ ] **Step 5: Implement the database helper, the version constant and the runner**

Create `packages/agents/src/schema-version.ts`:

```ts
// The highest migration prefix this build of the code was written against.
// api-server (and later the runner) compare it with max(version) in
// schema_migrations at boot and switch agent features off, without crashing,
// when the database is behind. Bump it in the same change that adds a file to
// db/migrations/.
export const EXPECTED_SCHEMA_VERSION = '0001';
```

Create `packages/agents/src/db.ts`:

```ts
import { Pool, type PoolConfig } from 'pg';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface SqlClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>>;
}

export interface Db extends SqlClient {
  /** Runs `fn` in one transaction on one connection. Rolls back if `fn` throws. */
  tx<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
  /** Runs `fn` on one dedicated connection, without opening a transaction. */
  withClient<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  /** Sets `search_path` for every connection. Used by tests to isolate a schema. */
  searchPath?: string;
  onError?: (err: Error) => void;
}

export function createPool(opts: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  if (opts.searchPath) config.options = `-c search_path=${opts.searchPath}`;
  const pool = new Pool(config);
  // An idle client that errors (server restart, network drop) emits 'error' on
  // the pool. With no listener Node treats it as an uncaught exception and the
  // process dies: the BullMQ error-listener scar in another costume.
  pool.on(
    'error',
    opts.onError ?? ((err) => console.error(`[agents] postgres pool error: ${err.message}`)),
  );
  return pool;
}

// The slice of pg's Pool and PoolClient this module uses. Both satisfy it.
interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

function wrap(target: PgQueryable): SqlClient {
  return {
    async query<R extends object>(text: string, params?: ReadonlyArray<unknown>) {
      const result = await target.query(text, params ? [...params] : undefined);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
  };
}

export function createDb(pool: Pool): Db {
  const root = wrap(pool);
  return {
    query: (text, params) => root.query(text, params),
    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(wrap(client));
      } finally {
        client.release();
      }
    },
    async tx(fn) {
      const client = await pool.connect();
      const scoped = wrap(client);
      try {
        await scoped.query('BEGIN');
        const value = await fn(scoped);
        await scoped.query('COMMIT');
        return value;
      } catch (err) {
        await scoped.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
```

Create `packages/agents/src/migrate.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';

// Contract shared with the infra repo's deploy-time migration step (see
// docs/agent/briefs/infra-postgres-and-vertex-for-agents.md): files are named
// NNNN_description.sql, applied in order, each in its own transaction, and
// recorded in schema_migrations by their four-digit prefix.
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

// Arbitrary constant; every migrator takes this advisory lock so two of them
// cannot interleave.
export const MIGRATION_LOCK_KEY = 4815162342;

export class MigrationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationPlanError';
  }
}

export function parseMigrationFilename(
  filename: string,
): { version: string; description: string } | null {
  const match = FILE_PATTERN.exec(filename);
  return match ? { version: match[1]!, description: match[2]! } : null;
}

export interface MigrationPlan {
  /** Filenames to apply, in order. */
  pending: string[];
  /** Versions recorded in the database that have no file here (an older checkout). */
  unknownApplied: string[];
}

export function planMigrations(
  filenames: ReadonlyArray<string>,
  applied: ReadonlyArray<string>,
): MigrationPlan {
  const byVersion = new Map<string, string>();
  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue; // README.md and friends are not migrations
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new MigrationPlanError(
        `"${filename}" is not a valid migration name (expected NNNN_description.sql, lower-case)`,
      );
    }
    const clash = byVersion.get(parsed.version);
    if (clash) {
      throw new MigrationPlanError(
        `Two migrations share version ${parsed.version}: "${clash}" and "${filename}"`,
      );
    }
    byVersion.set(parsed.version, filename);
  }

  const appliedSet = new Set(applied);
  const highestApplied = applied.reduce((max, v) => (v > max ? v : max), '');
  const pending: string[] = [];
  for (const version of [...byVersion.keys()].sort()) {
    if (appliedSet.has(version)) continue;
    if (version < highestApplied) {
      throw new MigrationPlanError(
        `Migration ${byVersion.get(version)} is older than the newest applied version ` +
          `${highestApplied}. Migrations are forward-only; give it a higher number.`,
      );
    }
    pending.push(byVersion.get(version)!);
  }

  return {
    pending,
    unknownApplied: applied.filter((v) => !byVersion.has(v)).sort(),
  };
}

/** Lists the directory, or returns [] when it does not exist yet. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface RunMigrationsOptions {
  db: Db;
  dir: string;
  log?: (line: string) => void;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = opts.log ?? (() => undefined);
  const filenames = await listMigrationFiles(opts.dir);

  return opts.db.withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      const alreadyApplied = rows.map((r) => r.version);
      const plan = planMigrations(filenames, alreadyApplied);
      if (plan.unknownApplied.length > 0) {
        log(`note: the database has versions with no file here: ${plan.unknownApplied.join(', ')}`);
      }

      const applied: string[] = [];
      for (const filename of plan.pending) {
        const sql = await readFile(join(opts.dir, filename), 'utf8');
        const { version } = parseMigrationFilename(filename)!;
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
        }
        applied.push(filename);
        log(`applied ${filename}`);
      }
      return { applied, alreadyApplied };
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  });
}
```

Create `packages/agents/src/migrate-cli.ts`:

```ts
// CLI entry for applying db/migrations. Used by `pnpm db:migrate` locally and
// in CI, and by the docker-compose `migrate` service. On GKE the infra repo's
// deploy step applies the same files under the same contract instead.
import { resolve } from 'node:path';
import { createDb, createPool } from './db.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('db:migrate needs DATABASE_URL (or DATABASE_MIGRATOR_URL) to be set.');
    process.exitCode = 2;
    return;
  }
  const dir = resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');
  const pool = createPool({ connectionString, max: 1 });
  try {
    const result = await runMigrations({
      db: createDb(pool),
      dir,
      log: (line) => console.log(line),
    });
    console.log(
      result.applied.length === 0
        ? `Nothing to apply (${result.alreadyApplied.length} already applied) from ${dir}.`
        : `Applied ${result.applied.length} migration(s) from ${dir}.`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
```

Create `packages/agents/src/index.ts` (later tasks append to it):

```ts
export { createDb, createPool } from './db.js';
export type { CreatePoolOptions, Db, QueryResult, SqlClient } from './db.js';
export {
  MIGRATION_LOCK_KEY,
  MigrationPlanError,
  listMigrationFiles,
  parseMigrationFilename,
  planMigrations,
  runMigrations,
} from './migrate.js';
export type { MigrationPlan, RunMigrationsOptions, RunMigrationsResult } from './migrate.js';
export { EXPECTED_SCHEMA_VERSION } from './schema-version.js';
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/migrate.test.ts src/__tests__/db.test.ts`
Expected: PASS — 2 files, 19 tests.

- [ ] **Step 7: Add the Postgres test harness and the integration suite**

Create `packages/agents/src/__tests__/test-db.ts`:

```ts
// Shared harness for the Postgres-backed suites. Each call creates a private
// schema and a pool whose search_path points at it, so suites cannot see each
// other's tables. The suites still run with --no-file-parallelism (see the scar
// integration-tests-sharing-a-db-must-run-serially): migrations take one
// database-wide advisory lock.
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, type Db } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Set in CI and when Postgres is running locally. Unset: the suites skip. */
export const DATABASE_TEST_URL: string | undefined = process.env.DATABASE_TEST_URL;

/** <repo root>/db/migrations */
export const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

export interface TestDatabase {
  db: Db;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!DATABASE_TEST_URL) throw new Error('DATABASE_TEST_URL is not set');
  const schema = `itest_${randomBytes(6).toString('hex')}`;

  const admin = createPool({ connectionString: DATABASE_TEST_URL, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = createPool({ connectionString: DATABASE_TEST_URL, max: 4, searchPath: schema });
  return {
    db: createDb(pool),
    async drop() {
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}
```

Create `packages/agents/src/__tests__/migrate.integration.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../migrate.js';
import { EXPECTED_SCHEMA_VERSION } from '../schema-version.js';
import {
  createTestDatabase,
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  type TestDatabase,
} from './test-db.js';

describe.skipIf(!DATABASE_TEST_URL)('runMigrations — Postgres integration', () => {
  let database: TestDatabase | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await database?.drop();
    database = undefined;
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempMigrations(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'shipit-migrations-'));
    tempDirs.push(dir);
    await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql)));
    return dir;
  }

  const appliedVersions = async (db: TestDatabase['db']) =>
    (
      await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
    ).rows.map((r) => r.version);

  it('applies the real db/migrations to an empty database, then nothing on a second run', async () => {
    database = await createTestDatabase();
    const first = await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.alreadyApplied).toEqual([]);
    expect((await appliedVersions(database.db)).at(-1)).toBe(EXPECTED_SCHEMA_VERSION);

    const second = await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(await appliedVersions(database.db));
  });

  it('treats a missing directory as nothing to apply', async () => {
    database = await createTestDatabase();
    const result = await runMigrations({
      db: database.db,
      dir: join(tmpdir(), 'shipit-no-such-dir'),
    });
    expect(result).toEqual({ applied: [], alreadyApplied: [] });
    expect(await appliedVersions(database.db)).toEqual([]);
  });

  it('rolls a failing file back completely and stops there', async () => {
    database = await createTestDatabase();
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE first_table (id integer PRIMARY KEY);',
      '0002_bad.sql': 'CREATE TABLE second_table (id integer PRIMARY KEY); SELECT 1 / 0;',
      '0003_never.sql': 'CREATE TABLE third_table (id integer PRIMARY KEY);',
    });

    await expect(runMigrations({ db: database.db, dir })).rejects.toThrow(/0002_bad\.sql failed/);

    expect(await appliedVersions(database.db)).toEqual(['0001']);
    const tables = await database.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name LIKE '%\\_table' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['first_table']);
  });

  it('picks up where a failed run left off once the file is fixed', async () => {
    database = await createTestDatabase();
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE first_table (id integer PRIMARY KEY);',
      '0002_bad.sql': 'SELECT 1 / 0;',
    });
    await expect(runMigrations({ db: database.db, dir })).rejects.toThrow();
    await writeFile(
      join(dir, '0002_bad.sql'),
      'CREATE TABLE second_table (id integer PRIMARY KEY);',
    );

    const retry = await runMigrations({ db: database.db, dir });
    expect(retry.applied).toEqual(['0002_bad.sql']);
    expect(retry.alreadyApplied).toEqual(['0001']);
  });

  it('applies each file once when two migrators start together', async () => {
    database = await createTestDatabase();
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE first_table (id integer PRIMARY KEY);',
      '0002_ok.sql': 'CREATE TABLE second_table (id integer PRIMARY KEY);',
    });
    // Without the advisory lock both would try CREATE TABLE and one would fail.
    const [a, b] = await Promise.all([
      runMigrations({ db: database.db, dir }),
      runMigrations({ db: database.db, dir }),
    ]);
    expect([...a.applied, ...b.applied].sort()).toEqual(['0001_ok.sql', '0002_ok.sql']);
    expect(await appliedVersions(database.db)).toEqual(['0001', '0002']);
  });

  it('logs each applied file', async () => {
    database = await createTestDatabase();
    const lines: string[] = [];
    const dir = await tempMigrations({ '0001_ok.sql': 'CREATE TABLE first_table (id integer);' });
    await runMigrations({ db: database.db, dir, log: (l) => lines.push(l) });
    expect(lines).toEqual(['applied 0001_ok.sql']);
  });
});
```

- [ ] **Step 8: Check the CLI and the whole package**

```bash
pnpm --filter @shipit-ai/agents typecheck
pnpm --filter @shipit-ai/agents test
env -u DATABASE_URL pnpm --silent db:migrate; echo "exit=$?"
```

Expected: typecheck clean; `2 passed | 1 skipped` files and `19 passed | 6 skipped` tests (the integration suite skips without `DATABASE_TEST_URL`; Task 2 runs it); then:

```
db:migrate needs DATABASE_URL (or DATABASE_MIGRATOR_URL) to be set.
exit=2
```

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/agents db package.json vitest.config.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add db packages/agents package.json vitest.config.ts pnpm-lock.yaml
git commit -m "agents: new package with the first migration and a plain-SQL migration runner"
```

---

## Task 2: Postgres for local development and CI

**Files:**

- Modify: `docker/docker-compose.yml`
- Modify: `scripts/infra.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `shipit.config.local.example.yaml`

**Interfaces:**

- Consumes: `pnpm db:migrate` and the integration suite from Task 1.
- Produces: a `postgres` compose service on `localhost:5432` (user `shipit`, password `shipit-dev`, database `shipit`); `DATABASE_TEST_URL` in the CI `integration` job.

This task has no unit test of its own. Its test is the Task 1 integration suite passing against a real Postgres for the first time.

- [ ] **Step 1: Add the compose service**

`docker/docker-compose.yml` gains a `postgres` service and its volume:

```diff
--- a/docker/docker-compose.yml
+++ b/docker/docker-compose.yml
@@ -31,6 +31,24 @@ services:
       timeout: 5s
       retries: 5

+  # Postgres holds agent definitions and (later) run history. Optional for the
+  # rest of the product: without it the AI pages show setup guidance.
+  postgres:
+    image: postgres:17-alpine
+    ports:
+      - '5432:5432'
+    environment:
+      POSTGRES_USER: shipit
+      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-shipit-dev}
+      POSTGRES_DB: shipit
+    volumes:
+      - postgres_data:/var/lib/postgresql/data
+    healthcheck:
+      test: ['CMD-SHELL', 'pg_isready -U shipit -d shipit']
+      interval: 5s
+      timeout: 5s
+      retries: 10
+
   # Each backend service reads shipit.config.yaml mounted into /app. Only the
   # env vars referenced from the YAML's ${VAR} placeholders are passed in —
   # everything else lives in the committed config file. NEO4J_URI / REDIS_URL
@@ -108,3 +126,4 @@ volumes:
   neo4j_data:
   neo4j_logs:
   redis_data:
+  postgres_data:
```

- [ ] **Step 2: Start it, and apply migrations, from the infra script**

`scripts/infra.sh`:

```diff
--- a/scripts/infra.sh
+++ b/scripts/infra.sh
@@ -3,8 +3,8 @@ set -euo pipefail

 ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

-echo "Starting Neo4j and Redis..."
-docker compose -f "$ROOT_DIR/docker/docker-compose.yml" up -d neo4j redis
+echo "Starting Neo4j, Redis and Postgres..."
+docker compose -f "$ROOT_DIR/docker/docker-compose.yml" up -d neo4j redis postgres

 echo "Waiting for services to be healthy..."

@@ -15,15 +15,22 @@ INTERVAL=5
 while (( ELAPSED < MAX_WAIT )); do
   NEO4J_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose -f "$ROOT_DIR/docker/docker-compose.yml" ps -q neo4j)" 2>/dev/null || echo "waiting")
   REDIS_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose -f "$ROOT_DIR/docker/docker-compose.yml" ps -q redis)" 2>/dev/null || echo "waiting")
+  POSTGRES_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose -f "$ROOT_DIR/docker/docker-compose.yml" ps -q postgres)" 2>/dev/null || echo "waiting")

-  if [[ "$NEO4J_HEALTH" == "healthy" && "$REDIS_HEALTH" == "healthy" ]]; then
+  if [[ "$NEO4J_HEALTH" == "healthy" && "$REDIS_HEALTH" == "healthy" && "$POSTGRES_HEALTH" == "healthy" ]]; then
     echo "Neo4j: healthy"
     echo "Redis: healthy"
+    echo "Postgres: healthy"
+    # Schema changes are applied here in local dev (and by the infra repo's
+    # deploy step on GKE), never by the app at boot. Safe to re-run: applied
+    # files are skipped.
+    echo "Applying database migrations..."
+    (cd "$ROOT_DIR" && DATABASE_URL="${DATABASE_URL:-postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@localhost:5432/shipit}" pnpm --silent db:migrate)
     echo "Infrastructure ready!"
     exit 0
   fi

-  echo "  neo4j=$NEO4J_HEALTH  redis=$REDIS_HEALTH  (${ELAPSED}s/${MAX_WAIT}s)"
+  echo "  neo4j=$NEO4J_HEALTH  redis=$REDIS_HEALTH  postgres=$POSTGRES_HEALTH  (${ELAPSED}s/${MAX_WAIT}s)"
   sleep "$INTERVAL"
   ELAPSED=$(( ELAPSED + INTERVAL ))
 done
```

- [ ] **Step 3: Give new checkouts a database URL**

`shipit.config.local.example.yaml`:

```diff
--- a/shipit.config.local.example.yaml
+++ b/shipit.config.local.example.yaml
@@ -19,6 +19,12 @@ backend:
     # Required for the same reason as neo4j.uri.
     url: redis://localhost:6379

+ai:
+  database:
+    # Matches the postgres service in docker/docker-compose.yml. Remove this
+    # block to run without agent features.
+    url: postgres://shipit:shipit-dev@localhost:5432/shipit
+
 connectors:
   github:
     app:
```

The `ai` config section does not exist until Task 5; until then the loader ignores this block. Existing checkouts keep their own `shipit.config.local.yaml`; Task 8 documents adding the block by hand.

- [ ] **Step 4: Add Postgres to the CI integration job**

`.github/workflows/ci.yml`:

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -87,7 +87,7 @@ jobs:
       - run: pnpm turbo test --force

   integration:
-    name: Integration (Neo4j)
+    name: Integration (Neo4j, Redis, Postgres)
     runs-on: ubuntu-latest
     # Neo4j-backed tests that exercise real Cypher (the core-writer freshness
     # guard's atomic compare-and-set + lossless-Integer round-trip) — behaviour
@@ -119,11 +119,25 @@ jobs:
           --health-interval 5s
           --health-timeout 5s
           --health-retries 10
+      postgres:
+        image: postgres:17-alpine
+        env:
+          POSTGRES_USER: shipit
+          POSTGRES_PASSWORD: testpassword
+          POSTGRES_DB: shipit_test
+        ports:
+          - 5432:5432
+        options: >-
+          --health-cmd "pg_isready -U shipit -d shipit_test"
+          --health-interval 5s
+          --health-timeout 5s
+          --health-retries 10
     env:
       NEO4J_TEST_URI: bolt://localhost:7687
       NEO4J_TEST_USER: neo4j
       NEO4J_TEST_PASSWORD: testpassword
       REDIS_TEST_URL: redis://localhost:6379
+      DATABASE_TEST_URL: postgres://shipit:testpassword@localhost:5432/shipit_test
     steps:
       - uses: actions/checkout@v7

@@ -145,6 +159,9 @@ jobs:
       - name: api-server integration (Neo4j + APOC, Redis)
         run: pnpm --filter @shipit-ai/api-server run test:integration

+      - name: agents integration (Postgres)
+        run: pnpm --filter @shipit-ai/agents run test:integration
+
   build:
     name: Build
     runs-on: ubuntu-latest
```

- [ ] **Step 5: Run the integration suite against a real Postgres**

Docker must be running.

```bash
pnpm start:infra
```

Expected, at the end:

```
Neo4j: healthy
Redis: healthy
Postgres: healthy
Applying database migrations...
applied 0001_agents.sql
Applied 1 migration(s) from <repo>/db/migrations.
Infrastructure ready!
```

Run it a second time; the migration lines become `Nothing to apply (1 already applied) from <repo>/db/migrations.`

Then:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agents run test:integration
```

Expected: PASS — 1 file, 6 tests. This is the first run of `test-db.ts` and of the two-migrators test on a real server. If the two-migrators test fails with a `relation … already exists` error, the advisory lock in `runMigrations` is not being held across the run: check that every statement in `runMigrations` goes through the one `client` that `withClient` hands in.

Confirm the suite cleaned up after itself:

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U shipit -d shipit -c "select count(*) from information_schema.schemata where schema_name like 'itest_%'"
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write docker/docker-compose.yml .github/workflows/ci.yml shipit.config.local.example.yaml
bash -n scripts/infra.sh
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add docker/docker-compose.yml scripts/infra.sh .github/workflows/ci.yml shipit.config.local.example.yaml
git commit -m "dev: Postgres in docker-compose, the infra script and the CI integration job"
```

---

## Task 3: The agent definition schema

**Files:**

- Create: `packages/agents/src/definition.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/__tests__/definition.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `AgentDefinition` = `{ instructions: string; model: string; effort?: string; limits: AgentLimits; grants: { services: Record<string, { read: GrantPolicy; write: GrantPolicy; delete: 'off' | 'ask' }>; tools: Record<string, GrantPolicy> }; output: { schema: Record<string, unknown> | null } }`
  - `AgentLimits` = `{ maxSteps: number; maxTokens: number; timeoutSeconds: number; dailyTokens: number }`
  - `GrantPolicy` = `'off' | 'allow' | 'ask'`; `ToolEffect` = `'read' | 'write' | 'delete'`
  - `parseAgentDefinition(input: unknown): { ok: true; definition: AgentDefinition } | { ok: false; issues: DefinitionIssue[] }`
  - `checkDefinitionAgainstPolicy(definition, { modelKeys: readonly string[]; ceilings: AgentLimits }): DefinitionIssue[]`
  - `grantedServiceEffects(definition): Array<{ service: string; effect: ToolEffect }>`
  - `DefinitionIssue` = `{ path: string; code: 'INVALID' | 'UNKNOWN_MODEL' | 'LIMIT_EXCEEDS_CEILING'; message: string }`

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/__tests__/definition.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  checkDefinitionAgainstPolicy,
  grantedServiceEffects,
  parseAgentDefinition,
  type AgentDefinition,
} from '../definition.js';

const valid = {
  instructions: 'Answer questions about service ownership.',
  model: 'claude-opus',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
};

function parsed(input: unknown): AgentDefinition {
  const result = parseAgentDefinition(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

describe('parseAgentDefinition', () => {
  it('fills in empty grants and no output schema by default', () => {
    expect(parsed(valid)).toEqual({
      ...valid,
      grants: { services: {}, tools: {} },
      output: { schema: null },
    });
  });

  it('defaults unspecified effects of a service to off', () => {
    const def = parsed({ ...valid, grants: { services: { graph: { read: 'allow' } } } });
    expect(def.grants.services.graph).toEqual({ read: 'allow', write: 'off', delete: 'off' });
    expect(def.grants.tools).toEqual({});
  });

  it('never accepts allow on delete', () => {
    const result = parseAgentDefinition({
      ...valid,
      grants: { services: { graph: { delete: 'allow' } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('grants.services.graph.delete');
  });

  it('accepts ask on delete', () => {
    const def = parsed({ ...valid, grants: { services: { graph: { delete: 'ask' } } } });
    expect(def.grants.services.graph!.delete).toBe('ask');
  });

  it.each([
    ['blank instructions', { ...valid, instructions: '   ' }, 'instructions'],
    ['oversized instructions', { ...valid, instructions: 'x'.repeat(50_001) }, 'instructions'],
    ['missing model', { ...valid, model: '' }, 'model'],
    ['zero steps', { ...valid, limits: { ...valid.limits, maxSteps: 0 } }, 'limits.maxSteps'],
    [
      'fractional tokens',
      { ...valid, limits: { ...valid.limits, maxTokens: 1500.5 } },
      'limits.maxTokens',
    ],
    ['missing limits', { instructions: 'x', model: 'm' }, 'limits'],
    ['unknown top-level key', { ...valid, secret: 'x' }, ''],
    [
      'unknown policy',
      { ...valid, grants: { services: { graph: { read: 'yes' } } } },
      'grants.services.graph.read',
    ],
    [
      'bad service key',
      { ...valid, grants: { services: { 'Graph!': { read: 'allow' } } } },
      'grants.services.Graph!',
    ],
    [
      'tool id without a service',
      { ...valid, grants: { tools: { blast_radius: 'allow' } } },
      'grants.tools.blast_radius',
    ],
  ])('rejects %s', (_name, input, path) => {
    const result = parseAgentDefinition(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain(path);
  });

  it.each([null, 'text', 42, []])('rejects a non-object definition: %j', (input) => {
    expect(parseAgentDefinition(input).ok).toBe(false);
  });
});

describe('checkDefinitionAgainstPolicy', () => {
  const policy = {
    modelKeys: ['claude-opus', 'claude-sonnet'],
    ceilings: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
  };

  it('passes a definition inside every ceiling', () => {
    expect(checkDefinitionAgainstPolicy(parsed(valid), policy)).toEqual([]);
  });

  it('passes a definition exactly at the ceilings', () => {
    expect(
      checkDefinitionAgainstPolicy(parsed({ ...valid, limits: policy.ceilings }), policy),
    ).toEqual([]);
  });

  it('names the model when it is not offered', () => {
    const issues = checkDefinitionAgainstPolicy(parsed({ ...valid, model: 'gpt-x' }), policy);
    expect(issues).toEqual([expect.objectContaining({ path: 'model', code: 'UNKNOWN_MODEL' })]);
    expect(issues[0]!.message).toContain('claude-opus, claude-sonnet');
  });

  it('says so when the instance has no models at all', () => {
    const issues = checkDefinitionAgainstPolicy(parsed(valid), { ...policy, modelKeys: [] });
    expect(issues[0]!.message).toContain('no models configured');
  });

  it('reports every limit above its ceiling', () => {
    const issues = checkDefinitionAgainstPolicy(
      parsed({
        ...valid,
        limits: { maxSteps: 26, maxTokens: 400_001, timeoutSeconds: 300, dailyTokens: 1000 },
      }),
      policy,
    );
    expect(issues.map((i) => i.path)).toEqual(['limits.maxSteps', 'limits.maxTokens']);
    expect(issues.every((i) => i.code === 'LIMIT_EXCEEDS_CEILING')).toBe(true);
  });
});

describe('grantedServiceEffects', () => {
  it('lists each service and effect that is not off', () => {
    const def = parsed({
      ...valid,
      grants: {
        services: {
          graph: { read: 'allow', write: 'ask' },
          github: { read: 'off', delete: 'ask' },
        },
      },
    });
    expect(grantedServiceEffects(def)).toEqual([
      { service: 'graph', effect: 'read' },
      { service: 'graph', effect: 'write' },
      { service: 'github', effect: 'delete' },
    ]);
  });

  it('counts a tool-level grant as write on its service, once', () => {
    const def = parsed({
      ...valid,
      grants: {
        tools: { 'github.open_pull_request': 'ask', 'github.comment': 'allow', 'graph.x': 'off' },
      },
    });
    expect(grantedServiceEffects(def)).toEqual([{ service: 'github', effect: 'write' }]);
  });

  it('is empty for an agent with no grants', () => {
    expect(grantedServiceEffects(parsed(valid))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/definition.test.ts`
Expected: FAIL — cannot resolve `../definition.js`.

- [ ] **Step 3: Implement the schema**

Create `packages/agents/src/definition.ts`:

```ts
import { z } from 'zod';

// What an agent may do with a tool. `off` hides the tool from the model,
// `allow` runs it, `ask` holds it for a person.
export const GRANT_POLICIES = ['off', 'allow', 'ask'] as const;
export type GrantPolicy = (typeof GRANT_POLICIES)[number];

export const TOOL_EFFECTS = ['read', 'write', 'delete'] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

const policySchema = z.enum(GRANT_POLICIES);

// Delete can be off or ask-first, never auto-allowed (design decision 14).
const deletePolicySchema = z.enum(['off', 'ask']);

const serviceKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'service keys are lower-case letters, digits and dashes');

// '<service>.<tool>', e.g. 'graph.blast_radius' or 'agent.triage'.
const toolIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9_-]{0,62}$/,
    "tool ids look like '<service>.<tool>'",
  );

const serviceGrantsSchema = z.strictObject({
  read: policySchema.default('off'),
  write: policySchema.default('off'),
  delete: deletePolicySchema.default('off'),
});

export const agentLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1),
  maxTokens: z.number().int().min(1000),
  timeoutSeconds: z.number().int().min(10),
  dailyTokens: z.number().int().min(1000),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

export const agentDefinitionSchema = z.strictObject({
  instructions: z.string().trim().min(1, 'instructions are required').max(50_000),
  model: z.string().min(1, 'a model is required').max(64),
  effort: z.string().min(1).max(20).optional(),
  limits: agentLimitsSchema,
  grants: z
    .strictObject({
      services: z.record(serviceKeySchema, serviceGrantsSchema).default({}),
      tools: z.record(toolIdSchema, policySchema).default({}),
    })
    .default({ services: {}, tools: {} }),
  output: z
    .strictObject({
      schema: z.record(z.string(), z.unknown()).nullable().default(null),
    })
    .default({ schema: null }),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export interface DefinitionIssue {
  /** Dot path into the definition, e.g. 'limits.maxTokens'. */
  path: string;
  code: 'INVALID' | 'UNKNOWN_MODEL' | 'LIMIT_EXCEEDS_CEILING';
  message: string;
}

export type ParseDefinitionResult =
  { ok: true; definition: AgentDefinition } | { ok: false; issues: DefinitionIssue[] };

/** Shape check only. Use `checkDefinitionAgainstPolicy` for instance-specific rules. */
export function parseAgentDefinition(input: unknown): ParseDefinitionResult {
  const result = agentDefinitionSchema.safeParse(input);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: 'INVALID' as const,
      message: issue.message,
    })),
  };
}

export interface DefinitionPolicy {
  /** Keys of the models this instance offers (ai.models[].key). */
  modelKeys: ReadonlyArray<string>;
  /** Instance ceilings (ai.limits). An agent may ask for less, never more. */
  ceilings: AgentLimits;
}

export function checkDefinitionAgainstPolicy(
  definition: AgentDefinition,
  policy: DefinitionPolicy,
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  if (!policy.modelKeys.includes(definition.model)) {
    issues.push({
      path: 'model',
      code: 'UNKNOWN_MODEL',
      message:
        policy.modelKeys.length === 0
          ? `Model "${definition.model}" is not available: this instance has no models configured (ai.models).`
          : `Model "${definition.model}" is not one of: ${policy.modelKeys.join(', ')}.`,
    });
  }
  for (const key of Object.keys(policy.ceilings) as Array<keyof AgentLimits>) {
    if (definition.limits[key] > policy.ceilings[key]) {
      issues.push({
        path: `limits.${key}`,
        code: 'LIMIT_EXCEEDS_CEILING',
        message: `limits.${key} is ${definition.limits[key]}; this instance allows at most ${policy.ceilings[key]}.`,
      });
    }
  }
  return issues;
}

/**
 * The (service, effect) pairs a definition switches on. A tool-level grant is
 * reported as effect 'write', the widest effect a non-delete grant can carry:
 * the tool catalog that knows each tool's real effect lives outside this
 * package, and over-reporting can only make the save-time ceiling stricter.
 */
export function grantedServiceEffects(
  definition: AgentDefinition,
): Array<{ service: string; effect: ToolEffect }> {
  const seen = new Set<string>();
  const out: Array<{ service: string; effect: ToolEffect }> = [];
  const add = (service: string, effect: ToolEffect) => {
    const key = `${service}:${effect}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ service, effect });
  };
  for (const [service, grants] of Object.entries(definition.grants.services)) {
    for (const effect of TOOL_EFFECTS) {
      if (grants[effect] !== 'off') add(service, effect);
    }
  }
  for (const [toolId, policy] of Object.entries(definition.grants.tools)) {
    if (policy !== 'off') add(toolId.split('.')[0]!, 'write');
  }
  return out;
}
```

Append to `packages/agents/src/index.ts`:

```ts
export {
  GRANT_POLICIES,
  TOOL_EFFECTS,
  agentDefinitionSchema,
  agentLimitsSchema,
  checkDefinitionAgainstPolicy,
  grantedServiceEffects,
  parseAgentDefinition,
} from './definition.js';
export type {
  AgentDefinition,
  AgentLimits,
  DefinitionIssue,
  DefinitionPolicy,
  GrantPolicy,
  ParseDefinitionResult,
  ToolEffect,
} from './definition.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/definition.test.ts`
Expected: PASS — 26 tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/agents/src
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/agents
git commit -m "agents: definition schema, instance-policy check and granted-effects helper"
```

---

## Task 4: The agent store

**Files:**

- Create: `packages/agents/src/agent-store.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/__tests__/agent-store.integration.test.ts`

**Interfaces:**

- Consumes: `Db` (Task 1), `AgentDefinition` (Task 3), `runMigrations` and `createTestDatabase` (Task 1), a running Postgres (Task 2).
- Produces:
  - `class AgentStore { constructor(db: Db) }` with:
    - `create(input: CreateAgentInput): Promise<AgentRecord>` — throws `AgentSlugTakenError`
    - `get(id: string): Promise<AgentRecord | null>`; `getBySlug(slug: string): Promise<AgentRecord | null>`
    - `list(opts?: { includeArchived?: boolean; limit?: number; offset?: number }): Promise<{ items: AgentRecord[]; total: number }>`
    - `update(id, expectedRevision: number | undefined, patch: UpdateAgentPatch, actor: string): Promise<AgentRecord>`
    - `publish(id, expectedRevision: number | undefined, note: string, actor: string): Promise<{ agent: AgentRecord; version: AgentVersionRecord }>`
    - `archive(id, expectedRevision: number | undefined, actor: string): Promise<void>`
    - `listVersions(id): Promise<AgentVersionRecord[]>`; `getVersion(id, version): Promise<AgentVersionRecord | null>`
  - `AgentRecord` = `{ id, slug, name, description, ownerTeamId: string | null, enabled, builtin, draftDefinition: AgentDefinition, publishedVersion: number | null, revision: number, createdBy, updatedBy, createdAt: string, updatedAt: string, archivedAt: string | null }`
  - `AgentVersionRecord` = `{ agentId, version: number, definition: AgentDefinition, note, createdBy, createdAt: string }`
  - `CreateAgentInput` = `{ slug; name; description?; ownerTeamId?: string | null; definition: AgentDefinition; builtin?: boolean; actor: string }`
  - `UpdateAgentPatch` = `{ name?; description?; ownerTeamId?: string | null; enabled?: boolean; definition?: AgentDefinition }`
  - Errors: `AgentNotFoundError`, `AgentSlugTakenError`, `AgentVersionConflictError` (with `serverRevision: number`), `AgentBuiltinProtectedError`
  - `expectedRevision: undefined` forces the write; a number makes it conditional.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/__tests__/agent-store.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentStore,
  AgentVersionConflictError,
} from '../agent-store.js';
import type { AgentDefinition } from '../definition.js';
import { runMigrations } from '../migrate.js';
import {
  createTestDatabase,
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  type TestDatabase,
} from './test-db.js';

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'claude-opus',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

describe.skipIf(!DATABASE_TEST_URL)('AgentStore — Postgres integration', () => {
  let database: TestDatabase;
  let store: AgentStore;

  beforeAll(async () => {
    database = await createTestDatabase();
    await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    store = new AgentStore(database.db);
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.query('DELETE FROM agents');
  });

  const make = (slug: string, extra: Partial<Parameters<AgentStore['create']>[0]> = {}) =>
    store.create({ slug, name: `Agent ${slug}`, definition, actor: 'admin@example.com', ...extra });

  it('creates an agent at revision 1 and reads it back unchanged', async () => {
    const created = await make('owners');
    expect(created).toMatchObject({
      slug: 'owners',
      name: 'Agent owners',
      description: '',
      ownerTeamId: null,
      enabled: true,
      builtin: false,
      draftDefinition: definition,
      publishedVersion: null,
      revision: 1,
      createdBy: 'admin@example.com',
      updatedBy: 'admin@example.com',
      archivedAt: null,
    });
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(await store.get(created.id)).toEqual(created);
    expect(await store.getBySlug('owners')).toEqual(created);
  });

  it('returns null, not an error, for an id that is not a UUID or does not exist', async () => {
    expect(await store.get('not-a-uuid')).toBeNull();
    expect(await store.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('refuses a second live agent with the same slug', async () => {
    await make('owners');
    await expect(make('owners')).rejects.toBeInstanceOf(AgentSlugTakenError);
  });

  it('frees the slug when the agent is archived', async () => {
    const first = await make('owners');
    await store.archive(first.id, first.revision, 'admin@example.com');
    const second = await make('owners');
    expect(second.id).not.toBe(first.id);
    expect(await store.getBySlug('owners')).toMatchObject({ id: second.id });
  });

  it('updates only the fields in the patch and bumps the revision', async () => {
    const created = await make('owners', { ownerTeamId: 'team:platform' });
    const updated = await store.update(
      created.id,
      created.revision,
      { name: 'Ownership helper', ownerTeamId: null, enabled: false },
      'other@example.com',
    );
    expect(updated).toMatchObject({
      name: 'Ownership helper',
      description: '',
      ownerTeamId: null,
      enabled: false,
      draftDefinition: definition,
      revision: 2,
      createdBy: 'admin@example.com',
      updatedBy: 'other@example.com',
    });
  });

  it('rejects a stale revision and leaves the row untouched', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'First writer' }, 'a@example.com');

    const stale = store.update(created.id, 1, { name: 'Second writer' }, 'b@example.com');
    await expect(stale).rejects.toBeInstanceOf(AgentVersionConflictError);
    await expect(stale).rejects.toMatchObject({ serverRevision: 2 });
    expect(await store.get(created.id)).toMatchObject({ name: 'First writer', revision: 2 });
  });

  it('lets exactly one of two writers holding the same revision win', async () => {
    const created = await make('owners');
    const results = await Promise.allSettled([
      store.update(created.id, 1, { name: 'A' }, 'a@example.com'),
      store.update(created.id, 1, { name: 'B' }, 'b@example.com'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await store.get(created.id))!.revision).toBe(2);
  });

  it('forces the write when no revision is given', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'First' }, 'a@example.com');
    const forced = await store.update(created.id, undefined, { name: 'Forced' }, 'b@example.com');
    expect(forced).toMatchObject({ name: 'Forced', revision: 3 });
  });

  it('publishes the draft as immutable, numbered versions', async () => {
    const created = await make('owners');
    const first = await store.publish(created.id, 1, 'first cut', 'admin@example.com');
    expect(first.version).toMatchObject({ version: 1, definition, note: 'first cut' });
    expect(first.agent).toMatchObject({ publishedVersion: 1, revision: 2 });

    const edited: AgentDefinition = { ...definition, instructions: 'Changed.' };
    const afterEdit = await store.update(
      created.id,
      2,
      { definition: edited },
      'admin@example.com',
    );
    const second = await store.publish(created.id, afterEdit.revision, '', 'admin@example.com');
    expect(second.version).toMatchObject({ version: 2, definition: edited });

    expect((await store.getVersion(created.id, 1))!.definition).toEqual(definition);
    expect((await store.listVersions(created.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('does not create a version when publish is given a stale revision', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'Moved on' }, 'a@example.com');
    await expect(store.publish(created.id, 1, '', 'b@example.com')).rejects.toBeInstanceOf(
      AgentVersionConflictError,
    );
    expect(await store.listVersions(created.id)).toEqual([]);
    expect((await store.get(created.id))!.publishedVersion).toBeNull();
  });

  it('hides archived agents from the default list and refuses further edits', async () => {
    const keep = await make('keep');
    const gone = await make('gone');
    await store.archive(gone.id, undefined, 'admin@example.com');

    const live = await store.list();
    expect(live.total).toBe(1);
    expect(live.items.map((a) => a.id)).toEqual([keep.id]);

    const all = await store.list({ includeArchived: true });
    expect(all.total).toBe(2);
    expect((await store.get(gone.id))!.archivedAt).not.toBeNull();
    expect((await store.get(gone.id))!.enabled).toBe(false);

    await expect(store.update(gone.id, undefined, { name: 'x' }, 'a')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    await expect(store.archive(gone.id, undefined, 'a')).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(store.publish(gone.id, undefined, '', 'a')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it('never archives a built-in agent', async () => {
    const builtin = await make('graph-assistant', { builtin: true });
    await expect(store.archive(builtin.id, undefined, 'admin@example.com')).rejects.toBeInstanceOf(
      AgentBuiltinProtectedError,
    );
    expect((await store.get(builtin.id))!.archivedAt).toBeNull();
  });

  it('rejects a stale revision on archive', async () => {
    const created = await make('owners');
    await store.update(created.id, 1, { name: 'x' }, 'a@example.com');
    await expect(store.archive(created.id, 1, 'b@example.com')).rejects.toBeInstanceOf(
      AgentVersionConflictError,
    );
  });

  it('pages the list and reports the full total', async () => {
    for (const slug of ['a1', 'a2', 'a3']) await make(slug);
    const page = await store.list({ limit: 2, offset: 0 });
    const rest = await store.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(rest.items).toHaveLength(1);
    const slugs = [...page.items, ...rest.items].map((a) => a.slug).sort();
    expect(slugs).toEqual(['a1', 'a2', 'a3']);
  });

  it('clamps a silly page size instead of failing', async () => {
    await make('a1');
    expect((await store.list({ limit: 0, offset: -5 })).items).toHaveLength(1);
    expect((await store.list({ limit: 10_000 })).items).toHaveLength(1);
  });

  it('removes versions with the agent row (foreign key cascade)', async () => {
    const created = await make('owners');
    await store.publish(created.id, 1, '', 'admin@example.com');
    await database.db.query('DELETE FROM agents WHERE id = $1', [created.id]);
    expect(await store.listVersions(created.id)).toEqual([]);
  });

  it('lets the database refuse a slug the API should have caught', async () => {
    await expect(make('Not A Slug')).rejects.toThrow(/agents_slug_format/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/agent-store.integration.test.ts
```

Expected: FAIL — cannot resolve `../agent-store.js`.

- [ ] **Step 3: Implement the store**

Create `packages/agents/src/agent-store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { AgentDefinition } from './definition.js';

export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerTeamId: string | null;
  enabled: boolean;
  builtin: boolean;
  draftDefinition: AgentDefinition;
  publishedVersion: number | null;
  /** Increments on every write. The API uses it as the ETag. */
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AgentVersionRecord {
  agentId: string;
  version: number;
  definition: AgentDefinition;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  ownerTeamId?: string | null;
  definition: AgentDefinition;
  builtin?: boolean;
  actor: string;
}

export interface UpdateAgentPatch {
  name?: string;
  description?: string;
  ownerTeamId?: string | null;
  enabled?: boolean;
  definition?: AgentDefinition;
}

export interface ListAgentsOptions {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export class AgentNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Agent ${id} not found`);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentSlugTakenError extends Error {
  readonly code = 'SLUG_TAKEN';
  constructor(slug: string) {
    super(`An agent with the slug "${slug}" already exists`);
    this.name = 'AgentSlugTakenError';
  }
}

export class AgentVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT';
  constructor(
    id: string,
    readonly serverRevision: number,
  ) {
    super(`Agent ${id} was changed by someone else (now at revision ${serverRevision})`);
    this.name = 'AgentVersionConflictError';
  }
}

export class AgentBuiltinProtectedError extends Error {
  readonly code = 'BUILTIN_PROTECTED';
  constructor(id: string) {
    super(`Agent ${id} is built in and cannot be archived`);
    this.name = 'AgentBuiltinProtectedError';
  }
}

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_team_id: string | null;
  enabled: boolean;
  builtin: boolean;
  draft_definition: AgentDefinition;
  published_version: number | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface VersionRow {
  agent_id: string;
  version: number;
  definition: AgentDefinition;
  note: string;
  created_by: string;
  created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 200;

const iso = (value: Date | string): string => new Date(value).toISOString();

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerTeamId: row.owner_team_id,
    enabled: row.enabled,
    builtin: row.builtin,
    draftDefinition: row.draft_definition,
    publishedVersion: row.published_version,
    revision: row.revision,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
  };
}

function toVersion(row: VersionRow): AgentVersionRecord {
  return {
    agentId: row.agent_id,
    version: row.version,
    definition: row.definition,
    note: row.note,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  return e?.code === '23505' && (e.constraint === constraint || !!e.message?.includes(constraint));
}

/**
 * Postgres-backed store for agent definitions. Every mutation bumps `revision`;
 * passing `expectedRevision` makes the write conditional on it (optimistic
 * concurrency), and `undefined` forces the write, matching the If-Match rule
 * used by the other editable resources.
 */
export class AgentStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    try {
      const { rows } = await this.db.query<AgentRow>(
        `INSERT INTO agents
           (id, slug, name, description, owner_team_id, builtin, draft_definition, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
         RETURNING *`,
        [
          randomUUID(),
          input.slug,
          input.name,
          input.description ?? '',
          input.ownerTeamId ?? null,
          input.builtin ?? false,
          JSON.stringify(input.definition),
          input.actor,
        ],
      );
      return toRecord(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, 'agents_slug_live_key')) throw new AgentSlugTakenError(input.slug);
      throw err;
    }
  }

  async get(id: string): Promise<AgentRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<AgentRow>('SELECT * FROM agents WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<AgentRecord | null> {
    const { rows } = await this.db.query<AgentRow>(
      'SELECT * FROM agents WHERE slug = $1 AND archived_at IS NULL',
      [slug],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(opts: ListAgentsOptions = {}): Promise<{ items: AgentRecord[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(opts.offset ?? 0, 0);
    const includeArchived = opts.includeArchived ?? false;
    const [page, count] = await Promise.all([
      this.db.query<AgentRow>(
        `SELECT * FROM agents
          WHERE ($1::boolean OR archived_at IS NULL)
          ORDER BY updated_at DESC, id
          LIMIT $2 OFFSET $3`,
        [includeArchived, limit, offset],
      ),
      this.db.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM agents WHERE ($1::boolean OR archived_at IS NULL)',
        [includeArchived],
      ),
    ]);
    return { items: page.rows.map(toRecord), total: Number(count.rows[0]!.total) };
  }

  async update(
    id: string,
    expectedRevision: number | undefined,
    patch: UpdateAgentPatch,
    actor: string,
  ): Promise<AgentRecord> {
    if (!UUID.test(id)) throw new AgentNotFoundError(id);
    const params: unknown[] = [id];
    const sets: string[] = [];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.ownerTeamId !== undefined) set('owner_team_id', patch.ownerTeamId);
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.definition !== undefined) {
      set('draft_definition', JSON.stringify(patch.definition), '::jsonb');
    }
    set('updated_by', actor);
    params.push(expectedRevision ?? null);
    const rev = `$${params.length}::integer`;

    const { rows } = await this.db.query<AgentRow>(
      `UPDATE agents
          SET ${sets.join(', ')}, revision = revision + 1, updated_at = now()
        WHERE id = $1 AND archived_at IS NULL AND (${rev} IS NULL OR revision = ${rev})
        RETURNING *`,
      params,
    );
    if (rows[0]) return toRecord(rows[0]);
    throw await this.explainMiss(id, false);
  }

  /** Freezes the current draft as the next immutable version and marks it published. */
  async publish(
    id: string,
    expectedRevision: number | undefined,
    note: string,
    actor: string,
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord }> {
    if (!UUID.test(id)) throw new AgentNotFoundError(id);
    return this.db.tx(async (client) => {
      const current = await client.query<AgentRow>(
        'SELECT * FROM agents WHERE id = $1 AND archived_at IS NULL FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw new AgentNotFoundError(id);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) {
        throw new AgentVersionConflictError(id, row.revision);
      }
      const next = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_versions WHERE agent_id = $1',
        [id],
      );
      const version = Number(next.rows[0]!.next);
      const inserted = await client.query<VersionRow>(
        `INSERT INTO agent_versions (agent_id, version, definition, note, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING *`,
        [id, version, JSON.stringify(row.draft_definition), note, actor],
      );
      const updated = await client.query<AgentRow>(
        `UPDATE agents
            SET published_version = $2, revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, version, actor],
      );
      return { agent: toRecord(updated.rows[0]!), version: toVersion(inserted.rows[0]!) };
    });
  }

  /** Soft-deletes. The slug becomes free for a new agent; versions and history stay. */
  async archive(id: string, expectedRevision: number | undefined, actor: string): Promise<void> {
    if (!UUID.test(id)) throw new AgentNotFoundError(id);
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE agents
          SET archived_at = now(), enabled = false, revision = revision + 1,
              updated_by = $2, updated_at = now()
        WHERE id = $1 AND archived_at IS NULL AND builtin = false
          AND ($3::integer IS NULL OR revision = $3::integer)
        RETURNING id`,
      [id, actor, expectedRevision ?? null],
    );
    if (rows[0]) return;
    throw await this.explainMiss(id, true);
  }

  async listVersions(id: string): Promise<AgentVersionRecord[]> {
    if (!UUID.test(id)) return [];
    const { rows } = await this.db.query<VersionRow>(
      'SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC',
      [id],
    );
    return rows.map(toVersion);
  }

  async getVersion(id: string, version: number): Promise<AgentVersionRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<VersionRow>(
      'SELECT * FROM agent_versions WHERE agent_id = $1 AND version = $2',
      [id, version],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  // A conditional write matched no row. Work out why, so the caller can tell
  // "gone" from "protected" from "someone else got there first".
  private async explainMiss(id: string, archiving: boolean): Promise<Error> {
    const { rows } = await this.db.query<{
      revision: number;
      builtin: boolean;
      archived_at: Date | null;
    }>('SELECT revision, builtin, archived_at FROM agents WHERE id = $1', [id]);
    const row = rows[0];
    if (!row || row.archived_at) return new AgentNotFoundError(id);
    if (archiving && row.builtin) return new AgentBuiltinProtectedError(id);
    return new AgentVersionConflictError(id, row.revision);
  }
}
```

Append to `packages/agents/src/index.ts`:

```ts
export {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentStore,
  AgentVersionConflictError,
} from './agent-store.js';
export type {
  AgentRecord,
  AgentVersionRecord,
  CreateAgentInput,
  ListAgentsOptions,
  UpdateAgentPatch,
} from './agent-store.js';
```

- [ ] **Step 4: Run the integration suites to verify they pass**

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agents run test:integration
```

Expected: PASS — 2 files, 23 tests. On a real server the `lets exactly one of two writers … win` test runs the two updates on separate connections: the second waits on the row lock, re-checks `revision = 1`, matches nothing, and is reported as a conflict.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/agents/src
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/agents
git commit -m "agents: Postgres-backed agent store with revisions, publishing and archiving"
```

---

## Task 5: The `ai` config section

**Files:**

- Modify: `packages/shared/src/config/schema.ts`
- Modify: `packages/shared/src/config/index.ts`, `packages/shared/src/index.ts`
- Modify: `shipit.config.yaml`
- Modify: `packages/api-server/src/__tests__/test-config.ts`
- Test: `packages/shared/src/__tests__/ai-config-schema.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `Config['ai']` = `AiConfig` = `{ enabled: boolean; database: { url: string }; vertex: { project: string; location: string }; models: AiModelConfig[]; defaultModel: string; limits: { maxSteps: number; maxTokens: number; timeoutSeconds: number; dailyTokens: number } }`
  - `AiModelConfig` = `{ key: string; label: string; family: 'anthropic' | 'gemini' | 'maas'; modelId: string; contextWindow: number; tools: boolean }`
  - Types `AiConfig` and `AiModelConfig` exported from `@shipit-ai/shared`.
  - `makeTestConfig().ai` has models `claude-opus` and `gemini`, project `test-project`, and the default ceilings.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/ai-config-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../config/schema.js';

// Minimal fixture: Zod won't parse a partial without the required tree.
const baseConfig = {
  backend: {
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'pw' },
    redis: { url: 'redis://localhost:6379' },
    api: { port: 3001 },
    schema: { path: './shipit-schema.yaml' },
    cypherQuery: { timeoutMs: 5000, rowLimit: 1000 },
    reconciliation: { threshold: 0.85 },
    mcp: {
      apiKeySecret: null,
      rateLimits: { graphQueryPerDay: 100, rowLimit: 1000, hopLimit: 6, queryTimeoutMs: 10000 },
    },
  },
  frontend: {
    api: { url: 'http://localhost:3001' },
    integrations: {
      pagerduty: { subdomain: null },
      datadog: { site: null },
      github: { org: null },
      slack: { workspace: null, channelPrefix: 'team-' },
      kubernetes: { consoleUrlTemplate: null },
    },
  },
};

const model = (key: string) => ({
  key,
  label: key,
  family: 'anthropic',
  modelId: `${key}-id`,
  contextWindow: 1000,
});

function parse(ai?: unknown) {
  return configSchema.safeParse(ai === undefined ? baseConfig : { ...baseConfig, ai });
}

describe('ai config section', () => {
  it('defaults to enabled, with no database, no models and the standard ceilings', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ai).toEqual({
      enabled: true,
      database: { url: '' },
      vertex: { project: '', location: 'global' },
      models: [],
      defaultModel: '',
      limits: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
    });
  });

  it('fills in the parts a partial block leaves out', () => {
    const result = parse({ database: { url: 'postgres://db/shipit' }, limits: { maxSteps: 5 } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ai.database.url).toBe('postgres://db/shipit');
    expect(result.data.ai.limits).toEqual({
      maxSteps: 5,
      maxTokens: 400_000,
      timeoutSeconds: 900,
      dailyTokens: 4_000_000,
    });
    expect(result.data.ai.vertex.location).toBe('global');
  });

  it('defaults a model to tool-capable', () => {
    const result = parse({ models: [model('claude-opus')], defaultModel: 'claude-opus' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ai.models[0]!.tools).toBe(true);
  });

  it('rejects two models with the same key', () => {
    const result = parse({ models: [model('m'), model('m')] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toContain('ai.models.1.key');
  });

  it('rejects a default model that is not in the catalog', () => {
    const result = parse({ models: [model('m')], defaultModel: 'other' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toContain('ai.defaultModel');
  });

  it.each([
    ['an upper-case model key', { models: [{ ...model('m'), key: 'Claude' }] }],
    ['an unknown family', { models: [{ ...model('m'), family: 'openai' }] }],
    ['a zero context window', { models: [{ ...model('m'), contextWindow: 0 }] }],
    ['a negative ceiling', { limits: { maxSteps: -1 } }],
    ['a non-boolean enabled', { enabled: 'yes' }],
  ])('rejects %s', (_name, ai) => {
    expect(parse(ai).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/shared exec vitest run src/__tests__/ai-config-schema.test.ts`
Expected: FAIL — `result.data.ai` is `undefined` in the first test; the rejection tests pass by accident or fail, because unknown keys are stripped.

- [ ] **Step 3: Add the schema section**

`packages/shared/src/config/schema.ts`:

```diff
--- a/packages/shared/src/config/schema.ts
+++ b/packages/shared/src/config/schema.ts
@@ -662,6 +662,69 @@ const feedbackConfigSchema = z.object({
   tokenSecret: z.string().default('github-feedback-token'),
 });

+// Top-level `ai:` block: user-defined agents (design:
+// docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md).
+// Everything defaults, so a config without the block still validates, and an
+// empty database URL simply leaves agent features switched off.
+const aiModelSchema = z.object({
+  // Stable key an agent definition refers to. Never sent to Vertex.
+  key: z
+    .string()
+    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'model keys are lower-case letters, digits and dashes'),
+  label: z.string().min(1),
+  // Which Vertex entry point serves the model: Claude (`anthropic`), Gemini
+  // (`gemini`), or an open model on the OpenAI-compatible endpoint (`maas`).
+  family: z.enum(['anthropic', 'gemini', 'maas']),
+  // The id Vertex expects for that family, e.g. `claude-opus-5-5`.
+  modelId: z.string().min(1),
+  contextWindow: z.number().int().positive(),
+  // False for a model that cannot call tools. Such a model can only back an
+  // agent that holds no grants.
+  tools: z.boolean().default(true),
+});
+
+const AI_LIMIT_DEFAULTS = {
+  maxSteps: 25,
+  maxTokens: 400_000,
+  timeoutSeconds: 900,
+  dailyTokens: 4_000_000,
+};
+
+const aiConfigSchema = z.object({
+  // Master switch. False hides agent features without touching stored data.
+  enabled: z.boolean().default(true),
+  database: z
+    .object({
+      // Postgres connection string. Supplied as ${DATABASE_URL:-} in the
+      // committed YAML and deliberately NOT a secrets-registry entry: boot
+      // hydration reads every registry entry from GSM when its env var is
+      // unset, and the api-server holds no grant on this container.
+      url: z.string().default(''),
+    })
+    .default({ url: '' }),
+  vertex: z
+    .object({
+      project: z.string().default(''),
+      location: z.string().default('global'),
+    })
+    .default({ project: '', location: 'global' }),
+  // The catalog the agent editor's model picker shows.
+  models: z.array(aiModelSchema).default([]),
+  // Key of the model a new agent starts with. Empty means "no default".
+  defaultModel: z.string().default(''),
+  // Instance ceilings. An agent's own limits may be lower, never higher.
+  limits: z
+    .object({
+      maxSteps: z.number().int().positive().default(AI_LIMIT_DEFAULTS.maxSteps),
+      maxTokens: z.number().int().positive().default(AI_LIMIT_DEFAULTS.maxTokens),
+      timeoutSeconds: z.number().int().positive().default(AI_LIMIT_DEFAULTS.timeoutSeconds),
+      dailyTokens: z.number().int().positive().default(AI_LIMIT_DEFAULTS.dailyTokens),
+    })
+    .default(AI_LIMIT_DEFAULTS),
+});
+export type AiConfig = z.infer<typeof aiConfigSchema>;
+export type AiModelConfig = z.infer<typeof aiModelSchema>;
+
 const baseConfigSchema = z.object({
   // Secrets registry — maps logical secret keys to their GSM container and
   // consumption mode. Defaults include all 13 canonical entries so a config
@@ -873,6 +936,16 @@ const baseConfigSchema = z.object({
     defaultLabels: ['user-report'],
     tokenSecret: 'github-feedback-token',
   }),
+  // User-defined AI agents. Defaulted so existing configs without an `ai`
+  // block still validate; with no database URL the feature stays off.
+  ai: aiConfigSchema.default({
+    enabled: true,
+    database: { url: '' },
+    vertex: { project: '', location: 'global' },
+    models: [],
+    defaultModel: '',
+    limits: AI_LIMIT_DEFAULTS,
+  }),
 });

 // Cross-reference validation: ensure every logical secret has a registry entry
@@ -914,6 +987,26 @@ export const configSchema = baseConfigSchema.superRefine((cfg, ctx) => {
       ctx.addIssue({ code: 'custom', path, message: `references unknown secret "${ref}"` });
     }
   }
+
+  // ai.models: keys are what agent definitions store, so they must be unique,
+  // and the default must point at one of them.
+  const modelKeys = cfg.ai.models.map((m) => m.key);
+  modelKeys.forEach((key, i) => {
+    if (modelKeys.indexOf(key) !== i) {
+      ctx.addIssue({
+        code: 'custom',
+        path: ['ai', 'models', i, 'key'],
+        message: `duplicate model key "${key}"`,
+      });
+    }
+  });
+  if (cfg.ai.defaultModel && !modelKeys.includes(cfg.ai.defaultModel)) {
+    ctx.addIssue({
+      code: 'custom',
+      path: ['ai', 'defaultModel'],
+      message: `"${cfg.ai.defaultModel}" is not a key in ai.models`,
+    });
+  }
 });

 export type Config = z.infer<typeof configSchema>;
```

Export the two new types. `packages/shared/src/config/index.ts`:

```diff
--- a/packages/shared/src/config/index.ts
+++ b/packages/shared/src/config/index.ts
@@ -20,6 +20,8 @@ export type {
   AppLike,
   AccessControlConfig,
   AuthConfig,
+  AiConfig,
+  AiModelConfig,
   SecretEntry,
   SecretsRegistry,
   KubernetesConnectorConfig,
```

`packages/shared/src/index.ts`:

```diff
--- a/packages/shared/src/index.ts
+++ b/packages/shared/src/index.ts
@@ -168,6 +168,8 @@ export type {
   AppLike,
   AccessControlConfig,
   AuthConfig,
+  AiConfig,
+  AiModelConfig,
   SecretEntry,
   SecretsRegistry,
   KubernetesConnectorConfig,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shipit-ai/shared exec vitest run src/__tests__/ai-config-schema.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Add the section to the committed config and to the api-server test fixture**

`shipit.config.yaml`:

```diff
--- a/shipit.config.yaml
+++ b/shipit.config.yaml
@@ -154,6 +154,50 @@ feedback:
     - user-report
   tokenSecret: github-feedback-token

+# User-defined AI agents (AI → Agents). Off until a database is configured:
+# with an empty database URL every agent route answers 503 AI_UNAVAILABLE and
+# the rest of the product is unaffected.
+ai:
+  enabled: true
+  database:
+    # Postgres connection string for the app role. Delivered as a plain env var
+    # (ESO in GKE). Intentionally not in the secrets: registry above, because
+    # boot hydration would then try to read it from GSM.
+    url: ${DATABASE_URL:-}
+  vertex:
+    # Model calls go to Vertex AI in this project, authenticated by Workload
+    # Identity / Application Default Credentials. No API key.
+    project: ${GOOGLE_CLOUD_PROJECT:-}
+    location: ${GOOGLE_CLOUD_LOCATION:-global}
+  # The model picker's catalog. `modelId` is the id Vertex expects for the
+  # family. Claude models must first be enabled in the project's Model Garden.
+  defaultModel: claude-opus
+  models:
+    - key: claude-opus
+      label: Claude Opus 5.5
+      family: anthropic
+      modelId: claude-opus-5-5
+      contextWindow: 1000000
+      tools: true
+    - key: claude-sonnet
+      label: Claude Sonnet 5.5
+      family: anthropic
+      modelId: claude-sonnet-5-5
+      contextWindow: 1000000
+      tools: true
+    - key: claude-haiku
+      label: Claude Haiku 4.5
+      family: anthropic
+      modelId: claude-haiku-4-5@20251001
+      contextWindow: 200000
+      tools: true
+  # Instance ceilings. An agent may set lower limits, never higher.
+  limits:
+    maxSteps: 25
+    maxTokens: 400000
+    timeoutSeconds: 900
+    dailyTokens: 4000000
+
 frontend:
   api:
     # Public URL the web-UI's browser code uses to reach the api-server.
```

Only Claude models are seeded: their Vertex ids are known. Task 9 adds the Gemini entry once the probe has confirmed an id that works.

`Config` now requires `ai`, so the api-server's hand-built test config must supply it. `packages/api-server/src/__tests__/test-config.ts`:

```diff
--- a/packages/api-server/src/__tests__/test-config.ts
+++ b/packages/api-server/src/__tests__/test-config.ts
@@ -112,6 +112,31 @@ export function makeTestConfig(overrides: Partial<Config> = {}): Config {
       defaultLabels: ['user-report'],
       tokenSecret: 'github-feedback-token',
     },
+    ai: {
+      enabled: true,
+      database: { url: '' },
+      vertex: { project: 'test-project', location: 'global' },
+      defaultModel: 'claude-opus',
+      models: [
+        {
+          key: 'claude-opus',
+          label: 'Claude Opus',
+          family: 'anthropic',
+          modelId: 'claude-opus-5-5',
+          contextWindow: 1_000_000,
+          tools: true,
+        },
+        {
+          key: 'gemini',
+          label: 'Gemini',
+          family: 'gemini',
+          modelId: 'gemini-test',
+          contextWindow: 1_000_000,
+          tools: true,
+        },
+      ],
+      limits: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
+    },
     secrets: {},
     ...overrides,
   };
```

- [ ] **Step 6: Verify the real config still loads, and nothing else broke**

```bash
pnpm typecheck && pnpm test
```

Expected: all green. `packages/shared`'s loader tests parse minimal YAML with no `ai` block, which proves the defaults; the api-server suites prove the fixture.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/shared/src shipit.config.yaml packages/api-server/src/__tests__/test-config.ts
pnpm lint && pnpm format:check
git add packages/shared shipit.config.yaml packages/api-server/src/__tests__/test-config.ts
git commit -m "shared: ai config section (database URL, Vertex, model catalog, ceilings)"
```

---

## Task 6: The status service and `/api/ai`

**Files:**

- Modify: `packages/api-server/package.json`, `packages/api-server/vitest.config.ts`, `packages/api-server/Dockerfile`
- Create: `packages/api-server/src/services/ai/ai-status-service.ts`
- Create: `packages/api-server/src/routes/ai.ts`
- Modify: `packages/api-server/src/server.ts`
- Test: `packages/api-server/src/__tests__/services/ai/ai-status-service.test.ts`
- Test: `packages/api-server/src/__tests__/routes/ai.test.ts`

**Interfaces:**

- Consumes: `Db`, `EXPECTED_SCHEMA_VERSION` (Task 1); `AiConfig`, `makeTestConfig().ai` (Task 5).
- Produces:
  - `class AiStatusService { constructor(opts: { config: AiConfig; db: Db | null; redis: { get(key: string): Promise<string | null> } | null; cacheMs?: number; now?: () => number; log?: (message: string) => void }); status(): Promise<AiStatus> }`
  - `AiStatus` = `{ available: boolean; definitionsAvailable: boolean; checks: AiCheck[] }`; `AiCheck` = `{ name: 'enabled' | 'database' | 'schema' | 'models' | 'runner'; ok: boolean; detail: string }`
  - `RUNNER_HEARTBEAT_KEY = 'shipit-agent-runner-heartbeat'`
  - `CreateServerOptions.aiStatus?: AiStatusService`; `server.aiStatus?: AiStatusService`
  - `GET /api/ai/status` → `AiStatus` (any signed-in user); `GET /api/ai/models` → `{ defaultModel: string; models: Array<{ key; label; family; contextWindow; tools }> }` (`agents:read`)
  - `AI_NOT_WIRED: AiStatus`, exported from `routes/ai.ts`

- [ ] **Step 1: Add the workspace dependency in all three places**

`packages/api-server/package.json`:

```diff
--- a/packages/api-server/package.json
+++ b/packages/api-server/package.json
@@ -27,6 +27,7 @@
     "@fastify/session": "^11.1.2",
     "@fastify/swagger": "^9.7.0",
     "@google-cloud/secret-manager": "^6.1.3",
+    "@shipit-ai/agents": "workspace:*",
     "@shipit-ai/connector-github": "workspace:*",
     "@shipit-ai/connector-kubernetes": "workspace:*",
     "@shipit-ai/connector-sdk": "workspace:*",
```

`packages/api-server/vitest.config.ts`:

```diff
--- a/packages/api-server/vitest.config.ts
+++ b/packages/api-server/vitest.config.ts
@@ -21,6 +21,7 @@ export default defineConfig({
     alias: {
       '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
       '@shipit-ai/shared': r('shared/src/index.ts'),
+      '@shipit-ai/agents': r('agents/src/index.ts'),
       '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
       '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
       '@shipit-ai/connector-github': r('connectors/github/src/index.ts'),
```

`packages/api-server/Dockerfile`:

```diff
--- a/packages/api-server/Dockerfile
+++ b/packages/api-server/Dockerfile
@@ -4,8 +4,9 @@ WORKDIR /app
 COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
 # api-server's workspace closure. Each line is one Docker layer, ordered
 # roughly from least-changing to most-changing for cache efficiency:
-#   shared → event-bus → connector-sdk → mcp-server → connectors/* → api-server
+#   shared → agents → event-bus → connector-sdk → mcp-server → connectors/* → api-server
 COPY packages/shared/ packages/shared/
+COPY packages/agents/ packages/agents/
 COPY packages/event-bus/ packages/event-bus/
 COPY packages/connector-sdk/ packages/connector-sdk/
 COPY packages/mcp-server/ packages/mcp-server/
```

Then:

```bash
pnpm install
```

Do not add `packages/agents` to `packages/api-server/tsconfig.json` `references`.

- [ ] **Step 2: Write the failing service test**

Create `packages/api-server/src/__tests__/services/ai/ai-status-service.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EXPECTED_SCHEMA_VERSION, type Db } from '@shipit-ai/agents';
import {
  AiStatusService,
  RUNNER_HEARTBEAT_KEY,
  type AiStatus,
} from '../../../services/ai/ai-status-service.js';
import { makeTestConfig } from '../../test-config.js';

const ai = () => makeTestConfig().ai;

/** A Db whose only query is answered by `answer` (a value or a thrown error). */
function dbAnswering(answer: () => { rows: unknown[] }): Db {
  const query = async () => ({ ...answer(), rowCount: null });
  return {
    query: query as Db['query'],
    tx: async (fn) => fn({ query: query as Db['query'] }),
    withClient: async (fn) => fn({ query: query as Db['query'] }),
  };
}

const migrated = dbAnswering(() => ({ rows: [{ version: EXPECTED_SCHEMA_VERSION }] }));
const aliveRedis = { get: async (key: string) => (key === RUNNER_HEARTBEAT_KEY ? '1' : null) };
const silentRedis = { get: async () => null };

const check = (status: AiStatus, name: string) => status.checks.find((c) => c.name === name)!;

describe('AiStatusService', () => {
  it('is fully available when every prerequisite is met', async () => {
    const service = new AiStatusService({
      config: ai(),
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    });
    const status = await service.status();
    expect(status.available).toBe(true);
    expect(status.definitionsAvailable).toBe(true);
    expect(status.checks.map((c) => c.name)).toEqual([
      'enabled',
      'database',
      'schema',
      'models',
      'runner',
    ]);
  });

  it('allows definitions but not runs when only the runner is missing', async () => {
    const service = new AiStatusService({
      config: ai(),
      db: migrated,
      redis: silentRedis,
      cacheMs: 0,
    });
    const status = await service.status();
    expect(status.definitionsAvailable).toBe(true);
    expect(status.available).toBe(false);
    expect(check(status, 'runner').ok).toBe(false);
  });

  it('is off when ai.enabled is false, even with everything else in place', async () => {
    const config = { ...ai(), enabled: false };
    const status = await new AiStatusService({
      config,
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(status.definitionsAvailable).toBe(false);
    expect(check(status, 'enabled').ok).toBe(false);
  });

  it('reports a missing database without trying to query one', async () => {
    const status = await new AiStatusService({
      config: ai(),
      db: null,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'database')).toMatchObject({ ok: false });
    expect(check(status, 'schema').ok).toBe(false);
    expect(status.definitionsAvailable).toBe(false);
  });

  it('distinguishes "connected but never migrated" from "unreachable"', async () => {
    const neverMigrated = dbAnswering(() => {
      throw Object.assign(new Error('relation "schema_migrations" does not exist'), {
        code: '42P01',
      });
    });
    const status = await new AiStatusService({
      config: ai(),
      db: neverMigrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'database').ok).toBe(true);
    expect(check(status, 'schema').ok).toBe(false);
    expect(check(status, 'schema').detail).toContain(EXPECTED_SCHEMA_VERSION);
  });

  it('fails the schema check when the table exists but is empty', async () => {
    const empty = dbAnswering(() => ({ rows: [{ version: null }] }));
    const status = await new AiStatusService({
      config: ai(),
      db: empty,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'database').ok).toBe(true);
    expect(check(status, 'schema').ok).toBe(false);
  });

  it('fails the schema check when the database is behind this build', async () => {
    const behind = dbAnswering(() => ({ rows: [{ version: '0000' }] }));
    const status = await new AiStatusService({
      config: ai(),
      db: behind,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'schema')).toMatchObject({ ok: false });
    expect(check(status, 'schema').detail).toContain('0000');
  });

  it('accepts a database that is ahead of this build', async () => {
    const ahead = dbAnswering(() => ({ rows: [{ version: '9999' }] }));
    const status = await new AiStatusService({
      config: ai(),
      db: ahead,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(status, 'schema').ok).toBe(true);
  });

  it('never puts the driver error in a detail a user can read', async () => {
    const logged: string[] = [];
    const unreachable = dbAnswering(() => {
      throw new Error('connect ECONNREFUSED 10.20.30.40:5432');
    });
    const status = await new AiStatusService({
      config: ai(),
      db: unreachable,
      redis: aliveRedis,
      cacheMs: 0,
      log: (m) => logged.push(m),
    }).status();
    expect(check(status, 'database').ok).toBe(false);
    expect(JSON.stringify(status)).not.toContain('10.20.30.40');
    expect(logged.join('\n')).toContain('10.20.30.40');
  });

  it('fails the models check with no Vertex project or no models', async () => {
    const noProject = { ...ai(), vertex: { project: '', location: 'global' } };
    const noModels = { ...ai(), models: [] };
    const a = await new AiStatusService({
      config: noProject,
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    const b = await new AiStatusService({
      config: noModels,
      db: migrated,
      redis: aliveRedis,
      cacheMs: 0,
    }).status();
    expect(check(a, 'models').ok).toBe(false);
    expect(check(b, 'models').ok).toBe(false);
    expect(a.definitionsAvailable).toBe(true);
  });

  it('survives Redis throwing during the runner check', async () => {
    const broken = {
      get: async () => {
        throw new Error('OOM command not allowed');
      },
    };
    const status = await new AiStatusService({
      config: ai(),
      db: migrated,
      redis: broken,
      cacheMs: 0,
    }).status();
    expect(check(status, 'runner').ok).toBe(false);
    expect(status.definitionsAvailable).toBe(true);
  });

  it('reuses a computed status inside the cache window, then recomputes', async () => {
    let calls = 0;
    let clock = 1_000;
    const counting = dbAnswering(() => {
      calls += 1;
      return { rows: [{ version: EXPECTED_SCHEMA_VERSION }] };
    });
    const service = new AiStatusService({
      config: ai(),
      db: counting,
      redis: aliveRedis,
      cacheMs: 5_000,
      now: () => clock,
    });
    await service.status();
    clock += 4_999;
    await service.status();
    expect(calls).toBe(1);
    clock += 2;
    await service.status();
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/ai`
Expected: FAIL — cannot resolve `../../../services/ai/ai-status-service.js`.

- [ ] **Step 4: Implement the service**

Create `packages/api-server/src/services/ai/ai-status-service.ts`:

```ts
// Feature gating for user-defined agents. Answers "can this instance store
// agent definitions?" and "can it run them?" from live checks, so a missing
// prerequisite turns the feature off with a named reason instead of crashing a
// process or returning a 500.
import type { AiConfig } from '@shipit-ai/shared';
import { EXPECTED_SCHEMA_VERSION, type Db } from '@shipit-ai/agents';

/** Written by agent-runner every 15s with a 60s TTL. Absent = no runner. */
export const RUNNER_HEARTBEAT_KEY = 'shipit-agent-runner-heartbeat';

export type AiCheckName = 'enabled' | 'database' | 'schema' | 'models' | 'runner';

export interface AiCheck {
  name: AiCheckName;
  ok: boolean;
  /** Safe to show to any signed-in user: never contains a host, URL or driver message. */
  detail: string;
}

export interface AiStatus {
  /** Every prerequisite for running an agent is in place. */
  available: boolean;
  /** Enough is in place to store and edit agent definitions. */
  definitionsAvailable: boolean;
  checks: AiCheck[];
}

export interface AiStatusServiceOptions {
  config: AiConfig;
  /** null when no database URL is configured. */
  db: Db | null;
  /** null when Redis is not configured. Only `get` is used. */
  redis: { get(key: string): Promise<string | null> } | null;
  /** How long a computed status is reused. Defaults to 5s; tests pass 0. */
  cacheMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const pass = (name: AiCheckName, detail: string): AiCheck => ({ name, ok: true, detail });
const fail = (name: AiCheckName, detail: string): AiCheck => ({ name, ok: false, detail });

export class AiStatusService {
  private cached: { at: number; status: AiStatus } | null = null;

  constructor(private readonly opts: AiStatusServiceOptions) {}

  async status(): Promise<AiStatus> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheMs ?? 5_000;
    if (this.cached && now - this.cached.at < ttl) return this.cached.status;
    const status = await this.compute();
    this.cached = { at: now, status };
    return status;
  }

  private async compute(): Promise<AiStatus> {
    const enabled = this.opts.config.enabled
      ? pass('enabled', 'Agent features are switched on.')
      : fail('enabled', 'Agent features are switched off (ai.enabled is false).');
    const [database, schema] = await this.checkDatabase();
    const checks = [enabled, database, schema, this.checkModels(), await this.checkRunner()];
    return {
      available: checks.every((c) => c.ok),
      definitionsAvailable: enabled.ok && database.ok && schema.ok,
      checks,
    };
  }

  private async checkDatabase(): Promise<[AiCheck, AiCheck]> {
    const { db } = this.opts;
    if (!db) {
      return [
        fail('database', 'No database is configured (ai.database.url is empty).'),
        fail('schema', 'No database to check.'),
      ];
    }
    try {
      const { rows } = await db.query<{ version: string | null }>(
        'SELECT max(version) AS version FROM schema_migrations',
      );
      const version = rows[0]?.version ?? null;
      const database = pass('database', 'Connected.');
      if (version === null) {
        return [
          database,
          fail('schema', `No migrations are applied. This build needs ${EXPECTED_SCHEMA_VERSION}.`),
        ];
      }
      if (version < EXPECTED_SCHEMA_VERSION) {
        return [
          database,
          fail(
            'schema',
            `The schema is at ${version}. This build needs ${EXPECTED_SCHEMA_VERSION}; run the migration step.`,
          ),
        ];
      }
      return [database, pass('schema', `The schema is at ${version}.`)];
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // 42P01 = undefined_table: we connected, but nothing has been migrated.
      if (e.code === '42P01') {
        return [
          pass('database', 'Connected.'),
          fail(
            'schema',
            `No migrations are applied. This build needs ${EXPECTED_SCHEMA_VERSION}; run the migration step.`,
          ),
        ];
      }
      this.opts.log?.(`ai-status: database check failed: ${e.message ?? String(err)}`);
      return [
        fail('database', 'The database is not reachable.'),
        fail('schema', 'The database is not reachable.'),
      ];
    }
  }

  private checkModels(): AiCheck {
    const { vertex, models } = this.opts.config;
    if (!vertex.project)
      return fail('models', 'No Vertex AI project is configured (ai.vertex.project).');
    if (models.length === 0) return fail('models', 'No models are configured (ai.models).');
    return pass('models', `${models.length} model(s) configured.`);
  }

  private async checkRunner(): Promise<AiCheck> {
    const { redis } = this.opts;
    if (!redis) return fail('runner', 'Redis is not configured, so no runner can be seen.');
    try {
      const beat = await redis.get(RUNNER_HEARTBEAT_KEY);
      return beat
        ? pass('runner', 'The agent runner is alive.')
        : fail('runner', 'No heartbeat from the agent runner in the last minute.');
    } catch (err) {
      this.opts.log?.(`ai-status: runner check failed: ${(err as Error).message}`);
      return fail('runner', 'The agent runner could not be checked.');
    }
  }
}
```

- [ ] **Step 5: Run the service test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/ai`
Expected: PASS — 12 tests.

- [ ] **Step 6: Write the failing route test**

Create `packages/api-server/src/__tests__/routes/ai.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';

describe('ai routes', () => {
  it('reports "not set up" from /api/ai/status when no status service is wired', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/ai/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, definitionsAvailable: false });
    expect(res.json().checks).toHaveLength(1);
    await server.close();
  });

  it('returns the wired status service result as is', async () => {
    const status: AiStatus = {
      available: true,
      definitionsAvailable: true,
      checks: [{ name: 'enabled', ok: true, detail: 'on' }],
    };
    const server = await createServer({
      config: makeTestConfig(),
      aiStatus: { status: async () => status } as unknown as AiStatusService,
    });
    await server.ready();
    expect((await server.inject({ method: 'GET', url: '/api/ai/status' })).json()).toEqual(status);
    await server.close();
  });

  it('lists the model catalog without the provider model ids', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      defaultModel: 'claude-opus',
      models: [
        {
          key: 'claude-opus',
          label: 'Claude Opus',
          family: 'anthropic',
          contextWindow: 1_000_000,
          tools: true,
        },
        { key: 'gemini', label: 'Gemini', family: 'gemini', contextWindow: 1_000_000, tools: true },
      ],
    });
    expect(res.body).not.toContain('claude-opus-5-5');
    await server.close();
  });

  it('returns an empty catalog on a server with no config', async () => {
    const server = await createServer();
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.json()).toEqual({ defaultModel: '', models: [] });
    await server.close();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/ai.test.ts`
Expected: FAIL — every request is a 404; `aiStatus` is not a known `createServer` option.

- [ ] **Step 8: Add the routes and wire them**

Create `packages/api-server/src/routes/ai.ts`:

```ts
// Instance-level facts about agent features (mounted /api/ai): whether they
// are available and which models an agent may use.
import type { FastifyPluginAsync } from 'fastify';
import { requireCapability } from '../middleware/require-auth.js';
import type { AiStatus, AiStatusService } from '../services/ai/ai-status-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    aiStatus?: AiStatusService;
  }
}

// What a server built without the status service reports (unit servers, and
// any deployment that predates agents).
export const AI_NOT_WIRED: AiStatus = {
  available: false,
  definitionsAvailable: false,
  checks: [{ name: 'enabled', ok: false, detail: 'Agent features are not set up on this server.' }],
};

const aiRoutes: FastifyPluginAsync = async (server) => {
  // Any signed-in user: the AI pages read this to show setup guidance.
  server.get('/status', async () => (server.aiStatus ? server.aiStatus.status() : AI_NOT_WIRED));

  server.get('/models', { preHandler: requireCapability('agents:read') }, async () => {
    const ai = server.config?.ai;
    return {
      defaultModel: ai?.defaultModel ?? '',
      // modelId (the provider's own id) stays server-side; agents store the key.
      models: (ai?.models ?? []).map(({ key, label, family, contextWindow, tools }) => ({
        key,
        label,
        family,
        contextWindow,
        tools,
      })),
    };
  });
};

export default aiRoutes;
```

Wire the status service and the routes into `packages/api-server/src/server.ts`:

```diff
--- a/packages/api-server/src/server.ts
+++ b/packages/api-server/src/server.ts
@@ -43,6 +43,8 @@ import { assertAuthConfigBootable, AuthConfigError } from './auth-bootability.js
 import type { SetupService } from './services/setup-service.js';
 import type { SettingsService } from './services/settings-service.js';
 import feedbackRoutes from './routes/feedback.js';
+import aiRoutes from './routes/ai.js';
+import type { AiStatusService } from './services/ai/ai-status-service.js';
 import type { FeedbackService } from './services/feedback-service.js';
 import { envSecretsView, type ResolvedSecrets } from './secrets/index.js';

@@ -108,6 +110,9 @@ export interface CreateServerOptions {
   // will consume it to pass typed secret values directly to services that need
   // them (FeedbackService, Neo4jService, etc.) instead of reading from process.env.
   resolved?: ResolvedSecrets;
+  // Live prerequisite checks for agent features. Optional: routes/ai.ts reports
+  // "not set up" when it is absent (tests, or no database configured).
+  aiStatus?: AiStatusService;
 }

 declare module 'fastify' {
@@ -399,6 +404,11 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   if (opts.webhookRefetch) {
     server.decorate('webhookRefetch', opts.webhookRefetch);
   }
+  // Agent features. Conditional decoration for the same multi-server-test
+  // reason as above; routes/agents.ts and routes/ai.ts handle their absence.
+  if (opts.aiStatus) {
+    server.decorate('aiStatus', opts.aiStatus);
+  }

   // Register routes
   await server.register(healthRoutes, { prefix: '/api' });
@@ -442,6 +452,10 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   // or configured.
   await server.register(feedbackRoutes, { prefix: '/api/feedback' });

+  // User-defined AI agents: instance status + model catalog, and agent
+  // definitions. Both answer 503 AI_UNAVAILABLE until a database is wired.
+  await server.register(aiRoutes, { prefix: '/api/ai' });
+
   // GitHub webhook receiver. Registered as its own encapsulated plugin so its
   // route-scoped raw-body parser (HMAC needs the exact bytes) doesn't leak
   // into the global JSON parsing. HMAC is the entire auth boundary — the route
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/ai.test.ts src/__tests__/services/ai`
Expected: PASS — 2 files, 16 tests.

- [ ] **Step 10: Commit**

```bash
npx prettier --write packages/api-server
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/api-server pnpm-lock.yaml
git commit -m "api-server: AI status service and /api/ai status and model routes"
```

---

## Task 7: The agent definition routes

**Files:**

- Create: `packages/api-server/src/routes/agents.ts`
- Modify: `packages/api-server/src/server.ts`
- Modify: `packages/api-server/src/routes/auth.ts:75-78`
- Test: `packages/api-server/src/__tests__/routes/agents.test.ts`
- Test: `packages/api-server/src/__tests__/routes/auth.test.ts:392` (modify)

**Interfaces:**

- Consumes: `AgentStore` and its errors and types (Task 4); `parseAgentDefinition`, `checkDefinitionAgainstPolicy`, `grantedServiceEffects` (Task 3); `AiStatusService`, `AiStatus` (Task 6); `requireCapability`, `hasCapability` (existing).
- Produces:
  - `CreateServerOptions.agentStore?: AgentStore`; `server.agentStore?: AgentStore`
  - Routes under `/api/agents`:

| Method and path     | Capability     | Success                                  | Notes                                                                         |
| ------------------- | -------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /`             | `agents:read`  | `200 { items, total }`                   | `?includeArchived=true&limit=&offset=`                                        |
| `GET /:id`          | `agents:read`  | `200 AgentRecord` + `ETag: "<revision>"` |                                                                               |
| `GET /:id/versions` | `agents:read`  | `200 { items: AgentVersionRecord[] }`    |                                                                               |
| `POST /`            | `agents:write` | `201 AgentRecord` + `ETag`               | body `{ slug, name, description?, ownerTeamId?, definition }`                 |
| `PUT /:id`          | `agents:write` | `200 AgentRecord` + `ETag`               | `If-Match`; body any of `name, description, ownerTeamId, enabled, definition` |
| `POST /:id/publish` | `agents:write` | `200 { agent, version }` + `ETag`        | `If-Match`; body `{ note? }`; re-validates the draft                          |
| `DELETE /:id`       | `agents:write` | `204`                                    | `If-Match`; archives                                                          |

- Member role capabilities become `['graph:read', 'catalog:read', 'graph:write', 'agents:read', 'agents:run']`.

- [ ] **Step 1: Write the failing test**

Create `packages/api-server/src/__tests__/routes/agents.test.ts`:

```ts
// Route tests for agent definitions. The store is an in-memory FAKE that throws
// the real error classes; the SQL behind the real store is covered by
// packages/agents' Postgres integration suite. Coverage:
//   - 503 AI_UNAVAILABLE when not wired or when a prerequisite fails
//   - create / read / update / publish / archive happy paths and ETags
//   - body, definition, model and ceiling validation (400 with issue paths)
//   - If-Match handling and 409 VERSION_CONFLICT
//   - store failures become 503, never 500, and never leak the driver message
//   - capability gating with auth enabled, including the author's own ceiling
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentVersionConflictError,
  type AgentDefinition,
  type AgentRecord,
  type AgentStore,
  type AgentVersionRecord,
  type CreateAgentInput,
  type UpdateAgentPatch,
} from '@shipit-ai/agents';
import { createServer } from '../../server.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const READY: AiStatus = {
  available: false,
  definitionsAvailable: true,
  checks: [
    { name: 'enabled', ok: true, detail: 'on' },
    { name: 'database', ok: true, detail: 'ok' },
    { name: 'schema', ok: true, detail: 'ok' },
    { name: 'models', ok: true, detail: 'ok' },
    { name: 'runner', ok: false, detail: 'No heartbeat from the agent runner in the last minute.' },
  ],
};

const statusOf = (status: AiStatus) =>
  ({ status: async () => status }) as unknown as AiStatusService;

const definition = {
  instructions: 'Answer questions about service ownership.',
  model: 'claude-opus',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
};

/** In-memory stand-in with the same contract as the Postgres AgentStore. */
class FakeAgentStore {
  agents = new Map<string, AgentRecord>();
  versions = new Map<string, AgentVersionRecord[]>();
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** When set, every method throws it. */
  failWith: Error | null = null;
  private seq = 0;

  private touch(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    if (this.failWith) throw this.failWith;
  }

  private live(id: string): AgentRecord {
    const agent = this.agents.get(id);
    if (!agent || agent.archivedAt) throw new AgentNotFoundError(id);
    return agent;
  }

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    this.touch('create', input);
    for (const a of this.agents.values()) {
      if (a.slug === input.slug && !a.archivedAt) throw new AgentSlugTakenError(input.slug);
    }
    this.seq += 1;
    const now = new Date().toISOString();
    const agent: AgentRecord = {
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      ownerTeamId: input.ownerTeamId ?? null,
      enabled: true,
      builtin: input.builtin ?? false,
      draftDefinition: input.definition,
      publishedVersion: null,
      revision: 1,
      createdBy: input.actor,
      updatedBy: input.actor,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async get(id: string): Promise<AgentRecord | null> {
    this.touch('get', id);
    return this.agents.get(id) ?? null;
  }

  async list(opts: unknown): Promise<{ items: AgentRecord[]; total: number }> {
    this.touch('list', opts);
    const items = [...this.agents.values()].filter((a) => !a.archivedAt);
    return { items, total: items.length };
  }

  async update(
    id: string,
    expected: number | undefined,
    patch: UpdateAgentPatch,
    actor: string,
  ): Promise<AgentRecord> {
    this.touch('update', id, expected, patch, actor);
    const agent = this.live(id);
    if (expected !== undefined && expected !== agent.revision) {
      throw new AgentVersionConflictError(id, agent.revision);
    }
    const { definition: nextDefinition, ...rest } = patch;
    const next: AgentRecord = {
      ...agent,
      ...rest,
      draftDefinition: nextDefinition ?? agent.draftDefinition,
      revision: agent.revision + 1,
      updatedBy: actor,
    };
    this.agents.set(id, next);
    return next;
  }

  async publish(id: string, expected: number | undefined, note: string, actor: string) {
    this.touch('publish', id, expected, note, actor);
    const agent = this.live(id);
    if (expected !== undefined && expected !== agent.revision) {
      throw new AgentVersionConflictError(id, agent.revision);
    }
    const list = this.versions.get(id) ?? [];
    const version: AgentVersionRecord = {
      agentId: id,
      version: list.length + 1,
      definition: agent.draftDefinition,
      note,
      createdBy: actor,
      createdAt: new Date().toISOString(),
    };
    this.versions.set(id, [version, ...list]);
    const next = { ...agent, publishedVersion: version.version, revision: agent.revision + 1 };
    this.agents.set(id, next);
    return { agent: next, version };
  }

  async archive(id: string, expected: number | undefined, actor: string): Promise<void> {
    this.touch('archive', id, expected, actor);
    const agent = this.live(id);
    if (agent.builtin) throw new AgentBuiltinProtectedError(id);
    if (expected !== undefined && expected !== agent.revision) {
      throw new AgentVersionConflictError(id, agent.revision);
    }
    this.agents.set(id, { ...agent, archivedAt: new Date().toISOString(), enabled: false });
  }

  async listVersions(id: string): Promise<AgentVersionRecord[]> {
    this.touch('listVersions', id);
    return this.versions.get(id) ?? [];
  }
}

const asStore = (fake: FakeAgentStore) => fake as unknown as AgentStore;

describe('agents routes — not available', () => {
  it('answers 503 AI_UNAVAILABLE when the server has no agent store', async () => {
    const server = await createServer({ config: makeTestConfig() });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AI_UNAVAILABLE');
    expect(res.json().checks).toHaveLength(1);
    // The rest of the product is unaffected.
    expect((await server.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await server.close();
  });

  it('names the failing prerequisites and never touches the store', async () => {
    const fake = new FakeAgentStore();
    const behind: AiStatus = {
      available: false,
      definitionsAvailable: false,
      checks: [
        { name: 'enabled', ok: true, detail: 'on' },
        { name: 'database', ok: true, detail: 'ok' },
        { name: 'schema', ok: false, detail: 'The schema is at 0000. This build needs 0001.' },
      ],
    };
    const server = await createServer({
      config: makeTestConfig(),
      agentStore: asStore(fake),
      aiStatus: statusOf(behind),
    });
    await server.ready();
    for (const [method, url] of [
      ['GET', '/api/agents'],
      ['POST', '/api/agents'],
      ['GET', '/api/agents/x'],
      ['PUT', '/api/agents/x'],
      ['DELETE', '/api/agents/x'],
      ['POST', '/api/agents/x/publish'],
      ['GET', '/api/agents/x/versions'],
    ] as const) {
      const res = await server.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().checks).toEqual([
        { name: 'schema', ok: false, detail: 'The schema is at 0000. This build needs 0001.' },
      ]);
    }
    expect(fake.calls).toEqual([]);
    await server.close();
  });
});

describe('agents routes — definitions (auth disabled, admin principal)', () => {
  let server: FastifyInstance;
  let fake: FakeAgentStore;

  beforeAll(async () => {
    fake = new FakeAgentStore();
    server = await createServer({
      config: makeTestConfig(),
      agentStore: asStore(fake),
      aiStatus: statusOf(READY),
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    fake.agents.clear();
    fake.versions.clear();
    fake.calls = [];
    fake.failWith = null;
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    server.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { slug: 'owners', name: 'Owners', definition, ...overrides },
    });

  it('creates an agent: 201, ETag "1", defaults filled in, author recorded', async () => {
    const res = await create({ description: 'Who owns what', ownerTeamId: 'team:platform' });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    const body = res.json() as AgentRecord;
    expect(body).toMatchObject({
      slug: 'owners',
      name: 'Owners',
      description: 'Who owns what',
      ownerTeamId: 'team:platform',
      revision: 1,
      publishedVersion: null,
    });
    expect(body.draftDefinition).toEqual({
      ...definition,
      grants: { services: {}, tools: {} },
      output: { schema: null },
    } satisfies AgentDefinition);
    expect(body.createdBy).toBeTruthy();
    expect(body.createdBy).toBe(body.updatedBy);
  });

  it.each([
    ['a missing slug', { slug: undefined }, 'slug'],
    ['an upper-case slug', { slug: 'Owners' }, 'slug'],
    ['a slug with a space', { slug: 'my agent' }, 'slug'],
    ['an empty name', { name: '   ' }, 'name'],
    ['a 121-character name', { name: 'x'.repeat(121) }, 'name'],
    ['a non-text description', { description: 7 }, 'description'],
    ['an empty ownerTeamId', { ownerTeamId: '' }, 'ownerTeamId'],
    ['a missing definition', { definition: undefined }, 'definition'],
    [
      'blank instructions',
      { definition: { ...definition, instructions: ' ' } },
      'definition.instructions',
    ],
    [
      'allow on delete',
      { definition: { ...definition, grants: { services: { graph: { delete: 'allow' } } } } },
      'definition.grants.services.graph.delete',
    ],
    ['an unknown model', { definition: { ...definition, model: 'gpt-x' } }, 'definition.model'],
    [
      'a limit above the ceiling',
      { definition: { ...definition, limits: { ...definition.limits, maxSteps: 26 } } },
      'definition.limits.maxSteps',
    ],
  ])(
    'rejects %s with 400 and the field path, and stores nothing',
    async (_name, overrides, path) => {
      const res = await create(overrides);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect((res.json().issues as Array<{ path: string }>).map((i) => i.path)).toContain(path);
      expect(fake.calls.filter((c) => c.method === 'create')).toEqual([]);
    },
  );

  it('rejects a body that is not a JSON object', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/agents', payload: ['nope'] });
    expect(res.statusCode).toBe(400);
  });

  it('answers 409 SLUG_TAKEN for a duplicate slug', async () => {
    await create();
    const res = await create();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SLUG_TAKEN');
  });

  it('reads one agent with its ETag, and 404s an unknown id', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({ method: 'GET', url: `/api/agents/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.json().slug).toBe('owners');

    const missing = await server.inject({ method: 'GET', url: '/api/agents/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('lists agents, passing paging through and ignoring junk paging values', async () => {
    await create();
    const res = await server.inject({
      method: 'GET',
      url: '/api/agents?limit=10&offset=abc&includeArchived=true',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1 });
    expect(fake.calls.at(-1)).toEqual({
      method: 'list',
      args: [{ includeArchived: true, limit: 10, offset: undefined }],
    });
  });

  it('updates with If-Match, returning the new ETag', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      headers: { 'if-match': '"1"' },
      payload: { name: 'Ownership helper', enabled: false, ownerTeamId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.json()).toMatchObject({ name: 'Ownership helper', enabled: false, revision: 2 });
    const call = fake.calls.find((c) => c.method === 'update')!;
    expect(call.args[1]).toBe(1);
    expect(call.args[2]).toEqual({ name: 'Ownership helper', enabled: false, ownerTeamId: null });
  });

  it('forces the write when If-Match is absent', async () => {
    const created = (await create()).json() as AgentRecord;
    await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { name: 'A' },
    });
    expect(fake.calls.find((c) => c.method === 'update')!.args[1]).toBeUndefined();
  });

  it('answers 409 VERSION_CONFLICT with the server revision for a stale If-Match', async () => {
    const created = (await create()).json() as AgentRecord;
    await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { name: 'First' },
    });
    const res = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      headers: { 'if-match': '"1"' },
      payload: { name: 'Second' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' }, serverRevision: 2 });
  });

  it.each(['"abc"', '"0"', '"-1"', '"1.5"', 'W/"1"'])(
    'rejects the If-Match value %s',
    async (header) => {
      const created = (await create()).json() as AgentRecord;
      const res = await server.inject({
        method: 'PUT',
        url: `/api/agents/${created.id}`,
        headers: { 'if-match': header },
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(fake.calls.filter((c) => c.method === 'update')).toEqual([]);
    },
  );

  it('rejects an update with nothing in it, and one with a bad field', async () => {
    const created = (await create()).json() as AgentRecord;
    const empty = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const bad = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe('enabled');
  });

  it('validates a definition sent in an update the same way as on create', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'PUT',
      url: `/api/agents/${created.id}`,
      payload: { definition: { ...definition, model: 'gpt-x' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toMatchObject({ path: 'definition.model', code: 'UNKNOWN_MODEL' });
  });

  it('publishes the draft and lists the version', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'POST',
      url: `/api/agents/${created.id}/publish`,
      headers: { 'if-match': '"1"' },
      payload: { note: 'first cut' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.json()).toMatchObject({
      agent: { publishedVersion: 1, revision: 2 },
      version: { version: 1, note: 'first cut' },
    });
    const versions = await server.inject({
      method: 'GET',
      url: `/api/agents/${created.id}/versions`,
    });
    expect(versions.json().items).toHaveLength(1);
  });

  it('refuses to publish a draft whose model the instance no longer offers', async () => {
    const created = (await create()).json() as AgentRecord;
    fake.agents.set(created.id, {
      ...created,
      draftDefinition: { ...created.draftDefinition, model: 'retired-model' },
    });
    const res = await server.inject({
      method: 'POST',
      url: `/api/agents/${created.id}/publish`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toMatchObject({ path: 'definition.model', code: 'UNKNOWN_MODEL' });
    expect(fake.calls.filter((c) => c.method === 'publish')).toEqual([]);
  });

  it('archives with 204, then 404s further writes', async () => {
    const created = (await create()).json() as AgentRecord;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/agents/${created.id}`,
      headers: { 'if-match': '"1"' },
    });
    expect(res.statusCode).toBe(204);
    const again = await server.inject({ method: 'DELETE', url: `/api/agents/${created.id}` });
    expect(again.statusCode).toBe(404);
  });

  it('answers 409 BUILTIN_PROTECTED when archiving a built-in agent', async () => {
    const created = (await create()).json() as AgentRecord;
    fake.agents.set(created.id, { ...created, builtin: true });
    const res = await server.inject({ method: 'DELETE', url: `/api/agents/${created.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUILTIN_PROTECTED');
  });

  it('turns a store failure into 503 without leaking the driver message', async () => {
    fake.failWith = new Error('connect ECONNREFUSED 10.20.30.40:5432');
    for (const [method, url, payload] of [
      ['GET', '/api/agents', undefined],
      ['POST', '/api/agents', { slug: 'owners', name: 'Owners', definition }],
      ['GET', '/api/agents/00000000-0000-4000-8000-000000000001', undefined],
    ] as const) {
      const res = await server.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error.code).toBe('AI_UNAVAILABLE');
      expect(res.body).not.toContain('10.20.30.40');
    }
  });
});

// --- Capability gating with auth ENABLED (principals from bearer tokens).
function buildAuthConfig(): Config {
  const base = makeTestConfig();
  return {
    ...base,
    accessControl: {
      ...base.accessControl,
      auth: {
        ...base.accessControl.auth,
        enabled: true,
        providers: {
          ...base.accessControl.auth.providers,
          oidc: {
            ...base.accessControl.auth.providers.oidc,
            enabled: true,
            issuerUrl: 'https://idp.example.com',
            clientId: 'oidc-test-client',
            displayName: 'Example IdP',
          },
        },
        admins: ['admin@example.com'],
        allowList: [],
        session: { ...base.accessControl.auth.session, secure: false },
      },
    },
  };
}

const stubOidc = {
  async startAuthorization() {
    return { url: 'https://idp.example.com/authorize', state: 's', codeVerifier: 'v' };
  },
  async exchange() {
    return { sub: 'sub', email: 'member@example.com', displayName: 'Member' };
  },
} as unknown as OidcProvider;

describe('agents routes — capability gating (auth enabled)', () => {
  let server: FastifyInstance;
  let fake: FakeAgentStore;

  const SCOPES: Record<string, string[]> = {
    reader: ['agents:read'],
    author: ['agents:read', 'agents:write', 'graph:read'],
    'graph-author': ['agents:read', 'agents:write', 'graph:read', 'graph:write'],
  };
  const tokenService = {
    validate: async (plaintext: string) =>
      SCOPES[plaintext]
        ? { id: plaintext, ownerEmail: `${plaintext}@example.com`, scopes: SCOPES[plaintext] }
        : null,
  } as unknown as TokenService;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    fake = new FakeAgentStore();
    server = await createServer({
      config: buildAuthConfig(),
      redis: new RedisMock() as unknown as Redis,
      resolved: makeTestResolved(),
      oidcProvider: stubOidc,
      tokenService,
      agentStore: asStore(fake),
      aiStatus: statusOf(READY),
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });
  beforeEach(() => {
    fake.agents.clear();
    fake.calls = [];
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, def: unknown) =>
    server.inject({
      method: 'POST',
      url: '/api/agents',
      headers: as(token),
      payload: { slug: 'owners', name: 'Owners', definition: def },
    });

  it('401s an unauthenticated request before any gate', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
  });

  it('lets agents:read list but not create, edit, publish or archive', async () => {
    expect(
      (await server.inject({ method: 'GET', url: '/api/agents', headers: as('reader') }))
        .statusCode,
    ).toBe(200);
    for (const [method, url] of [
      ['POST', '/api/agents'],
      ['PUT', '/api/agents/x'],
      ['POST', '/api/agents/x/publish'],
      ['DELETE', '/api/agents/x'],
    ] as const) {
      const res = await server.inject({ method, url, headers: as('reader'), payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('lets an author create an agent whose grants they hold', async () => {
    const res = await post('author', {
      ...definition,
      grants: { services: { graph: { read: 'allow' } } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().createdBy).toBe('author@example.com');
  });

  it('refuses a grant the author does not hold, naming the capability', async () => {
    const res = await post('author', {
      ...definition,
      grants: { services: { graph: { read: 'allow', write: 'ask' } } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('GRANT_EXCEEDS_CAPABILITY');
    expect(res.json().issues).toEqual([
      expect.objectContaining({ path: 'definition.grants.services.graph.write' }),
    ]);
    expect(fake.calls.filter((c) => c.method === 'create')).toEqual([]);
  });

  it('accepts the same grant from an author who holds graph:write', async () => {
    const res = await post('graph-author', {
      ...definition,
      grants: { services: { graph: { read: 'allow', write: 'ask' } } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('treats any non-graph service, and any tool-level grant, as admin-only', async () => {
    const service = await post('graph-author', {
      ...definition,
      grants: { services: { github: { read: 'allow' } } },
    });
    const tool = await post('graph-author', {
      ...definition,
      grants: { tools: { 'github.open_pull_request': 'ask' } },
    });
    expect(service.statusCode).toBe(403);
    expect(tool.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/agents.test.ts`
Expected: FAIL — the routes do not exist (404s), and `agentStore` is not a known `createServer` option.

- [ ] **Step 3: Implement the routes**

Create `packages/api-server/src/routes/agents.ts`:

```ts
// Agent definitions (mounted /api/agents). Definitions only: nothing here runs
// an agent. House style: manual body guards + { error: { code, message } }.
//
// Concurrency follows the editable-config ETag rule, with the row's integer
// `revision` as the ETag: GET returns ETag: "<revision>"; PUT/DELETE/publish
// honour If-Match and answer 409 VERSION_CONFLICT with the server's revision;
// a missing If-Match forces the write.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { hasCapability, type AiConfig } from '@shipit-ai/shared';
import {
  AgentBuiltinProtectedError,
  AgentNotFoundError,
  AgentSlugTakenError,
  AgentVersionConflictError,
  checkDefinitionAgainstPolicy,
  grantedServiceEffects,
  parseAgentDefinition,
  type AgentDefinition,
  type AgentRecord,
  type AgentStore,
  type DefinitionIssue,
  type ToolEffect,
  type UpdateAgentPatch,
} from '@shipit-ai/agents';
import { requireCapability } from '../middleware/require-auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    agentStore?: AgentStore;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2_000;
const MAX_TEAM_ID = 300;
const MAX_NOTE = 500;

interface Issue {
  path: string;
  code: string;
  message: string;
}

const actorOf = (request: FastifyRequest): string => request.ctx.user.email;

function setEtag(reply: FastifyReply, agent: AgentRecord): void {
  reply.header('ETag', `"${agent.revision}"`);
}

function invalid(reply: FastifyReply, issues: Issue[]): FastifyReply {
  return reply.status(400).send({
    error: { code: 'VALIDATION_ERROR', message: issues[0]?.message ?? 'Invalid request.' },
    issues,
  });
}

/**
 * Reads If-Match as a revision. `undefined` (no header) forces the write;
 * `null` means the header was present but unusable.
 */
function parseIfMatch(header: unknown): number | undefined | null {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') return null;
  const raw = header.replace(/^"|"$/g, '');
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

function intParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

// Which capability the saving user must hold for a grant to be allowed. Only
// the graph has its own capabilities today; every other service is admin-only.
function capabilityFor(service: string, effect: ToolEffect): string {
  if (service === 'graph') return effect === 'read' ? 'graph:read' : 'graph:write';
  return 'ai:admin';
}

function replyForStoreError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof AgentNotFoundError) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
  }
  if (err instanceof AgentSlugTakenError) {
    return reply.status(409).send({ error: { code: 'SLUG_TAKEN', message: err.message } });
  }
  if (err instanceof AgentVersionConflictError) {
    return reply.status(409).send({
      error: { code: 'VERSION_CONFLICT', message: err.message },
      serverRevision: err.serverRevision,
    });
  }
  if (err instanceof AgentBuiltinProtectedError) {
    return reply.status(409).send({ error: { code: 'BUILTIN_PROTECTED', message: err.message } });
  }
  // Anything else is the store itself failing (database down, pool exhausted).
  // Log the real error; tell the caller only that agents are unavailable.
  request.log.error({ err }, 'agents: store error');
  return reply.status(503).send({
    error: { code: 'AI_UNAVAILABLE', message: 'The agent store is not reachable right now.' },
    checks: [{ name: 'database', ok: false, detail: 'The database is not reachable.' }],
  });
}

const agentsRoutes: FastifyPluginAsync = async (server) => {
  // Every handler starts here: no store, or a failing prerequisite, is a 503
  // that names what is missing. It is never a 500 and never a crash.
  async function ready(reply: FastifyReply): Promise<{ store: AgentStore; ai: AiConfig } | null> {
    const store = server.agentStore;
    const ai = server.config?.ai;
    const status = server.aiStatus ? await server.aiStatus.status() : null;
    if (!store || !ai || !status || !status.definitionsAvailable) {
      reply.status(503).send({
        error: {
          code: 'AI_UNAVAILABLE',
          message: 'Agent features are not available on this server.',
        },
        checks: status
          ? status.checks.filter((c) => !c.ok)
          : [
              {
                name: 'enabled',
                ok: false,
                detail: 'Agent features are not set up on this server.',
              },
            ],
      });
      return null;
    }
    return { store, ai };
  }

  // Shape check, then instance policy (known model, limits under the ceilings),
  // then the saving user's own ceiling. Replies and returns null on any failure.
  function validDefinition(
    request: FastifyRequest,
    reply: FastifyReply,
    ai: AiConfig,
    raw: unknown,
  ): AgentDefinition | null {
    const parsed = parseAgentDefinition(raw);
    if (!parsed.ok) {
      invalid(
        reply,
        parsed.issues.map((i: DefinitionIssue) => ({
          ...i,
          path: i.path ? `definition.${i.path}` : 'definition',
        })),
      );
      return null;
    }
    const policyIssues = checkDefinitionAgainstPolicy(parsed.definition, {
      modelKeys: ai.models.map((m) => m.key),
      ceilings: ai.limits,
    });
    if (policyIssues.length > 0) {
      invalid(
        reply,
        policyIssues.map((i) => ({ ...i, path: `definition.${i.path}` })),
      );
      return null;
    }
    const beyond = grantedServiceEffects(parsed.definition).filter(
      ({ service, effect }) => !hasCapability(request.ctx, capabilityFor(service, effect)),
    );
    if (beyond.length > 0) {
      reply.status(403).send({
        error: {
          code: 'GRANT_EXCEEDS_CAPABILITY',
          message: 'An agent cannot be granted access its author does not hold.',
        },
        issues: beyond.map(({ service, effect }) => ({
          path: `definition.grants.services.${service}.${effect}`,
          code: 'GRANT_EXCEEDS_CAPABILITY',
          message: `Granting ${effect} on ${service} requires the ${capabilityFor(service, effect)} capability.`,
        })),
      });
      return null;
    }
    return parsed.definition;
  }

  // Shared by create and update. `partial` makes every field optional.
  function readFields(
    body: Record<string, unknown>,
    partial: boolean,
  ): { issues: Issue[]; fields: Omit<UpdateAgentPatch, 'definition'> } {
    const issues: Issue[] = [];
    const fields: Omit<UpdateAgentPatch, 'definition'> = {};

    if (body.name !== undefined || !partial) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        issues.push({ path: 'name', code: 'INVALID', message: 'name is required.' });
      } else if (body.name.trim().length > MAX_NAME) {
        issues.push({
          path: 'name',
          code: 'INVALID',
          message: `name is at most ${MAX_NAME} characters.`,
        });
      } else {
        fields.name = body.name.trim();
      }
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION) {
        issues.push({
          path: 'description',
          code: 'INVALID',
          message: `description is text of at most ${MAX_DESCRIPTION} characters.`,
        });
      } else {
        fields.description = body.description;
      }
    }
    if (body.ownerTeamId !== undefined) {
      const v = body.ownerTeamId;
      if (v !== null && (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEAM_ID)) {
        issues.push({
          path: 'ownerTeamId',
          code: 'INVALID',
          message: 'ownerTeamId is a team id or null.',
        });
      } else {
        fields.ownerTeamId = v as string | null;
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        issues.push({ path: 'enabled', code: 'INVALID', message: 'enabled is true or false.' });
      } else {
        fields.enabled = body.enabled;
      }
    }
    return { issues, fields };
  }

  const asObject = (body: unknown): Record<string, unknown> | null =>
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;

  server.get<{ Querystring: { includeArchived?: string; limit?: string; offset?: string } }>(
    '/',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      try {
        return await ctx.store.list({
          includeArchived: request.query.includeArchived === 'true',
          limit: intParam(request.query.limit),
          offset: intParam(request.query.offset),
        });
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      try {
        const agent = await ctx.store.get(request.params.id);
        if (!agent) throw new AgentNotFoundError(request.params.id);
        setEtag(reply, agent);
        return agent;
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    '/:id/versions',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      try {
        const agent = await ctx.store.get(request.params.id);
        if (!agent) throw new AgentNotFoundError(request.params.id);
        return { items: await ctx.store.listVersions(agent.id) };
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.post<{ Body: unknown }>(
    '/',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const body = asObject(request.body);
      if (!body) {
        return invalid(reply, [
          { path: '', code: 'INVALID', message: 'A JSON object is required.' },
        ]);
      }
      const { issues, fields } = readFields(body, false);
      if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) {
        issues.unshift({
          path: 'slug',
          code: 'INVALID',
          message:
            'slug is 1 to 63 lower-case letters, digits or dashes, starting with a letter or digit.',
        });
      }
      if (issues.length > 0) return invalid(reply, issues);
      const definition = validDefinition(request, reply, ctx.ai, body.definition);
      if (!definition) return reply;
      try {
        const agent = await ctx.store.create({
          slug: body.slug as string,
          name: fields.name!,
          description: fields.description,
          ownerTeamId: fields.ownerTeamId,
          definition,
          actor: actorOf(request),
        });
        setEtag(reply, agent);
        return reply.status(201).send(agent);
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.put<{ Params: { id: string }; Body: unknown }>(
    '/:id',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        return invalid(reply, [
          {
            path: 'If-Match',
            code: 'INVALID',
            message: 'If-Match must be the agent revision, e.g. "3".',
          },
        ]);
      }
      const body = asObject(request.body);
      if (!body) {
        return invalid(reply, [
          { path: '', code: 'INVALID', message: 'A JSON object is required.' },
        ]);
      }
      const { issues, fields } = readFields(body, true);
      if (issues.length > 0) return invalid(reply, issues);
      const patch: UpdateAgentPatch = { ...fields };
      if (body.definition !== undefined) {
        const definition = validDefinition(request, reply, ctx.ai, body.definition);
        if (!definition) return reply;
        patch.definition = definition;
      }
      if (Object.keys(patch).length === 0) {
        return invalid(reply, [
          {
            path: '',
            code: 'INVALID',
            message:
              'Nothing to update: send name, description, ownerTeamId, enabled or definition.',
          },
        ]);
      }
      try {
        const agent = await ctx.store.update(request.params.id, expected, patch, actorOf(request));
        setEtag(reply, agent);
        return agent;
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/publish',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        return invalid(reply, [
          {
            path: 'If-Match',
            code: 'INVALID',
            message: 'If-Match must be the agent revision, e.g. "3".',
          },
        ]);
      }
      const note = asObject(request.body)?.note;
      if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) {
        return invalid(reply, [
          {
            path: 'note',
            code: 'INVALID',
            message: `note is text of at most ${MAX_NOTE} characters.`,
          },
        ]);
      }
      try {
        // The draft was valid when it was saved, but the instance's models and
        // ceilings may have changed since. Publishing re-checks, so a stale
        // draft cannot become the version triggers run.
        const current = await ctx.store.get(request.params.id);
        if (!current || current.archivedAt) throw new AgentNotFoundError(request.params.id);
        if (!validDefinition(request, reply, ctx.ai, current.draftDefinition)) return reply;
        const result = await ctx.store.publish(
          request.params.id,
          expected,
          (note as string | undefined) ?? '',
          actorOf(request),
        );
        setEtag(reply, result.agent);
        return result;
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );

  server.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireCapability('agents:write') },
    async (request, reply) => {
      const ctx = await ready(reply);
      if (!ctx) return reply;
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        return invalid(reply, [
          {
            path: 'If-Match',
            code: 'INVALID',
            message: 'If-Match must be the agent revision, e.g. "3".',
          },
        ]);
      }
      try {
        await ctx.store.archive(request.params.id, expected, actorOf(request));
        return reply.status(204).send();
      } catch (err) {
        return replyForStoreError(request, reply, err);
      }
    },
  );
};

export default agentsRoutes;
```

Add the store option, its decoration and the route registration to `packages/api-server/src/server.ts`, next to the Task 6 edits:

```diff
--- a/packages/api-server/src/server.ts
+++ b/packages/api-server/src/server.ts
@@ -44,6 +44,8 @@ import type { SetupService } from './services/setup-service.js';
 import type { SettingsService } from './services/settings-service.js';
 import feedbackRoutes from './routes/feedback.js';
 import aiRoutes from './routes/ai.js';
+import agentsRoutes from './routes/agents.js';
+import type { AgentStore } from '@shipit-ai/agents';
 import type { AiStatusService } from './services/ai/ai-status-service.js';
 import type { FeedbackService } from './services/feedback-service.js';
 import { envSecretsView, type ResolvedSecrets } from './secrets/index.js';
@@ -110,8 +112,10 @@ export interface CreateServerOptions {
   // will consume it to pass typed secret values directly to services that need
   // them (FeedbackService, Neo4jService, etc.) instead of reading from process.env.
   resolved?: ResolvedSecrets;
-  // Live prerequisite checks for agent features. Optional: routes/ai.ts reports
-  // "not set up" when it is absent (tests, or no database configured).
+  // Postgres-backed agent definitions. Optional: the /api/agents routes answer
+  // 503 AI_UNAVAILABLE when it is not wired (no database configured, or tests).
+  agentStore?: AgentStore;
+  // Live prerequisite checks for agent features. Optional for the same reason.
   aiStatus?: AiStatusService;
 }

@@ -406,6 +410,9 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   }
   // Agent features. Conditional decoration for the same multi-server-test
   // reason as above; routes/agents.ts and routes/ai.ts handle their absence.
+  if (opts.agentStore) {
+    server.decorate('agentStore', opts.agentStore);
+  }
   if (opts.aiStatus) {
     server.decorate('aiStatus', opts.aiStatus);
   }
@@ -455,6 +462,7 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   // User-defined AI agents: instance status + model catalog, and agent
   // definitions. Both answer 503 AI_UNAVAILABLE until a database is wired.
   await server.register(aiRoutes, { prefix: '/api/ai' });
+  await server.register(agentsRoutes, { prefix: '/api/agents' });

   // GitHub webhook receiver. Registered as its own encapsulated plugin so its
   // route-scoped raw-body parser (HMAC needs the exact bytes) doesn't leak
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/agents.test.ts`
Expected: PASS — 40 tests.

- [ ] **Step 5: Let members read and run agents**

`packages/api-server/src/routes/auth.ts`:

```diff
--- a/packages/api-server/src/routes/auth.ts
+++ b/packages/api-server/src/routes/auth.ts
@@ -74,7 +74,9 @@ function emailPassesAllowList(
 // the seam future grants will hang off of.
 function capabilitiesForRole(role: AuthRole): ReadonlyArray<string> {
   if (role === 'admin') return ['*'];
-  return ['graph:read', 'catalog:read', 'graph:write'];
+  // agents:read / agents:run let members see and start agents; creating and
+  // editing them (agents:write) stays with admins until real roles exist.
+  return ['graph:read', 'catalog:read', 'graph:write', 'agents:read', 'agents:run'];
 }

 const authRoutes: FastifyPluginAsync = async (server) => {
```

The existing assertion on the member capability list changes with it. `packages/api-server/src/__tests__/routes/auth.test.ts`:

```diff
--- a/packages/api-server/src/__tests__/routes/auth.test.ts
+++ b/packages/api-server/src/__tests__/routes/auth.test.ts
@@ -389,7 +389,13 @@ describe('/api/auth — auth enabled', () => {
     });
     const body = me.json();
     expect(body.user.role).toBe('member');
-    expect(body.user.capabilities).toEqual(['graph:read', 'catalog:read', 'graph:write']);
+    expect(body.user.capabilities).toEqual([
+      'graph:read',
+      'catalog:read',
+      'graph:write',
+      'agents:read',
+      'agents:run',
+    ]);
   });

   it('callback redirects to /login?error=INVALID_STATE on an unknown state value', async () => {
```

Capabilities are written into the session at sign-in, so a member who is already signed in picks up the new ones at their next sign-in (sessions last 12 hours).

- [ ] **Step 6: Run the api-server suite**

Run: `pnpm --filter @shipit-ai/api-server test`
Expected: PASS, no failures. In the clone this was 59 files and 674 tests passed, with 9 files and 51 tests skipped (the Neo4j and Redis integration suites).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/api-server/src
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/api-server
git commit -m "api-server: /api/agents definitions API with revision ETags and capability gates"
```

---

## Task 8: Boot wiring, the compose migrate service, docs, and a hands-on check

**Files:**

- Modify: `packages/api-server/src/index.ts`
- Modify: `docker/docker-compose.yml`
- Modify: `docs/local-development.md`
- Modify: `docs/agent/plans/ai-agents-and-workflows.md` (Status section)

**Interfaces:**

- Consumes: everything above.
- Produces: an api-server that opens a pool when `ai.enabled` and `ai.database.url` are set, and a compose stack that migrates before the api-server starts.

`index.ts` is the process entry point and has no unit test, like the rest of the boot wiring. Its test is Step 4.

- [ ] **Step 1: Wire the pool, the store and the status service at boot**

`packages/api-server/src/index.ts`:

```diff
--- a/packages/api-server/src/index.ts
+++ b/packages/api-server/src/index.ts
@@ -28,6 +28,8 @@ import { OidcSettingsService } from './services/auth/oidc-settings-service.js';
 import { SetupService } from './services/setup-service.js';
 import { SettingsService } from './services/settings-service.js';
 import { FeedbackService } from './services/feedback-service.js';
+import { AgentStore, createDb, createPool, type Db } from '@shipit-ai/agents';
+import { AiStatusService } from './services/ai/ai-status-service.js';
 import {
   applyDerivedAuthConfig,
   evaluateAuthBootability,
@@ -425,6 +427,28 @@ async function main() {
     redis: runStoreRedis,
   });

+  // User-defined AI agents. Postgres is optional: with ai.enabled false or no
+  // database URL, no pool is opened, the store stays unwired and every agent
+  // route answers 503 AI_UNAVAILABLE while the rest of the API runs as before.
+  // The pool connects lazily, so an unreachable database does not fail boot
+  // either; AiStatusService reports it per request.
+  const agentPool =
+    config.ai.enabled && config.ai.database.url
+      ? createPool({ connectionString: config.ai.database.url })
+      : null;
+  const agentDb: Db | null = agentPool ? createDb(agentPool) : null;
+  const aiStatus = new AiStatusService({
+    config: config.ai,
+    db: agentDb,
+    redis: runStoreRedis,
+    log: (message) => console.warn(message),
+  });
+  console.log(
+    agentPool
+      ? 'Agent features: database configured.'
+      : 'Agent features: off (ai.enabled is false or ai.database.url is empty).',
+  );
+
   const server = await createServer({
     logger: true,
     neo4jService,
@@ -454,6 +478,8 @@ async function main() {
     // of a Redis URL stays a soft warning rather than a hard boot failure.
     redis: runStoreRedis ?? undefined,
     resolved,
+    agentStore: agentDb ? new AgentStore(agentDb) : undefined,
+    aiStatus,
   });

   // Start any pre-configured connectors after the server is constructed so
@@ -504,6 +530,7 @@ async function main() {
     // close() only tears down the worker/queue it created), so close it here.
     if (eventBus) await eventBus.close();
     if (runStoreRedis) runStoreRedis.disconnect();
+    if (agentPool) await agentPool.end();
     await neo4jService.close();
     process.exit(0);
   };
```

The pool connects lazily, so a wrong or unreachable URL does not stop the server from booting; the status service reports it on the next request.

- [ ] **Step 2: Add the one-shot migrate service to compose**

`docker/docker-compose.yml` gains a `migrate` service, and `api-server` gets the URL and waits for it:

```diff
--- a/docker/docker-compose.yml
+++ b/docker/docker-compose.yml
@@ -49,6 +49,22 @@ services:
       timeout: 5s
       retries: 10

+  # One-shot: applies db/migrations and exits. Runs the CLI that ships inside
+  # the api-server image (@shipit-ai/agents). On GKE the infra repo's deploy
+  # step applies the same files instead.
+  migrate:
+    build:
+      context: ..
+      dockerfile: packages/api-server/Dockerfile
+    command: ['node', 'node_modules/@shipit-ai/agents/dist/migrate-cli.js']
+    volumes:
+      - ../db/migrations:/app/db/migrations:ro
+    environment:
+      DATABASE_URL: postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@postgres:5432/shipit
+    depends_on:
+      postgres:
+        condition: service_healthy
+
   # Each backend service reads shipit.config.yaml mounted into /app. Only the
   # env vars referenced from the YAML's ${VAR} placeholders are passed in —
   # everything else lives in the committed config file. NEO4J_URI / REDIS_URL
@@ -68,11 +84,14 @@ services:
       NEO4J_URI: bolt://neo4j:7687
       REDIS_URL: redis://redis:6379
       NEO4J_PASSWORD: ${NEO4J_PASSWORD:-shipit-dev}
+      DATABASE_URL: postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@postgres:5432/shipit
     depends_on:
       neo4j:
         condition: service_healthy
       redis:
         condition: service_healthy
+      migrate:
+        condition: service_completed_successfully

   core-writer:
     build:
```

- [ ] **Step 3: Document it**

`docs/local-development.md`:

````diff
--- a/docs/local-development.md
+++ b/docs/local-development.md
@@ -165,13 +165,14 @@ concurrently, the loser sees a 409 and a "reload and rebase" dialog.

 | Script                | What it starts                                                             |
 | --------------------- | -------------------------------------------------------------------------- |
-| `pnpm start:infra`    | Docker: Neo4j + Redis only                                                 |
+| `pnpm start:infra`    | Docker: Neo4j + Redis + Postgres, then applies database migrations         |
 | `pnpm start:backend`  | Infra + `api-server` + `core-writer` (auto-seeds demo data if graph empty) |
 | `pnpm start:frontend` | Web UI dev server only                                                     |
 | `pnpm start:mcp`      | MCP server only (stdio)                                                    |
 | `pnpm start:all`      | Everything in parallel                                                     |
 | `pnpm stop`           | Bring all docker-compose services down                                     |
-| `pnpm stop:clean`     | Down + delete volumes (wipes Neo4j data)                                   |
+| `pnpm stop:clean`     | Down + delete volumes (wipes Neo4j, Redis and Postgres data)               |
+| `pnpm db:migrate`     | Apply pending files in `db/migrations/` (needs `DATABASE_URL`)             |

 ### Manual paths

@@ -179,7 +180,8 @@ For surgical control:

 ```bash
 # Terminal 1 — infra
-docker compose -f docker/docker-compose.yml up -d neo4j redis
+docker compose -f docker/docker-compose.yml up -d neo4j redis postgres
+DATABASE_URL=postgres://shipit:shipit-dev@localhost:5432/shipit pnpm db:migrate

 # Terminal 2 — api-server (watch mode)
 pnpm --filter @shipit-ai/api-server dev
@@ -193,14 +195,50 @@ pnpm --filter @shipit-ai/web-ui dev

 ### Ports

-| Service     | URL                                         | Notes                                     |
-| ----------- | ------------------------------------------- | ----------------------------------------- |
-| Web UI      | <http://localhost:3000>                     | Next.js                                   |
-| API Server  | <http://localhost:3001>                     | Fastify; OpenAPI at `/docs`               |
-| Neo4j HTTP  | <http://localhost:7474>                     | Neo4j Browser; login `neo4j`/`shipit-dev` |
-| Neo4j Bolt  | `bolt://localhost:7687`                     | driver protocol                           |
-| Redis       | `redis://localhost:6379`                    | BullMQ + event bus                        |
-| Smee target | `http://localhost:3001/api/webhooks/github` | When you set up webhooks (§10)            |
+| Service     | URL                                         | Notes                                          |
+| ----------- | ------------------------------------------- | ---------------------------------------------- |
+| Web UI      | <http://localhost:3000>                     | Next.js                                        |
+| API Server  | <http://localhost:3001>                     | Fastify; OpenAPI at `/docs`                    |
+| Neo4j HTTP  | <http://localhost:7474>                     | Neo4j Browser; login `neo4j`/`shipit-dev`      |
+| Neo4j Bolt  | `bolt://localhost:7687`                     | driver protocol                                |
+| Redis       | `redis://localhost:6379`                    | BullMQ + event bus                             |
+| Postgres    | `postgres://localhost:5432/shipit`          | Agent definitions; login `shipit`/`shipit-dev` |
+| Smee target | `http://localhost:3001/api/webhooks/github` | When you set up webhooks (§10)                 |
+
+### Postgres and agent features
+
+Agent definitions (AI → Agents) live in Postgres. It is optional: without it the
+rest of the product runs as before and every `/api/agents` call answers
+`503 AI_UNAVAILABLE`.
+
+To turn it on locally, point the api-server at the compose database by adding
+this to `shipit.config.local.yaml` (new checkouts get it from the example file):
+
+```yaml
+ai:
+  database:
+    url: postgres://shipit:shipit-dev@localhost:5432/shipit
+```
+
+`GET http://localhost:3001/api/ai/status` then reports each prerequisite. The
+`runner` check stays red until the agent runner exists; definitions work
+without it.
+
+The schema is plain SQL in `db/migrations/`, named `NNNN_description.sql` and
+forward-only: never edit a file that has been applied, add a new one. The app
+does not migrate at boot. `pnpm start:infra` applies pending files locally; on
+GKE the infra repo's deploy step applies the same files. When you add a
+migration, bump `EXPECTED_SCHEMA_VERSION` in
+`packages/agents/src/schema-version.ts` in the same change.
+
+Run the Postgres-backed tests with the compose database up:
+
+```bash
+DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
+  pnpm --filter @shipit-ai/agents run test:integration
+```
+
+Each suite creates and drops its own schema, so it does not touch your data.

 ---

````

In `docs/agent/plans/ai-agents-and-workflows.md`, append to the Status section:

```markdown
**Milestone 1, first half (foundation) implemented** per
`docs/superpowers/plans/2026-10-01-agents-foundation.md`: `@shipit-ai/agents` package,
`db/migrations/0001_agents.sql`, `pnpm db:migrate`, the `ai` config section,
`/api/ai/status`, `/api/ai/models` and the `/api/agents` definitions API. No runner, model
layer or UI yet.
```

- [ ] **Step 4: Check it by hand**

Add the `ai.database.url` block from `shipit.config.local.example.yaml` to your own `shipit.config.local.yaml`, then:

```bash
pnpm start:backend
```

Expected in the api-server log: `Agent features: database configured.`

In a second terminal (local auth is off, so requests run as the dev admin):

```bash
curl -s localhost:3001/api/ai/status
```

Expected: `"definitionsAvailable":true`, `"available":false`, and five checks, with `enabled`, `database` and `schema` ok. `models` is not ok locally unless `GOOGLE_CLOUD_PROJECT` is set, and `runner` is not ok because no runner exists yet.

```bash
curl -s -i -X POST localhost:3001/api/agents -H 'content-type: application/json' -d '{
  "slug": "owners",
  "name": "Ownership helper",
  "definition": {
    "instructions": "Answer questions about who owns what.",
    "model": "claude-opus",
    "limits": { "maxSteps": 10, "maxTokens": 100000, "timeoutSeconds": 300, "dailyTokens": 1000000 },
    "grants": { "services": { "graph": { "read": "allow" } } }
  }
}'
```

Expected: `HTTP/1.1 201`, `etag: "1"`, and the agent with `"revision":1`. Copy its `id`, then:

```bash
ID=<the id>
curl -s -i -X PUT localhost:3001/api/agents/$ID -H 'content-type: application/json' -H 'if-match: "1"' -d '{"name":"Owners"}'
curl -s -i -X PUT localhost:3001/api/agents/$ID -H 'content-type: application/json' -H 'if-match: "1"' -d '{"name":"Stale"}'
curl -s -X POST localhost:3001/api/agents/$ID/publish -H 'content-type: application/json' -d '{"note":"first"}'
curl -s localhost:3001/api/agents
```

Expected, in order: `200` with `etag: "2"`; `409` with `"code":"VERSION_CONFLICT"` and `"serverRevision":2`; a body with `"publishedVersion":1`; a list with `"total":1`.

Now the two conditions tests cannot pin (Review Focus):

```bash
docker compose -f docker/docker-compose.yml stop postgres
sleep 6
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/api/agents
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/api/health
docker compose -f docker/docker-compose.yml start postgres
```

Expected: `503`, then `200`, and the api-server process is still running (it logs a pool error and carries on). After Postgres is back and the 5-second status cache has expired, `curl -s localhost:3001/api/agents` returns the list again without a restart.

Then stop the backend, remove the `ai:` block from `shipit.config.local.yaml`, and start it again. Expected log line: `Agent features: off (ai.enabled is false or ai.database.url is empty).`, `/api/health` is `200`, and `/api/agents` is `503` with `database` among the failing checks. Put the block back afterwards.

- [ ] **Step 5: Build the api-server image**

```bash
docker build -f packages/api-server/Dockerfile -t shipit-api-server:foundation .
docker run --rm shipit-api-server:foundation ls node_modules/@shipit-ai/agents/dist/migrate-cli.js
```

Expected: the build succeeds and the file is listed. A failure with `TS2307: Cannot find module '@shipit-ai/agents'` means the `COPY packages/agents/` line from Task 6 is missing.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/api-server/src/index.ts docker/docker-compose.yml docs
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add packages/api-server/src/index.ts docker/docker-compose.yml docs
git commit -m "api-server: open the agent store at boot when a database is configured; compose migrate service; docs"
```

---

## Task 9: Vertex model-layer probe

This is a spike. Its output is a findings note, not code that stays. It can run in parallel with Tasks 1 to 8, and it gates the **next** plan (runner and model layer), not this one.

**Prerequisites, all outside this repo:**

- `gcloud auth application-default login` on the machine that runs it.
- The Vertex AI API enabled on the project (`ship-it-ai-portal`), and your account holding `roles/aiplatform.user` there.
- At least one Claude model enabled in the project's Model Garden. This is a console step that includes accepting Anthropic's terms.

**Files:**

- Create: `docs/agent/investigations/vertex-model-layer-probe.md`
- Modify: `shipit.config.yaml` (add a Gemini model entry, if the probe passes for Gemini)
- Modify: `docs/agent/decisions/agent-platform-v1-foundations.md` (record the outcome), `docs/agent/MANIFEST.md`

**Interfaces:**

- Consumes: nothing from this plan.
- Produces: a recorded answer to three questions for Claude and for Gemini: does a single call with executor-less tools return the tool calls; does a transcript with signed reasoning survive JSON and get accepted on the next call; is usage reported per call.

- [ ] **Step 1: Set up a throwaway directory outside the repo**

```bash
mkdir -p "$TMPDIR/vertex-probe" && cd "$TMPDIR/vertex-probe"
printf '{ "name": "vertex-probe", "private": true, "type": "module" }\n' > package.json
npm install --no-audit --no-fund ai@7.0.126 @ai-sdk/google-vertex@5.0.101 tsx typescript @types/node
```

- [ ] **Step 2: Write the probe**

Create `$TMPDIR/vertex-probe/probe.ts`. This file typechecks against `ai@7.0.126` and `@ai-sdk/google-vertex@5.0.101`:

```ts
// Vertex model-layer probe. THROWAWAY: run it, record what it prints, delete it.
//
// Proves, per model, the three things the agent runner's design depends on:
//   1. one model call with tools declared WITHOUT executors returns the tool
//      calls and stops (we run tools ourselves, behind the permission gate);
//   2. the assistant message, including any signed reasoning, survives being
//      written to and read back from JSON (as it will be in Postgres), and the
//      model accepts it on the next call;
//   3. token usage is reported per call.
//
// Usage:
//   GOOGLE_CLOUD_PROJECT=<project> npx tsx probe.ts anthropic claude-sonnet-5-5
//   GOOGLE_CLOUD_PROJECT=<project> npx tsx probe.ts gemini <gemini model id>
//   GOOGLE_CLOUD_PROJECT=<project> npx tsx probe.ts maas <publisher/model-maas>
import { generateText, isStepCount, jsonSchema, tool, type ModelMessage } from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createVertexMaas } from '@ai-sdk/google-vertex/maas';

const [family, modelId] = process.argv.slice(2);
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'global';
if (!project || !family || !modelId) {
  console.error(
    'usage: GOOGLE_CLOUD_PROJECT=<project> npx tsx probe.ts <anthropic|gemini|maas> <modelId>',
  );
  process.exit(2);
}

const model =
  family === 'anthropic'
    ? createVertexAnthropic({ project, location })(modelId)
    : family === 'maas'
      ? createVertexMaas({ project, location })(modelId)
      : createVertex({ project, location })(modelId);

// Model-facing names use a double underscore: provider name rules reject dots.
const tools = {
  graph__find_owners: tool({
    description: 'Find the owners of an entity in the knowledge graph.',
    inputSchema: jsonSchema<{ entity: string }>({
      type: 'object',
      properties: { entity: { type: 'string', description: 'Entity name or canonical id' } },
      required: ['entity'],
      additionalProperties: false,
    }),
  }),
};

const instructions =
  'You answer questions about a software knowledge graph. Always use the tools; never guess an owner.';
const messages: ModelMessage[] = [{ role: 'user', content: 'Who owns payments-api?' }];

const first = await generateText({
  model,
  instructions,
  messages,
  tools,
  stopWhen: isStepCount(1),
});
const calls = first.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input }));
console.log('step 1 finishReason:', first.finishReason);
console.log('step 1 toolCalls:', JSON.stringify(calls));
console.log('step 1 usage:', JSON.stringify(first.usage));
console.log(
  'step 1 assistant part types:',
  first.responseMessages.flatMap((m) =>
    typeof m.content === 'string' ? ['text'] : m.content.map((p) => p.type),
  ),
);
if (calls.length === 0) {
  console.error('FAIL: the model did not call the tool, so checks 1 and 2 are not proven.');
  process.exit(1);
}

// The round trip a paused run makes: transcript -> JSON -> transcript.
const stored = JSON.stringify([...messages, ...first.responseMessages]);
const restored = JSON.parse(stored) as ModelMessage[];
console.log('stored transcript bytes:', stored.length);

const second = await generateText({
  model,
  instructions,
  messages: [
    ...restored,
    {
      role: 'tool',
      content: calls.map((call) => ({
        type: 'tool-result' as const,
        toolCallId: call.id,
        toolName: call.name,
        output: {
          type: 'json' as const,
          value: { owners: ['team-payments'], source: 'CODEOWNERS' },
        },
      })),
    },
  ],
  tools,
  stopWhen: isStepCount(1),
});
console.log('step 2 finishReason:', second.finishReason);
console.log('step 2 text:', second.text.slice(0, 200));
console.log('step 2 usage:', JSON.stringify(second.usage));
console.log(
  second.text.includes('team-payments')
    ? 'PASS: tool call returned, transcript survived JSON, model used the tool result.'
    : 'CHECK: the reply did not mention team-payments; read it before calling this a pass.',
);
```

- [ ] **Step 3: Run it for Claude**

```bash
GOOGLE_CLOUD_PROJECT=ship-it-ai-portal npx tsx probe.ts anthropic claude-sonnet-5-5
```

Expected on success: `step 1 toolCalls:` with one `graph__find_owners` call, `step 1 assistant part types:` (note whether a `reasoning` part is listed), and a final `PASS:` line.

How to read a failure:

| Output                                                                                          | Meaning                                                                    | What to do                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Could not load the default credentials`                                                        | No ADC                                                                     | `gcloud auth application-default login`                  |
| `403` / `PERMISSION_DENIED`                                                                     | Missing `roles/aiplatform.user`, or the API is not enabled                 | Fix in GCP; not a design problem                         |
| `404` naming the model, or a message about the model not being enabled                          | Claude is not enabled in Model Garden, or the id is wrong for this project | Enable it; try `claude-opus-5-5`                         |
| Step 1 passes, step 2 errors with a message about `thinking`, `signature` or an invalid message | **The JSON round-trip loses signed reasoning.**                            | This is the result that matters. Record the exact error. |
| `FAIL: the model did not call the tool`                                                         | The model answered without the tool                                        | Re-run once; if it repeats, record it                    |

- [ ] **Step 4: Run it for Gemini**

Find the current Gemini model id on its Model Garden card in the Vertex console ("Model ID"), then:

```bash
GOOGLE_CLOUD_PROJECT=ship-it-ai-portal npx tsx probe.ts gemini <model id>
```

Same reading as Step 3. For Gemini 3 models a step-2 error mentioning `thought_signature` is the round-trip failure.

- [ ] **Step 5: Optionally run it for one open model**

```bash
GOOGLE_CLOUD_PROJECT=ship-it-ai-portal npx tsx probe.ts maas <publisher/model-maas id>
```

A failure here does not block anything: the design marks such a model `tools: false`.

- [ ] **Step 6: Record the findings**

Create `docs/agent/investigations/vertex-model-layer-probe.md`, filling every `<…>` from what the probe printed:

```markdown
---
type: investigation
status: completed
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
author: <session or person>
tags: [ai, agents, vertex, model-layer, spike]
importance: core
---

# Vertex model-layer probe: does the AI SDK Vertex provider support our run loop?

## Symptoms

Not a bug hunt. The design (`docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md`
§Model layer) rested on facts read from docs and SDK source. This probe ran them live.

## Root Cause

Results, with `ai@7.0.126` and `@ai-sdk/google-vertex@5.0.101`, project `ship-it-ai-portal`,
location `global`:

| Check                                                     | Claude (`<model id>`) | Gemini (`<model id>`) |
| --------------------------------------------------------- | --------------------- | --------------------- |
| One call, tools without executors, returns tool calls     | <pass / fail + error> | <pass / fail + error> |
| Assistant message types returned                          | <list>                | <list>                |
| Transcript survives JSON and is accepted on the next call | <pass / fail + error> | <pass / fail + error> |
| Usage reported per call                                   | <the usage JSON>      | <the usage JSON>      |

Open model (`<id>`, optional): <result>.

## Fix

<One of:>
- Both passed: the model layer is the AI SDK Vertex provider, as designed.
- The round trip failed for <model>: the model layer for that family uses the direct SDK
  (`@anthropic-ai/vertex-sdk` or `@google/genai`) behind the same `ModelClient` interface.

## Prevention

The runner plan adds an opt-in live suite gated on `VERTEX_TEST_PROJECT` that repeats these
checks, so an SDK upgrade that breaks the round trip is caught before release.

## Related

- [agent-platform-v1-foundations](../decisions/agent-platform-v1-foundations.md)
- [ai-agents-and-workflows](../plans/ai-agents-and-workflows.md)
```

Add its line to `docs/agent/MANIFEST.md` under Investigations and bump the note count. In `docs/agent/decisions/agent-platform-v1-foundations.md`, replace the Consequences bullet that calls the AI SDK "the leading candidate; the spec locks it" with the outcome and a link to the note.

- [ ] **Step 7: If Gemini passed, add it to the model catalog**

In `shipit.config.yaml`, under `ai.models`, add (with the id that worked):

```yaml
- key: gemini
  label: Gemini
  family: gemini
  modelId: <the id that passed>
  contextWindow: <from the model card>
  tools: true
```

Run `pnpm --filter @shipit-ai/shared test` to confirm the config still validates.

- [ ] **Step 8: Delete the throwaway directory and commit the findings**

```bash
rm -rf "$TMPDIR/vertex-probe"
npx prettier --write docs/agent shipit.config.yaml
pnpm format:check
git add docs/agent shipit.config.yaml
git commit -m "docs: Vertex model-layer probe findings"
```

---

## Self-review notes

- **Spec coverage.** §Packages (`packages/agents`, `db/migrations`, compose and CI Postgres): Tasks 1, 2, 8. §Data model: `agents` and `agent_versions` only; the other eleven tables arrive with the features that use them, each in its own numbered migration. §Schema version handshake: Tasks 1 and 6. §Agent definition: Task 3, minus the test panel and Publish diff, which are UI. §API: the `/ai/status`, `/ai/models` and `/agents` rows; runs, approvals, triggers, workflows and connections belong to later plans. §Config: `enabled`, `database`, `vertex`, `models`, `defaultModel`, `limits`; the `runner`, `approvals`, `triggers` and `retention` keys are added by the plans that read them. §Secrets: `DATABASE_URL` as a plain env placeholder. §Feature gating: Task 6 implements five of the six checks; `key` arrives with tool connections. §Testing: the `agents` unit and integration rows and the api-server row, as far as this plan's routes go.
- **Deviations from the spec, on purpose:**
  - The migration CLI lives in the package (`packages/agents/src/migrate-cli.ts`, run by `pnpm db:migrate`) instead of `scripts/db-migrate.ts`, so the compose `migrate` service can run the same code from inside the api-server image.
  - `ai.database.url` carries the connection string (fed by `${DATABASE_URL:-}`), matching how `backend.neo4j` and `backend.redis` are configured, instead of reading `process.env` directly.
  - A slug is unique among **live** agents, so archiving frees it.
  - `AiStatus` has a second flag, `definitionsAvailable`, because definitions are usable before a runner exists.
- **Not in this plan, by design:** the runner, the model client, tools, runs, the built-in agent, the graph projection, and every UI page. They are the next plan, written after Task 9 reports.
- **`seed:reset` is unchanged.** Agent definitions are configuration and survive a reset, like connector config. The plan that adds runs will make `seed:reset` clear run history, per the pattern `reset-script-must-drain-redis-surfaces`.
