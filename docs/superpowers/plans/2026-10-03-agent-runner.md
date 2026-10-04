# Agent Runner Implementation Plan (Milestone 1, second half: backend)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can be run: `POST /api/agents/:id/runs` queues a run, a new `agent-runner` process calls a model on Vertex AI one step at a time, runs the graph read tools the agent is granted, records every message and tool call in Postgres, and `GET /api/runs/:id/stream` shows it live. Ask's built-in Graph assistant exists and answers questions about the catalog.

**Architecture:** The api-server stays the control plane (creates runs, queues their ids on BullMQ, takes chat messages and cancels, streams runs). A new `@shipit-ai/agent-runner` process is the data plane: a BullMQ worker hands each run id to a run loop, which works as a state machine over the stored transcript, so resuming after a crash is the normal code path. A run is held by one worker through a lease in Postgres. The model layer is the AI SDK's Vertex provider behind a `ModelClient` interface; the graph tools are the MCP server's own handlers, reused in-process. This plan is the backend; the UI (agent editor, test panel, run view, Ask) is the next plan.

**Tech Stack:** TypeScript (ESM, Node 22), `ai` 7 + `@ai-sdk/google-vertex` 5, BullMQ 5 + ioredis, `pg` 8, Zod 4, Fastify 5 (Server-Sent Events), Vitest 4, Postgres 17, Redis 7, Docker.

**Spec:** `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md` (§Model layer, §Run lifecycle, §Tool gateway, §Tool sources → Graph read, §API → runs, §Config, §Feature gating, §Built-in agent, §Testing; Milestone 1). Probe findings: `docs/agent/investigations/vertex-model-layer-probe.md`.

**How this plan was checked.** Every code block was first written and run in a scratch worktree, then replayed into a clean one task by task: after each task the workspace typechecked and that task's suites passed, and each block below is the diff git computed between consecutive task states. On this machine, against Docker Postgres 17 and Redis 7: the whole workspace gate (`pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`) and every Postgres and Redis integration suite passed; the live suite passed against `gemini-3.8-flash` and `gemini-3.1-pro-preview` on Vertex; the real runner process, started from its build, answered questions through the real graph tools, through the HTTP API and its live stream; the agent-runner image built. Claude was not run: the project has no Claude quota yet (see the probe note).

**Base, and a rebase before executing.** The diffs below are against `2186875` (branch `ai-agents-design` on 2026-10-03). The knowledge-layer K0 work (`docs/superpowers/plans/2026-10-03-knowledge-foundations.md`, another session, same branch) also adds migration `0002` and edits several of the same files (compose, CI, root `vitest.config.ts` and `package.json`, the shared config schema, the api-server test config, `server.ts` and `index.ts`, where it introduces a shared Postgres pool). Agreed with that session on 2026-10-03: K0 keeps `0002_knowledge.sql`; this plan's migration becomes **`0003_runs.sql`** and `EXPECTED_SCHEMA_VERSION` **`'0003'`**. Once K0's commits are on the branch, regenerate this plan's diffs on top of them (apply this plan to `2186875`, then merge onto the K0 head and resolve the shared files), and re-run every task's checks. K0 also adds `.superpowers/` to `.prettierignore`.

## Global Constraints

- **Run commands from the repo root.** One test file: `pnpm --filter <package> exec vitest run <path>`.
- **Verify before each commit:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`. Run `npx prettier --write <files>` on what you touch.
- **Commits:** the owner approved committing at each plan commit step and pushing after each commit on `ai-agents-design`. No `Co-Authored-By` or other AI-attribution trailer. Pushing anywhere else, a PR or a merge each needs its own approval.
- **Never commit `packages/web-ui/next-env.d.ts`** (test runs rewrite it).
- **Postgres-backed suites** are `*.integration.test.ts`, gated on `DATABASE_TEST_URL`, run with `--no-file-parallelism`. Redis-backed ones also need `REDIS_TEST_URL`. Local values: `DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit`, `REDIS_TEST_URL=redis://localhost:6379`. Docker must be running (`pnpm start:infra`).
- **New workspace dependency in three places** (scar `docker-builder-copies-fixed-package-set`): the consuming package's Dockerfile `COPY` list, its vitest alias list, the lockfile.
- **BullMQ:** no colon in a queue name or job id (scar `bullmq-5-forbids-colons-in-queue-names-and-job-ids`); every Queue, Worker and ioredis client gets an `error` listener (scar `redis-memory-limit-below-dataset-oomkills`).
- **The transcript is stored verbatim.** `run_messages.content` is the AI SDK message object as the model layer returned it, `providerOptions` included. Never rebuild or edit a stored message: dropping Gemini's `thoughtSignature` does not fail, the SDK silently replays without the model's reasoning (probe finding).
- **Exact values:**
  - Queue `shipit-agent-runs`; pub/sub channel `shipit-run-events`; heartbeat key `shipit-agent-runner-heartbeat` (15 s writes, 60 s expiry).
  - Run lease 60 s, renewed every 5 s; sweeper every 30 s; a running run with no progress for 2 × its timeout fails `INTERNAL`.
  - Run statuses `queued | running | waiting_approval | waiting_input | succeeded | failed | cancelled`; error codes `BUDGET_EXCEEDED | STEP_LIMIT | TIMEOUT | CONTEXT_EXCEEDED | MODEL_REFUSED | MODEL_ERROR | DAILY_LIMIT | INTERNAL`.
  - Tool names to the model: `graph.find_owners` becomes `graph__find_owners`.
  - Config defaults: `ai.runner.concurrency: 4`, `ai.limits.toolResultChars: 50000`, `ai.limits.chatIdleMinutes: 60`.
  - Built-in agent slug `graph-assistant`.
  - Run input: text of 1 to 20,000 characters, or a JSON object of at most 64,000 characters.

## Review Focus

Conditions the spec implies that a person will hit. Each is pinned by a test in the task that owns the code:

1. **The runner dies in the middle of a run.** Another worker takes the run over once its lease runs out; a read that was in flight is re-run, a write is reported to the model as "outcome unknown" and never repeated. → Task 2 (`lets another worker take over…`), Task 6 (`crash recovery`), Task 7 (`re-queues a run whose worker died…`).
2. **A model keeps calling tools until its steps run out.** On the last step the run asks for an answer from what it found, so it ends with an answer, not a bare `STEP_LIMIT`; if the model still calls a tool, nothing runs past the limit. → Task 6 (`asks for an answer on the last allowed step…`, `fails with STEP_LIMIT…`).
3. **A model calls a tool it was not given, or with bad input.** The gateway records a denied or failed call and tells the model; the SDK never answers a call itself. → Task 4 (`hands a call to an undeclared tool to the caller…`), Task 6 (`denies a tool the model invented…`, `returns invalid input…`).
4. **A chat in Ask goes on for many questions.** Step, token and time limits apply per turn, so the conversation does not die after a few questions; the daily cap still bounds spend. → Task 6 (`applies the step and token limits to each turn…`).
5. **Someone is watching a run when the api-server restarts.** The stream ends so the process can exit, and the viewer resumes from the last event it saw. → Task 9 (`ends open streams when the server shuts down…`, `resumes after the last event the client saw…`).

Also checked by hand in Task 11: a stopped Postgres or Redis does not crash either process, and a SIGTERM with a stream open exits within seconds.

## File Structure

| Path                                                    | Responsibility                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/mcp-server/src/tools/registry.ts`             | The 8 graph tools as in-process functions, captured from their `register*` functions.                 |
| `db/migrations/0002_runs.sql`                           | `runs` (with the lease), `run_messages`, `tool_calls`.                                                |
| `packages/agents/src/run-store.ts`                      | `RunStore`: create, claim and lease, messages, steps, tool calls, finish, chat turns, cancel, sweeps. |
| `packages/agents/src/tools.ts`                          | `ToolDescriptor`, grant resolution with the four ceilings, model-facing tool names.                   |
| `packages/agents/src/queues.ts`, `run-queue.ts`         | Queue, channel and key names; `RunQueue` (enqueue) shared by api-server and runner.                   |
| `packages/agents/src/testing.ts`                        | The Postgres test harness, exported as `@shipit-ai/agents/testing`.                                   |
| `packages/agent-runner/src/model/`                      | `ModelClient`, `VertexModelClient`, transcript message builders.                                      |
| `packages/agent-runner/src/tools/`                      | `RunnerTool` and the graph tools.                                                                     |
| `packages/agent-runner/src/loop/agent-loop.ts`          | The run loop (`AgentRuntime`).                                                                        |
| `packages/agent-runner/src/process/`                    | BullMQ worker, run events, heartbeat and sweeper, schema wait.                                        |
| `packages/agent-runner/src/main.ts`                     | Process entry.                                                                                        |
| `packages/api-server/src/routes/runs.ts`                | Runs API and the live stream.                                                                         |
| `packages/api-server/src/services/ai/run-event-hub.ts`  | One Redis subscription fanned out to open streams.                                                    |
| `packages/api-server/src/services/ai/builtin-agents.ts` | The Graph assistant seed.                                                                             |

---

## Task 1: Graph read tools as in-process functions (mcp-server)

The runner must run the same graph tool handlers the MCP server runs. Rather than rewrite eight inline closures, a registry runs each existing `register*` function against a recorder that keeps the input shape and handler it registers (the MCP tool tests already capture handlers this way). The tool metadata gains `service` and `effect`, which the agent gateway grants by.

**Files:**

- Modify: `packages/mcp-server/package.json`
- Test: `packages/mcp-server/src/__tests__/metadata.test.ts` (modify)
- Test: `packages/mcp-server/src/__tests__/registry.test.ts` (create)
- Modify: `packages/mcp-server/src/tools/metadata.ts`
- Create: `packages/mcp-server/src/tools/registry.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `graphReadTools(neo4j: Neo4jClient, config: GraphToolConfig): GraphReadTool[]` from `@shipit-ai/mcp-server/tools`, where `GraphReadTool = { name; description; effect; inputSchema: z.ZodObject; run(params): Promise<unknown> }` and `GraphToolConfig = { rateLimits: { rowLimit; hopLimit } }`.
  - `createNeo4jClient` and `Neo4jClient`, re-exported from the same entry (so the runner never imports the package root, which loads the MCP transports).
  - `McpToolMetadata.service: 'graph'` and `effect: 'read' | 'write' | 'delete'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/src/__tests__/registry.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';
import { captureTool, toolPayload } from './helpers/capture-tool.js';
import { registerFindOwners } from '../tools/find-owners.js';
import { graphReadTools } from '../tools/registry.js';
import { MCP_TOOLS } from '../tools/metadata.js';

const RATE_LIMITS = { rateLimits: { rowLimit: 100, hopLimit: 6 } };

function ownersResponses() {
  const responses = new Map();
  responses.set('MATCH (entity {id: $entityId})', {
    records: [
      createMockRecord({
        entity: {
          properties: { id: 'shipit://logical-service/default/graph-api', name: 'graph-api' },
        },
        owners: [{ properties: { id: 'shipit://team/default/api-team', name: 'api-team' } }],
        codeowners: [],
        on_call: [],
      }),
    ],
    summary: { resultAvailableAfter: 1 },
  });
  return responses;
}

describe('graphReadTools', () => {
  it('exposes every tool the MCP server registers, in metadata order', () => {
    const tools = graphReadTools(createMockNeo4jClient(), RATE_LIMITS);
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      const meta = MCP_TOOLS.find((m) => m.name === tool.name)!;
      expect(tool.description).toBe(meta.description);
      expect(tool.effect).toBe(meta.effect);
    }
  });

  it('gives each tool a Zod input schema, empty for schema_info', () => {
    const tools = graphReadTools(createMockNeo4jClient(), RATE_LIMITS);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName.schema_info.inputSchema.shape)).toEqual([]);
    expect(Object.keys(byName.find_owners.inputSchema.shape)).toEqual([
      'entity',
      'include_chain',
      'include_absent',
      'compact',
    ]);
    // Defaults apply on parse, exactly as the MCP SDK applies them.
    expect(byName.find_owners.inputSchema.parse({ entity: 'x' })).toEqual({
      entity: 'x',
      include_chain: false,
      include_absent: false,
      compact: false,
    });
  });

  it('returns the same payload as the MCP tool, parsed instead of stringified', async () => {
    const viaMcp = toolPayload(
      await captureTool(
        registerFindOwners,
        createMockNeo4jClient(ownersResponses()) as never,
      )({
        entity: 'shipit://logical-service/default/graph-api',
        include_chain: false,
        include_absent: false,
        compact: true,
      }),
    );
    const tool = graphReadTools(createMockNeo4jClient(ownersResponses()), RATE_LIMITS).find(
      (t) => t.name === 'find_owners',
    )!;
    const direct = await tool.run(
      tool.inputSchema.parse({
        entity: 'shipit://logical-service/default/graph-api',
        compact: true,
      }),
    );
    expect(direct).toEqual(viaMcp);
  });

  it('passes the row and hop limits through to graph_query', async () => {
    const tool = graphReadTools(createMockNeo4jClient(), {
      rateLimits: { rowLimit: 100, hopLimit: 2 },
    }).find((t) => t.name === 'graph_query')!;
    const result = (await tool.run(
      tool.inputSchema.parse({ query: 'MATCH (a)-[*..5]->(b) RETURN b' }),
    )) as { error: { code: string } };
    expect(result.error.code).toBe('HOP_LIMIT_EXCEEDED');
  });

  it('rejects input the schema does not allow before any query runs', () => {
    const neo4j = createMockNeo4jClient();
    const tool = graphReadTools(neo4j, RATE_LIMITS).find((t) => t.name === 'blast_radius')!;
    expect(tool.inputSchema.safeParse({ node: 'x', depth: 99 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(neo4j.runCypher).not.toHaveBeenCalled();
    expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
  });
});
```
<!-- prettier-ignore-end -->

`packages/mcp-server/src/__tests__/metadata.test.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/mcp-server/src/__tests__/metadata.test.ts b/packages/mcp-server/src/__tests__/metadata.test.ts
index 19caf19..b982dd2 100644
--- a/packages/mcp-server/src/__tests__/metadata.test.ts
+++ b/packages/mcp-server/src/__tests__/metadata.test.ts
@@ -1,5 +1,5 @@
 import { describe, it, expect } from 'vitest';
-import { MCP_TOOL_BY_NAME } from '../tools/metadata.js';
+import { MCP_TOOLS, MCP_TOOL_BY_NAME } from '../tools/metadata.js';
 
 describe('MCP tool metadata — include_absent', () => {
   it.each([
@@ -23,3 +23,11 @@ describe('MCP tool metadata — include_absent', () => {
     );
   });
 });
+
+describe('MCP tool metadata — service and effect', () => {
+  // Agents see these tools as service 'graph'. All eight only read; a write
+  // tool added here must say so, because the agent gateway grants by effect.
+  it.each(MCP_TOOLS.map((t) => t.name))('%s is a graph read tool', (tool) => {
+    expect(MCP_TOOL_BY_NAME[tool]).toMatchObject({ service: 'graph', effect: 'read' });
+  });
+});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run them to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/mcp-server exec vitest run src/__tests__/registry.test.ts src/__tests__/metadata.test.ts
```

Expected: FAIL — `registry.test.ts` cannot resolve `../tools/registry.js`; in `metadata.test.ts` the 8 `is a graph read tool` cases fail.

- [ ] **Step 3: Implement**

Create `packages/mcp-server/src/tools/registry.ts`:

<!-- prettier-ignore-start -->
```ts
// The graph read tools as plain in-process functions, for callers that are not
// MCP clients (the agent runner). Each tool's existing `register*` function is
// run against a recorder that keeps the input shape and handler it registers,
// so the MCP server and the runner execute the same code: there is one handler
// per tool, not a copy.
//
// This module imports no value from the MCP SDK, so the runner can load it
// without starting a server.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '../neo4j-client.js';
import type { McpServerConfig } from '../config.js';
import { registerBlastRadius } from './blast-radius.js';
import { registerEntityDetail } from './entity-detail.js';
import { registerSchemaInfo } from './schema-info.js';
import { registerFindOwners } from './find-owners.js';
import { registerDependencyChain } from './dependency-chain.js';
import { registerGraphStats } from './graph-stats.js';
import { registerSearchEntities } from './search-entities.js';
import { registerGraphQuery } from './graph-query.js';
import { MCP_TOOL_BY_NAME, type McpToolMetadata } from './metadata.js';

// The runner opens its own read-session client; re-exported so it never has to
// import the package root, which pulls in the MCP transports.
export { createNeo4jClient } from '../neo4j-client.js';
export type { Neo4jClient } from '../neo4j-client.js';

export interface GraphReadTool {
  /** The MCP tool name, e.g. 'blast_radius'. */
  name: string;
  description: string;
  /** From the tool's metadata. Every graph tool today only reads. */
  effect: McpToolMetadata['effect'];
  /** Validates and fills defaults. Parse with it before calling `run`. */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * Runs the tool on already-parsed input and returns its payload: the JSON the
   * MCP tool would send as text, as an object. Tool-level failures (unknown
   * node, hop limit) come back as `{ error: { code, message } }`, not thrown.
   */
  run(params: Record<string, unknown>): Promise<unknown>;
}

/** The slice of the MCP server config the tools read (graph_query's guardrails). */
export interface GraphToolConfig {
  rateLimits: Pick<McpServerConfig['rateLimits'], 'rowLimit' | 'hopLimit'>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

export function graphReadTools(neo4j: Neo4jClient, config: GraphToolConfig): GraphReadTool[] {
  const tools: GraphReadTool[] = [];
  // server.tool(name, description, handler) or server.tool(name, description, shape, handler).
  const recorder = {
    tool: (name: string, description: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as ToolHandler;
      const shape = (rest.length > 1 ? rest[0] : {}) as z.ZodRawShape;
      tools.push({
        name,
        description,
        effect: MCP_TOOL_BY_NAME[name]!.effect,
        inputSchema: z.object(shape),
        run: async (params) => JSON.parse((await handler(params)).content[0]!.text) as unknown,
      });
    },
  } as unknown as McpServer;

  registerBlastRadius(recorder, neo4j);
  registerEntityDetail(recorder, neo4j);
  registerSchemaInfo(recorder, neo4j);
  registerFindOwners(recorder, neo4j);
  registerDependencyChain(recorder, neo4j);
  registerGraphStats(recorder, neo4j);
  registerSearchEntities(recorder, neo4j);
  registerGraphQuery(recorder, neo4j, config as McpServerConfig);
  return tools;
}
```
<!-- prettier-ignore-end -->

`packages/mcp-server/src/tools/metadata.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/mcp-server/src/tools/metadata.ts b/packages/mcp-server/src/tools/metadata.ts
index bae25e2..c8ab049 100644
--- a/packages/mcp-server/src/tools/metadata.ts
+++ b/packages/mcp-server/src/tools/metadata.ts
@@ -16,6 +16,10 @@ export interface McpToolParamSpec {
 export interface McpToolMetadata {
   name: string;
   description: string;
+  /** The service agents see this tool under. Every MCP tool is a graph tool. */
+  service: 'graph';
+  /** What the tool does to the service; the agent gateway grants by effect. */
+  effect: 'read' | 'write' | 'delete';
   /** Anchor on docs/mcp-tools.md (the tool name itself, slugified). */
   docAnchor: string;
   params: readonly McpToolParamSpec[];
@@ -44,6 +48,8 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     description:
       'Analyze downstream/upstream impact of a node in the knowledge graph. Returns affected nodes, paths, and summary statistics.',
     docAnchor: 'blast_radius',
+    service: 'graph',
+    effect: 'read',
     params: [
       {
         name: 'node',
@@ -89,6 +95,8 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     description:
       'Get detailed information about a single entity in the knowledge graph, including properties, claims, and neighbors.',
     docAnchor: 'entity_detail',
+    service: 'graph',
+    effect: 'read',
     params: [
       { name: 'entity', type: 'string', required: true, description: 'Entity canonical ID.' },
       {
@@ -114,6 +122,8 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     description:
       'Return the current graph schema: all node types with property definitions and resolution strategies, all relationship types with direction and cardinality.',
     docAnchor: 'schema_info',
+    service: 'graph',
+    effect: 'read',
     params: [],
   },
   {
@@ -121,6 +131,8 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     description:
       'Find owners, code owners, and on-call personnel for an entity. Traverses OWNS, CODEOWNER_OF, MEMBER_OF, and ON_CALL_FOR relationships.',
     docAnchor: 'find_owners',
+    service: 'graph',
+    effect: 'read',
     params: [
       { name: 'entity', type: 'string', required: true, description: 'Entity canonical ID.' },
       {
@@ -138,6 +150,8 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     name: 'dependency_chain',
     description: 'Find the shortest dependency path between two entities in the knowledge graph.',
     docAnchor: 'dependency_chain',
+    service: 'graph',
+    effect: 'read',
     params: [
       { name: 'from', type: 'string', required: true, description: 'Source node canonical ID.' },
       { name: 'to', type: 'string', required: true, description: 'Target node canonical ID.' },
@@ -157,12 +171,16 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     description:
       'Return aggregate statistics about the knowledge graph: node counts by label, edge counts by type, environments, totals, and freshness summary.',
     docAnchor: 'graph_stats',
+    service: 'graph',
+    effect: 'read',
     params: [INCLUDE_ABSENT_PARAM],
   },
   {
     name: 'search_entities',
     description: 'Search and filter entities in the knowledge graph by label and property values.',
     docAnchor: 'search_entities',
+    service: 'graph',
+    effect: 'read',
     params: [
       {
         name: 'label',
@@ -199,6 +217,8 @@ export const MCP_TOOLS: readonly McpToolMetadata[] = [
     description:
       'Execute a raw Cypher query against the knowledge graph. Read-only queries only. Subject to guardrails: parameterized queries, timeout, row limit, hop limit.',
     docAnchor: 'graph_query',
+    service: 'graph',
+    effect: 'read',
     params: [
       {
         name: 'query',
```
<!-- prettier-ignore-end -->

`packages/mcp-server/package.json`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/mcp-server/package.json b/packages/mcp-server/package.json
index 9d5bc90..0d20325 100644
--- a/packages/mcp-server/package.json
+++ b/packages/mcp-server/package.json
@@ -13,6 +13,10 @@
     "./metadata": {
       "import": "./dist/tools/metadata.js",
       "types": "./dist/tools/metadata.d.ts"
+    },
+    "./tools": {
+      "import": "./dist/tools/registry.js",
+      "types": "./dist/tools/registry.d.ts"
     }
   },
   "scripts": {
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/mcp-server exec vitest run && pnpm --filter @shipit-ai/mcp-server build
```

Expected: PASS — 13 files, 105 tests (registry 5, metadata 15); `dist/tools/registry.js` exists.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/package.json packages/mcp-server/src/__tests__/metadata.test.ts packages/mcp-server/src/__tests__/registry.test.ts packages/mcp-server/src/tools/metadata.ts packages/mcp-server/src/tools/registry.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/mcp-server/package.json packages/mcp-server/src/__tests__/metadata.test.ts packages/mcp-server/src/__tests__/registry.test.ts packages/mcp-server/src/tools/metadata.ts packages/mcp-server/src/tools/registry.ts
git commit -m "mcp-server: graph read tools as in-process functions for the agent runner"
```

---

## Task 2: Runs schema and the run store (agents)

Runs, their transcripts and their tool calls go in Postgres. A run is worked by one runner at a time through a **lease** (`lease_owner`, `lease_expires_at`): a worker claims a queued run, renews the lease while it works, and gives it up when the run parks or ends. A running run whose lease ran out (its worker died) can be claimed again; writes from a worker that lost its lease are refused. The Postgres test harness moves to `src/testing.ts` and is exported as `@shipit-ai/agents/testing`, so the runner's and api-server's suites can use it.

**Files:**

- Create: `db/migrations/0002_runs.sql`
- Modify: `packages/agents/package.json`
- Test: `packages/agents/src/__tests__/run-store.integration.test.ts` (create)
- Test: `packages/agents/src/__tests__/test-db.ts` (modify)
- Modify: `packages/agents/src/index.ts`
- Create: `packages/agents/src/run-store.ts`
- Modify: `packages/agents/src/schema-version.ts`
- Create: `packages/agents/src/testing.ts`

**Interfaces:**

- Consumes: `Db`, `AgentDefinition`, `GrantPolicy`, `ToolEffect` (foundation plan).
- Produces (from `@shipit-ai/agents`):
  - `class RunStore { constructor(db: Db) }` with `create(input: CreateRunInput): Promise<RunRecord>`, `get(id)`, `list({ agentId?, status?, limit?, offset? })`, `claim(id, owner, leaseSeconds)`, `renewLease(id, owner, leaseSeconds): Promise<{ held; cancelRequested }>`, `expiredLeases(): Promise<string[]>`, `appendMessages(id, messages, owner?)`, `listMessages(id, { afterSeq? })`, `recordStep(id, { input, output })`, `addWarning(id, text)`, `finish(id, outcome, owner?)`, `waitForInput(id, owner?)`, `addUserMessage(id, message)`, `requestCancel(id)`, `startToolCall(input)`, `finishToolCall(id, result)`, `listToolCalls(runId)`, `tokensSince(agentId, since)`, `failStalled()`, `closeIdleChats(idleMinutes)`.
  - Errors `RunNotFoundError`, `RunNotWaitingError` (with `status`), `RunLeaseLostError`; constants `RUN_STATUSES`, `TERMINAL_RUN_STATUSES`; types `RunRecord`, `RunMessageRecord`, `StoredMessage`, `ToolCallRecord`, `StartToolCallInput`, `RunStatus`, `RunMode`, `RunWritePolicy`, `RunTriggerKind`, `RunError`, `RunErrorCode`, `ToolCallStatus`, `CreateRunInput`, `ListRunsOptions`.
  - `@shipit-ai/agents/testing`: `createTestDatabase()`, `createMigratedTestDatabase()`, `DATABASE_TEST_URL`, `MIGRATIONS_DIR`, `TestDatabase`.
  - `EXPECTED_SCHEMA_VERSION = '0002'`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/__tests__/run-store.integration.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentStore } from '../agent-store.js';
import type { AgentDefinition } from '../definition.js';
import { runMigrations } from '../migrate.js';
import {
  RunLeaseLostError,
  RunNotFoundError,
  RunNotWaitingError,
  RunStore,
  type CreateRunInput,
  type StoredMessage,
} from '../run-store.js';
import {
  createTestDatabase,
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  type TestDatabase,
} from './test-db.js';

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

const userMessage = (text: string): StoredMessage => ({ role: 'user', content: text });

describe.skipIf(!DATABASE_TEST_URL)('RunStore — Postgres integration', () => {
  let database: TestDatabase;
  let runs: RunStore;
  let agentId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    runs = new RunStore(database.db);
    const agent = await new AgentStore(database.db).create({
      slug: 'owners',
      name: 'Owners',
      definition,
      actor: 'admin@example.com',
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
  });

  const make = (extra: Partial<CreateRunInput> = {}) =>
    runs.create({
      agentId,
      agentVersion: 1,
      definition,
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode: 'task',
      input: { text: 'Who owns payments-api?' },
      messages: [userMessage('Who owns payments-api?')],
      ...extra,
    });

  it('creates a queued run with its first message and reads it back', async () => {
    const run = await make();
    expect(run).toMatchObject({
      agentId,
      agentVersion: 1,
      definition,
      parentRunId: null,
      rootRunId: run.id,
      depth: 0,
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode: 'task',
      writePolicy: 'as_granted',
      status: 'queued',
      input: { text: 'Who owns payments-api?' },
      output: null,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
      cancelRequested: false,
      warnings: [],
      startedAt: null,
      finishedAt: null,
    });
    expect(await runs.get(run.id)).toEqual(run);
    const messages = await runs.listMessages(run.id);
    expect(messages.map((m) => [m.seq, m.role, m.content])).toEqual([
      [0, 'user', userMessage('Who owns payments-api?')],
    ]);
  });

  it('returns null for an unknown or malformed id', async () => {
    expect(await runs.get('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await runs.get('not-a-uuid')).toBeNull();
  });

  it('links a child run to its parent and root, one level deeper', async () => {
    const parent = await make();
    const child = await make({ parentRunId: parent.id, triggerKind: 'agent_tool' });
    expect(child).toMatchObject({ parentRunId: parent.id, rootRunId: parent.id, depth: 1 });
  });

  it('claims a queued run exactly once', async () => {
    const run = await make();
    const [a, b] = await Promise.all([
      runs.claim(run.id, 'worker-a', 60),
      runs.claim(run.id, 'worker-b', 60),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: 'running' });
    expect(winners[0]!.startedAt).not.toBeNull();
    expect(await runs.claim(run.id, 'worker-c', 60)).toBeNull();
  });

  it('lets another worker take over a running run whose lease ran out', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    expect(await runs.claim(run.id, 'worker-b', 60)).toBeNull();
    await database.db.query(
      `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    expect(await runs.expiredLeases()).toEqual([run.id]);
    expect(await runs.claim(run.id, 'worker-b', 60)).toMatchObject({ status: 'running' });
    // The old holder finds out when it next renews, and stops.
    expect(await runs.renewLease(run.id, 'worker-a', 60)).toEqual({
      held: false,
      cancelRequested: false,
    });
    expect(await runs.renewLease(run.id, 'worker-b', 60)).toEqual({
      held: true,
      cancelRequested: false,
    });
  });

  it('refuses writes from a worker that no longer holds the lease', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await database.db.query(`UPDATE runs SET lease_owner = 'worker-b' WHERE id = $1`, [run.id]);
    await expect(
      runs.appendMessages(run.id, [{ role: 'assistant', content: 'stale' }], 'worker-a'),
    ).rejects.toBeInstanceOf(RunLeaseLostError);
    await expect(
      runs.finish(run.id, { status: 'succeeded', output: null }, 'worker-a'),
    ).rejects.toBeInstanceOf(RunLeaseLostError);
    await expect(runs.waitForInput(run.id, 'worker-a')).rejects.toBeInstanceOf(RunLeaseLostError);
    expect((await runs.listMessages(run.id)).map((m) => m.seq)).toEqual([0]);
    // The holder's writes go through.
    expect(
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'ok' }], 'worker-b'),
    ).toHaveLength(1);
  });

  it('reports a cancel request to the lease holder when it renews', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    await runs.requestCancel(run.id);
    expect(await runs.renewLease(run.id, 'worker-a', 60)).toEqual({
      held: true,
      cancelRequested: true,
    });
  });

  it('appends messages with consecutive sequence numbers and lists them after a seq', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const appended = await runs.appendMessages(run.id, [
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
      { role: 'tool', content: [] },
    ]);
    expect(appended.map((m) => m.seq)).toEqual([1, 2]);
    const after = await runs.listMessages(run.id, { afterSeq: 0 });
    expect(after.map((m) => m.role)).toEqual(['assistant', 'tool']);
    // The stored message is the whole object, role included, as the model layer replays it.
    expect(after[0]!.content).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Looking.' }],
    });
  });

  it('adds usage and counts steps', async () => {
    const run = await make();
    await runs.recordStep(run.id, { input: 100, output: 20 });
    const after = await runs.recordStep(run.id, { input: 50, output: 5 });
    expect(after).toMatchObject({ steps: 2, inputTokens: 150, outputTokens: 25 });
  });

  it('records each warning once', async () => {
    const run = await make();
    await runs.addWarning(run.id, 'Tool graph.x is no longer available.');
    const after = await runs.addWarning(run.id, 'Tool graph.x is no longer available.');
    expect(after.warnings).toEqual(['Tool graph.x is no longer available.']);
  });

  it('finishes a run once; a second finish does not overwrite the first', async () => {
    const run = await make();
    await runs.claim(run.id, 'worker-a', 60);
    const done = await runs.finish(run.id, { status: 'succeeded', output: { text: 'team-a' } });
    expect(done).toMatchObject({ status: 'succeeded', output: { text: 'team-a' }, error: null });
    expect(done!.finishedAt).not.toBeNull();
    const again = await runs.finish(run.id, {
      status: 'failed',
      error: { code: 'INTERNAL', message: 'late' },
    });
    expect(again).toBeNull();
    expect((await runs.get(run.id))!.status).toBe('succeeded');
  });

  it('parks a chat run waiting for input, then takes the next message and requeues it', async () => {
    const run = await make({ mode: 'chat' });
    await runs.claim(run.id, 'worker-a', 60);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'Hi.' }]);
    expect(await runs.waitForInput(run.id)).toMatchObject({ status: 'waiting_input' });

    const resumed = await runs.addUserMessage(run.id, userMessage('And payments-db?'));
    expect(resumed.status).toBe('queued');
    const messages = await runs.listMessages(run.id);
    expect(messages.at(-1)).toMatchObject({ seq: 2, role: 'user' });
  });

  it('refuses a message for a run that is not waiting for one', async () => {
    const run = await make({ mode: 'chat' });
    await expect(runs.addUserMessage(run.id, userMessage('x'))).rejects.toBeInstanceOf(
      RunNotWaitingError,
    );
    await expect(
      runs.addUserMessage('00000000-0000-0000-0000-000000000000', userMessage('x')),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('cancels a run that no worker holds at once, and flags a running one', async () => {
    const queued = await make();
    expect(await runs.requestCancel(queued.id)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
    });
    expect(await runs.claim(queued.id, 'worker-a', 60)).toBeNull();

    const running = await make();
    await runs.claim(running.id, 'worker-a', 60);
    expect(await runs.requestCancel(running.id)).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });

    const finished = await make();
    await runs.claim(finished.id, 'worker-a', 60);
    await runs.finish(finished.id, { status: 'succeeded', output: null });
    expect(await runs.requestCancel(finished.id)).toMatchObject({
      status: 'succeeded',
      cancelRequested: false,
    });
    expect(await runs.requestCancel('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('records a tool call from start to finish, and restarts one left executing', async () => {
    const run = await make();
    const base = {
      runId: run.id,
      callId: 'call_1',
      messageSeq: 1,
      toolId: 'graph.find_owners',
      service: 'graph',
      effect: 'read' as const,
      policy: 'allow' as const,
      decision: 'allow' as const,
      input: { entity: 'payments-api' },
    };
    const started = await runs.startToolCall({ ...base, status: 'executing' });
    expect(started).toMatchObject({ status: 'executing', output: null });
    expect(started.startedAt).not.toBeNull();

    // A crash before finishing leaves the row executing; starting the same call
    // again (a read being re-run) reuses the row instead of failing on the key.
    const restarted = await runs.startToolCall({ ...base, status: 'executing' });
    expect(restarted.id).toBe(started.id);

    const finished = await runs.finishToolCall(started.id, {
      status: 'succeeded',
      output: { owners: ['team-a'] },
      outputTruncated: false,
    });
    expect(finished).toMatchObject({ status: 'succeeded', output: { owners: ['team-a'] } });
    expect(finished.finishedAt).not.toBeNull();
    expect((await runs.listToolCalls(run.id)).map((c) => c.callId)).toEqual(['call_1']);
  });

  it('records a call to a tool that does not exist, with no service or effect', async () => {
    const run = await make();
    const denied = await runs.startToolCall({
      runId: run.id,
      callId: 'c9',
      messageSeq: 1,
      toolId: 'graph__drop_database',
      service: null,
      effect: null,
      policy: 'off',
      decision: 'deny',
      status: 'denied',
      input: {},
      error: { code: 'UNKNOWN_TOOL', message: 'no such tool' },
    });
    expect(denied).toMatchObject({
      service: null,
      effect: null,
      status: 'denied',
      error: { code: 'UNKNOWN_TOOL' },
    });
    expect(denied.finishedAt).not.toBeNull();
  });

  it('sums an agent’s tokens since a moment, across runs', async () => {
    const before = new Date(Date.now() - 1000);
    const a = await make();
    const b = await make();
    await runs.recordStep(a.id, { input: 1000, output: 200 });
    await runs.recordStep(b.id, { input: 300, output: 0 });
    expect(await runs.tokensSince(agentId, before)).toBe(1500);
    expect(await runs.tokensSince(agentId, new Date(Date.now() + 60_000))).toBe(0);
  });

  it('lists runs newest first, filtered by agent and status', async () => {
    const first = await make();
    const second = await make();
    await runs.claim(second.id, 'worker-a', 60);
    const all = await runs.list({});
    expect(all.total).toBe(2);
    expect(all.items.map((r) => r.id)).toEqual([second.id, first.id]);
    const running = await runs.list({ agentId, status: 'running' });
    expect(running.items.map((r) => r.id)).toEqual([second.id]);
    expect((await runs.list({ agentId: 'not-a-uuid' })).total).toBe(0);
  });

  it('fails runs that made no progress for twice their timeout', async () => {
    const stuck = await make();
    await runs.claim(stuck.id, 'worker-a', 60);
    const fresh = await make();
    await runs.claim(fresh.id, 'worker-a', 60);
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '601 seconds' WHERE id = $1`,
      [stuck.id],
    );
    expect(await runs.failStalled()).toEqual([stuck.id]);
    expect(await runs.get(stuck.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERNAL' },
    });
    expect((await runs.get(fresh.id))!.status).toBe('running');
  });

  it('closes chat runs idle past the limit', async () => {
    const chat = await make({ mode: 'chat' });
    await runs.claim(chat.id, 'worker-a', 60);
    await runs.waitForInput(chat.id);
    await database.db.query(
      `UPDATE runs SET updated_at = now() - interval '61 minutes' WHERE id = $1`,
      [chat.id],
    );
    expect(await runs.closeIdleChats(60)).toEqual([chat.id]);
    expect((await runs.get(chat.id))!.status).toBe('succeeded');
  });
});
```
<!-- prettier-ignore-end -->

Move the harness first, so the new suite can import it: create `src/testing.ts` and reduce `src/__tests__/test-db.ts` to a re-export.

- [ ] **Step 2: Implement**

Create `packages/agents/src/testing.ts`:

<!-- prettier-ignore-start -->
```ts
// Shared harness for the Postgres-backed suites, in this package and in the
// packages that build on it (exported as @shipit-ai/agents/testing; app code
// never imports it). Each call creates a private schema and a pool whose
// search_path points at it, so suites cannot see each other's tables. The
// suites still run with --no-file-parallelism (scar
// integration-tests-sharing-a-db-must-run-serially): migrations take one
// database-wide advisory lock.
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, type Db } from './db.js';
import { runMigrations } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Set in CI and when Postgres is running locally. Unset: the suites skip. */
export const DATABASE_TEST_URL: string | undefined = process.env.DATABASE_TEST_URL;

/** <repo root>/db/migrations */
export const MIGRATIONS_DIR = resolve(here, '../../../db/migrations');

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

/** A private schema with every migration in db/migrations applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
  return database;
}
```
<!-- prettier-ignore-end -->

`packages/agents/src/__tests__/test-db.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/agents/src/__tests__/test-db.ts b/packages/agents/src/__tests__/test-db.ts
index 9494e02..337809b 100644
--- a/packages/agents/src/__tests__/test-db.ts
+++ b/packages/agents/src/__tests__/test-db.ts
@@ -1,46 +1,2 @@
-// Shared harness for the Postgres-backed suites. Each call creates a private
-// schema and a pool whose search_path points at it, so suites cannot see each
-// other's tables. The suites still run with --no-file-parallelism (see the scar
-// integration-tests-sharing-a-db-must-run-serially): migrations take one
-// database-wide advisory lock.
-import { randomBytes } from 'node:crypto';
-import { dirname, resolve } from 'node:path';
-import { fileURLToPath } from 'node:url';
-import { createDb, createPool, type Db } from '../db.js';
-
-const here = dirname(fileURLToPath(import.meta.url));
-
-/** Set in CI and when Postgres is running locally. Unset: the suites skip. */
-export const DATABASE_TEST_URL: string | undefined = process.env.DATABASE_TEST_URL;
-
-/** <repo root>/db/migrations */
-export const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');
-
-export interface TestDatabase {
-  db: Db;
-  drop(): Promise<void>;
-}
-
-export async function createTestDatabase(): Promise<TestDatabase> {
-  if (!DATABASE_TEST_URL) throw new Error('DATABASE_TEST_URL is not set');
-  const schema = `itest_${randomBytes(6).toString('hex')}`;
-
-  const admin = createPool({ connectionString: DATABASE_TEST_URL, max: 1 });
-  try {
-    await admin.query(`CREATE SCHEMA ${schema}`);
-  } finally {
-    await admin.end();
-  }
-
-  const pool = createPool({ connectionString: DATABASE_TEST_URL, max: 4, searchPath: schema });
-  return {
-    db: createDb(pool),
-    async drop() {
-      try {
-        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
-      } finally {
-        await pool.end();
-      }
-    },
-  };
-}
+// The harness lives in src/testing.ts so other packages' suites can use it.
+export * from '../testing.js';
```
<!-- prettier-ignore-end -->

`packages/agents/package.json`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/agents/package.json b/packages/agents/package.json
index 0f5654f..210266c 100644
--- a/packages/agents/package.json
+++ b/packages/agents/package.json
@@ -9,6 +9,10 @@
     ".": {
       "import": "./dist/index.js",
       "types": "./dist/index.d.ts"
+    },
+    "./testing": {
+      "import": "./dist/testing.js",
+      "types": "./dist/testing.d.ts"
     }
   },
   "scripts": {
```
<!-- prettier-ignore-end -->

- [ ] **Step 3: Run it to verify it fails**

Run:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/run-store.integration.test.ts
```

Expected: FAIL — cannot resolve `../run-store.js`.

Add the migration. The schema-version guard should now fail, because the newest file is `0002` and the constant still says `0001`:

- [ ] **Step 4: Implement**

Create `db/migrations/0002_runs.sql`:

<!-- prettier-ignore-start -->
```sql
-- 0002_runs.sql: agent runs, their transcripts, and the tool calls they make.
--
-- Applied by the migration step, never by the app at boot. Forward-only.

CREATE TABLE runs (
  id                uuid PRIMARY KEY,
  agent_id          uuid NOT NULL REFERENCES agents (id),
  -- The published version the run pins; NULL for a draft run from the test panel.
  agent_version     integer,
  -- The definition the run executes, copied at creation so an edit or a new
  -- version never changes a run in flight.
  definition        jsonb NOT NULL,
  parent_run_id     uuid REFERENCES runs (id),
  root_run_id       uuid NOT NULL,
  depth             integer NOT NULL DEFAULT 0,
  trigger_kind      text NOT NULL,
  trigger_id        uuid,
  triggered_by      text NOT NULL,
  -- 'chat' runs end each turn waiting for the next message; 'task' runs end.
  mode              text NOT NULL,
  write_policy      text NOT NULL DEFAULT 'as_granted',
  status            text NOT NULL DEFAULT 'queued',
  input             jsonb NOT NULL,
  output            jsonb,
  error             jsonb,
  input_tokens      integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  steps             integer NOT NULL DEFAULT 0,
  cancel_requested  boolean NOT NULL DEFAULT false,
  -- The worker holding the run renews this lease while it works. A run whose
  -- lease ran out (its worker died) can be claimed again and resumed.
  lease_owner       text,
  lease_expires_at  timestamptz,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  -- Bumped on every write; the stall sweeper compares it with the timeout.
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_trigger_kind_valid CHECK (trigger_kind IN
    ('manual', 'api', 'schedule', 'webhook', 'event', 'run_completed', 'workflow', 'agent_tool')),
  CONSTRAINT runs_mode_valid CHECK (mode IN ('task', 'chat')),
  CONSTRAINT runs_write_policy_valid CHECK (write_policy IN ('as_granted', 'always_ask')),
  CONSTRAINT runs_status_valid CHECK (status IN
    ('queued', 'running', 'waiting_approval', 'waiting_input', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT runs_depth_nonnegative CHECK (depth >= 0)
);

CREATE INDEX runs_status_idx ON runs (status);
CREATE INDEX runs_agent_created_idx ON runs (agent_id, created_at DESC);
CREATE INDEX runs_root_idx ON runs (root_run_id);
CREATE INDEX runs_created_idx ON runs (created_at DESC);

-- The transcript exactly as the model layer consumes it (each row is one
-- message object, provider metadata included). Append-only.
CREATE TABLE run_messages (
  run_id     uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  role       text NOT NULL,
  content    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT run_messages_role_valid CHECK (role IN ('user', 'assistant', 'tool')),
  CONSTRAINT run_messages_seq_nonnegative CHECK (seq >= 0)
);

CREATE TABLE tool_calls (
  id               uuid PRIMARY KEY,
  run_id           uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  -- The model's id for the call; unique within a run.
  call_id          text NOT NULL,
  -- seq of the assistant message that asked for the call.
  message_seq      integer NOT NULL,
  -- For a call to a tool that does not exist, tool_id is the name the model
  -- used and service and effect are NULL.
  tool_id          text NOT NULL,
  service          text,
  effect           text,
  policy           text NOT NULL,
  decision         text NOT NULL,
  status           text NOT NULL,
  input            jsonb NOT NULL,
  input_hash       text,
  output           jsonb,
  output_truncated boolean NOT NULL DEFAULT false,
  error            jsonb,
  approval_id      uuid,
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT tool_calls_run_call_key UNIQUE (run_id, call_id),
  CONSTRAINT tool_calls_effect_valid CHECK (effect IS NULL OR effect IN ('read', 'write', 'delete')),
  CONSTRAINT tool_calls_policy_valid CHECK (policy IN ('off', 'allow', 'ask')),
  CONSTRAINT tool_calls_decision_valid CHECK (decision IN ('allow', 'ask', 'deny')),
  CONSTRAINT tool_calls_status_valid CHECK (status IN
    ('pending', 'executing', 'succeeded', 'failed', 'denied', 'expired', 'outcome_unknown'))
);

CREATE INDEX tool_calls_run_idx ON tool_calls (run_id);
CREATE INDEX tool_calls_service_effect_idx ON tool_calls (service, effect, started_at);
```
<!-- prettier-ignore-end -->

- [ ] **Step 5: Run it to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/migrate.test.ts
```

Expected: FAIL — `ends at EXPECTED_SCHEMA_VERSION, so the code and the schema move together`.

- [ ] **Step 6: Implement**

`packages/agents/src/schema-version.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/agents/src/schema-version.ts b/packages/agents/src/schema-version.ts
index 8462a8d..d81329c 100644
--- a/packages/agents/src/schema-version.ts
+++ b/packages/agents/src/schema-version.ts
@@ -3,4 +3,4 @@
 // schema_migrations at boot and switch agent features off, without crashing,
 // when the database is behind. Bump it in the same change that adds a file to
 // db/migrations/.
-export const EXPECTED_SCHEMA_VERSION = '0001';
+export const EXPECTED_SCHEMA_VERSION = '0002';
```
<!-- prettier-ignore-end -->

Create `packages/agents/src/run-store.ts`:

<!-- prettier-ignore-start -->
```ts
import { randomUUID } from 'node:crypto';
import type { Db, SqlClient } from './db.js';
import type { AgentDefinition, GrantPolicy, ToolEffect } from './definition.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export type RunMode = 'task' | 'chat';
export type RunWritePolicy = 'as_granted' | 'always_ask';
export type RunTriggerKind =
  'manual' | 'api' | 'schedule' | 'webhook' | 'event' | 'run_completed' | 'workflow' | 'agent_tool';

export type RunErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'STEP_LIMIT'
  | 'TIMEOUT'
  | 'CONTEXT_EXCEEDED'
  | 'MODEL_REFUSED'
  | 'MODEL_ERROR'
  | 'DAILY_LIMIT'
  | 'INTERNAL';

export interface RunError {
  code: RunErrorCode;
  message: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  /** The pinned published version; null for a draft run. */
  agentVersion: number | null;
  definition: AgentDefinition;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;
  triggerKind: RunTriggerKind;
  triggeredBy: string;
  mode: RunMode;
  writePolicy: RunWritePolicy;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: RunError | null;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  cancelRequested: boolean;
  warnings: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** One stored message: the whole model-layer message object, provider metadata included. */
export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  [key: string]: unknown;
}

export interface RunMessageRecord {
  runId: string;
  seq: number;
  role: StoredMessage['role'];
  content: StoredMessage;
  createdAt: string;
}

export type ToolCallStatus =
  'pending' | 'executing' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'outcome_unknown';

export interface ToolCallRecord {
  id: string;
  runId: string;
  callId: string;
  messageSeq: number;
  toolId: string;
  /** Null for a call to a tool that does not exist. */
  service: string | null;
  effect: ToolEffect | null;
  policy: GrantPolicy;
  decision: 'allow' | 'ask' | 'deny';
  status: ToolCallStatus;
  input: unknown;
  output: unknown;
  outputTruncated: boolean;
  error: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateRunInput {
  agentId: string;
  agentVersion: number | null;
  definition: AgentDefinition;
  triggerKind: RunTriggerKind;
  triggeredBy: string;
  mode: RunMode;
  writePolicy?: RunWritePolicy;
  input: unknown;
  /** The opening messages, usually one user message. */
  messages: StoredMessage[];
  parentRunId?: string | null;
}

export interface StartToolCallInput {
  runId: string;
  callId: string;
  messageSeq: number;
  toolId: string;
  service: string | null;
  effect: ToolEffect | null;
  policy: GrantPolicy;
  decision: 'allow' | 'ask' | 'deny';
  status: ToolCallStatus;
  input: unknown;
  /** Set when the call is decided without running (denied, invalid input). */
  error?: unknown;
}

export interface ListRunsOptions {
  agentId?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export class RunNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Run ${id} not found`);
    this.name = 'RunNotFoundError';
  }
}

/** The worker lost the run to another worker (its lease ran out and was taken). */
export class RunLeaseLostError extends Error {
  readonly code = 'RUN_LEASE_LOST';
  constructor(id: string) {
    super(`Run ${id} is held by another worker`);
    this.name = 'RunLeaseLostError';
  }
}

export class RunNotWaitingError extends Error {
  readonly code = 'RUN_NOT_WAITING';
  constructor(
    id: string,
    readonly status: RunStatus,
  ) {
    super(`Run ${id} is ${status}, not waiting for a message`);
    this.name = 'RunNotWaitingError';
  }
}

interface RunRow {
  id: string;
  agent_id: string;
  agent_version: number | null;
  definition: AgentDefinition;
  parent_run_id: string | null;
  root_run_id: string;
  depth: number;
  trigger_kind: RunTriggerKind;
  triggered_by: string;
  mode: RunMode;
  write_policy: RunWritePolicy;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: RunError | null;
  input_tokens: number;
  output_tokens: number;
  steps: number;
  cancel_requested: boolean;
  warnings: string[];
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

interface MessageRow {
  run_id: string;
  seq: number;
  role: StoredMessage['role'];
  content: StoredMessage;
  created_at: Date;
}

interface ToolCallRow {
  id: string;
  run_id: string;
  call_id: string;
  message_seq: number;
  tool_id: string;
  service: string | null;
  effect: ToolEffect | null;
  policy: GrantPolicy;
  decision: 'allow' | 'ask' | 'deny';
  status: ToolCallStatus;
  input: unknown;
  output: unknown;
  output_truncated: boolean;
  error: unknown;
  started_at: Date | null;
  finished_at: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 200;
// Statuses a run can leave by being cancelled without a worker's help.
const PARKED = "('queued', 'waiting_input', 'waiting_approval')";
const LIVE = "('queued', 'running', 'waiting_input', 'waiting_approval')";

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? iso(value) : null);
const json = (value: unknown): string => JSON.stringify(value ?? null);

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    definition: row.definition,
    parentRunId: row.parent_run_id,
    rootRunId: row.root_run_id,
    depth: row.depth,
    triggerKind: row.trigger_kind,
    triggeredBy: row.triggered_by,
    mode: row.mode,
    writePolicy: row.write_policy,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    steps: row.steps,
    cancelRequested: row.cancel_requested,
    warnings: row.warnings,
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    updatedAt: iso(row.updated_at),
  };
}

function toMessage(row: MessageRow): RunMessageRecord {
  return {
    runId: row.run_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    createdAt: iso(row.created_at),
  };
}

function toToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    callId: row.call_id,
    messageSeq: row.message_seq,
    toolId: row.tool_id,
    service: row.service,
    effect: row.effect,
    policy: row.policy,
    decision: row.decision,
    status: row.status,
    input: row.input,
    output: row.output,
    outputTruncated: row.output_truncated,
    error: row.error,
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

async function insertMessages(
  client: SqlClient,
  runId: string,
  firstSeq: number,
  messages: StoredMessage[],
): Promise<RunMessageRecord[]> {
  const out: RunMessageRecord[] = [];
  for (const [i, message] of messages.entries()) {
    const { rows } = await client.query<MessageRow>(
      `INSERT INTO run_messages (run_id, seq, role, content)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [runId, firstSeq + i, message.role, json(message)],
    );
    out.push(toMessage(rows[0]!));
  }
  return out;
}

/**
 * Postgres-backed store for agent runs. The runner is the only writer of a
 * running run: it claims the run with a lease, renews the lease while it works,
 * and gives it up when the run parks or ends. The API creates runs, adds chat
 * messages and requests cancels; each of those is a single conditional write,
 * so the two sides never overwrite each other.
 */
export class RunStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const id: string = randomUUID();
    return this.db.tx(async (client) => {
      let rootRunId = id;
      let depth = 0;
      if (input.parentRunId) {
        const parent = await client.query<{ root_run_id: string; depth: number }>(
          'SELECT root_run_id, depth FROM runs WHERE id = $1',
          [input.parentRunId],
        );
        if (!parent.rows[0]) throw new RunNotFoundError(input.parentRunId);
        rootRunId = parent.rows[0].root_run_id;
        depth = parent.rows[0].depth + 1;
      }
      const { rows } = await client.query<RunRow>(
        `INSERT INTO runs (id, agent_id, agent_version, definition, parent_run_id, root_run_id,
                           depth, trigger_kind, triggered_by, mode, write_policy, input)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         RETURNING *`,
        [
          id,
          input.agentId,
          input.agentVersion,
          json(input.definition),
          input.parentRunId ?? null,
          rootRunId,
          depth,
          input.triggerKind,
          input.triggeredBy,
          input.mode,
          input.writePolicy ?? 'as_granted',
          json(input.input),
        ],
      );
      await insertMessages(client, id, 0, input.messages);
      return toRun(rows[0]!);
    });
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async list(opts: ListRunsOptions = {}): Promise<{ items: RunRecord[]; total: number }> {
    if (opts.agentId !== undefined && !UUID.test(opts.agentId)) return { items: [], total: 0 };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = `($1::uuid IS NULL OR agent_id = $1::uuid) AND ($2::text IS NULL OR status = $2::text)`;
    const filters = [opts.agentId ?? null, opts.status ?? null];
    const [page, count] = await Promise.all([
      this.db.query<RunRow>(
        `SELECT * FROM runs WHERE ${where} ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
        [...filters, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM runs WHERE ${where}`,
        filters,
      ),
    ]);
    return { items: page.rows.map(toRun), total: Number(count.rows[0]!.total) };
  }

  /**
   * Takes the run for one worker. Succeeds for a queued run, or for a running
   * run whose previous holder's lease ran out (that worker died). Returns null
   * when someone else holds it, it was cancelled, or it is finished.
   */
  async claim(id: string, owner: string, leaseSeconds: number): Promise<RunRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET status = 'running', lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3),
              started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = $1 AND NOT cancel_requested
          AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
        RETURNING *`,
      [id, owner, leaseSeconds],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Extends the holder's lease. `held: false` means another worker took the run. */
  async renewLease(
    id: string,
    owner: string,
    leaseSeconds: number,
  ): Promise<{ held: boolean; cancelRequested: boolean }> {
    const { rows } = await this.db.query<{ cancel_requested: boolean }>(
      `UPDATE runs SET lease_expires_at = now() + make_interval(secs => $3)
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        RETURNING cancel_requested`,
      [id, owner, leaseSeconds],
    );
    return rows[0]
      ? { held: true, cancelRequested: rows[0].cancel_requested }
      : { held: false, cancelRequested: false };
  }

  /** Running runs whose worker stopped renewing. The runner re-queues them. */
  async expiredLeases(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM runs WHERE status = 'running' AND lease_expires_at < now() ORDER BY id`,
    );
    return rows.map((r) => r.id);
  }

  /**
   * Appends to the transcript. With `owner`, only the worker holding the lease
   * may append; anyone else gets RunLeaseLostError and nothing is written.
   */
  async appendMessages(
    id: string,
    messages: StoredMessage[],
    owner?: string,
  ): Promise<RunMessageRecord[]> {
    return this.db.tx(async (client) => {
      // Locking the run row serialises appends, so sequence numbers never collide.
      const run = await client.query<{ lease_owner: string | null }>(
        'SELECT lease_owner FROM runs WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!run.rows[0]) throw new RunNotFoundError(id);
      if (owner !== undefined && run.rows[0].lease_owner !== owner) {
        throw new RunLeaseLostError(id);
      }
      const next = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_messages WHERE run_id = $1',
        [id],
      );
      const out = await insertMessages(client, id, Number(next.rows[0]!.next), messages);
      await client.query('UPDATE runs SET updated_at = now() WHERE id = $1', [id]);
      return out;
    });
  }

  async listMessages(id: string, opts: { afterSeq?: number } = {}): Promise<RunMessageRecord[]> {
    if (!UUID.test(id)) return [];
    const { rows } = await this.db.query<MessageRow>(
      'SELECT * FROM run_messages WHERE run_id = $1 AND seq > $2 ORDER BY seq',
      [id, opts.afterSeq ?? -1],
    );
    return rows.map(toMessage);
  }

  /** Counts one model step and adds its token usage. */
  async recordStep(id: string, usage: { input: number; output: number }): Promise<RunRecord> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET steps = steps + 1, input_tokens = input_tokens + $2,
              output_tokens = output_tokens + $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, usage.input, usage.output],
    );
    if (!rows[0]) throw new RunNotFoundError(id);
    return toRun(rows[0]);
  }

  async addWarning(id: string, warning: string): Promise<RunRecord> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET warnings = CASE WHEN warnings @> $2::jsonb THEN warnings ELSE warnings || $2::jsonb END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, json([warning])],
    );
    if (!rows[0]) throw new RunNotFoundError(id);
    return toRun(rows[0]);
  }

  /**
   * Moves a live run to a terminal status and releases its lease. Returns null
   * when the run had already ended: the first outcome stands. With `owner`, a
   * worker that lost the lease gets RunLeaseLostError instead.
   */
  async finish(
    id: string,
    outcome:
      | { status: 'succeeded'; output: unknown }
      | { status: 'failed'; error: RunError; output?: unknown }
      | { status: 'cancelled'; output?: unknown },
    owner?: string,
  ): Promise<RunRecord | null> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET status = $2, output = $3::jsonb, error = $4::jsonb, finished_at = now(),
              updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND status IN ${LIVE} AND ($5::text IS NULL OR lease_owner = $5::text)
        RETURNING *`,
      [
        id,
        outcome.status,
        json('output' in outcome ? outcome.output : null),
        json(outcome.status === 'failed' ? outcome.error : null),
        owner ?? null,
      ],
    );
    if (rows[0]) return toRun(rows[0]);
    await this.throwIfHeldByOther(id, owner);
    return null;
  }

  /** Ends a chat turn: the run waits for the next message and holds no worker. */
  async waitForInput(id: string, owner?: string): Promise<RunRecord | null> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET status = 'waiting_input', updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND status = 'running' AND ($2::text IS NULL OR lease_owner = $2::text)
        RETURNING *`,
      [id, owner ?? null],
    );
    if (rows[0]) return toRun(rows[0]);
    await this.throwIfHeldByOther(id, owner);
    return null;
  }

  // A conditional write by `owner` matched nothing: if the run is still live
  // and someone else holds it, say so rather than reporting a quiet no-op.
  private async throwIfHeldByOther(id: string, owner: string | undefined): Promise<void> {
    if (owner === undefined) return;
    const { rows } = await this.db.query<{ status: RunStatus; lease_owner: string | null }>(
      'SELECT status, lease_owner FROM runs WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row && !TERMINAL_RUN_STATUSES.has(row.status) && row.lease_owner !== owner) {
      throw new RunLeaseLostError(id);
    }
  }

  /** Adds the next chat message to a run that is waiting for one and re-queues it. */
  async addUserMessage(id: string, message: StoredMessage): Promise<RunRecord> {
    if (!UUID.test(id)) throw new RunNotFoundError(id);
    return this.db.tx(async (client) => {
      const current = await client.query<RunRow>('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      const row = current.rows[0];
      if (!row) throw new RunNotFoundError(id);
      if (row.status !== 'waiting_input') throw new RunNotWaitingError(id, row.status);
      const next = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_messages WHERE run_id = $1',
        [id],
      );
      await insertMessages(client, id, Number(next.rows[0]!.next), [message]);
      const updated = await client.query<RunRow>(
        `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      return toRun(updated.rows[0]!);
    });
  }

  /**
   * Asks a run to stop. A run no worker holds (queued, or parked waiting) is
   * cancelled at once; a running run is flagged and its worker stops at the next
   * check. A finished run is returned unchanged. Null when the run does not exist.
   */
  async requestCancel(id: string): Promise<RunRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET cancel_requested = true,
              status = CASE WHEN status IN ${PARKED} THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status IN ${PARKED} THEN now() ELSE finished_at END,
              updated_at = now()
        WHERE id = $1 AND status IN ${LIVE}
        RETURNING *`,
      [id],
    );
    if (rows[0]) return toRun(rows[0]);
    return this.get(id);
  }

  /**
   * Writes the audit row for a tool call before it runs. Starting a call that
   * already has a row (a read re-run after a crash) reuses that row.
   */
  async startToolCall(input: StartToolCallInput): Promise<ToolCallRecord> {
    const { rows } = await this.db.query<ToolCallRow>(
      `INSERT INTO tool_calls (id, run_id, call_id, message_seq, tool_id, service, effect, policy,
                               decision, status, input, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, now(),
               CASE WHEN $10 = 'executing' THEN NULL ELSE now() END)
       ON CONFLICT (run_id, call_id) DO UPDATE
          SET status = EXCLUDED.status, started_at = now(), finished_at = EXCLUDED.finished_at,
              error = EXCLUDED.error
       RETURNING *`,
      [
        randomUUID(),
        input.runId,
        input.callId,
        input.messageSeq,
        input.toolId,
        input.service,
        input.effect,
        input.policy,
        input.decision,
        input.status,
        json(input.input),
        input.error === undefined ? null : json(input.error),
      ],
    );
    return toToolCall(rows[0]!);
  }

  async finishToolCall(
    id: string,
    result: {
      status: Exclude<ToolCallStatus, 'pending' | 'executing'>;
      output?: unknown;
      outputTruncated?: boolean;
      error?: unknown;
    },
  ): Promise<ToolCallRecord> {
    const { rows } = await this.db.query<ToolCallRow>(
      `UPDATE tool_calls
          SET status = $2, output = $3::jsonb, output_truncated = $4, error = $5::jsonb,
              finished_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        result.status,
        result.output === undefined ? null : json(result.output),
        result.outputTruncated ?? false,
        result.error === undefined ? null : json(result.error),
      ],
    );
    if (!rows[0]) throw new Error(`Tool call ${id} not found`);
    return toToolCall(rows[0]);
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    if (!UUID.test(runId)) return [];
    const { rows } = await this.db.query<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE run_id = $1 ORDER BY message_seq, started_at, call_id',
      [runId],
    );
    return rows.map(toToolCall);
  }

  /** Input plus output tokens of every run of the agent created at or after `since`. */
  async tokensSince(agentId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::text AS total
         FROM runs WHERE agent_id = $1 AND created_at >= $2`,
      [agentId, since.toISOString()],
    );
    return Number(rows[0]!.total);
  }

  /**
   * Fails running runs that made no progress for twice their timeout: the last
   * line of defence when a run keeps getting taken over and dying.
   */
  async failStalled(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE runs
          SET status = 'failed', finished_at = now(), updated_at = now(),
              lease_owner = NULL, lease_expires_at = NULL,
              error = jsonb_build_object('code', 'INTERNAL',
                                         'message', 'The run made no progress and was stopped.')
        WHERE status = 'running'
          AND updated_at < now() - make_interval(
                secs => 2 * (definition -> 'limits' ->> 'timeoutSeconds')::integer)
        RETURNING id`,
    );
    return rows.map((r) => r.id).sort();
  }

  /** Closes chat runs nobody has written to for `idleMinutes`. */
  async closeIdleChats(idleMinutes: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE runs
          SET status = 'succeeded', finished_at = now(), updated_at = now()
        WHERE status = 'waiting_input' AND mode = 'chat'
          AND updated_at < now() - make_interval(mins => $1)
        RETURNING id`,
      [idleMinutes],
    );
    return rows.map((r) => r.id).sort();
  }
}
```
<!-- prettier-ignore-end -->

`packages/agents/src/index.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/agents/src/index.ts b/packages/agents/src/index.ts
index b5aadb9..2cce011 100644
--- a/packages/agents/src/index.ts
+++ b/packages/agents/src/index.ts
@@ -42,3 +42,27 @@ export type {
   ListAgentsOptions,
   UpdateAgentPatch,
 } from './agent-store.js';
+export {
+  RUN_STATUSES,
+  RunLeaseLostError,
+  RunNotFoundError,
+  RunNotWaitingError,
+  RunStore,
+  TERMINAL_RUN_STATUSES,
+} from './run-store.js';
+export type {
+  CreateRunInput,
+  ListRunsOptions,
+  RunError,
+  RunErrorCode,
+  RunMessageRecord,
+  RunMode,
+  RunRecord,
+  RunStatus,
+  RunTriggerKind,
+  RunWritePolicy,
+  StartToolCallInput,
+  StoredMessage,
+  ToolCallRecord,
+  ToolCallStatus,
+} from './run-store.js';
```
<!-- prettier-ignore-end -->

- [ ] **Step 7: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/agents exec vitest run && DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agents run test:integration && pnpm --filter @shipit-ai/agents build
```

Expected: PASS — unit: 47 passed, 44 skipped; integration: 44 passed (run store 20, of which the concurrent claim, the lease takeover and the refused stale writes run on separate connections).

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/agents/package.json packages/agents/src/__tests__/run-store.integration.test.ts packages/agents/src/__tests__/test-db.ts packages/agents/src/index.ts packages/agents/src/run-store.ts packages/agents/src/schema-version.ts packages/agents/src/testing.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add db/migrations/0002_runs.sql packages/agents/package.json packages/agents/src/__tests__/run-store.integration.test.ts packages/agents/src/__tests__/test-db.ts packages/agents/src/index.ts packages/agents/src/run-store.ts packages/agents/src/schema-version.ts packages/agents/src/testing.ts
git commit -m "agents: runs, transcripts and tool calls in Postgres, with run leases"
```

---

## Task 3: Tool resolution, queue names and the run queue (agents)

The policy core of the tool gateway, kept pure so it can be tested as a table: a tool grant beats the service grant for the tool's effect, nothing granted is `off`, and four ceilings can only tighten (delete never `allow`; `always_ask` runs ask before writes; an unconfirmed connection tool is a write that asks; a disabled tool is `off`). Names the api-server and runner must agree on live here, with `RunQueue`, which both use to add run ids to the queue.

**Files:**

- Modify: `packages/agents/package.json`
- Test: `packages/agents/src/__tests__/tools.test.ts` (create)
- Modify: `packages/agents/src/index.ts`
- Create: `packages/agents/src/queues.ts`
- Create: `packages/agents/src/run-queue.ts`
- Create: `packages/agents/src/tools.ts`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)

**Interfaces:**

- Consumes: `AgentDefinition`, `RunWritePolicy`, `RunStatus` (Task 2).
- Produces (from `@shipit-ai/agents`):
  - `ToolDescriptor = { id; service; effect; description; inputSchema; source: 'builtin' | 'connection' | 'agent'; effectConfirmed; enabled }`; `ResolvedTool = ToolDescriptor & { policy: 'allow' | 'ask'; modelName }`.
  - `modelToolName(toolId): string`, `resolvePolicy(definition, tool, writePolicy): GrantPolicy`, `resolveTools(definition, catalog, writePolicy): { tools: ResolvedTool[]; warnings: string[] }`.
  - `AGENT_RUNS_QUEUE`, `RUN_EVENTS_CHANNEL`, `RUNNER_HEARTBEAT_KEY`; `RunJob = { runId }`; `RunEvent = { runId; seq?; status? }`.
  - `class RunQueue { constructor({ redisUrl, queueName?, log? }); enqueue(runId); close() }`; `parseRedisUrl(url): ConnectionOptions`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/__tests__/tools.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect } from 'vitest';
import type { AgentDefinition, GrantPolicy, ToolEffect } from '../definition.js';
import { modelToolName, resolvePolicy, resolveTools, type ToolDescriptor } from '../tools.js';
import { AGENT_RUNS_QUEUE, RUN_EVENTS_CHANNEL, RUNNER_HEARTBEAT_KEY } from '../queues.js';

const base: AgentDefinition = {
  instructions: 'x',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: {}, tools: {} },
  output: { schema: null },
};

const withGrants = (grants: Partial<AgentDefinition['grants']>): AgentDefinition => ({
  ...base,
  grants: { services: grants.services ?? {}, tools: grants.tools ?? {} },
});

const tool = (
  id: string,
  effect: ToolEffect,
  extra: Partial<ToolDescriptor> = {},
): ToolDescriptor => ({
  id,
  service: id.split('.')[0]!,
  effect,
  description: `${id} tool`,
  inputSchema: { type: 'object', properties: {} },
  source: 'builtin',
  effectConfirmed: true,
  enabled: true,
  ...extra,
});

describe('modelToolName', () => {
  it('replaces the dot, which provider name rules reject', () => {
    expect(modelToolName('graph.blast_radius')).toBe('graph__blast_radius');
    expect(modelToolName('my-mcp.list-issues')).toBe('my-mcp__list-issues');
  });

  it('keeps every name within 64 characters, starting with a letter, and distinct', () => {
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}`;
    const longer = `${'a'.repeat(60)}.${'b'.repeat(59)}c`;
    for (const id of [long, longer, '1password.read_item']) {
      expect(modelToolName(id)).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
    }
    expect(modelToolName(long)).not.toBe(modelToolName(longer));
    expect(modelToolName(long)).toBe(modelToolName(long));
  });
});

describe('resolvePolicy', () => {
  // [description, definition grants, tool, write policy, expected]
  const cases: Array<
    [
      string,
      Partial<AgentDefinition['grants']>,
      ToolDescriptor,
      'as_granted' | 'always_ask',
      GrantPolicy,
    ]
  > = [
    ['no grant at all is off', {}, tool('graph.find_owners', 'read'), 'as_granted', 'off'],
    [
      'a service grant applies to every tool of that effect',
      { services: { graph: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('graph.find_owners', 'read'),
      'as_granted',
      'allow',
    ],
    [
      'a service grant for another effect does not apply',
      { services: { graph: { read: 'off', write: 'allow', delete: 'off' } } },
      tool('graph.find_owners', 'read'),
      'as_granted',
      'off',
    ],
    [
      'a tool grant beats the service grant',
      {
        services: { graph: { read: 'allow', write: 'off', delete: 'off' } },
        tools: { 'graph.graph_query': 'off' },
      },
      tool('graph.graph_query', 'read'),
      'as_granted',
      'off',
    ],
    [
      'a tool grant can open a tool the service grant leaves off',
      { tools: { 'graph.graph_query': 'ask' } },
      tool('graph.graph_query', 'read'),
      'as_granted',
      'ask',
    ],
    [
      'ceiling 1: delete is never allowed unattended',
      { tools: { 'github.delete_branch': 'allow' } },
      tool('github.delete_branch', 'delete'),
      'as_granted',
      'ask',
    ],
    [
      'ceiling 2: always_ask turns an allowed write into ask',
      { services: { github: { read: 'allow', write: 'allow', delete: 'off' } } },
      tool('github.comment', 'write'),
      'always_ask',
      'ask',
    ],
    [
      'ceiling 2 leaves reads alone',
      { services: { graph: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('graph.find_owners', 'read'),
      'always_ask',
      'allow',
    ],
    [
      'ceiling 3: an unconfirmed tool is a write that asks, whatever its hint',
      { services: { slack: { read: 'allow', write: 'allow', delete: 'off' } } },
      tool('slack.post', 'read', { source: 'connection', effectConfirmed: false }),
      'as_granted',
      'ask',
    ],
    [
      'ceiling 3: an unconfirmed tool with no write grant is off',
      { services: { slack: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('slack.post', 'read', { source: 'connection', effectConfirmed: false }),
      'as_granted',
      'off',
    ],
    [
      'ceiling 4: a disabled tool is off',
      { services: { graph: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('graph.find_owners', 'read', { enabled: false }),
      'as_granted',
      'off',
    ],
  ];

  it.each(cases)('%s', (_name, grants, descriptor, writePolicy, expected) => {
    expect(resolvePolicy(withGrants(grants), descriptor, writePolicy)).toBe(expected);
  });
});

describe('resolveTools', () => {
  const catalog = [
    tool('graph.find_owners', 'read'),
    tool('graph.graph_query', 'read'),
    tool('github.comment', 'write'),
  ];

  it('returns only the tools that are not off, with their policy and model name', () => {
    const { tools, warnings } = resolveTools(
      withGrants({
        services: { graph: { read: 'allow', write: 'off', delete: 'off' } },
        tools: { 'graph.graph_query': 'ask' },
      }),
      catalog,
      'as_granted',
    );
    expect(tools.map((t) => [t.id, t.policy, t.modelName])).toEqual([
      ['graph.find_owners', 'allow', 'graph__find_owners'],
      ['graph.graph_query', 'ask', 'graph__graph_query'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns about a tool grant that matches no available tool', () => {
    const { tools, warnings } = resolveTools(
      withGrants({ tools: { 'graph.removed_tool': 'allow' } }),
      catalog,
      'as_granted',
    );
    expect(tools).toEqual([]);
    expect(warnings).toEqual([
      'The grant for graph.removed_tool was ignored: no such tool is available.',
    ]);
  });
});

describe('queue and channel names', () => {
  // BullMQ 5 throws on a colon in a queue name or job id (scar
  // bullmq-5-forbids-colons-in-queue-names-and-job-ids). Redis keys follow suit.
  it('contain no colon', () => {
    for (const name of [AGENT_RUNS_QUEUE, RUN_EVENTS_CHANNEL, RUNNER_HEARTBEAT_KEY]) {
      expect(name).not.toContain(':');
    }
    expect(AGENT_RUNS_QUEUE).toBe('shipit-agent-runs');
    expect(RUNNER_HEARTBEAT_KEY).toBe('shipit-agent-runner-heartbeat');
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/tools.test.ts
```

Expected: FAIL — cannot resolve `../tools.js`.

- [ ] **Step 3: Implement**

Create `packages/agents/src/tools.ts`:

<!-- prettier-ignore-start -->
```ts
import { createHash } from 'node:crypto';
import type { AgentDefinition, GrantPolicy, ToolEffect } from './definition.js';
import type { RunWritePolicy } from './run-store.js';

/** One callable tool, described the same way whatever its source. */
export interface ToolDescriptor {
  /** '<service>.<tool>', e.g. 'graph.blast_radius'. */
  id: string;
  service: string;
  effect: ToolEffect;
  description: string;
  /** JSON Schema for the tool's input, as the model sees it. */
  inputSchema: Record<string, unknown>;
  source: 'builtin' | 'connection' | 'agent';
  /** False for a connection tool whose effect no admin has confirmed. */
  effectConfirmed: boolean;
  enabled: boolean;
}

export interface ResolvedTool extends ToolDescriptor {
  policy: Exclude<GrantPolicy, 'off'>;
  /** The name the model sees and calls. */
  modelName: string;
}

const MODEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/**
 * The name a model sees for a tool id. Provider name rules reject dots, so
 * 'graph.blast_radius' becomes 'graph__blast_radius'. An id that would still
 * break the rules (too long, or starting with a digit) gets a short hash prefix,
 * which keeps names distinct and stable across runs.
 */
export function modelToolName(toolId: string): string {
  const plain = toolId.replace('.', '__');
  if (MODEL_NAME.test(plain)) return plain;
  const hash = createHash('sha256').update(toolId).digest('hex').slice(0, 8);
  return `t_${hash}_${plain.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/**
 * The policy a definition gives one tool, after the ceilings. A tool grant beats
 * the service grant for the tool's effect; nothing granted is `off`. Each
 * ceiling can only tighten:
 *   1. a delete is never `allow`;
 *   2. an `always_ask` run asks before any write or delete;
 *   3. a tool whose effect nobody confirmed is treated as a write that asks;
 *   4. a disabled tool is `off`.
 */
export function resolvePolicy(
  definition: AgentDefinition,
  tool: ToolDescriptor,
  writePolicy: RunWritePolicy,
): GrantPolicy {
  if (!tool.enabled) return 'off';
  const effect: ToolEffect = tool.effectConfirmed ? tool.effect : 'write';
  let policy: GrantPolicy =
    definition.grants.tools[tool.id] ?? definition.grants.services[tool.service]?.[effect] ?? 'off';
  if (policy === 'off') return 'off';
  if (!tool.effectConfirmed) return 'ask';
  if (effect === 'delete' && policy === 'allow') policy = 'ask';
  if (writePolicy === 'always_ask' && effect !== 'read' && policy === 'allow') policy = 'ask';
  return policy;
}

/** The tools a run may offer the model, in catalog order, and what was dropped. */
export function resolveTools(
  definition: AgentDefinition,
  catalog: readonly ToolDescriptor[],
  writePolicy: RunWritePolicy,
): { tools: ResolvedTool[]; warnings: string[] } {
  const tools: ResolvedTool[] = [];
  for (const tool of catalog) {
    const policy = resolvePolicy(definition, tool, writePolicy);
    if (policy !== 'off') tools.push({ ...tool, policy, modelName: modelToolName(tool.id) });
  }
  const known = new Set(catalog.map((t) => t.id));
  const warnings = Object.keys(definition.grants.tools)
    .filter((id) => !known.has(id))
    .map((id) => `The grant for ${id} was ignored: no such tool is available.`);
  return { tools, warnings };
}
```
<!-- prettier-ignore-end -->

Create `packages/agents/src/queues.ts`:

<!-- prettier-ignore-start -->
```ts
// Names the api-server and the agent runner must agree on. No colons anywhere:
// BullMQ 5 rejects them in queue names and job ids (scar
// bullmq-5-forbids-colons-in-queue-names-and-job-ids).
import type { RunStatus } from './run-store.js';

/** BullMQ queue of runs to work on. Jobs carry only the run id; state lives in Postgres. */
export const AGENT_RUNS_QUEUE = 'shipit-agent-runs';

export interface RunJob {
  runId: string;
}

/** Redis pub/sub channel: the runner announces each write to a run here. */
export const RUN_EVENTS_CHANNEL = 'shipit-run-events';

export interface RunEvent {
  runId: string;
  /** Set when messages were appended: the highest new sequence number. */
  seq?: number;
  status?: RunStatus;
}

/** Written by the runner every 15 s with a 60 s TTL; GET /ai/status reads it. */
export const RUNNER_HEARTBEAT_KEY = 'shipit-agent-runner-heartbeat';
```
<!-- prettier-ignore-end -->

Create `packages/agents/src/run-queue.ts`:

<!-- prettier-ignore-start -->
```ts
// The shipit-agent-runs queue, for the two processes that add to it: the
// api-server (a new run, a chat message) and the runner (a run to recover).
// Jobs carry only a run id: state lives in Postgres, and the run's lease (not
// BullMQ) decides who works on it, so a duplicate job is a harmless no-op and
// `attempts` stays 1.
import { Queue, type ConnectionOptions } from 'bullmq';
import { AGENT_RUNS_QUEUE, type RunJob } from './queues.js';

// Bounded like the other queues: completed jobs for a day, failed for a week.
const COMPLETED_JOB_RETENTION = { age: 24 * 3600, count: 1000 };
const FAILED_JOB_RETENTION = { age: 7 * 24 * 3600, count: 5000 };

export interface RunQueueOptions {
  redisUrl: string;
  queueName?: string;
  log?: (message: string) => void;
}

export class RunQueue {
  private readonly queue: Queue<RunJob>;

  constructor(opts: RunQueueOptions) {
    const log = opts.log ?? console.warn;
    this.queue = new Queue<RunJob>(opts.queueName ?? AGENT_RUNS_QUEUE, {
      connection: parseRedisUrl(opts.redisUrl),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
    // Without a listener an emitted 'error' crashes the process (scar
    // redis-memory-limit-below-dataset-oomkills).
    this.queue.on('error', (err: Error) => log(`agent-runs queue error: ${err.message}`));
  }

  async enqueue(runId: string): Promise<void> {
    await this.queue.add('run', { runId });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

// Parse a redis:// URL into the host/port/password shape BullMQ's
// ConnectionOptions expects, rather than handing BullMQ an ioredis instance
// the type checker cannot reconcile across hoisted versions. (The api-server's
// older queues keep their own copies for the same reason.)
export function parseRedisUrl(url: string): ConnectionOptions {
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
```
<!-- prettier-ignore-end -->

`packages/agents/src/index.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/agents/src/index.ts b/packages/agents/src/index.ts
index 2cce011..802dfc7 100644
--- a/packages/agents/src/index.ts
+++ b/packages/agents/src/index.ts
@@ -66,3 +66,9 @@ export type {
   ToolCallRecord,
   ToolCallStatus,
 } from './run-store.js';
+export { modelToolName, resolvePolicy, resolveTools } from './tools.js';
+export type { ResolvedTool, ToolDescriptor } from './tools.js';
+export { AGENT_RUNS_QUEUE, RUN_EVENTS_CHANNEL, RUNNER_HEARTBEAT_KEY } from './queues.js';
+export type { RunEvent, RunJob } from './queues.js';
+export { RunQueue, parseRedisUrl } from './run-queue.js';
+export type { RunQueueOptions } from './run-queue.js';
```
<!-- prettier-ignore-end -->

`packages/agents/package.json`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/agents/package.json b/packages/agents/package.json
index 210266c..fd10b1d 100644
--- a/packages/agents/package.json
+++ b/packages/agents/package.json
@@ -25,6 +25,7 @@
     "clean": "rm -rf dist"
   },
   "dependencies": {
+    "bullmq": "^5.79.1",
     "pg": "^8.23.1",
     "zod": "^4.4.3"
   },
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Install**

```bash
pnpm install
```

- [ ] **Step 5: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/agents exec vitest run src/__tests__/tools.test.ts && pnpm --filter @shipit-ai/agents build
```

Expected: PASS — 16 tests (2 naming, 11 policy cases, 2 resolution, 1 names).

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/agents/package.json packages/agents/src/__tests__/tools.test.ts packages/agents/src/index.ts packages/agents/src/queues.ts packages/agents/src/run-queue.ts packages/agents/src/tools.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/agents/package.json packages/agents/src/__tests__/tools.test.ts packages/agents/src/index.ts packages/agents/src/queues.ts packages/agents/src/run-queue.ts packages/agents/src/tools.ts pnpm-lock.yaml
git commit -m "agents: grant resolution with ceilings, queue names, and the shared run queue"
```

---

## Task 4: The agent-runner package and the model client

A new package. The model client is the only code that imports the AI SDK: one `step` is one model call with tools declared and no executors, so the SDK returns the calls and stops. Three behaviours come from running against Vertex, not from docs: the SDK answers a call to an undeclared tool itself with an error message (the client drops that message so the gateway records the call); an agent's `effort` maps onto the SDK's provider-neutral `reasoning` level; a context-length rejection becomes `CONTEXT_EXCEEDED`. The message builders include the last-step note Task 6 uses.

**Files:**

- Create: `packages/agent-runner/package.json`
- Test: `packages/agent-runner/src/__tests__/messages.test.ts` (create)
- Test: `packages/agent-runner/src/__tests__/vertex-model-client.live.test.ts` (create)
- Test: `packages/agent-runner/src/__tests__/vertex-model-client.test.ts` (create)
- Create: `packages/agent-runner/src/model/messages.ts`
- Create: `packages/agent-runner/src/model/model-client.ts`
- Create: `packages/agent-runner/src/model/vertex-model-client.ts`
- Create: `packages/agent-runner/tsconfig.json`
- Create: `packages/agent-runner/vitest.config.ts`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)
- Modify: `vitest.config.ts`

**Interfaces:**

- Consumes: `StoredMessage` (Task 2); `AiModelConfig` (shared).
- Produces:
  - `interface ModelClient { step(request: ModelStepRequest): Promise<ModelStepResult> }`; `ModelStepRequest = { model; instructions; messages; tools: ModelToolSpec[]; effort?; signal }`; `ModelStepResult = { messages; toolCalls: { callId; name; input }[]; text; finish: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error'; usage: { input; output; reasoning?; cacheRead? } }`.
  - `class ModelCallError { code: 'MODEL_ERROR' | 'CONTEXT_EXCEEDED' | 'ABORTED' }`; `class VertexModelClient { constructor({ project?, location?, resolveModel? }) }`.
  - `userMessage(text)`, `toolResultMessage(results)`, `stepLimitNote()`, `isStepLimitNote(message)`, `STEP_LIMIT_NOTE`.

Create the package files and register it with the root test runner. Add every alias now (`@shipit-ai/agents/testing` and `@shipit-ai/mcp-server/tools` are used from Tasks 5 and 6).

- [ ] **Step 1: Implement**

Create `packages/agent-runner/package.json`:

<!-- prettier-ignore-start -->
```json
{
  "name": "@shipit-ai/agent-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/main.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run .integration --no-file-parallelism",
    "test:live": "vitest run .live",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@ai-sdk/google-vertex": "^5.0.101",
    "@shipit-ai/agents": "workspace:*",
    "@shipit-ai/mcp-server": "workspace:*",
    "@shipit-ai/shared": "workspace:*",
    "ai": "^7.0.127",
    "bullmq": "^5.79.1",
    "ioredis": "^5.11.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.11"
  }
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/tsconfig.json`:

<!-- prettier-ignore-start -->
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
<!-- prettier-ignore-end -->

Create `packages/agent-runner/vitest.config.ts`:

<!-- prettier-ignore-start -->
```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Resolve @shipit-ai/* workspace packages to their TypeScript source, so the
// suites run straight after `pnpm install` with no build step (the CI
// `integration` job builds nothing). Subpaths are listed before their package
// root so vite's prefix match does not rewrite them against the root.
const r = (...p: string[]) => resolve(import.meta.dirname, '..', ...p);

export default defineConfig({
  resolve: {
    alias: {
      '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
      '@shipit-ai/shared': r('shared/src/index.ts'),
      '@shipit-ai/agents/testing': r('agents/src/testing.ts'),
      '@shipit-ai/agents': r('agents/src/index.ts'),
      '@shipit-ai/mcp-server/tools': r('mcp-server/src/tools/registry.ts'),
    },
  },
  test: {
    name: 'agent-runner',
    include: ['src/**/*.test.ts'],
  },
});
```
<!-- prettier-ignore-end -->

`vitest.config.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/vitest.config.ts b/vitest.config.ts
index 6c53819..9156fb0 100644
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -9,6 +9,7 @@ export default defineConfig({
     projects: [
       'packages/shared',
       'packages/agents',
+      'packages/agent-runner',
       'packages/event-bus',
       'packages/core-writer',
       'packages/connector-sdk',
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Install**

```bash
pnpm install
```

- [ ] **Step 3: Write the failing tests**

Create `packages/agent-runner/src/__tests__/vertex-model-client.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { AiModelConfig } from '@shipit-ai/shared';
import { VertexModelClient } from '../model/vertex-model-client.js';
import { ModelCallError, type ModelStepRequest } from '../model/model-client.js';

const gemini: AiModelConfig = {
  key: 'gemini',
  label: 'Gemini',
  family: 'gemini',
  modelId: 'gemini-3.8-flash',
  contextWindow: 1_048_576,
  tools: true,
};

const usage = (input: number, output: number, reasoning = 0, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
  outputTokens: { total: output, text: output - reasoning, reasoning },
});

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function clientReturning(result: Partial<GenerateResult> | (() => never)) {
  const mock = new MockLanguageModelV4({
    doGenerate:
      typeof result === 'function'
        ? result
        : async () => ({
            content: [],
            finishReason: { unified: 'stop', raw: 'STOP' },
            usage: usage(0, 0),
            warnings: [],
            ...result,
          }),
  });
  const client = new VertexModelClient({ resolveModel: () => mock });
  return { client, mock };
}

const request = (extra: Partial<ModelStepRequest> = {}): ModelStepRequest => ({
  model: gemini,
  instructions: 'You answer ownership questions.',
  messages: [{ role: 'user', content: 'Who owns payments-api?' }],
  tools: [
    {
      name: 'graph__find_owners',
      description: 'Find owners.',
      inputSchema: {
        type: 'object',
        properties: { entity: { type: 'string' } },
        required: ['entity'],
      },
    },
  ],
  signal: new AbortController().signal,
  ...extra,
});

describe('VertexModelClient.step', () => {
  it('returns a final answer as one assistant message with its usage', async () => {
    const { client } = clientReturning({
      content: [{ type: 'text', text: 'team-payments owns it.' }],
      usage: usage(120, 30, 10, 20),
    });
    const step = await client.step(request());
    expect(step.finish).toBe('stop');
    expect(step.text).toBe('team-payments owns it.');
    expect(step.toolCalls).toEqual([]);
    expect(step.usage).toEqual({ input: 120, output: 30, reasoning: 10, cacheRead: 20 });
    expect(step.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'team-payments owns it.' }] },
    ]);
  });

  it('returns tool calls without running anything, keeping provider metadata on the message', async () => {
    const { client } = clientReturning({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'graph__find_owners',
          input: JSON.stringify({ entity: 'payments-api' }),
          providerMetadata: { google: { thoughtSignature: 'sig-abc' } },
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'STOP' },
      usage: usage(100, 20),
    });
    const step = await client.step(request());
    expect(step.finish).toBe('tool_calls');
    expect(step.toolCalls).toEqual([
      { callId: 'call_1', name: 'graph__find_owners', input: { entity: 'payments-api' } },
    ]);
    // The signature must survive in the stored message (probe finding,
    // docs/agent/investigations/vertex-model-layer-probe.md).
    expect(JSON.stringify(step.messages)).toContain('sig-abc');
  });

  it('hands a call to an undeclared tool to the caller instead of answering it itself', async () => {
    // Left alone, the SDK appends its own error result for such a call, which
    // would bypass the gateway and its audit row.
    const { client } = clientReturning({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_9',
          toolName: 'graph__search_nodes',
          input: JSON.stringify({ q: 'x' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'STOP' },
    });
    const step = await client.step(request());
    expect(step.toolCalls).toEqual([
      { callId: 'call_9', name: 'graph__search_nodes', input: { q: 'x' } },
    ]);
    expect(step.messages.map((m) => m.role)).toEqual(['assistant']);
  });

  it('sends the instructions, the transcript and the tool schemas, with no executors', async () => {
    const { client, mock } = clientReturning({ content: [{ type: 'text', text: 'ok' }] });
    await client.step(request());
    const call = mock.doGenerateCalls[0]!;
    expect(call.prompt[0]).toEqual({ role: 'system', content: 'You answer ownership questions.' });
    expect(call.prompt[1]).toMatchObject({ role: 'user' });
    expect(call.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'graph__find_owners',
        inputSchema: expect.objectContaining({ required: ['entity'] }),
      }),
    ]);
  });

  it('passes a known effort through as the reasoning level and ignores an unknown one', async () => {
    const known = clientReturning({ content: [{ type: 'text', text: 'ok' }] });
    await known.client.step(request({ effort: 'high' }));
    expect(known.mock.doGenerateCalls[0]!.reasoning).toBe('high');

    const unknown = clientReturning({ content: [{ type: 'text', text: 'ok' }] });
    await unknown.client.step(request({ effort: 'turbo' }));
    expect(unknown.mock.doGenerateCalls[0]!.reasoning).toBeUndefined();
  });

  it('reports a content filter stop as a refusal', async () => {
    const { client } = clientReturning({
      content: [],
      finishReason: { unified: 'content-filter', raw: 'SAFETY' },
    });
    expect((await client.step(request())).finish).toBe('refusal');
  });

  it('reports a context-length rejection as CONTEXT_EXCEEDED', async () => {
    const { client } = clientReturning(() => {
      throw new APICallError({
        message:
          'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
        url: 'https://aiplatform.googleapis.com',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    });
    await expect(client.step(request())).rejects.toMatchObject({
      name: 'ModelCallError',
      code: 'CONTEXT_EXCEEDED',
    });
  });

  it('reports any other provider failure as MODEL_ERROR', async () => {
    const { client } = clientReturning(() => {
      throw new APICallError({
        message: 'Quota exceeded',
        url: 'https://aiplatform.googleapis.com',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: false,
      });
    });
    const err = await client.step(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err).toMatchObject({ code: 'MODEL_ERROR', message: expect.stringContaining('Quota') });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = clientReturning({ content: [{ type: 'text', text: 'late' }] });
    await expect(client.step(request({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });
});
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/__tests__/messages.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect } from 'vitest';
import {
  STEP_LIMIT_NOTE,
  isStepLimitNote,
  stepLimitNote,
  toolResultMessage,
  userMessage,
} from '../model/messages.js';

describe('transcript messages', () => {
  it('builds a user message from text', () => {
    expect(userMessage('Who owns payments-api?')).toEqual({
      role: 'user',
      content: 'Who owns payments-api?',
    });
  });

  it('puts every result of a step in one tool message, in call order', () => {
    expect(
      toolResultMessage([
        { callId: 'c1', name: 'graph__find_owners', output: { owners: ['team-a'] } },
        {
          callId: 'c2',
          name: 'graph__graph_stats',
          output: { error: { code: 'X', message: 'y' } },
        },
      ]),
    ).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'graph__find_owners',
          output: { type: 'json', value: { owners: ['team-a'] } },
        },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'graph__graph_stats',
          output: { type: 'json', value: { error: { code: 'X', message: 'y' } } },
        },
      ],
    });
  });

  it('stores an undefined output as null, which JSON can carry', () => {
    const message = toolResultMessage([{ callId: 'c1', name: 't', output: undefined }]);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it('builds the last-step note as a tagged user message, and recognises it', () => {
    const note = stepLimitNote();
    expect(note).toEqual({
      role: 'user',
      content: STEP_LIMIT_NOTE,
      providerOptions: { shipit: { kind: 'step-limit-note' } },
    });
    expect(isStepLimitNote(note)).toBe(true);
    expect(isStepLimitNote(userMessage(STEP_LIMIT_NOTE))).toBe(false);
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run it to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/agent-runner exec vitest run
```

Expected: FAIL — cannot resolve `../model/vertex-model-client.js` and `../model/messages.js`.

- [ ] **Step 5: Implement**

Create `packages/agent-runner/src/model/model-client.ts`:

<!-- prettier-ignore-start -->
```ts
// The one interface the run loop uses to call a model. Nothing outside
// src/model/ imports the AI SDK, so swapping a family to a direct SDK (the
// fallback the design keeps open for Claude) touches only this folder.
import type { StoredMessage } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';

export interface ModelToolSpec {
  /** The model-facing name, e.g. 'graph__find_owners'. */
  name: string;
  description: string;
  /** JSON Schema. Declared without an executor: the model only asks. */
  inputSchema: Record<string, unknown>;
}

export interface ModelStepRequest {
  model: AiModelConfig;
  instructions: string;
  /** The transcript as stored: model-layer message objects, metadata included. */
  messages: StoredMessage[];
  tools: ModelToolSpec[];
  /** The agent's effort setting; passed on as the reasoning level when valid. */
  effort?: string;
  signal: AbortSignal;
}

export type ModelFinish = 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error';

export interface ModelToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ModelStepResult {
  /** What to append to the transcript: the assistant message(s), stored as-is. */
  messages: StoredMessage[];
  toolCalls: ModelToolCall[];
  text: string;
  finish: ModelFinish;
  usage: { input: number; output: number; reasoning?: number; cacheRead?: number };
}

export interface ModelClient {
  /** One model call. Tools are declared, never run here. */
  step(request: ModelStepRequest): Promise<ModelStepResult>;
}

export type ModelCallErrorCode = 'MODEL_ERROR' | 'CONTEXT_EXCEEDED' | 'ABORTED';

export class ModelCallError extends Error {
  constructor(
    readonly code: ModelCallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/model/vertex-model-client.ts`:

<!-- prettier-ignore-start -->
```ts
// ModelClient over the AI SDK's Vertex provider. One family per entry point:
// the package root for Gemini, /anthropic for Claude, /maas for open models.
// Authentication is Application Default Credentials (Workload Identity on GKE,
// `gcloud auth application-default login` locally); there is no API key.
import {
  APICallError,
  generateText,
  isStepCount,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createVertexMaas } from '@ai-sdk/google-vertex/maas';
import type { StoredMessage } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import {
  ModelCallError,
  type ModelClient,
  type ModelFinish,
  type ModelStepRequest,
  type ModelStepResult,
} from './model-client.js';

// The SDK's provider-neutral reasoning levels. An agent's `effort` maps onto
// one of these; anything else is ignored rather than failing the run.
const REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Wording Vertex uses when a prompt does not fit: Gemini ("input token count
// … exceeds the maximum") and Claude ("prompt is too long").
const CONTEXT_EXCEEDED =
  /token count .* exceeds|prompt is too long|context length|too many tokens/i;

const FINISH: Record<string, ModelFinish> = {
  stop: 'stop',
  'tool-calls': 'tool_calls',
  length: 'length',
  'content-filter': 'refusal',
  error: 'error',
  other: 'error',
};

export interface VertexModelClientOptions {
  project?: string;
  location?: string;
  /** Test seam: builds the SDK model for a catalog entry. */
  resolveModel?: (model: AiModelConfig) => LanguageModel;
}

export class VertexModelClient implements ModelClient {
  private readonly resolveModel: (model: AiModelConfig) => LanguageModel;

  constructor(opts: VertexModelClientOptions) {
    this.resolveModel = opts.resolveModel ?? vertexResolver(opts.project ?? '', opts.location);
  }

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    if (request.signal.aborted) throw new ModelCallError('ABORTED', 'The run was cancelled.');
    const tools: ToolSet = Object.fromEntries(
      request.tools.map((t) => [
        t.name,
        tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as never) }),
      ]),
    );
    const reasoning =
      request.effort && REASONING_LEVELS.has(request.effort)
        ? (request.effort as ReasoningLevel)
        : undefined;
    try {
      const result = await generateText({
        model: this.resolveModel(request.model),
        instructions: request.instructions,
        messages: request.messages as unknown as ModelMessage[],
        tools,
        // One model call per step: the run loop decides and runs the tools.
        stopWhen: isStepCount(1),
        abortSignal: request.signal,
        // Three attempts in all for a retryable failure (429, 5xx).
        maxRetries: 2,
        ...(reasoning ? { reasoning } : {}),
      });
      return {
        // Only the model's own message. For a call to an undeclared tool (or
        // with input the SDK rejects) the SDK appends a tool message with its
        // own error result; the gateway must decide and record every call, so
        // that message is dropped and the call is passed on like any other.
        messages: result.responseMessages.filter(
          (m) => m.role === 'assistant',
        ) as unknown as StoredMessage[],
        toolCalls: result.toolCalls.map((c) => ({
          callId: c.toolCallId,
          name: c.toolName,
          input: c.input,
        })),
        text: result.text,
        finish: FINISH[result.finishReason] ?? 'error',
        usage: {
          input: result.usage.inputTokens ?? 0,
          output: result.usage.outputTokens ?? 0,
          ...(result.usage.outputTokenDetails?.reasoningTokens
            ? { reasoning: result.usage.outputTokenDetails.reasoningTokens }
            : {}),
          ...(result.usage.inputTokenDetails?.cacheReadTokens
            ? { cacheRead: result.usage.inputTokenDetails.cacheReadTokens }
            : {}),
        },
      };
    } catch (err) {
      throw toModelCallError(err, request.signal);
    }
  }
}

function toModelCallError(err: unknown, signal: AbortSignal): ModelCallError {
  if (signal.aborted) return new ModelCallError('ABORTED', 'The run was cancelled.');
  // The SDK wraps a retried failure in a RetryError whose lastError is the API error.
  const inner = (err as { lastError?: unknown }).lastError ?? err;
  const message = inner instanceof Error ? inner.message : String(inner);
  if (APICallError.isInstance(inner) && CONTEXT_EXCEEDED.test(message)) {
    return new ModelCallError('CONTEXT_EXCEEDED', message);
  }
  return new ModelCallError('MODEL_ERROR', message);
}

function vertexResolver(
  project: string,
  location = 'global',
): (model: AiModelConfig) => LanguageModel {
  // Providers are created once, on first use of a family.
  let gemini: ReturnType<typeof createVertex> | undefined;
  let anthropic: ReturnType<typeof createVertexAnthropic> | undefined;
  let maas: ReturnType<typeof createVertexMaas> | undefined;
  return (model) => {
    switch (model.family) {
      case 'anthropic':
        anthropic ??= createVertexAnthropic({ project, location });
        return anthropic(model.modelId);
      case 'maas':
        maas ??= createVertexMaas({ project, location });
        return maas(model.modelId);
      default:
        gemini ??= createVertex({ project, location });
        return gemini(model.modelId);
    }
  };
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/model/messages.ts`:

<!-- prettier-ignore-start -->
```ts
// Builders for the transcript messages the loop writes itself. They use the AI
// SDK's message shape, which is what run_messages stores and replays.
import type { StoredMessage } from '@shipit-ai/agents';

export function userMessage(text: string): StoredMessage {
  return { role: 'user', content: text };
}

/**
 * One tool message carrying every result of a step, in the order the model
 * made the calls. Gemini rejects a transcript where a step's results are split
 * or reordered, so the loop only appends this once every call is resolved.
 */
export function toolResultMessage(
  results: ReadonlyArray<{ callId: string; name: string; output: unknown }>,
): StoredMessage {
  return {
    role: 'tool',
    content: results.map((r) => ({
      type: 'tool-result',
      toolCallId: r.callId,
      toolName: r.name,
      output: { type: 'json', value: r.output ?? null },
    })),
  };
}

export const STEP_LIMIT_NOTE =
  'This is your last step: you cannot call tools any more. Answer now with what you have found, and say what you could not check.';

/**
 * The note the loop adds before a run's last model step. It goes in the
 * transcript as a user message, because on long transcripts Gemini heeds a
 * trailing message and ignores the same words in the instructions (measured
 * live, 2026-10-03). The `shipit` provider options tag it for display; model
 * providers ignore keys that are not theirs.
 */
export function stepLimitNote(): StoredMessage {
  return {
    role: 'user',
    content: STEP_LIMIT_NOTE,
    providerOptions: { shipit: { kind: 'step-limit-note' } },
  };
}

export function isStepLimitNote(message: StoredMessage | undefined): boolean {
  const options = message?.providerOptions as { shipit?: { kind?: string } } | undefined;
  return options?.shipit?.kind === 'step-limit-note';
}
```
<!-- prettier-ignore-end -->

- [ ] **Step 6: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/agent-runner exec vitest run && pnpm --filter @shipit-ai/agent-runner typecheck
```

Expected: PASS — 2 files, 13 tests (model client 9, messages 4).

Add the opt-in live suite. It skips without `VERTEX_TEST_PROJECT`, so CI never runs it.

- [ ] **Step 7: Write the failing test**

Create `packages/agent-runner/src/__tests__/vertex-model-client.live.test.ts`:

<!-- prettier-ignore-start -->
```ts
// Opt-in checks against real models on Vertex AI. Not run in CI. They repeat
// the Milestone 1 probe (docs/agent/investigations/vertex-model-layer-probe.md)
// through the real ModelClient, so an SDK upgrade that breaks the round trip
// fails here first.
//
//   VERTEX_TEST_PROJECT=ship-it-ai-portal \
//   VERTEX_TEST_MODELS=gemini:gemini-3.8-flash,anthropic:claude-sonnet-5-5 \
//     pnpm --filter @shipit-ai/agent-runner test:live
//
// Needs Application Default Credentials (`gcloud auth application-default login`).
import { describe, it, expect } from 'vitest';
import type { StoredMessage } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import { VertexModelClient } from '../model/vertex-model-client.js';
import { toolResultMessage, userMessage } from '../model/messages.js';

const project = process.env.VERTEX_TEST_PROJECT ?? '';
const models: AiModelConfig[] = (process.env.VERTEX_TEST_MODELS ?? 'gemini:gemini-3.8-flash')
  .split(',')
  .map((entry) => {
    const [family, modelId] = entry.split(':') as [AiModelConfig['family'], string];
    return { key: modelId, label: modelId, family, modelId, contextWindow: 200_000, tools: true };
  });

const tools = [
  {
    name: 'graph__find_owners',
    description: 'Find the owners of an entity in the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: { entity: { type: 'string', description: 'Entity name or canonical id' } },
      required: ['entity'],
      additionalProperties: false,
    },
  },
];

describe.skipIf(!project)('VertexModelClient — live', () => {
  const client = new VertexModelClient({
    project,
    location: process.env.VERTEX_TEST_LOCATION ?? 'global',
  });
  const instructions =
    'You answer questions about a software knowledge graph. Always use the tools; never guess an owner.';

  it.each(models.map((m) => [`${m.family} ${m.modelId}`, m] as const))(
    '%s: calls the tool, survives a JSON round trip, and uses the result',
    async (_name, model) => {
      const signal = new AbortController().signal;
      const opening: StoredMessage[] = [userMessage('Who owns payments-api?')];
      const first = await client.step({ model, instructions, messages: opening, tools, signal });
      expect(first.finish).toBe('tool_calls');
      expect(first.toolCalls.map((c) => c.name)).toEqual(['graph__find_owners']);
      expect(first.usage.input).toBeGreaterThan(0);

      // The round trip a stored run makes: transcript -> JSON -> transcript.
      const stored = JSON.parse(JSON.stringify([...opening, ...first.messages])) as StoredMessage[];
      if (model.family === 'gemini') {
        // Without it the SDK silently injects a skip sentinel instead of failing.
        expect(JSON.stringify(stored)).toContain('thoughtSignature');
      }
      const results = toolResultMessage(
        first.toolCalls.map((c) => ({
          callId: c.callId,
          name: c.name,
          output: { owners: ['team-payments'], source: 'CODEOWNERS' },
        })),
      );
      const second = await client.step({
        model,
        instructions,
        messages: [...stored, results],
        tools,
        signal,
      });
      expect(second.finish).toBe('stop');
      expect(second.text).toContain('team-payments');
    },
    120_000,
  );
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 8: Run to verify it passes**

Run:

```bash
gcloud auth application-default login   # if your credentials have expired
VERTEX_TEST_PROJECT=ship-it-ai-portal VERTEX_TEST_MODELS=gemini:gemini-3.8-flash \
  pnpm --filter @shipit-ai/agent-runner run test:live
```

Expected: PASS — 1 test: the model calls the tool, the transcript survives JSON with its `thoughtSignature`, and the second step answers with the tool's result. A 429 "Quota exceeded" means the project has no quota for that model, not a code problem.

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/agent-runner/package.json packages/agent-runner/src/__tests__/messages.test.ts packages/agent-runner/src/__tests__/vertex-model-client.live.test.ts packages/agent-runner/src/__tests__/vertex-model-client.test.ts packages/agent-runner/src/model/messages.ts packages/agent-runner/src/model/model-client.ts packages/agent-runner/src/model/vertex-model-client.ts packages/agent-runner/tsconfig.json packages/agent-runner/vitest.config.ts vitest.config.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/agent-runner/package.json packages/agent-runner/src/__tests__/messages.test.ts packages/agent-runner/src/__tests__/vertex-model-client.live.test.ts packages/agent-runner/src/__tests__/vertex-model-client.test.ts packages/agent-runner/src/model/messages.ts packages/agent-runner/src/model/model-client.ts packages/agent-runner/src/model/vertex-model-client.ts packages/agent-runner/tsconfig.json packages/agent-runner/vitest.config.ts pnpm-lock.yaml vitest.config.ts
git commit -m "agent-runner: new package with the Vertex model client"
```

---

## Task 5: The graph tools for the runner

Each graph tool becomes a `RunnerTool`: its descriptor (`graph.<name>`, service `graph`, its effect, the input JSON Schema the model sees), a parser that validates and fills defaults, and an executor. The executor drops the MCP `_meta` envelope but keeps the two parts of it that change what the data means, a truncation flag and warnings (MCP's own `compact` mode drops those too, and not every tool offers it).

**Files:**

- Test: `packages/agent-runner/src/__tests__/graph-tools.test.ts` (create)
- Create: `packages/agent-runner/src/tools/graph-tools.ts`
- Create: `packages/agent-runner/src/tools/runner-tool.ts`

**Interfaces:**

- Consumes: `graphReadTools`, `Neo4jClient` (Task 1); `ToolDescriptor` (Task 3).
- Produces: `interface RunnerTool { descriptor: ToolDescriptor; parse(input): { ok: true; value } | { ok: false; message }; execute(input): Promise<unknown> }`; `graphTools(neo4j, config): RunnerTool[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/agent-runner/src/__tests__/graph-tools.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect, vi } from 'vitest';
import type { Neo4jClient } from '@shipit-ai/mcp-server/tools';
import { graphTools } from '../tools/graph-tools.js';

// A Neo4j stand-in: every query returns no rows, and calls are recorded.
function emptyGraph() {
  const runCypher = vi.fn(async () => ({ records: [], summary: { resultAvailableAfter: 0 } }));
  return { runCypher, close: vi.fn(async () => {}) } as unknown as Neo4jClient & {
    runCypher: typeof runCypher;
  };
}

const LIMITS = { rateLimits: { rowLimit: 100, hopLimit: 6 } };

describe('graphTools', () => {
  it('describes the eight graph tools as built-in graph reads', () => {
    const tools = graphTools(emptyGraph(), LIMITS);
    expect(tools.map((t) => t.descriptor.id)).toEqual([
      'graph.blast_radius',
      'graph.entity_detail',
      'graph.schema_info',
      'graph.find_owners',
      'graph.dependency_chain',
      'graph.graph_stats',
      'graph.search_entities',
      'graph.graph_query',
    ]);
    for (const { descriptor } of tools) {
      expect(descriptor).toMatchObject({
        service: 'graph',
        effect: 'read',
        source: 'builtin',
        effectConfirmed: true,
        enabled: true,
      });
      expect(descriptor.description.length).toBeGreaterThan(10);
    }
  });

  it('hides the compact flag from the model, and sends plain JSON Schema', () => {
    const findOwners = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.find_owners',
    )!;
    const schema = findOwners.descriptor.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
      $schema?: string;
    };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['entity', 'include_chain', 'include_absent']);
    expect(schema.required).toEqual(['entity']);
    expect(schema.$schema).toBeUndefined();
  });

  it('validates input and fills defaults, naming the field that is wrong', () => {
    const blast = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.blast_radius',
    )!;
    expect(blast.parse({ node: 'shipit://x' })).toEqual({
      ok: true,
      value: expect.objectContaining({ node: 'shipit://x', depth: 3, direction: 'DOWNSTREAM' }),
    });
    const bad = blast.parse({ node: 'shipit://x', depth: 99 });
    expect(bad).toEqual({ ok: false, message: expect.stringContaining('depth') });
    expect(blast.parse('not an object')).toMatchObject({ ok: false });
  });

  it('returns the payload without the MCP envelope', async () => {
    const graph = emptyGraph();
    const stats = graphTools(graph, LIMITS).find((t) => t.descriptor.id === 'graph.graph_stats')!;
    const parsed = stats.parse({});
    if (!parsed.ok) throw new Error(parsed.message);
    const result = (await stats.execute(parsed.value)) as Record<string, unknown>;
    expect(result).not.toHaveProperty('_meta');
    expect(graph.runCypher).toHaveBeenCalled();
  });

  it('keeps a truncation warning, so the model knows rows are missing', async () => {
    const row = { get: () => 1, toObject: () => ({ n: 1 }) };
    const graph = emptyGraph();
    graph.runCypher.mockResolvedValue({
      records: [row, row],
      summary: { resultAvailableAfter: 0 },
    } as never);
    const query = graphTools(graph, { rateLimits: { rowLimit: 2, hopLimit: 6 } }).find(
      (t) => t.descriptor.id === 'graph.graph_query',
    )!;
    const parsed = query.parse({ query: 'MATCH (n) RETURN n' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(await query.execute(parsed.value)).toEqual({
      data: { rows: [{ n: 1 }, { n: 1 }], row_count: 2 },
      truncated: true,
      warnings: ['Results truncated to 2 rows'],
    });
  });

  it('returns a tool-level failure as data, not as a thrown error', async () => {
    const query = graphTools(emptyGraph(), LIMITS).find(
      (t) => t.descriptor.id === 'graph.graph_query',
    )!;
    const parsed = query.parse({ query: 'MATCH (n) DETACH DELETE n' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(await query.execute(parsed.value)).toEqual({
      error: expect.objectContaining({ code: 'INVALID_PARAMETER' }),
    });
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/agent-runner exec vitest run src/__tests__/graph-tools.test.ts
```

Expected: FAIL — cannot resolve `../tools/graph-tools.js`.

- [ ] **Step 3: Implement**

Create `packages/agent-runner/src/tools/runner-tool.ts`:

<!-- prettier-ignore-start -->
```ts
import type { ToolDescriptor } from '@shipit-ai/agents';

export type ParseResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** A tool the runner can offer a model: what it is, how to check input, how to run it. */
export interface RunnerTool {
  descriptor: ToolDescriptor;
  /** Validates the model's input and fills defaults. A failure goes back to the model. */
  parse(input: unknown): ParseResult;
  /**
   * Runs the tool on parsed input. A tool-level failure the model should see
   * (unknown node, guardrail) is returned as data; a throw means the tool
   * itself broke and is recorded as a failed call.
   */
  execute(input: Record<string, unknown>): Promise<unknown>;
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/tools/graph-tools.ts`:

<!-- prettier-ignore-start -->
```ts
// The graph read tools, as the MCP server runs them. The runner calls the same
// handlers in-process through @shipit-ai/mcp-server/tools, on its own
// read-session Neo4j client.
import { z } from 'zod';
import {
  graphReadTools,
  type GraphToolConfig,
  type Neo4jClient,
} from '@shipit-ai/mcp-server/tools';
import type { RunnerTool } from './runner-tool.js';

export function graphTools(neo4j: Neo4jClient, config: GraphToolConfig): RunnerTool[] {
  return graphReadTools(neo4j, config).map((tool) => {
    // The runner unwraps the MCP envelope itself (see unwrap below), so the
    // `compact` flag means nothing here and is hidden from the model.
    const modelSchema =
      'compact' in tool.inputSchema.shape
        ? tool.inputSchema.omit({ compact: true } as never)
        : tool.inputSchema;
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(modelSchema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    return {
      descriptor: {
        id: `graph.${tool.name}`,
        service: 'graph',
        effect: tool.effect,
        description: tool.description,
        inputSchema,
        source: 'builtin',
        effectConfirmed: true,
        enabled: true,
      },
      parse(input) {
        const result = modelSchema.safeParse(input ?? {});
        if (result.success) return { ok: true, value: result.data as Record<string, unknown> };
        return {
          ok: false,
          message: result.error.issues
            .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
            .join('; '),
        };
      },
      execute: async (input) => unwrap(await tool.run(input)),
    };
  });
}

/**
 * Drops the MCP `_meta` envelope, which costs tokens and tells a model nothing,
 * but keeps the two parts of it that change what the data means: a truncation
 * flag and warnings. (MCP's own `compact` mode drops those too, and not every
 * tool offers it.) Error payloads have no envelope and pass through.
 */
function unwrap(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('_meta' in payload) || !('data' in payload)) {
    return payload;
  }
  const { _meta: meta, data } = payload as {
    _meta: { truncated?: boolean; warnings?: string[] };
    data: unknown;
  };
  if (!meta.truncated && !meta.warnings?.length) return data;
  return { data, truncated: meta.truncated ?? false, warnings: meta.warnings ?? [] };
}
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/agent-runner exec vitest run && pnpm --filter @shipit-ai/agent-runner typecheck
```

Expected: PASS — 3 files, 19 tests (graph tools 6), 1 skipped (live).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/agent-runner/src/__tests__/graph-tools.test.ts packages/agent-runner/src/tools/graph-tools.ts packages/agent-runner/src/tools/runner-tool.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/agent-runner/src/__tests__/graph-tools.test.ts packages/agent-runner/src/tools/graph-tools.ts packages/agent-runner/src/tools/runner-tool.ts
git commit -m "agent-runner: the graph read tools, validated and unwrapped for models"
```

---

## Task 6: The run loop

The loop reads the last stored message and does the one thing that state needs: a user or tool message means a model step; an assistant message with tool calls means settling those calls (decide, run, record) and appending their results as one tool message, in call order; an assistant message without calls ends the run, or the chat turn. Because every decision is made from Postgres, a resumed run takes the normal path.

Limits are checked before every step (cancel, steps, tokens, time, the agent's daily tokens), using the lower of the agent's own and the instance ceilings. On the last allowed step the loop adds a note asking for an answer, in the instructions and as a stored, tagged message at the end of the transcript (on long transcripts Gemini heeds only the latter; measured live). The tools stay declared on that step: with them gone, Gemini invents tool names. A chat run counts its limits per turn. The lease heartbeat (every 5 s) doubles as the cancel check, aborting the model call in flight. A tool whose grant is `ask` is not offered yet: approvals arrive with Milestone 3.

**Files:**

- Test: `packages/agent-runner/src/__tests__/agent-loop.integration.test.ts` (create)
- Test: `packages/agent-runner/src/__tests__/helpers/loop-fixtures.ts` (create)
- Create: `packages/agent-runner/src/loop/agent-loop.ts`

**Interfaces:**

- Consumes: `RunStore`, `resolveTools`, `RunLeaseLostError` (Tasks 2, 3); `ModelClient`, message builders (Task 4); `RunnerTool` (Task 5).
- Produces: `interface AgentRuntime { process(runId): Promise<ProcessOutcome> }`, `ProcessOutcome = 'finished' | 'waiting' | 'not_claimed' | 'lease_lost'`; `class AgentLoop implements AgentRuntime { constructor(opts: AgentLoopOptions) }` with `AgentLoopOptions = { runs; model; tools; models; ceilings; toolResultChars; owner; leaseSeconds?; renewEveryMs?; now?; publish?; log? }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-runner/src/__tests__/helpers/loop-fixtures.ts`:

<!-- prettier-ignore-start -->
```ts
// Fixtures for the run-loop suites: a scripted model, fake tools, and an agent
// definition with the grants the suites need.
import type { AgentDefinition, StoredMessage, ToolEffect } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import type {
  ModelClient,
  ModelStepRequest,
  ModelStepResult,
  ModelToolCall,
} from '../../model/model-client.js';
import type { RunnerTool } from '../../tools/runner-tool.js';

export const MODEL: AiModelConfig = {
  key: 'gemini',
  label: 'Gemini',
  family: 'gemini',
  modelId: 'gemini-3.8-flash',
  contextWindow: 1_048_576,
  tools: true,
};

export const definition = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  instructions: 'Answer ownership questions using the tools.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: {
    services: {
      graph: { read: 'allow', write: 'off', delete: 'off' },
      gh: { read: 'allow', write: 'allow', delete: 'off' },
    },
    tools: {},
  },
  output: { schema: null },
  ...extra,
});

type Step = (request: ModelStepRequest) => ModelStepResult | Promise<ModelStepResult>;

/** A model that plays back scripted steps and records every request. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelStepRequest[] = [];
  constructor(private readonly script: Step[]) {}

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    // Copy: the loop reuses arrays between steps.
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedModel: no step left');
    return next(request);
  }
}

export const answer =
  (text: string, usage = { input: 100, output: 10 }): Step =>
  () => ({
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
    toolCalls: [],
    text,
    finish: 'stop',
    usage,
  });

/** An assistant message asking for tools, with a Gemini-style signature on each call. */
export const toolCallMessage = (calls: ModelToolCall[]): StoredMessage => ({
  role: 'assistant',
  content: calls.map((c) => ({
    type: 'tool-call',
    toolCallId: c.callId,
    toolName: c.name,
    input: c.input,
    providerOptions: { google: { thoughtSignature: `sig-${c.callId}` } },
  })),
});

export const callTools =
  (calls: ModelToolCall[], usage = { input: 100, output: 10 }): Step =>
  () => ({
    messages: [toolCallMessage(calls)],
    toolCalls: calls,
    text: '',
    finish: 'tool_calls',
    usage,
  });

export interface FakeTool extends RunnerTool {
  calls: Array<Record<string, unknown>>;
  /** [start, end] timestamps per execution, to check overlap. */
  spans: Array<[number, number]>;
}

/** A tool taking `{ q: string }` that answers `{ answer: q }` after `delayMs`. */
export function fakeTool(
  id: string,
  effect: ToolEffect,
  opts: { delayMs?: number; result?: (input: Record<string, unknown>) => unknown } = {},
): FakeTool {
  const tool: FakeTool = {
    calls: [],
    spans: [],
    descriptor: {
      id,
      service: id.split('.')[0]!,
      effect,
      description: `The ${id} tool.`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      source: 'builtin',
      effectConfirmed: true,
      enabled: true,
    },
    parse(input) {
      const q = (input as { q?: unknown } | null)?.q;
      return typeof q === 'string'
        ? { ok: true, value: { q } }
        : { ok: false, message: 'q: expected a string' };
    },
    async execute(input) {
      const start = Date.now();
      tool.calls.push(input);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      tool.spans.push([start, Date.now()]);
      return opts.result ? opts.result(input) : { answer: input.q };
    },
  };
  return tool;
}

/** The tool-result parts of the transcript's tool messages, in order. */
export function toolResults(messages: Array<{ content: StoredMessage }>) {
  return messages
    .filter((m) => m.content.role === 'tool')
    .flatMap(
      (m) =>
        m.content.content as Array<{
          toolCallId: string;
          toolName: string;
          output: { type: string; value: unknown };
        }>,
    );
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/__tests__/agent-loop.integration.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  AgentStore,
  RunStore,
  type AgentDefinition,
  type RunEvent,
  type RunRecord,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { AgentLoop, type AgentLoopOptions } from '../loop/agent-loop.js';
import { ModelCallError } from '../model/model-client.js';
import { userMessage } from '../model/messages.js';
import {
  MODEL,
  ScriptedModel,
  answer,
  callTools,
  definition,
  fakeTool,
  toolCallMessage,
  toolResults,
  type FakeTool,
} from './helpers/loop-fixtures.js';

const CEILINGS = { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 };

describe.skipIf(!DATABASE_TEST_URL)('AgentLoop — Postgres integration', () => {
  let database: TestDatabase;
  let runs: RunStore;
  let agentId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    runs = new RunStore(database.db);
    const agent = await new AgentStore(database.db).create({
      slug: 'owners',
      name: 'Owners',
      definition: definition(),
      actor: 'admin@example.com',
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
  });

  const createRun = (
    extra: { definition?: AgentDefinition; mode?: 'task' | 'chat'; text?: string } = {},
  ) =>
    runs.create({
      agentId,
      agentVersion: 1,
      definition: extra.definition ?? definition(),
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode: extra.mode ?? 'task',
      input: { text: extra.text ?? 'Who owns payments-api?' },
      messages: [userMessage(extra.text ?? 'Who owns payments-api?')],
    });

  function loop(model: ScriptedModel, tools: FakeTool[], extra: Partial<AgentLoopOptions> = {}) {
    const events: RunEvent[] = [];
    const instance = new AgentLoop({
      runs,
      model,
      tools,
      models: [MODEL],
      ceilings: CEILINGS,
      toolResultChars: 50_000,
      owner: 'worker-test',
      renewEveryMs: 20,
      publish: (e) => events.push(e),
      ...extra,
    });
    return { instance, events };
  }

  const reload = async (id: string): Promise<RunRecord> => (await runs.get(id))!;

  it('answers without tools: one step, the answer as output, usage recorded', async () => {
    const run = await createRun();
    const model = new ScriptedModel([answer('team-payments owns it.', { input: 120, output: 30 })]);
    const { instance, events } = loop(model, []);
    expect(await instance.process(run.id)).toBe('finished');

    expect(await reload(run.id)).toMatchObject({
      status: 'succeeded',
      output: { text: 'team-payments owns it.' },
      steps: 1,
      inputTokens: 120,
      outputTokens: 30,
    });
    expect((await runs.listMessages(run.id)).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(model.requests[0]).toMatchObject({
      model: MODEL,
      instructions: 'Answer ownership questions using the tools.',
    });
    expect(events.at(-1)).toEqual({ runId: run.id, status: 'succeeded' });
  });

  it('runs an allowed tool, hands the result back, then answers', async () => {
    const run = await createRun();
    const owners = fakeTool('graph.find_owners', 'read');
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'payments-api' } }]),
      answer('team-payments'),
    ]);
    const { instance } = loop(model, [owners]);
    await instance.process(run.id);

    expect(owners.calls).toEqual([{ q: 'payments-api' }]);
    const messages = await runs.listMessages(run.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(toolResults(messages)).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'graph__find_owners',
        output: { type: 'json', value: { answer: 'payments-api' } },
      },
    ]);
    // The provider metadata the model sent is replayed on the next step.
    expect(JSON.stringify(model.requests[1]!.messages)).toContain('sig-c1');
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['graph__find_owners']);
    expect(await runs.listToolCalls(run.id)).toEqual([
      expect.objectContaining({
        callId: 'c1',
        toolId: 'graph.find_owners',
        service: 'graph',
        effect: 'read',
        policy: 'allow',
        decision: 'allow',
        status: 'succeeded',
        input: { q: 'payments-api' },
        output: { answer: 'payments-api' },
      }),
    ]);
    expect((await reload(run.id)).status).toBe('succeeded');
  });

  it('denies a tool the model invented, tells it so, and carries on', async () => {
    const run = await createRun();
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__drop_database', input: {} }]),
      answer('I cannot do that.'),
    ]);
    const { instance } = loop(model, [fakeTool('graph.find_owners', 'read')]);
    await instance.process(run.id);

    expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
      error: { code: 'UNKNOWN_TOOL', message: expect.stringContaining('graph__drop_database') },
    });
    expect(await runs.listToolCalls(run.id)).toEqual([
      expect.objectContaining({
        toolId: 'graph__drop_database',
        decision: 'deny',
        status: 'denied',
        policy: 'off',
      }),
    ]);
    expect((await reload(run.id)).status).toBe('succeeded');
  });

  it('returns invalid input to the model as an error naming the problem, without running the tool', async () => {
    const run = await createRun();
    const owners = fakeTool('graph.find_owners', 'read');
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 42 } }]),
      answer('Sorry.'),
    ]);
    await loop(model, [owners]).instance.process(run.id);

    expect(owners.calls).toEqual([]);
    expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
      error: { code: 'INVALID_INPUT', message: 'q: expected a string' },
    });
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({ status: 'failed' });
  });

  it('records a tool that throws as a failed call and lets the model see the error', async () => {
    const run = await createRun();
    const broken = fakeTool('graph.find_owners', 'read', {
      result: () => {
        throw new Error('Neo4j unavailable');
      },
    });
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'x' } }]),
      answer('The graph is down.'),
    ]);
    await loop(model, [broken]).instance.process(run.id);

    expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
      error: { code: 'TOOL_ERROR', message: 'Neo4j unavailable' },
    });
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: 'Neo4j unavailable' },
    });
    expect((await reload(run.id)).status).toBe('succeeded');
  });

  it('runs reads in parallel and appends every result in call order', async () => {
    const run = await createRun();
    const slow = fakeTool('graph.slow', 'read', { delayMs: 80 });
    const fast = fakeTool('graph.fast', 'read', { delayMs: 5 });
    const model = new ScriptedModel([
      callTools([
        { callId: 'c1', name: 'graph__slow', input: { q: 'a' } },
        { callId: 'c2', name: 'graph__fast', input: { q: 'b' } },
      ]),
      answer('done'),
    ]);
    await loop(model, [slow, fast]).instance.process(run.id);

    // The fast read started before the slow one finished.
    expect(fast.spans[0]![0]).toBeLessThan(slow.spans[0]![1]);
    const messages = await runs.listMessages(run.id);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(toolResults(messages).map((r) => r.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('runs writes one at a time', async () => {
    const run = await createRun();
    const first = fakeTool('gh.comment', 'write', { delayMs: 40 });
    const second = fakeTool('gh.add_labels', 'write', { delayMs: 5 });
    const model = new ScriptedModel([
      callTools([
        { callId: 'c1', name: 'gh__comment', input: { q: 'a' } },
        { callId: 'c2', name: 'gh__add_labels', input: { q: 'b' } },
      ]),
      answer('done'),
    ]);
    await loop(model, [first, second]).instance.process(run.id);

    expect(second.spans[0]![0]).toBeGreaterThanOrEqual(first.spans[0]![1]);
  });

  it('offers only allowed tools; an ask grant waits for approvals, with a warning', async () => {
    const run = await createRun({
      definition: definition({
        grants: {
          services: { graph: { read: 'allow', write: 'off', delete: 'off' } },
          tools: { 'gh.comment': 'ask' },
        },
      }),
    });
    const model = new ScriptedModel([answer('ok')]);
    await loop(model, [
      fakeTool('graph.find_owners', 'read'),
      fakeTool('gh.comment', 'write'),
      fakeTool('gh.add_labels', 'write'),
    ]).instance.process(run.id);

    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['graph__find_owners']);
    expect((await reload(run.id)).warnings).toEqual([
      'gh.comment needs approval before it runs. Approvals are not available yet, so it was not offered.',
    ]);
  });

  it('stores a large result in full and gives the model a truncated copy', async () => {
    const run = await createRun();
    const big = fakeTool('graph.find_owners', 'read', {
      result: () => ({ blob: 'x'.repeat(500) }),
    });
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'x' } }]),
      answer('ok'),
    ]);
    await loop(model, [big], { toolResultChars: 100 }).instance.process(run.id);

    const inContext = toolResults(await runs.listMessages(run.id))[0]!.output.value as {
      truncated: boolean;
      note: string;
      content: string;
    };
    expect(inContext.truncated).toBe(true);
    expect(inContext.content).toHaveLength(100);
    expect(inContext.note).toMatch(/100 of 511 characters/);
    expect((await runs.listToolCalls(run.id))[0]).toMatchObject({
      output: { blob: 'x'.repeat(500) },
      outputTruncated: true,
    });
  });

  describe('limits', () => {
    it('fails with STEP_LIMIT when the model keeps calling tools past maxSteps', async () => {
      const run = await createRun({
        definition: definition({
          limits: { maxSteps: 2, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        callTools([{ callId: 'c2', name: 'graph__find_owners', input: { q: 'b' } }]),
        answer('never reached'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')]).instance.process(run.id);

      expect(model.requests).toHaveLength(2);
      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        error: { code: 'STEP_LIMIT' },
        steps: 2,
      });
      // A call made on the last step is kept in the transcript but never run.
      expect((await runs.listToolCalls(run.id)).map((c) => c.callId)).toEqual(['c1']);
      expect((await runs.listMessages(run.id)).at(-1)!.role).toBe('assistant');
    });

    it('asks for an answer on the last allowed step, from what the run found', async () => {
      const run = await createRun({
        definition: definition({
          limits: { maxSteps: 2, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        answer('team-a, as far as I found.'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')]).instance.process(run.id);

      // Tools stay declared (Gemini invents tool names when they vanish from a
      // transcript that used them); the instructions ask for an answer.
      expect(model.requests[1]!.tools).toHaveLength(1);
      expect(model.requests[0]!.instructions).not.toMatch(/last step/i);
      expect(model.requests[1]!.instructions).toMatch(/last step.*answer now/i);
      // A note at the end of the transcript is what long transcripts heed
      // (measured live); it is stored, tagged so the UI can show it as a note.
      const note = model.requests[1]!.messages.at(-1)!;
      expect(note).toMatchObject({
        role: 'user',
        content: expect.stringMatching(/last step/i),
        providerOptions: { shipit: { kind: 'step-limit-note' } },
      });
      const stored = (await runs.listMessages(run.id)).map((m) => m.content);
      expect(stored.filter((m) => JSON.stringify(m).includes('step-limit-note'))).toHaveLength(1);
      expect(await reload(run.id)).toMatchObject({
        status: 'succeeded',
        output: { text: 'team-a, as far as I found.' },
      });
    });

    it('fails with BUDGET_EXCEEDED once the run has used its tokens', async () => {
      const run = await createRun({
        definition: definition({
          limits: { maxSteps: 10, maxTokens: 1_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }], {
          input: 900,
          output: 200,
        }),
        answer('never reached'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')]).instance.process(run.id);

      expect(model.requests).toHaveLength(1);
      expect((await reload(run.id)).error).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    });

    it('applies the instance ceiling when it is lower than the agent’s own limit', async () => {
      const run = await createRun();
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        answer('never reached'),
      ]);
      await loop(model, [fakeTool('graph.find_owners', 'read')], {
        ceilings: { ...CEILINGS, maxSteps: 1 },
      }).instance.process(run.id);

      expect((await reload(run.id)).error).toMatchObject({ code: 'STEP_LIMIT' });
    });

    it('refuses to start with DAILY_LIMIT when the agent spent its daily tokens', async () => {
      const earlier = await createRun();
      await runs.recordStep(earlier.id, { input: 999_000, output: 1_000 });
      const run = await createRun();
      const model = new ScriptedModel([answer('never reached')]);
      await loop(model, []).instance.process(run.id);

      expect(model.requests).toHaveLength(0);
      expect((await reload(run.id)).error).toMatchObject({ code: 'DAILY_LIMIT' });
    });

    it('fails with TIMEOUT once the run is older than its timeout', async () => {
      const run = await createRun();
      const later = () => new Date(Date.now() + 301_000);
      const model = new ScriptedModel([answer('never reached')]);
      await loop(model, [], { now: later }).instance.process(run.id);

      expect(model.requests).toHaveLength(0);
      expect((await reload(run.id)).error).toMatchObject({ code: 'TIMEOUT' });
    });
  });

  describe('model outcomes', () => {
    it('fails with MODEL_REFUSED when the model stops for safety', async () => {
      const run = await createRun();
      const model = new ScriptedModel([
        () => ({
          messages: [],
          toolCalls: [],
          text: '',
          finish: 'refusal',
          usage: { input: 5, output: 0 },
        }),
      ]);
      await loop(model, []).instance.process(run.id);
      expect((await reload(run.id)).error).toMatchObject({ code: 'MODEL_REFUSED' });
    });

    it('fails with the model layer’s code when the call fails', async () => {
      for (const code of ['MODEL_ERROR', 'CONTEXT_EXCEEDED'] as const) {
        const run = await createRun();
        const model = new ScriptedModel([
          () => {
            throw new ModelCallError(code, `boom ${code}`);
          },
        ]);
        await loop(model, []).instance.process(run.id);
        expect((await reload(run.id)).error).toEqual({ code, message: `boom ${code}` });
      }
    });

    it('fails with MODEL_ERROR when the agent names a model the instance does not offer', async () => {
      const run = await createRun({ definition: definition({ model: 'retired-model' }) });
      const model = new ScriptedModel([answer('never reached')]);
      await loop(model, []).instance.process(run.id);
      expect(model.requests).toHaveLength(0);
      expect((await reload(run.id)).error).toMatchObject({
        code: 'MODEL_ERROR',
        message: expect.stringContaining('retired-model'),
      });
    });

    it('offers no tools to a model that cannot call them, and says so', async () => {
      const run = await createRun();
      const model = new ScriptedModel([answer('ok')]);
      await loop(model, [fakeTool('graph.find_owners', 'read')], {
        models: [{ ...MODEL, tools: false }],
      }).instance.process(run.id);
      expect(model.requests[0]!.tools).toEqual([]);
      expect((await reload(run.id)).warnings).toContain(
        'Model gemini cannot call tools, so none were offered.',
      );
    });
  });

  describe('cancel', () => {
    it('aborts the model call in flight and ends the run cancelled', async () => {
      const run = await createRun();
      const model = new ScriptedModel([
        (request) =>
          new Promise((_resolve, reject) => {
            void runs.requestCancel(run.id);
            request.signal.addEventListener('abort', () =>
              reject(new ModelCallError('ABORTED', 'aborted')),
            );
          }),
      ]);
      expect(await loop(model, []).instance.process(run.id)).toBe('finished');
      expect((await reload(run.id)).status).toBe('cancelled');
    });

    it('does nothing for a run that was cancelled before a worker took it', async () => {
      const run = await createRun();
      await runs.requestCancel(run.id);
      const model = new ScriptedModel([answer('never reached')]);
      expect(await loop(model, []).instance.process(run.id)).toBe('not_claimed');
      expect(model.requests).toHaveLength(0);
    });
  });

  describe('chat', () => {
    it('ends each turn waiting for input and continues on the next message', async () => {
      const run = await createRun({ mode: 'chat', text: 'Hi' });
      const model = new ScriptedModel([answer('Hello. Ask me about owners.'), answer('team-a')]);
      const { instance } = loop(model, []);
      expect(await instance.process(run.id)).toBe('waiting');
      expect((await reload(run.id)).status).toBe('waiting_input');

      await runs.addUserMessage(run.id, userMessage('Who owns x?'));
      expect(await instance.process(run.id)).toBe('waiting');
      expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect((await reload(run.id)).steps).toBe(2);
    });

    it('applies the step and token limits to each turn, not to the whole conversation', async () => {
      const run = await createRun({
        mode: 'chat',
        definition: definition({
          limits: { maxSteps: 2, maxTokens: 300, timeoutSeconds: 300, dailyTokens: 1_000_000 },
        }),
      });
      const owners = fakeTool('graph.find_owners', 'read');
      const model = new ScriptedModel([
        callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'a' } }]),
        answer('team-a'),
        callTools([{ callId: 'c2', name: 'graph__find_owners', input: { q: 'b' } }]),
        answer('team-b'),
      ]);
      const { instance } = loop(model, [owners]);
      expect(await instance.process(run.id)).toBe('waiting');
      await runs.addUserMessage(run.id, userMessage('And b?'));
      // Two steps and 220 tokens already spent; the second turn gets its own two and 300.
      expect(await instance.process(run.id)).toBe('waiting');
      expect(await reload(run.id)).toMatchObject({ status: 'waiting_input', steps: 4 });
      expect(owners.calls).toEqual([{ q: 'a' }, { q: 'b' }]);
    });
  });

  describe('crash recovery', () => {
    // A worker died after the model asked for tools and after it wrote the
    // tool_calls row as executing, before the result was appended. The run's
    // lease has run out, so another worker takes it.
    async function crashedMidTool(effect: 'read' | 'write') {
      const name = effect === 'read' ? 'graph__find_owners' : 'gh__comment';
      const toolId = effect === 'read' ? 'graph.find_owners' : 'gh.comment';
      const run = await createRun();
      await runs.claim(run.id, 'worker-dead', 60);
      const [assistant] = await runs.appendMessages(run.id, [
        toolCallMessage([{ callId: 'c1', name, input: { q: 'x' } }]),
      ]);
      await runs.recordStep(run.id, { input: 100, output: 10 });
      await runs.startToolCall({
        runId: run.id,
        callId: 'c1',
        messageSeq: assistant!.seq,
        toolId,
        service: toolId.split('.')[0]!,
        effect,
        policy: 'allow',
        decision: 'allow',
        status: 'executing',
        input: { q: 'x' },
      });
      await database.db.query(
        `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [run.id],
      );
      return run;
    }

    it('re-runs a read that was in flight', async () => {
      const run = await crashedMidTool('read');
      const owners = fakeTool('graph.find_owners', 'read');
      const model = new ScriptedModel([answer('team-a')]);
      expect(await loop(model, [owners]).instance.process(run.id)).toBe('finished');

      expect(owners.calls).toEqual([{ q: 'x' }]);
      expect((await runs.listToolCalls(run.id))[0]).toMatchObject({ status: 'succeeded' });
      expect((await reload(run.id)).status).toBe('succeeded');
    });

    it('never repeats a write that was in flight; the model is told its outcome is unknown', async () => {
      const run = await crashedMidTool('write');
      const comment = fakeTool('gh.comment', 'write');
      const model = new ScriptedModel([answer('I will check before retrying.')]);
      await loop(model, [comment]).instance.process(run.id);

      expect(comment.calls).toEqual([]);
      expect((await runs.listToolCalls(run.id))[0]).toMatchObject({ status: 'outcome_unknown' });
      expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
        error: { code: 'OUTCOME_UNKNOWN', message: expect.stringMatching(/check/i) },
      });
    });

    it('reuses a result that was recorded before the crash instead of running the tool again', async () => {
      const run = await crashedMidTool('read');
      const [row] = await runs.listToolCalls(run.id);
      await runs.finishToolCall(row!.id, { status: 'succeeded', output: { answer: 'cached' } });
      const owners = fakeTool('graph.find_owners', 'read');
      const model = new ScriptedModel([answer('ok')]);
      await loop(model, [owners]).instance.process(run.id);

      expect(owners.calls).toEqual([]);
      expect(toolResults(await runs.listMessages(run.id))[0]!.output.value).toEqual({
        answer: 'cached',
      });
    });
  });

  it('stops without touching the run when another worker takes it over', async () => {
    const run = await createRun();
    const model = new ScriptedModel([
      async (request) => {
        // Another worker steals the run while the model call is in flight.
        await database.db.query(`UPDATE runs SET lease_owner = 'worker-other' WHERE id = $1`, [
          run.id,
        ]);
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(new ModelCallError('ABORTED', 'aborted')),
          ),
        );
      },
    ]);
    expect(await loop(model, []).instance.process(run.id)).toBe('lease_lost');
    expect((await reload(run.id)).status).toBe('running');
  });

  it('announces every append and the final status', async () => {
    const run = await createRun();
    const model = new ScriptedModel([
      callTools([{ callId: 'c1', name: 'graph__find_owners', input: { q: 'x' } }]),
      answer('ok'),
    ]);
    const { instance, events } = loop(model, [fakeTool('graph.find_owners', 'read')]);
    await instance.process(run.id);
    expect(events).toEqual([
      { runId: run.id, status: 'running' },
      { runId: run.id, seq: 1 },
      { runId: run.id, seq: 2 },
      { runId: run.id, seq: 3 },
      { runId: run.id, status: 'succeeded' },
    ]);
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agent-runner exec vitest run src/__tests__/agent-loop.integration.test.ts
```

Expected: FAIL — cannot resolve `../loop/agent-loop.js`.

- [ ] **Step 3: Implement**

Create `packages/agent-runner/src/loop/agent-loop.ts`:

<!-- prettier-ignore-start -->
```ts
// The run loop: the one AgentRuntime implementation (design §Run lifecycle).
//
// It works as a state machine over the stored transcript. Each pass reads the
// last message and does the one thing that state needs:
//   - a user or tool message: call the model for the next step;
//   - an assistant message with tool calls: settle those calls (decide, run,
//     record) and append their results as one tool message;
//   - an assistant message without tool calls: end the run, or the chat turn.
// Because the decision is made from Postgres every time, resuming after a
// crash is the same code path as running normally.
import {
  RunLeaseLostError,
  resolveTools,
  type AgentLimits,
  type ResolvedTool,
  type RunErrorCode,
  type RunEvent,
  type RunRecord,
  type RunStore,
  type StartToolCallInput,
  type StoredMessage,
  type ToolCallRecord,
} from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import { ModelCallError, type ModelClient, type ModelStepResult } from '../model/model-client.js';
import {
  STEP_LIMIT_NOTE,
  isStepLimitNote,
  stepLimitNote,
  toolResultMessage,
} from '../model/messages.js';
import type { RunnerTool } from '../tools/runner-tool.js';

export type ProcessOutcome = 'finished' | 'waiting' | 'not_claimed' | 'lease_lost';

/** The seam the worker depends on; a hosted runtime could implement it later. */
export interface AgentRuntime {
  /** Claims the run and works on it until it ends, parks, or another worker takes it. */
  process(runId: string): Promise<ProcessOutcome>;
}

export interface AgentLoopOptions {
  runs: RunStore;
  model: ModelClient;
  /** Every tool the runner can offer; each run sees the ones its grants allow. */
  tools: RunnerTool[];
  /** The instance's model catalog (ai.models). */
  models: AiModelConfig[];
  /** Instance ceilings (ai.limits). The lower of these and the agent's own apply. */
  ceilings: AgentLimits;
  /** A tool result longer than this, as JSON, is truncated in the model's context. */
  toolResultChars: number;
  /** Identifies this worker in run leases. */
  owner: string;
  leaseSeconds?: number;
  renewEveryMs?: number;
  now?: () => Date;
  publish?: (event: RunEvent) => void;
  log?: (message: string) => void;
}

interface ToolCallRequest {
  callId: string;
  name: string;
  input: unknown;
}

interface Offered {
  resolved: ResolvedTool;
  tool: RunnerTool;
}

type AbortReason = 'cancelled' | 'lease_lost';

/** Steps and tokens counted against the limits: the run's, or a chat turn's. */
interface Usage {
  steps: number;
  tokens: number;
}

// A finished run's outcome, or a reason to stop without touching the run.
type Stop = { kind: 'end'; outcome: ProcessOutcome };

const LIVE_CALL: ReadonlySet<ToolCallRecord['status']> = new Set(['pending', 'executing']);

export class AgentLoop implements AgentRuntime {
  private readonly leaseSeconds: number;
  private readonly renewEveryMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: AgentLoopOptions) {
    this.leaseSeconds = opts.leaseSeconds ?? 60;
    this.renewEveryMs = opts.renewEveryMs ?? 5_000;
    this.now = opts.now ?? (() => new Date());
  }

  async process(runId: string): Promise<ProcessOutcome> {
    const run = await this.opts.runs.claim(runId, this.opts.owner, this.leaseSeconds);
    if (!run) return 'not_claimed';
    this.publish({ runId, status: 'running' });

    // The lease heartbeat doubles as the cancel check: a cancel request or a
    // takeover aborts whatever the run is waiting on.
    const control = new AbortController();
    const heartbeat = setInterval(() => {
      this.opts.runs.renewLease(runId, this.opts.owner, this.leaseSeconds).then(
        (lease) => {
          if (!lease.held) control.abort('lease_lost' satisfies AbortReason);
          else if (lease.cancelRequested) control.abort('cancelled' satisfies AbortReason);
        },
        (err: Error) => this.log(`run ${runId}: lease renewal failed: ${err.message}`),
      );
    }, this.renewEveryMs);

    try {
      return await this.drive(run, control.signal);
    } catch (err) {
      if (err instanceof RunLeaseLostError) return 'lease_lost';
      throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async drive(claimed: RunRecord, signal: AbortSignal): Promise<ProcessOutcome> {
    const { runs } = this.opts;
    let run = claimed;
    const definition = run.definition;
    const model = this.opts.models.find((m) => m.key === definition.model);
    if (!model) {
      return this.fail(
        run,
        'MODEL_ERROR',
        `Model ${definition.model} is not offered on this instance.`,
      );
    }
    const limits = lowest(definition.limits, this.opts.ceilings);
    const offered = await this.offerTools(run, model);
    // A task run's limits cover the whole run. A chat run's step, token and
    // time limits cover one turn (from a user message to the answer): counted
    // over the whole conversation they would end every chat after a few
    // questions, since each step resends the transcript. The daily cap still
    // bounds what a conversation spends.
    const chat = run.mode === 'chat';
    const clockStart = chat ? this.now() : new Date(run.startedAt ?? Date.now());
    const base = chat ? { steps: run.steps, tokens: run.inputTokens + run.outputTokens } : null;
    const used = (r: RunRecord): Usage => ({
      steps: r.steps - (base?.steps ?? 0),
      tokens: r.inputTokens + r.outputTokens - (base?.tokens ?? 0),
    });

    for (;;) {
      const messages = await runs.listMessages(run.id);
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        const calls = toolCallsOf(last.content);
        if (calls.length > 0) {
          const results = await this.settleCalls(run, last.seq, calls, offered);
          const stopped = this.stopFor(signal);
          if (stopped === 'lease_lost') return 'lease_lost';
          await this.append(run, [toolResultMessage(results)]);
          continue;
        }
        if (run.mode === 'chat') {
          await runs.waitForInput(run.id, this.opts.owner);
          this.publish({ runId: run.id, status: 'waiting_input' });
          return 'waiting';
        }
        return this.end(run, { status: 'succeeded', output: { text: textOf(last.content) } });
      }

      const blocked = await this.checkBeforeStep(run, used, limits, clockStart, signal);
      if (blocked) return blocked.outcome;
      if (isLastStep(used(run), limits) && !isStepLimitNote(last?.content)) {
        await this.append(run, [stepLimitNote()]);
        continue;
      }

      const step = await this.callModel(
        run,
        used(run),
        model,
        definition,
        messages,
        offered,
        limits,
        clockStart,
        signal,
      );
      if ('kind' in step) return step.outcome;
      if (step.finish === 'refusal') {
        await runs.recordStep(run.id, step.usage);
        return this.fail(run, 'MODEL_REFUSED', step.text || 'The model declined to answer.');
      }
      if (step.messages.length === 0 || (step.finish === 'error' && step.toolCalls.length === 0)) {
        await runs.recordStep(run.id, step.usage);
        return this.fail(run, 'MODEL_ERROR', 'The model stopped without an answer.');
      }
      const lastStep = isLastStep(used(run), limits);
      await this.append(run, step.messages);
      run = await runs.recordStep(run.id, step.usage);
      if (lastStep && step.toolCalls.length > 0) {
        // Asked to answer, the model called a tool anyway. Nothing runs past
        // the limit: the call stays in the transcript, unrun.
        return this.fail(
          run,
          'STEP_LIMIT',
          `The run reached its limit of ${limits.maxSteps} model steps.`,
        );
      }
      if (step.finish === 'length' && step.toolCalls.length === 0) {
        await runs.addWarning(run.id, "The answer was cut off at the model's output limit.");
      }
    }
  }

  /** The tools this run may offer, with a warning for each grant it cannot honour. */
  private async offerTools(run: RunRecord, model: AiModelConfig): Promise<Map<string, Offered>> {
    const byId = new Map(this.opts.tools.map((t) => [t.descriptor.id, t]));
    const { tools, warnings } = resolveTools(
      run.definition,
      this.opts.tools.map((t) => t.descriptor),
      run.writePolicy,
    );
    const notes = [...warnings];
    let allowed = tools.filter((t) => t.policy === 'allow');
    for (const t of tools.filter((t) => t.policy === 'ask')) {
      // Approvals arrive with Milestone 3. Until then a tool that must ask is
      // not offered at all, rather than offered and then refused.
      notes.push(
        `${t.id} needs approval before it runs. Approvals are not available yet, so it was not offered.`,
      );
    }
    if (!model.tools && allowed.length > 0) {
      notes.push(`Model ${model.key} cannot call tools, so none were offered.`);
      allowed = [];
    }
    if (run.definition.output.schema) {
      notes.push('Structured output is not available yet; the run returns text.');
    }
    for (const note of notes) await this.opts.runs.addWarning(run.id, note);
    return new Map(allowed.map((t) => [t.modelName, { resolved: t, tool: byId.get(t.id)! }]));
  }

  /** Cancel, limits and the daily cap, checked before every model step. */
  private async checkBeforeStep(
    run: RunRecord,
    used: (run: RunRecord) => Usage,
    limits: AgentLimits,
    clockStart: Date,
    signal: AbortSignal,
  ): Promise<Stop | null> {
    const stopped = this.stopFor(signal);
    if (stopped === 'lease_lost') return { kind: 'end', outcome: 'lease_lost' };
    const current = (await this.opts.runs.get(run.id)) ?? run;
    if (stopped === 'cancelled' || current.cancelRequested) {
      return { kind: 'end', outcome: await this.end(run, { status: 'cancelled' }) };
    }
    const failWith = async (code: RunErrorCode, message: string): Promise<Stop> => ({
      kind: 'end',
      outcome: await this.fail(run, code, message),
    });
    const spent = used(current);
    if (spent.steps >= limits.maxSteps) {
      return failWith('STEP_LIMIT', `The run reached its limit of ${limits.maxSteps} model steps.`);
    }
    if (spent.tokens >= limits.maxTokens) {
      return failWith(
        'BUDGET_EXCEEDED',
        `The run used ${spent.tokens} tokens, over its limit of ${limits.maxTokens}.`,
      );
    }
    if (this.now().getTime() - clockStart.getTime() >= limits.timeoutSeconds * 1000) {
      return failWith('TIMEOUT', `The run passed its timeout of ${limits.timeoutSeconds} seconds.`);
    }
    const today = await this.opts.runs.tokensSince(run.agentId, startOfUtcDay(this.now()));
    if (today >= limits.dailyTokens) {
      return failWith(
        'DAILY_LIMIT',
        `The agent used ${today} tokens today, over its daily limit of ${limits.dailyTokens}.`,
      );
    }
    return null;
  }

  private async callModel(
    run: RunRecord,
    spent: Usage,
    model: AiModelConfig,
    definition: RunRecord['definition'],
    messages: Array<{ content: StoredMessage }>,
    offered: Map<string, Offered>,
    limits: AgentLimits,
    clockStart: Date,
    signal: AbortSignal,
  ): Promise<ModelStepResult | Stop> {
    // The step may run until the run's timeout, and no longer.
    const remainingMs = clockStart.getTime() + limits.timeoutSeconds * 1000 - this.now().getTime();
    // On the last step the run may take, ask for an answer: a model still
    // exploring would otherwise spend the whole budget and end with nothing.
    // The note is in the instructions and (stepLimitNote) at the end of the
    // transcript. The tools stay declared: with them gone from a transcript
    // that used them, Gemini invents tool names instead of answering (seen live).
    const instructions = isLastStep(spent, limits)
      ? `${definition.instructions}\n\n${STEP_LIMIT_NOTE}`
      : definition.instructions;
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(remainingMs, 1))]);
    try {
      return await this.opts.model.step({
        model,
        instructions,
        messages: messages.map((m) => m.content),
        tools: [...offered.values()].map(({ resolved }) => ({
          name: resolved.modelName,
          description: resolved.description,
          inputSchema: resolved.inputSchema,
        })),
        ...(definition.effort ? { effort: definition.effort } : {}),
        signal: stepSignal,
      });
    } catch (err) {
      if (!(err instanceof ModelCallError)) throw err;
      if (err.code !== 'ABORTED') {
        return { kind: 'end', outcome: await this.fail(run, err.code, err.message) };
      }
      const stopped = this.stopFor(signal);
      if (stopped === 'lease_lost') return { kind: 'end', outcome: 'lease_lost' };
      if (stopped === 'cancelled') {
        return { kind: 'end', outcome: await this.end(run, { status: 'cancelled' }) };
      }
      return {
        kind: 'end',
        outcome: await this.fail(
          run,
          'TIMEOUT',
          `The run passed its timeout of ${limits.timeoutSeconds} seconds.`,
        ),
      };
    }
  }

  /**
   * Resolves every call of one model step and returns their results in call
   * order. A call with a finished audit row reuses that row's result (the
   * runner stopped after recording it). Reads run in parallel; writes and
   * deletes run one at a time, after the reads.
   */
  private async settleCalls(
    run: RunRecord,
    messageSeq: number,
    calls: ToolCallRequest[],
    offered: Map<string, Offered>,
  ): Promise<Array<{ callId: string; name: string; output: unknown }>> {
    const { runs } = this.opts;
    const recorded = new Map((await runs.listToolCalls(run.id)).map((c) => [c.callId, c]));
    const outputs: unknown[] = new Array(calls.length);
    const reads: Array<() => Promise<void>> = [];
    const writes: Array<() => Promise<void>> = [];

    calls.forEach((call, i) => {
      const prior = recorded.get(call.callId);
      if (prior && !LIVE_CALL.has(prior.status)) {
        outputs[i] = this.resultOf(prior);
        return;
      }
      const entry = offered.get(call.name);
      if (!entry) {
        reads.push(async () => {
          const error = {
            code: 'UNKNOWN_TOOL',
            message: `There is no tool named ${call.name}. Use only the tools you were given.`,
          };
          await runs.startToolCall({
            runId: run.id,
            callId: call.callId,
            messageSeq,
            toolId: call.name,
            service: null,
            effect: null,
            policy: 'off',
            decision: 'deny',
            status: 'denied',
            input: call.input ?? null,
            error,
          });
          outputs[i] = { error };
        });
        return;
      }
      const { resolved, tool } = entry;
      const base = {
        runId: run.id,
        callId: call.callId,
        messageSeq,
        toolId: resolved.id,
        service: resolved.service,
        effect: resolved.effect,
        policy: resolved.policy,
        decision: 'allow' as const,
        input: call.input ?? null,
      };
      // A write or delete that was running when the runner stopped is never
      // repeated (design decision 13): the model is told to check first.
      if (prior?.status === 'executing' && resolved.effect !== 'read') {
        writes.push(async () => {
          const error = {
            code: 'OUTCOME_UNKNOWN',
            message:
              'The runner stopped while this call was running, so it may or may not have taken effect. Check its result before trying again.',
          };
          await runs.finishToolCall(prior.id, { status: 'outcome_unknown', error });
          outputs[i] = { error };
        });
        return;
      }
      const parsed = tool.parse(call.input);
      if (!parsed.ok) {
        reads.push(async () => {
          const error = { code: 'INVALID_INPUT', message: parsed.message };
          await runs.startToolCall({ ...base, status: 'failed', error });
          outputs[i] = { error };
        });
        return;
      }
      (resolved.effect === 'read' ? reads : writes).push(async () => {
        outputs[i] = await this.execute(base, tool, parsed.value);
      });
    });

    await Promise.all(reads.map((task) => task()));
    for (const task of writes) await task();
    return calls.map((call, i) => ({ callId: call.callId, name: call.name, output: outputs[i] }));
  }

  /** Runs one call with its audit row written before and after. */
  private async execute(
    base: Omit<StartToolCallInput, 'status'>,
    tool: RunnerTool,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const { runs } = this.opts;
    const row = await runs.startToolCall({ ...base, status: 'executing' });
    try {
      const output = await tool.execute(input);
      const fitted = this.fit(output);
      await runs.finishToolCall(row.id, {
        status: 'succeeded',
        output: output ?? null,
        outputTruncated: fitted.truncated,
      });
      return fitted.value;
    } catch (err) {
      const error = { code: 'TOOL_ERROR', message: (err as Error).message };
      await runs.finishToolCall(row.id, { status: 'failed', error });
      return { error };
    }
  }

  /** The result a recorded call gives the model. */
  private resultOf(call: ToolCallRecord): unknown {
    if (call.status === 'succeeded') return this.fit(call.output).value;
    return { error: call.error };
  }

  /** A result too long for context is cut, with a note; the audit row keeps it whole. */
  private fit(output: unknown): { value: unknown; truncated: boolean } {
    const text = JSON.stringify(output ?? null);
    const limit = this.opts.toolResultChars;
    if (text.length <= limit) return { value: output ?? null, truncated: false };
    return {
      value: {
        truncated: true,
        note: `Result truncated to ${limit} of ${text.length} characters.`,
        content: text.slice(0, limit),
      },
      truncated: true,
    };
  }

  private async append(run: RunRecord, messages: StoredMessage[]): Promise<void> {
    const appended = await this.opts.runs.appendMessages(run.id, messages, this.opts.owner);
    const last = appended.at(-1);
    if (last) this.publish({ runId: run.id, seq: last.seq });
  }

  private async end(
    run: RunRecord,
    outcome: { status: 'succeeded'; output: unknown } | { status: 'cancelled' },
  ): Promise<ProcessOutcome> {
    const done = await this.opts.runs.finish(run.id, outcome, this.opts.owner);
    if (done) this.publish({ runId: run.id, status: done.status });
    return 'finished';
  }

  private async fail(run: RunRecord, code: RunErrorCode, message: string): Promise<ProcessOutcome> {
    const done = await this.opts.runs.finish(
      run.id,
      { status: 'failed', error: { code, message } },
      this.opts.owner,
    );
    if (done) this.publish({ runId: run.id, status: done.status });
    return 'finished';
  }

  private stopFor(signal: AbortSignal): AbortReason | null {
    return signal.aborted ? (signal.reason as AbortReason) : null;
  }

  private publish(event: RunEvent): void {
    try {
      this.opts.publish?.(event);
    } catch (err) {
      this.log(`run ${event.runId}: publish failed: ${(err as Error).message}`);
    }
  }

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }
}

function isLastStep(spent: Usage, limits: AgentLimits): boolean {
  return spent.steps + 1 >= limits.maxSteps;
}

function lowest(own: AgentLimits, ceilings: AgentLimits): AgentLimits {
  return {
    maxSteps: Math.min(own.maxSteps, ceilings.maxSteps),
    maxTokens: Math.min(own.maxTokens, ceilings.maxTokens),
    timeoutSeconds: Math.min(own.timeoutSeconds, ceilings.timeoutSeconds),
    dailyTokens: Math.min(own.dailyTokens, ceilings.dailyTokens),
  };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The tool calls in a stored assistant message, in order. */
function toolCallsOf(message: StoredMessage): ToolCallRequest[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } =>
        (part as { type?: string })?.type === 'tool-call',
    )
    .map((part) => ({ callId: part.toolCallId, name: part.toolName, input: part.input }));
}

/** The text of a stored assistant message. */
function textOf(message: StoredMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        (part as { type?: string })?.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agent-runner run test:integration && pnpm --filter @shipit-ai/agent-runner typecheck
```

Expected: PASS — 1 file, 28 tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/agent-runner/src/__tests__/agent-loop.integration.test.ts packages/agent-runner/src/__tests__/helpers/loop-fixtures.ts packages/agent-runner/src/loop/agent-loop.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/agent-runner/src/__tests__/agent-loop.integration.test.ts packages/agent-runner/src/__tests__/helpers/loop-fixtures.ts packages/agent-runner/src/loop/agent-loop.ts
git commit -m "agent-runner: the run loop (limits, cancel, chat turns, crash recovery)"
```

---

## Task 7: The runner process

The process around the loop: a BullMQ worker that hands each job's run id to the loop; run events published on Redis; a heartbeat and a sweeper (expired leases re-queued, stalled runs failed, idle chats closed); a schema wait so a runner started before the migration step catches up waits instead of crashing; and the entry point, Dockerfile, compose service and CI. The config gains `ai.runner.concurrency`, `ai.limits.toolResultChars` and `ai.limits.chatIdleMinutes`.

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docker/docker-compose.yml`
- Create: `packages/agent-runner/Dockerfile`
- Test: `packages/agent-runner/src/__tests__/prerequisites.test.ts` (create)
- Test: `packages/agent-runner/src/__tests__/runner-process.integration.test.ts` (create)
- Create: `packages/agent-runner/src/main.ts`
- Create: `packages/agent-runner/src/process/housekeeping.ts`
- Create: `packages/agent-runner/src/process/prerequisites.ts`
- Create: `packages/agent-runner/src/process/run-events.ts`
- Create: `packages/agent-runner/src/process/run-worker.ts`
- Test: `packages/api-server/src/__tests__/test-config.ts` (modify)
- Test: `packages/shared/src/__tests__/ai-config-schema.test.ts` (modify)
- Modify: `packages/shared/src/config/schema.ts`

**Interfaces:**

- Consumes: everything above; `RunQueue`, `RUNNER_HEARTBEAT_KEY`, `RUN_EVENTS_CHANNEL` (Task 3).
- Produces: `RunWorker`, `RedisRunEvents`, `Housekeeping` (`start`, `stop`, `beat`, `sweep`), `schemaVersion(db)`, `waitForSchema(db, expected, opts?)`; `AiConfig.runner.concurrency`, `AiConfig.limits.toolResultChars`, `AiConfig.limits.chatIdleMinutes`; the `agent-runner` image and compose service.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/__tests__/ai-config-schema.test.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/shared/src/__tests__/ai-config-schema.test.ts b/packages/shared/src/__tests__/ai-config-schema.test.ts
index a709951..c5b9505 100644
--- a/packages/shared/src/__tests__/ai-config-schema.test.ts
+++ b/packages/shared/src/__tests__/ai-config-schema.test.ts
@@ -50,7 +50,15 @@ describe('ai config section', () => {
       vertex: { project: '', location: 'global' },
       models: [],
       defaultModel: '',
-      limits: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
+      runner: { concurrency: 4 },
+      limits: {
+        maxSteps: 25,
+        maxTokens: 400_000,
+        timeoutSeconds: 900,
+        dailyTokens: 4_000_000,
+        toolResultChars: 50_000,
+        chatIdleMinutes: 60,
+      },
     });
   });
 
@@ -64,10 +72,17 @@ describe('ai config section', () => {
       maxTokens: 400_000,
       timeoutSeconds: 900,
       dailyTokens: 4_000_000,
+      toolResultChars: 50_000,
+      chatIdleMinutes: 60,
     });
     expect(result.data.ai.vertex.location).toBe('global');
   });
 
+  it('rejects a runner with no concurrency, and a zero result size', () => {
+    expect(parse({ runner: { concurrency: 0 } }).success).toBe(false);
+    expect(parse({ limits: { toolResultChars: 0 } }).success).toBe(false);
+  });
+
   it('defaults a model to tool-capable', () => {
     const result = parse({ models: [model('claude-opus')], defaultModel: 'claude-opus' });
     expect(result.success).toBe(true);
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/shared exec vitest run src/__tests__/ai-config-schema.test.ts
```

Expected: FAIL — 3 tests (the defaults, the partial block, and the new rejections).

- [ ] **Step 3: Implement**

`packages/shared/src/config/schema.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/shared/src/config/schema.ts b/packages/shared/src/config/schema.ts
index 7695721..ef16bd0 100644
--- a/packages/shared/src/config/schema.ts
+++ b/packages/shared/src/config/schema.ts
@@ -688,6 +688,8 @@ const AI_LIMIT_DEFAULTS = {
   maxTokens: 400_000,
   timeoutSeconds: 900,
   dailyTokens: 4_000_000,
+  toolResultChars: 50_000,
+  chatIdleMinutes: 60,
 };
 
 const aiConfigSchema = z.object({
@@ -712,6 +714,13 @@ const aiConfigSchema = z.object({
   models: z.array(aiModelSchema).default([]),
   // Key of the model a new agent starts with. Empty means "no default".
   defaultModel: z.string().default(''),
+  // The agent-runner process.
+  runner: z
+    .object({
+      // Runs one runner works on at once.
+      concurrency: z.number().int().positive().default(4),
+    })
+    .default({ concurrency: 4 }),
   // Instance ceilings. An agent's own limits may be lower, never higher.
   limits: z
     .object({
@@ -719,6 +728,11 @@ const aiConfigSchema = z.object({
       maxTokens: z.number().int().positive().default(AI_LIMIT_DEFAULTS.maxTokens),
       timeoutSeconds: z.number().int().positive().default(AI_LIMIT_DEFAULTS.timeoutSeconds),
       dailyTokens: z.number().int().positive().default(AI_LIMIT_DEFAULTS.dailyTokens),
+      // A tool result longer than this (as JSON) is stored in full but cut,
+      // with a note, in the model's context.
+      toolResultChars: z.number().int().positive().default(AI_LIMIT_DEFAULTS.toolResultChars),
+      // A chat (Ask, test panel) with no new message for this long is closed.
+      chatIdleMinutes: z.number().int().positive().default(AI_LIMIT_DEFAULTS.chatIdleMinutes),
     })
     .default(AI_LIMIT_DEFAULTS),
 });
@@ -944,6 +958,7 @@ const baseConfigSchema = z.object({
     vertex: { project: '', location: 'global' },
     models: [],
     defaultModel: '',
+    runner: { concurrency: 4 },
     limits: AI_LIMIT_DEFAULTS,
   }),
 });
```
<!-- prettier-ignore-end -->

`packages/api-server/src/__tests__/test-config.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/__tests__/test-config.ts b/packages/api-server/src/__tests__/test-config.ts
index bb583a1..a98e2fe 100644
--- a/packages/api-server/src/__tests__/test-config.ts
+++ b/packages/api-server/src/__tests__/test-config.ts
@@ -135,7 +135,15 @@ export function makeTestConfig(overrides: Partial<Config> = {}): Config {
           tools: true,
         },
       ],
-      limits: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
+      runner: { concurrency: 4 },
+      limits: {
+        maxSteps: 25,
+        maxTokens: 400_000,
+        timeoutSeconds: 900,
+        dailyTokens: 4_000_000,
+        toolResultChars: 50_000,
+        chatIdleMinutes: 60,
+      },
     },
     secrets: {},
     ...overrides,
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/shared exec vitest run && pnpm --filter @shipit-ai/shared build && pnpm --filter @shipit-ai/api-server typecheck
```

Expected: PASS — shared 152 tests; the api-server fixture typechecks with the new keys.

- [ ] **Step 5: Write the failing tests**

Create `packages/agent-runner/src/__tests__/prerequisites.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect, vi } from 'vitest';
import type { Db } from '@shipit-ai/agents';
import { schemaVersion, waitForSchema } from '../process/prerequisites.js';

// A Db whose schema_migrations answers come from a list, one per query.
function dbAnswering(...answers: Array<string | null | Error>): Db {
  const query = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return { rows: [{ version: next }], rowCount: 1 };
  });
  return { query } as unknown as Db;
}

const undefinedTable = Object.assign(new Error('relation "schema_migrations" does not exist'), {
  code: '42P01',
});

describe('schemaVersion', () => {
  it('reads the highest applied migration', async () => {
    expect(await schemaVersion(dbAnswering('0002'))).toBe('0002');
  });

  it('is null when nothing was ever migrated', async () => {
    expect(await schemaVersion(dbAnswering(undefinedTable))).toBeNull();
  });

  it('lets any other database error through', async () => {
    await expect(schemaVersion(dbAnswering(new Error('connection refused')))).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('waitForSchema', () => {
  it('returns at once when the schema is current or newer', async () => {
    const sleep = vi.fn(async () => {});
    await waitForSchema(dbAnswering('0003'), '0002', { sleep, log: () => {} });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits, saying why, until the migration step catches up; it never throws', async () => {
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    await waitForSchema(
      dbAnswering(new Error('connection refused'), undefinedTable, '0001', '0002'),
      '0002',
      { sleep, log },
    );
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([m]) => m)).toEqual([
      expect.stringContaining('connection refused'),
      expect.stringContaining('not migrated'),
      expect.stringContaining('0001'),
    ]);
  });
});
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/__tests__/runner-process.integration.test.ts`:

<!-- prettier-ignore-start -->
```ts
// The runner's moving parts against a real Redis and Postgres: the queue, the
// worker, the event channel, the heartbeat and the sweeper. The run loop
// itself is covered by agent-loop.integration.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  AgentStore,
  RUN_EVENTS_CHANNEL,
  RUNNER_HEARTBEAT_KEY,
  RunQueue,
  RunStore,
  type RunEvent,
  type RunStatus,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { AgentLoop } from '../loop/agent-loop.js';
import { userMessage } from '../model/messages.js';
import { Housekeeping } from '../process/housekeeping.js';
import { RedisRunEvents } from '../process/run-events.js';
import { RunWorker } from '../process/run-worker.js';
import { MODEL, ScriptedModel, answer, definition } from './helpers/loop-fixtures.js';

const REDIS_URL = process.env.REDIS_TEST_URL;
const CEILINGS = { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 };

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > until)
      throw new Error(`waitFor timed out; last value ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!DATABASE_TEST_URL || !REDIS_URL)('runner process — Redis and Postgres', () => {
  let database: TestDatabase;
  let runs: RunStore;
  let agentId: string;
  let redis: Redis;
  let subscriber: Redis;
  const heard: RunEvent[] = [];
  // A queue of its own per suite run, so parallel CI jobs never share one.
  const queueName = `shipit-agent-runs-test-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    runs = new RunStore(database.db);
    agentId = (
      await new AgentStore(database.db).create({
        slug: 'owners',
        name: 'Owners',
        definition: definition(),
        actor: 'admin@example.com',
      })
    ).id;
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    subscriber = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    await subscriber.subscribe(RUN_EVENTS_CHANNEL);
    subscriber.on('message', (_channel, text: string) => heard.push(JSON.parse(text) as RunEvent));
  });

  afterAll(async () => {
    await subscriber.quit();
    await redis.quit();
    await database.drop();
  });

  beforeEach(async () => {
    heard.length = 0;
    await database.db.query('DELETE FROM runs');
  });

  const createRun = (mode: 'task' | 'chat' = 'task') =>
    runs.create({
      agentId,
      agentVersion: 1,
      definition: definition(),
      triggerKind: 'manual',
      triggeredBy: 'member@example.com',
      mode,
      input: { text: 'Who owns payments-api?' },
      messages: [userMessage('Who owns payments-api?')],
    });

  const status = async (id: string): Promise<RunStatus | undefined> => (await runs.get(id))?.status;

  function stack(script: Parameters<typeof answer>[0][] = ['team-a']) {
    const events = new RedisRunEvents(redis);
    const loop = new AgentLoop({
      runs,
      model: new ScriptedModel(script.map((text) => answer(text))),
      tools: [],
      models: [MODEL],
      ceilings: CEILINGS,
      toolResultChars: 50_000,
      owner: 'worker-test',
      publish: (e) => events.publish(e),
    });
    const queue = new RunQueue({ redisUrl: REDIS_URL!, queueName });
    const worker = new RunWorker({
      redisUrl: REDIS_URL!,
      queueName,
      concurrency: 2,
      runtime: loop,
    });
    const housekeeping = new Housekeeping({
      runs,
      redis,
      queue,
      publish: (e) => events.publish(e),
      chatIdleMinutes: 60,
    });
    return {
      queue,
      worker,
      housekeeping,
      async close() {
        await worker.close();
        await queue.close();
      },
    };
  }

  it('works a run when its id is enqueued, and announces it on the events channel', async () => {
    const parts = stack();
    try {
      const run = await createRun();
      await parts.queue.enqueue(run.id);
      expect(
        await waitFor(
          () => status(run.id),
          (s) => s === 'succeeded',
        ),
      ).toBe('succeeded');
      await waitFor(
        async () => heard,
        (events) => events.some((e) => e.runId === run.id && e.status === 'succeeded'),
      );
      expect(heard.filter((e) => e.runId === run.id)).toEqual([
        { runId: run.id, status: 'running' },
        { runId: run.id, seq: 1 },
        { runId: run.id, status: 'succeeded' },
      ]);
    } finally {
      await parts.close();
    }
  });

  it('treats a duplicate job for the same run as a no-op', async () => {
    const parts = stack(['once']);
    try {
      const run = await createRun();
      await parts.queue.enqueue(run.id);
      await parts.queue.enqueue(run.id);
      await waitFor(
        () => status(run.id),
        (s) => s === 'succeeded',
      );
      // The scripted model had one step; a second processing would have thrown.
      expect((await runs.get(run.id))!.steps).toBe(1);
    } finally {
      await parts.close();
    }
  });

  it('writes the runner heartbeat with a 60-second expiry', async () => {
    const parts = stack();
    try {
      await parts.housekeeping.beat();
      expect(await redis.get(RUNNER_HEARTBEAT_KEY)).not.toBeNull();
      const ttl = await redis.ttl(RUNNER_HEARTBEAT_KEY);
      expect(ttl).toBeGreaterThan(50);
      expect(ttl).toBeLessThanOrEqual(60);
    } finally {
      await parts.close();
    }
  });

  it('re-queues a run whose worker died, and the run is finished by another', async () => {
    const parts = stack(['resumed']);
    try {
      const run = await createRun();
      await runs.claim(run.id, 'worker-dead', 60);
      await database.db.query(
        `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [run.id],
      );
      await parts.housekeeping.sweep();
      expect(
        await waitFor(
          () => status(run.id),
          (s) => s === 'succeeded',
        ),
      ).toBe('succeeded');
    } finally {
      await parts.close();
    }
  });

  it('fails stalled runs and closes idle chats on a sweep, announcing each', async () => {
    const parts = stack();
    try {
      const stuck = await createRun();
      await runs.claim(stuck.id, 'worker-dead', 3600);
      const chat = await createRun('chat');
      await runs.claim(chat.id, 'worker-test', 60);
      await runs.waitForInput(chat.id);
      await database.db.query(
        `UPDATE runs SET updated_at = now() - interval '2 hours' WHERE id = ANY($1::uuid[])`,
        [[stuck.id, chat.id]],
      );
      await parts.housekeeping.sweep();
      expect(await status(stuck.id)).toBe('failed');
      expect(await status(chat.id)).toBe('succeeded');
      await waitFor(
        async () => heard,
        (events) => events.length >= 2,
      );
      expect(heard).toEqual(
        expect.arrayContaining([
          { runId: stuck.id, status: 'failed' },
          { runId: chat.id, status: 'succeeded' },
        ]),
      );
    } finally {
      await parts.close();
    }
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 6: Run it to verify it fails**

Run:

```bash
pnpm --filter @shipit-ai/agent-runner exec vitest run src/__tests__/prerequisites.test.ts
```

Expected: FAIL — cannot resolve `../process/prerequisites.js`.

- [ ] **Step 7: Implement**

Create `packages/agent-runner/src/process/prerequisites.ts`:

<!-- prettier-ignore-start -->
```ts
import type { Db } from '@shipit-ai/agents';

/** The highest applied migration, or null when the database was never migrated. */
export async function schemaVersion(db: Db): Promise<string | null> {
  try {
    const { rows } = await db.query<{ version: string | null }>(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    return rows[0]?.version ?? null;
  } catch (err) {
    // 42P01 = undefined_table: connected, but nothing has been migrated.
    if ((err as { code?: string }).code === '42P01') return null;
    throw err;
  }
}

/**
 * Waits until the database schema is at least `expected`. The infra repo
 * applies migrations at deploy, so a runner can briefly start against an older
 * schema; it waits and says why instead of crashing (design §Feature gating:
 * no process exits because an agent prerequisite is missing).
 */
export async function waitForSchema(
  db: Db,
  expected: string,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    retryMs?: number;
  } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? console.warn;
  for (;;) {
    let reason: string;
    try {
      const version = await schemaVersion(db);
      if (version !== null && version >= expected) return;
      reason =
        version === null
          ? 'the database is not migrated'
          : `the schema is at ${version}, this runner needs ${expected}`;
    } catch (err) {
      reason = `the database is not reachable (${(err as Error).message})`;
    }
    log(`Agent runner waiting: ${reason}. Retrying in a minute.`);
    await sleep(opts.retryMs ?? 60_000);
  }
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/process/run-worker.ts`:

<!-- prettier-ignore-start -->
```ts
// The runner's side of the shipit-agent-runs queue: a BullMQ worker that hands
// each job's run id to the run loop. The run's lease (not BullMQ) decides who
// works on a run, so a duplicate job is a harmless no-op.
import { Worker, type Job } from 'bullmq';
import {
  AGENT_RUNS_QUEUE,
  parseRedisUrl,
  type RunJob,
  type RunQueueOptions,
} from '@shipit-ai/agents';
import type { AgentRuntime } from '../loop/agent-loop.js';

export interface RunWorkerOptions extends RunQueueOptions {
  concurrency: number;
  runtime: AgentRuntime;
}

export class RunWorker {
  private readonly worker: Worker<RunJob>;

  constructor(opts: RunWorkerOptions) {
    const log = opts.log ?? console.warn;
    this.worker = new Worker<RunJob>(
      opts.queueName ?? AGENT_RUNS_QUEUE,
      async (job: Job<RunJob>) => opts.runtime.process(job.data.runId),
      { connection: parseRedisUrl(opts.redisUrl), concurrency: opts.concurrency },
    );
    this.worker.on('error', (err: Error) => log(`agent-runs worker error: ${err.message}`));
    this.worker.on('failed', (job: Job<RunJob> | undefined, err: Error) =>
      log(`run ${job?.data.runId ?? '?'} failed in the worker: ${err.message}`),
    );
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/process/run-events.ts`:

<!-- prettier-ignore-start -->
```ts
import type { Redis } from 'ioredis';
import { RUN_EVENTS_CHANNEL, type RunEvent } from '@shipit-ai/agents';

/**
 * Announces run changes on Redis pub/sub for the api-server's stream endpoint.
 * Best-effort: a missed event only delays a viewer, who replays from Postgres.
 */
export class RedisRunEvents {
  constructor(
    private readonly redis: Redis,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  publish(event: RunEvent): void {
    this.redis
      .publish(RUN_EVENTS_CHANNEL, JSON.stringify(event))
      .catch((err: Error) => this.log(`run ${event.runId}: event not published: ${err.message}`));
  }
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/process/housekeeping.ts`:

<!-- prettier-ignore-start -->
```ts
// Periodic work outside any one run: the heartbeat GET /ai/status reads, and a
// sweep that recovers runs whose worker died, stops runs that make no
// progress, and closes idle chats.
import type { Redis } from 'ioredis';
import { RUNNER_HEARTBEAT_KEY, type RunEvent, type RunStore } from '@shipit-ai/agents';

export interface HousekeepingOptions {
  runs: RunStore;
  redis: Redis;
  queue: { enqueue(runId: string): Promise<void> };
  publish: (event: RunEvent) => void;
  chatIdleMinutes: number;
  heartbeatEveryMs?: number;
  sweepEveryMs?: number;
  log?: (message: string) => void;
}

export class Housekeeping {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: HousekeepingOptions) {}

  start(): void {
    void this.beat();
    void this.sweep();
    this.timers = [
      setInterval(() => void this.beat(), this.opts.heartbeatEveryMs ?? 15_000),
      setInterval(() => void this.sweep(), this.opts.sweepEveryMs ?? 30_000),
    ];
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** Written every 15 s with a 60 s expiry: a runner gone for a minute shows as down. */
  async beat(): Promise<void> {
    try {
      await this.opts.redis.set(RUNNER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 60);
    } catch (err) {
      this.log(`heartbeat failed: ${(err as Error).message}`);
    }
  }

  async sweep(): Promise<void> {
    const { runs } = this.opts;
    try {
      for (const id of await runs.expiredLeases()) await this.opts.queue.enqueue(id);
      for (const id of await runs.failStalled()) this.opts.publish({ runId: id, status: 'failed' });
      for (const id of await runs.closeIdleChats(this.opts.chatIdleMinutes)) {
        this.opts.publish({ runId: id, status: 'succeeded' });
      }
    } catch (err) {
      this.log(`sweep failed: ${(err as Error).message}`);
    }
  }

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }
}
```
<!-- prettier-ignore-end -->

Create `packages/agent-runner/src/main.ts`:

<!-- prettier-ignore-start -->
```ts
// Entry point for the agent-runner process (design §Packages and processes).
// It works the runs the api-server queues: calls models on Vertex AI, runs the
// tools each agent is granted, and records everything in Postgres.
//
// Like core-writer/src/main.ts, this file only wires production adapters into
// the parts the suites test with fakes. A missing agent prerequisite never
// stops the process (design §Feature gating): it logs why and waits, and GET
// /ai/status shows the runner as down until it is working.
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import {
  createDb,
  createPool,
  EXPECTED_SCHEMA_VERSION,
  RunQueue,
  RunStore,
} from '@shipit-ai/agents';
import { createNeo4jClient } from '@shipit-ai/mcp-server/tools';
import { loadConfig } from '@shipit-ai/shared';
import { AgentLoop } from './loop/agent-loop.js';
import { VertexModelClient } from './model/vertex-model-client.js';
import { Housekeeping } from './process/housekeeping.js';
import { waitForSchema } from './process/prerequisites.js';
import { RedisRunEvents } from './process/run-events.js';
import { RunWorker } from './process/run-worker.js';
import { graphTools } from './tools/graph-tools.js';

function idle(reason: string): void {
  console.warn(`Agent runner idle: ${reason}.`);
  // Stay up so the Deployment does not crash-loop; a config change restarts the pod.
  setInterval(() => {}, 1 << 30);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { ai } = config;
  if (!ai.enabled) return idle('ai.enabled is false');
  if (!ai.database.url) return idle('ai.database.url is empty');
  if (!config.backend.redis.url) return idle('backend.redis.url is empty');
  if (!ai.vertex.project)
    console.warn('Agent runner: ai.vertex.project is empty; model calls will fail.');

  const pool = createPool({
    connectionString: ai.database.url,
    max: ai.runner.concurrency + 2,
    onError: (err) => console.error(`Agent runner Postgres pool error: ${err.message}`),
  });
  const db = createDb(pool);
  await waitForSchema(db, EXPECTED_SCHEMA_VERSION);

  const owner = `${hostname()}-${process.pid}`;
  const redis = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => console.warn(`Agent runner Redis error: ${err.message}`));
  const events = new RedisRunEvents(redis);
  const runs = new RunStore(db);
  const neo4j = createNeo4jClient(
    config.backend.neo4j.uri,
    config.backend.neo4j.user,
    config.backend.neo4j.password,
  );

  const loop = new AgentLoop({
    runs,
    model: new VertexModelClient({ project: ai.vertex.project, location: ai.vertex.location }),
    tools: graphTools(neo4j, { rateLimits: config.backend.mcp.rateLimits }),
    models: ai.models,
    ceilings: ai.limits,
    toolResultChars: ai.limits.toolResultChars,
    owner,
    publish: (event) => events.publish(event),
  });
  const queue = new RunQueue({ redisUrl: config.backend.redis.url });
  const worker = new RunWorker({
    redisUrl: config.backend.redis.url,
    concurrency: ai.runner.concurrency,
    runtime: loop,
  });
  const housekeeping = new Housekeeping({
    runs,
    redis,
    queue,
    publish: (event) => events.publish(event),
    chatIdleMinutes: ai.limits.chatIdleMinutes,
  });
  housekeeping.start();
  console.log(
    `Agent runner ${owner} working (concurrency ${ai.runner.concurrency}, ${ai.models.length} models).`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Agent runner received ${signal}, shutting down...`);
    try {
      housekeeping.stop();
      // Waits for runs in progress; a run cut off later resumes on another worker.
      await worker.close();
      await queue.close();
      await redis.quit();
      await neo4j.close();
      await pool.end();
    } catch (err) {
      console.error(`Agent runner shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('Agent runner crashed during startup:', err);
  process.exit(1);
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 8: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/agent-runner exec vitest run && DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit REDIS_TEST_URL=redis://localhost:6379 \
  pnpm --filter @shipit-ai/agent-runner run test:integration && pnpm --filter @shipit-ai/agent-runner build
```

Expected: PASS — unit 24 tests (prerequisites 5); integration 2 files, 33 tests (runner process 5).

- [ ] **Step 9: Implement**

Create `packages/agent-runner/Dockerfile`:

<!-- prettier-ignore-start -->
```dockerfile
FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# agent-runner's workspace closure. Each line is one Docker layer, ordered
# roughly from least-changing to most-changing for cache efficiency:
#   shared → agents → mcp-server → agent-runner
# A new workspace dependency must be added here, to the package's vitest alias
# list, and to the lockfile (scar docker-builder-copies-fixed-package-set).
COPY packages/shared/ packages/shared/
COPY packages/agents/ packages/agents/
COPY packages/mcp-server/ packages/mcp-server/
COPY packages/agent-runner/ packages/agent-runner/
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@shipit-ai/agent-runner
# Self-contained prod bundle: dist + real (de-symlinked) node_modules,
# including the workspace dependencies.
RUN pnpm --filter=@shipit-ai/agent-runner deploy --legacy --prod /out

FROM node:22-alpine
# Runtime-stage hygiene, as in the other images: Alpine security patches, and
# no bundled npm CLI (never used at runtime; its vendored deps fail the scan).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /out ./
CMD ["node", "dist/main.js"]
```
<!-- prettier-ignore-end -->

`docker/docker-compose.yml`:

<!-- prettier-ignore-start -->
```diff
diff --git a/docker/docker-compose.yml b/docker/docker-compose.yml
index 22dd975..bc5ef5d 100644
--- a/docker/docker-compose.yml
+++ b/docker/docker-compose.yml
@@ -109,6 +109,32 @@ services:
       redis:
         condition: service_healthy
 
+  # Works the agent runs the api-server queues: model calls on Vertex AI and
+  # the tools each agent is granted. Locally it authenticates to Vertex with
+  # your application-default credentials (`gcloud auth application-default
+  # login`); on GKE, Workload Identity does that and no file is mounted.
+  agent-runner:
+    build:
+      context: ..
+      dockerfile: packages/agent-runner/Dockerfile
+    volumes:
+      - ../shipit.config.yaml:/app/shipit.config.yaml:ro
+      - ${HOME}/.config/gcloud/application_default_credentials.json:/gcloud/adc.json:ro
+    environment:
+      NEO4J_URI: bolt://neo4j:7687
+      REDIS_URL: redis://redis:6379
+      NEO4J_PASSWORD: ${NEO4J_PASSWORD:-shipit-dev}
+      DATABASE_URL: postgres://shipit:${POSTGRES_PASSWORD:-shipit-dev}@postgres:5432/shipit
+      GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT:-}
+      GOOGLE_APPLICATION_CREDENTIALS: /gcloud/adc.json
+    depends_on:
+      neo4j:
+        condition: service_healthy
+      redis:
+        condition: service_healthy
+      migrate:
+        condition: service_completed_successfully
+
   mcp-server:
     build:
       context: ..
```
<!-- prettier-ignore-end -->

`.github/workflows/ci.yml`:

<!-- prettier-ignore-start -->
```diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 9d59748..c5dc4a5 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -162,6 +162,9 @@ jobs:
       - name: agents integration (Postgres)
         run: pnpm --filter @shipit-ai/agents run test:integration
 
+      - name: agent-runner integration (Postgres, Redis)
+        run: pnpm --filter @shipit-ai/agent-runner run test:integration
+
   build:
     name: Build
     runs-on: ubuntu-latest
@@ -193,6 +196,8 @@ jobs:
             dockerfile: packages/core-writer/Dockerfile
           - service: mcp-server
             dockerfile: packages/mcp-server/Dockerfile
+          - service: agent-runner
+            dockerfile: packages/agent-runner/Dockerfile
     steps:
       - uses: actions/checkout@v7
 
```
<!-- prettier-ignore-end -->

- [ ] **Step 10: Run to verify it passes**

Run:

```bash
docker compose -f docker/docker-compose.yml config -q && echo compose-ok
docker build -f packages/agent-runner/Dockerfile -t shipit-agent-runner:dev .
docker run --rm shipit-agent-runner:dev ls dist/main.js node_modules/@shipit-ai/mcp-server/dist/tools/registry.js
```

Expected: `compose-ok`; the image builds; both files are listed. A `Cannot find module '@shipit-ai/...'` during the build means a `COPY` line is missing.

- [ ] **Step 11: Commit**

```bash
npx prettier --write .github/workflows/ci.yml docker/docker-compose.yml packages/agent-runner/src/__tests__/prerequisites.test.ts packages/agent-runner/src/__tests__/runner-process.integration.test.ts packages/agent-runner/src/main.ts packages/agent-runner/src/process/housekeeping.ts packages/agent-runner/src/process/prerequisites.ts packages/agent-runner/src/process/run-events.ts packages/agent-runner/src/process/run-worker.ts packages/api-server/src/__tests__/test-config.ts packages/shared/src/__tests__/ai-config-schema.test.ts packages/shared/src/config/schema.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add .github/workflows/ci.yml docker/docker-compose.yml packages/agent-runner/Dockerfile packages/agent-runner/src/__tests__/prerequisites.test.ts packages/agent-runner/src/__tests__/runner-process.integration.test.ts packages/agent-runner/src/main.ts packages/agent-runner/src/process/housekeeping.ts packages/agent-runner/src/process/prerequisites.ts packages/agent-runner/src/process/run-events.ts packages/agent-runner/src/process/run-worker.ts packages/api-server/src/__tests__/test-config.ts packages/shared/src/__tests__/ai-config-schema.test.ts packages/shared/src/config/schema.ts
git commit -m "agent-runner: the process (worker, events, heartbeat, sweeper), image, compose and CI"
```

---

## Task 8: The runs API (api-server)

Starting a run creates the row and its first message, then queues the run id; if the queue is unreachable the run is failed rather than left queued forever. Text input is the user speaking; a JSON object is passed as data, labelled so it cannot pose as instructions. Running a draft is part of editing an agent and needs `agents:write`. Anyone with `agents:read` sees the run list and statuses; a run's content (input, output, transcript, tool calls) is for its starter, the agent's author and admins, and others get the run with `contentHidden: true`. Only the starter or an admin may add a chat message or cancel.

**Files:**

- Test: `packages/api-server/src/__tests__/routes/runs.integration.test.ts` (create)
- Modify: `packages/api-server/src/index.ts`
- Create: `packages/api-server/src/routes/runs.ts`
- Modify: `packages/api-server/src/server.ts`
- Modify: `packages/api-server/src/services/ai/ai-status-service.ts`
- Modify: `packages/api-server/vitest.config.ts`

**Interfaces:**

- Consumes: `RunStore`, `RunQueue`, `AgentStore` (Tasks 2, 3, foundation).
- Produces:
  - `POST /api/agents/:id/runs` (`agents:run`) body `{ input: string | object; mode?: 'task' | 'chat'; draft?: boolean }` → `201` run + `Location`; errors `400 VALIDATION_ERROR`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 NOT_PUBLISHED | AGENT_DISABLED | MODEL_UNAVAILABLE`, `503 AI_UNAVAILABLE | QUEUE_UNAVAILABLE`.
  - `GET /api/runs?agentId&status&limit&offset`, `GET /api/runs/:id` (`agents:read`); `GET /api/runs/:id/messages?afterSeq` → `{ messages, toolCalls }` (content access).
  - `POST /api/runs/:id/messages` `{ text }` → `202`, `409 RUN_NOT_WAITING`; `POST /api/runs/:id/cancel` → the run (`agents:run`, starter or admin).
  - `CreateServerOptions.runStore?`, `runQueue?: RunEnqueuer`; `interface RunEnqueuer { enqueue(runId): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Create `packages/api-server/src/__tests__/routes/runs.integration.test.ts`:

<!-- prettier-ignore-start -->
```ts
// The runs API against a real Postgres (the run store's conditional writes are
// the point), with a recording stand-in for the BullMQ queue.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import {
  AgentStore,
  RunStore,
  type AgentDefinition,
  type AgentRecord,
  type RunRecord,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { createServer } from '../../server.js';
import { makeTestConfig, makeTestResolved } from '../test-config.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const check = (name: AiStatus['checks'][number]['name'], ok = true) => ({
  name,
  ok,
  detail: ok ? 'ok' : `${name} is down`,
});
const AVAILABLE: AiStatus = {
  available: true,
  definitionsAvailable: true,
  checks: (['enabled', 'database', 'schema', 'models', 'runner'] as const).map((n) => check(n)),
};
const RUNNER_DOWN: AiStatus = {
  available: false,
  definitionsAvailable: true,
  checks: [...AVAILABLE.checks.slice(0, 4), check('runner', false)],
};

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

class RecordingQueue {
  enqueued: string[] = [];
  failing = false;
  async enqueue(runId: string): Promise<void> {
    if (this.failing) throw new Error('OOM command not allowed');
    this.enqueued.push(runId);
  }
}

function authConfig(): Config {
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

// Bearer tokens stand in for signed-in people with given capabilities.
const PRINCIPALS: Record<string, string[]> = {
  member: ['agents:read', 'agents:run'],
  other: ['agents:read', 'agents:run'],
  author: ['agents:read', 'agents:write', 'agents:run', 'graph:read'],
  reader: ['agents:read'],
  boss: ['*'],
};
const tokenService = {
  validate: async (plaintext: string) =>
    PRINCIPALS[plaintext]
      ? { id: plaintext, ownerEmail: `${plaintext}@example.com`, scopes: PRINCIPALS[plaintext] }
      : null,
} as unknown as TokenService;

describe.skipIf(!DATABASE_TEST_URL)('runs routes — Postgres integration', () => {
  let database: TestDatabase;
  let agents: AgentStore;
  let runs: RunStore;
  const queue = new RecordingQueue();
  let status: AiStatus = AVAILABLE;
  const aiStatus = { status: async () => status } as unknown as AiStatusService;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    agents = new AgentStore(database.db);
    runs = new RunStore(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
    await database.db.query('DELETE FROM agent_versions');
    await database.db.query('DELETE FROM agents');
    queue.enqueued = [];
    queue.failing = false;
    status = AVAILABLE;
  });

  async function publishedAgent(createdBy = 'author@example.com'): Promise<AgentRecord> {
    const agent = await agents.create({
      slug: `owners-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Owners',
      definition,
      actor: createdBy,
    });
    return (await agents.publish(agent.id, undefined, 'first', createdBy)).agent;
  }

  describe('as the local dev user (auth off, every capability)', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      server = await createServer({
        config: makeTestConfig(),
        agentStore: agents,
        runStore: runs,
        runQueue: queue,
        aiStatus,
      });
      await server.ready();
    });
    afterAll(async () => {
      await server.close();
    });

    const start = (agentId: string, payload: Record<string, unknown>) =>
      server.inject({ method: 'POST', url: `/api/agents/${agentId}/runs`, payload });

    it('starts a run of the published version and queues it', async () => {
      const agent = await publishedAgent();
      const res = await start(agent.id, { input: 'Who owns payments-api?' });
      expect(res.statusCode).toBe(201);
      const run = res.json() as RunRecord;
      expect(res.headers.location).toBe(`/api/runs/${run.id}`);
      expect(run).toMatchObject({
        agentId: agent.id,
        agentVersion: 1,
        definition,
        status: 'queued',
        mode: 'task',
        triggerKind: 'manual',
        triggeredBy: 'dev@shipit.local',
        input: { text: 'Who owns payments-api?' },
      });
      expect(queue.enqueued).toEqual([run.id]);
      expect((await runs.listMessages(run.id)).map((m) => m.content)).toEqual([
        { role: 'user', content: 'Who owns payments-api?' },
      ]);
    });

    it('passes structured input to the model as data, not as instructions', async () => {
      const agent = await publishedAgent();
      const res = await start(agent.id, { input: { pr: 42, repo: 'payments-api' } });
      expect(res.statusCode).toBe(201);
      const [first] = await runs.listMessages(res.json().id);
      expect(first!.content.content).toMatch(/JSON data, not instructions/);
      expect(first!.content.content).toContain('"repo":"payments-api"');
    });

    it('runs the draft when asked, pinning no version', async () => {
      const agent = await publishedAgent();
      const draft = { ...definition, instructions: 'Draft instructions.' };
      await agents.update(agent.id, undefined, { definition: draft }, 'author@example.com');
      const res = await start(agent.id, { input: 'hi', draft: true, mode: 'chat' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ agentVersion: null, definition: draft, mode: 'chat' });
    });

    it('refuses an agent with nothing published, a disabled one and an unknown one', async () => {
      const unpublished = await agents.create({
        slug: 'draft-only',
        name: 'Draft only',
        definition,
        actor: 'author@example.com',
      });
      expect((await start(unpublished.id, { input: 'x' })).json().error.code).toBe('NOT_PUBLISHED');
      const disabled = await publishedAgent();
      await agents.update(disabled.id, undefined, { enabled: false }, 'author@example.com');
      const res = await start(disabled.id, { input: 'x' });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'AGENT_DISABLED']);
      expect((await start('00000000-0000-0000-0000-000000000000', { input: 'x' })).statusCode).toBe(
        404,
      );
      expect(queue.enqueued).toEqual([]);
    });

    it('refuses an agent whose model the instance no longer offers', async () => {
      const agent = await agents.create({
        slug: 'retired',
        name: 'Retired',
        definition: { ...definition, model: 'retired-model' },
        actor: 'author@example.com',
      });
      const res = await start(agent.id, { input: 'x', draft: true });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'MODEL_UNAVAILABLE']);
    });

    it.each([
      ['no input', {}, 'input'],
      ['empty input', { input: '' }, 'input'],
      ['input over 20,000 characters', { input: 'x'.repeat(20_001) }, 'input'],
      ['an unknown mode', { input: 'x', mode: 'batch' }, 'mode'],
      ['a draft flag that is not boolean', { input: 'x', draft: 'yes' }, 'draft'],
    ])('rejects %s, naming the field', async (_label, payload, path) => {
      const agent = await publishedAgent();
      const res = await start(agent.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toBe(path);
    });

    it('answers 503 naming the runner when no runner is working, and starts nothing', async () => {
      const agent = await publishedAgent();
      status = RUNNER_DOWN;
      const res = await start(agent.id, { input: 'x' });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks).toEqual([check('runner', false)]);
      expect((await runs.list({})).total).toBe(0);
    });

    it('fails the run and answers 503 when the queue is unreachable', async () => {
      const agent = await publishedAgent();
      queue.failing = true;
      const res = await start(agent.id, { input: 'x' });
      expect([res.statusCode, res.json().error.code]).toEqual([503, 'QUEUE_UNAVAILABLE']);
      const [run] = (await runs.list({})).items;
      expect(run).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
    });

    it('lists runs, filtered by agent and status, and reads one', async () => {
      const a = await publishedAgent();
      const b = await publishedAgent();
      const first = (await start(a.id, { input: 'one' })).json() as RunRecord;
      await start(b.id, { input: 'two' });
      const all = await server.inject({ method: 'GET', url: '/api/runs' });
      expect(all.json().total).toBe(2);
      const forA = await server.inject({ method: 'GET', url: `/api/runs?agentId=${a.id}` });
      expect(forA.json().items.map((r: RunRecord) => r.id)).toEqual([first.id]);
      const queued = await server.inject({ method: 'GET', url: '/api/runs?status=queued' });
      expect(queued.json().total).toBe(2);
      const bad = await server.inject({ method: 'GET', url: '/api/runs?status=bogus' });
      expect(bad.statusCode).toBe(400);
      const one = await server.inject({ method: 'GET', url: `/api/runs/${first.id}` });
      expect(one.json()).toMatchObject({ id: first.id, input: { text: 'one' } });
      expect((await server.inject({ method: 'GET', url: '/api/runs/not-a-run' })).statusCode).toBe(
        404,
      );
    });

    it('returns the transcript and tool calls, optionally after a sequence number', async () => {
      const agent = await publishedAgent();
      const run = (await start(agent.id, { input: 'one' })).json() as RunRecord;
      await runs.claim(run.id, 'w', 60);
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'two' }]);
      const all = await server.inject({ method: 'GET', url: `/api/runs/${run.id}/messages` });
      expect(all.json().messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1]);
      expect(all.json().toolCalls).toEqual([]);
      const later = await server.inject({
        method: 'GET',
        url: `/api/runs/${run.id}/messages?afterSeq=0`,
      });
      expect(later.json().messages.map((m: { seq: number }) => m.seq)).toEqual([1]);
    });

    it('takes the next chat message for a waiting run and queues it again', async () => {
      const agent = await publishedAgent();
      const run = (await start(agent.id, { input: 'hi', mode: 'chat' })).json() as RunRecord;
      queue.enqueued = [];
      const early = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/messages`,
        payload: { text: 'too soon' },
      });
      expect([early.statusCode, early.json().error.code]).toEqual([409, 'RUN_NOT_WAITING']);

      await runs.claim(run.id, 'w', 60);
      await runs.appendMessages(run.id, [{ role: 'assistant', content: 'Hello.' }], 'w');
      await runs.waitForInput(run.id, 'w');
      const res = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/messages`,
        payload: { text: 'Who owns x?' },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe('queued');
      expect(queue.enqueued).toEqual([run.id]);
      const empty = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/messages`,
        payload: { text: '  ' },
      });
      expect(empty.statusCode).toBe(400);
    });

    it('cancels a queued run', async () => {
      const agent = await publishedAgent();
      const run = (await start(agent.id, { input: 'x' })).json() as RunRecord;
      const res = await server.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'cancelled', cancelRequested: true });
      const missing = await server.inject({
        method: 'POST',
        url: '/api/runs/00000000-0000-0000-0000-000000000000/cancel',
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('as signed-in people (auth on)', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
      server = await createServer({
        config: authConfig(),
        redis: new RedisMock() as unknown as Redis,
        resolved: makeTestResolved(),
        oidcProvider: stubOidc,
        tokenService,
        agentStore: agents,
        runStore: runs,
        runQueue: queue,
        aiStatus,
      });
      await server.ready();
    });
    afterAll(async () => {
      await server.close();
      delete process.env.SHIPIT_SESSION_SECRET;
    });

    const as = (who: string) => ({ authorization: `Bearer ${who}` });
    const startAs = (who: string, agentId: string, payload: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/runs`,
        headers: as(who),
        payload,
      });

    it('lets a member start a published agent, not a draft', async () => {
      const agent = await publishedAgent();
      const res = await startAs('member', agent.id, { input: 'x' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ triggerKind: 'api', triggeredBy: 'member@example.com' });
      const draft = await startAs('member', agent.id, { input: 'x', draft: true });
      expect([draft.statusCode, draft.json().error.code]).toEqual([403, 'FORBIDDEN']);
      expect((await startAs('reader', agent.id, { input: 'x' })).statusCode).toBe(403);
    });

    it('shows a run’s content only to its starter, the agent’s author and admins', async () => {
      const agent = await publishedAgent('author@example.com');
      const run = (await startAs('member', agent.id, { input: 'secret question' })).json();
      for (const who of ['member', 'author', 'boss']) {
        const res = await server.inject({
          method: 'GET',
          url: `/api/runs/${run.id}`,
          headers: as(who),
        });
        expect(res.json().input, who).toEqual({ text: 'secret question' });
        const transcript = await server.inject({
          method: 'GET',
          url: `/api/runs/${run.id}/messages`,
          headers: as(who),
        });
        expect(transcript.statusCode, who).toBe(200);
      }
      const other = await server.inject({
        method: 'GET',
        url: `/api/runs/${run.id}`,
        headers: as('other'),
      });
      expect(other.json()).toMatchObject({
        id: run.id,
        input: null,
        output: null,
        contentHidden: true,
      });
      const list = await server.inject({ method: 'GET', url: '/api/runs', headers: as('other') });
      expect(list.json().items[0]).toMatchObject({ input: null, contentHidden: true });
      const denied = await server.inject({
        method: 'GET',
        url: `/api/runs/${run.id}/messages`,
        headers: as('other'),
      });
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'FORBIDDEN']);
    });

    it('lets only the starter or an admin cancel a run or add to it', async () => {
      const agent = await publishedAgent();
      const run = (await startAs('member', agent.id, { input: 'x', mode: 'chat' })).json();
      for (const [method, path, payload] of [
        ['POST', 'cancel', undefined],
        ['POST', 'messages', { text: 'hi' }],
      ] as const) {
        const res = await server.inject({
          method,
          url: `/api/runs/${run.id}/${path}`,
          headers: as('other'),
          payload,
        });
        expect([res.statusCode, res.json().error.code], path).toEqual([403, 'FORBIDDEN']);
      }
      const byAdmin = await server.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/cancel`,
        headers: as('boss'),
      });
      expect(byAdmin.json().status).toBe('cancelled');
    });
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Implement**

`packages/api-server/vitest.config.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/vitest.config.ts b/packages/api-server/vitest.config.ts
index b4a376a..ec32a8f 100644
--- a/packages/api-server/vitest.config.ts
+++ b/packages/api-server/vitest.config.ts
@@ -21,6 +21,7 @@ export default defineConfig({
     alias: {
       '@shipit-ai/shared/schema': r('shared/src/schema/index.ts'),
       '@shipit-ai/shared': r('shared/src/index.ts'),
+      '@shipit-ai/agents/testing': r('agents/src/testing.ts'),
       '@shipit-ai/agents': r('agents/src/index.ts'),
       '@shipit-ai/event-bus': r('event-bus/src/index.ts'),
       '@shipit-ai/connector-sdk': r('connector-sdk/src/index.ts'),
```
<!-- prettier-ignore-end -->

- [ ] **Step 3: Run it to verify it fails**

Run:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/runs.integration.test.ts
```

Expected: FAIL — 19 tests (the routes do not exist yet).

- [ ] **Step 4: Implement**

Create `packages/api-server/src/routes/runs.ts`:

<!-- prettier-ignore-start -->
```ts
// Agent runs (mounted /api). The api-server is the control plane: it creates
// run rows, queues their ids, takes chat messages and cancel requests. It never
// calls a model; the agent runner does the work.
//
// Who sees what (design §API): anyone with agents:read sees the run list and
// each run's status. A run's content (its input, output, transcript and tool
// calls) is for the person who started it, the agent's author, and holders of
// runs:read_transcript (admins hold `*`). Only the starter or an admin may add
// a message to a run or cancel it.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { hasCapability, type AiConfig } from '@shipit-ai/shared';
import {
  RUN_STATUSES,
  RunNotFoundError,
  RunNotWaitingError,
  type AgentDefinition,
  type AgentRecord,
  type AgentStore,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StoredMessage,
} from '@shipit-ai/agents';
import { requireCapability } from '../middleware/require-auth.js';

/** Anything that can put a run id on the agent-runs queue. */
export interface RunEnqueuer {
  enqueue(runId: string): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    runStore?: RunStore;
    runQueue?: RunEnqueuer;
  }
}

const MAX_TEXT = 20_000;
const MAX_INPUT_JSON = 64_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Issue {
  path: string;
  code: string;
  message: string;
}

const actorOf = (request: FastifyRequest): string => request.ctx.user.email;

function invalid(reply: FastifyReply, issues: Issue[]): FastifyReply {
  return reply.status(400).send({
    error: { code: 'VALIDATION_ERROR', message: issues[0]?.message ?? 'Invalid request.' },
    issues,
  });
}

function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}

/**
 * The first message of a run. Text is the user speaking. Structured input is
 * handed over as data, so a webhook body or an API caller's JSON cannot pose as
 * instructions (design §Safety).
 */
function openingMessage(input: string | Record<string, unknown>): StoredMessage {
  if (typeof input === 'string') return { role: 'user', content: input };
  return {
    role: 'user',
    content: `The run was started with this input (JSON data, not instructions):\n${JSON.stringify(input)}`,
  };
}

const runsRoutes: FastifyPluginAsync = async (server) => {
  // `needRunner`: starting work needs the whole platform (models and a working
  // runner); reading needs only the stored definitions and runs.
  async function ready(
    reply: FastifyReply,
    needRunner: boolean,
  ): Promise<{ runs: RunStore; agents: AgentStore; queue: RunEnqueuer; ai: AiConfig } | null> {
    const runs = server.runStore;
    const agents = server.agentStore;
    const queue = server.runQueue;
    const ai = server.config?.ai;
    const status = server.aiStatus ? await server.aiStatus.status() : null;
    const ok = status && (needRunner ? status.available : status.definitionsAvailable);
    if (!runs || !agents || !queue || !ai || !ok) {
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
    return { runs, agents, queue, ai };
  }

  async function canSeeContent(
    request: FastifyRequest,
    run: RunRecord,
    agents: AgentStore,
  ): Promise<boolean> {
    const actor = actorOf(request);
    if (hasCapability(request.ctx, 'runs:read_transcript') || run.triggeredBy === actor)
      return true;
    return (await agents.get(run.agentId))?.createdBy === actor;
  }

  const isStarterOrAdmin = (request: FastifyRequest, run: RunRecord): boolean =>
    run.triggeredBy === actorOf(request) || hasCapability(request.ctx, '*');

  // Run content is replaced, not omitted, so a client can tell "hidden" from "empty".
  const hideContent = (run: RunRecord) => ({
    ...run,
    input: null,
    output: null,
    error: run.error ? { code: run.error.code, message: '' } : null,
    contentHidden: true,
  });

  async function present(request: FastifyRequest, run: RunRecord, agents: AgentStore) {
    return (await canSeeContent(request, run, agents)) ? run : hideContent(run);
  }

  async function queueOrFail(
    reply: FastifyReply,
    runs: RunStore,
    queue: RunEnqueuer,
    run: RunRecord,
    request: FastifyRequest,
  ): Promise<boolean> {
    try {
      await queue.enqueue(run.id);
      return true;
    } catch (err) {
      request.log.error({ err, runId: run.id }, 'runs: enqueue failed');
      // A run nobody will pick up must not sit queued forever.
      await runs.finish(run.id, {
        status: 'failed',
        error: { code: 'INTERNAL', message: 'The run could not be queued.' },
      });
      fail(reply, 503, 'QUEUE_UNAVAILABLE', 'The run queue is not reachable right now.');
      return false;
    }
  }

  server.post<{ Params: { id: string }; Body: unknown }>(
    '/agents/:id/runs',
    { preHandler: requireCapability('agents:run') },
    async (request, reply) => {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const issues: Issue[] = [];
      const input = body.input;
      if (typeof input === 'string') {
        if (input.trim().length === 0 || input.length > MAX_TEXT) {
          issues.push({
            path: 'input',
            code: 'INVALID',
            message: `input is text of 1 to ${MAX_TEXT} characters, or a JSON object.`,
          });
        }
      } else if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (JSON.stringify(input).length > MAX_INPUT_JSON) {
          issues.push({
            path: 'input',
            code: 'INVALID',
            message: `input is at most ${MAX_INPUT_JSON} characters as JSON.`,
          });
        }
      } else {
        issues.push({
          path: 'input',
          code: 'INVALID',
          message: 'input is required: text, or a JSON object.',
        });
      }
      if (body.mode !== undefined && body.mode !== 'task' && body.mode !== 'chat') {
        issues.push({ path: 'mode', code: 'INVALID', message: "mode is 'task' or 'chat'." });
      }
      if (body.draft !== undefined && typeof body.draft !== 'boolean') {
        issues.push({ path: 'draft', code: 'INVALID', message: 'draft is true or false.' });
      }
      if (issues.length > 0) return invalid(reply, issues);
      const draft = body.draft === true;
      // A draft is unpublished work: running it is part of editing the agent.
      if (draft && !hasCapability(request.ctx, 'agents:write')) {
        return fail(
          reply,
          403,
          'FORBIDDEN',
          'Running a draft requires the agents:write capability.',
        );
      }

      const ctx = await ready(reply, true);
      if (!ctx) return reply;
      const agent: AgentRecord | null = await ctx.agents.get(request.params.id);
      if (!agent || agent.archivedAt) {
        return fail(reply, 404, 'NOT_FOUND', `Agent ${request.params.id} not found`);
      }
      if (!agent.enabled) return fail(reply, 409, 'AGENT_DISABLED', 'This agent is turned off.');
      let definition: AgentDefinition;
      let agentVersion: number | null = null;
      if (draft) {
        definition = agent.draftDefinition;
      } else {
        const version =
          agent.publishedVersion === null
            ? null
            : await ctx.agents.getVersion(agent.id, agent.publishedVersion);
        if (!version) {
          return fail(reply, 409, 'NOT_PUBLISHED', 'This agent has no published version to run.');
        }
        definition = version.definition;
        agentVersion = version.version;
      }
      if (!ctx.ai.models.some((m) => m.key === definition.model)) {
        return fail(
          reply,
          409,
          'MODEL_UNAVAILABLE',
          `The agent uses model ${definition.model}, which this instance no longer offers.`,
        );
      }

      const text = typeof input === 'string' ? input : null;
      const run = await ctx.runs.create({
        agentId: agent.id,
        agentVersion,
        definition,
        // A token caller is the API trigger; a signed-in person pressed Run.
        triggerKind: request.ctx.user.provider === 'mcp-token' ? 'api' : 'manual',
        triggeredBy: actorOf(request),
        mode: body.mode === 'chat' ? 'chat' : 'task',
        input: text !== null ? { text } : input,
        messages: [openingMessage(input as string | Record<string, unknown>)],
      });
      if (!(await queueOrFail(reply, ctx.runs, ctx.queue, run, request))) return reply;
      reply.header('Location', `/api/runs/${run.id}`);
      return reply.status(201).send(run);
    },
  );

  server.get<{
    Querystring: { agentId?: string; status?: string; limit?: string; offset?: string };
  }>('/runs', { preHandler: requireCapability('agents:read') }, async (request, reply) => {
    const { agentId, status, limit, offset } = request.query;
    if (status !== undefined && !RUN_STATUSES.includes(status as RunStatus)) {
      return invalid(reply, [
        {
          path: 'status',
          code: 'INVALID',
          message: `status is one of ${RUN_STATUSES.join(', ')}.`,
        },
      ]);
    }
    const ctx = await ready(reply, false);
    if (!ctx) return reply;
    const page = await ctx.runs.list({
      ...(agentId ? { agentId } : {}),
      ...(status ? { status: status as RunStatus } : {}),
      ...(limit !== undefined && Number.isInteger(Number(limit)) ? { limit: Number(limit) } : {}),
      ...(offset !== undefined && Number.isInteger(Number(offset))
        ? { offset: Number(offset) }
        : {}),
    });
    return {
      items: await Promise.all(page.items.map((run) => present(request, run, ctx.agents))),
      total: page.total,
    };
  });

  server.get<{ Params: { id: string } }>(
    '/runs/:id',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply, false);
      if (!ctx) return reply;
      const run = await ctx.runs.get(request.params.id);
      if (!run) return fail(reply, 404, 'NOT_FOUND', `Run ${request.params.id} not found`);
      return present(request, run, ctx.agents);
    },
  );

  server.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>(
    '/runs/:id/messages',
    { preHandler: requireCapability('agents:read') },
    async (request, reply) => {
      const ctx = await ready(reply, false);
      if (!ctx) return reply;
      const run = await ctx.runs.get(request.params.id);
      if (!run) return fail(reply, 404, 'NOT_FOUND', `Run ${request.params.id} not found`);
      if (!(await canSeeContent(request, run, ctx.agents))) {
        return fail(
          reply,
          403,
          'FORBIDDEN',
          "Only the run's starter, the agent's author and admins can read it.",
        );
      }
      const after = Number(request.query.afterSeq);
      const [messages, toolCalls] = await Promise.all([
        ctx.runs.listMessages(run.id, Number.isInteger(after) ? { afterSeq: after } : {}),
        ctx.runs.listToolCalls(run.id),
      ]);
      return { messages, toolCalls };
    },
  );

  server.post<{ Params: { id: string }; Body: unknown }>(
    '/runs/:id/messages',
    { preHandler: requireCapability('agents:run') },
    async (request, reply) => {
      const text = (request.body as { text?: unknown } | null)?.text;
      if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT) {
        return invalid(reply, [
          { path: 'text', code: 'INVALID', message: `text is 1 to ${MAX_TEXT} characters.` },
        ]);
      }
      const ctx = await ready(reply, true);
      if (!ctx) return reply;
      if (!UUID.test(request.params.id)) {
        return fail(reply, 404, 'NOT_FOUND', `Run ${request.params.id} not found`);
      }
      const run = await ctx.runs.get(request.params.id);
      if (!run) return fail(reply, 404, 'NOT_FOUND', `Run ${request.params.id} not found`);
      if (!isStarterOrAdmin(request, run)) {
        return fail(reply, 403, 'FORBIDDEN', 'Only the person who started this run can add to it.');
      }
      try {
        const queued = await ctx.runs.addUserMessage(run.id, { role: 'user', content: text });
        if (!(await queueOrFail(reply, ctx.runs, ctx.queue, queued, request))) return reply;
        return reply.status(202).send(queued);
      } catch (err) {
        if (err instanceof RunNotWaitingError) {
          return reply.status(409).send({
            error: { code: 'RUN_NOT_WAITING', message: err.message },
            status: err.status,
          });
        }
        if (err instanceof RunNotFoundError) return fail(reply, 404, 'NOT_FOUND', err.message);
        throw err;
      }
    },
  );

  server.post<{ Params: { id: string } }>(
    '/runs/:id/cancel',
    { preHandler: requireCapability('agents:run') },
    async (request, reply) => {
      const ctx = await ready(reply, false);
      if (!ctx) return reply;
      const run = await ctx.runs.get(request.params.id);
      if (!run) return fail(reply, 404, 'NOT_FOUND', `Run ${request.params.id} not found`);
      if (!isStarterOrAdmin(request, run)) {
        return fail(reply, 403, 'FORBIDDEN', 'Only the person who started this run can cancel it.');
      }
      return ctx.runs.requestCancel(run.id);
    },
  );
};

export default runsRoutes;
```
<!-- prettier-ignore-end -->

`packages/api-server/src/server.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/server.ts b/packages/api-server/src/server.ts
index d572f52..1c2580b 100644
--- a/packages/api-server/src/server.ts
+++ b/packages/api-server/src/server.ts
@@ -45,7 +45,8 @@ import type { SettingsService } from './services/settings-service.js';
 import feedbackRoutes from './routes/feedback.js';
 import aiRoutes from './routes/ai.js';
 import agentsRoutes from './routes/agents.js';
-import type { AgentStore } from '@shipit-ai/agents';
+import runsRoutes, { type RunEnqueuer } from './routes/runs.js';
+import type { AgentStore, RunStore } from '@shipit-ai/agents';
 import type { AiStatusService } from './services/ai/ai-status-service.js';
 import type { FeedbackService } from './services/feedback-service.js';
 import { envSecretsView, type ResolvedSecrets } from './secrets/index.js';
@@ -117,6 +118,9 @@ export interface CreateServerOptions {
   agentStore?: AgentStore;
   // Live prerequisite checks for agent features. Optional for the same reason.
   aiStatus?: AiStatusService;
+  // Agent runs and the queue the runner works from. Optional for the same reason.
+  runStore?: RunStore;
+  runQueue?: RunEnqueuer;
 }
 
 declare module 'fastify' {
@@ -416,6 +420,12 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   if (opts.aiStatus) {
     server.decorate('aiStatus', opts.aiStatus);
   }
+  if (opts.runStore) {
+    server.decorate('runStore', opts.runStore);
+  }
+  if (opts.runQueue) {
+    server.decorate('runQueue', opts.runQueue);
+  }
 
   // Register routes
   await server.register(healthRoutes, { prefix: '/api' });
@@ -463,6 +473,8 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   // definitions. Both answer 503 AI_UNAVAILABLE until a database is wired.
   await server.register(aiRoutes, { prefix: '/api/ai' });
   await server.register(agentsRoutes, { prefix: '/api/agents' });
+  // Runs: start one (POST /api/agents/:id/runs), list and read them, chat, cancel.
+  await server.register(runsRoutes, { prefix: '/api' });
 
   // GitHub webhook receiver. Registered as its own encapsulated plugin so its
   // route-scoped raw-body parser (HMAC needs the exact bytes) doesn't leak
```
<!-- prettier-ignore-end -->

`packages/api-server/src/services/ai/ai-status-service.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/services/ai/ai-status-service.ts b/packages/api-server/src/services/ai/ai-status-service.ts
index b8c7eba..c7dc0ea 100644
--- a/packages/api-server/src/services/ai/ai-status-service.ts
+++ b/packages/api-server/src/services/ai/ai-status-service.ts
@@ -3,10 +3,11 @@
 // prerequisite turns the feature off with a named reason instead of crashing a
 // process or returning a 500.
 import type { AiConfig } from '@shipit-ai/shared';
-import { EXPECTED_SCHEMA_VERSION, type Db } from '@shipit-ai/agents';
+import { EXPECTED_SCHEMA_VERSION, RUNNER_HEARTBEAT_KEY, type Db } from '@shipit-ai/agents';
 
-/** Written by agent-runner every 15s with a 60s TTL. Absent = no runner. */
-export const RUNNER_HEARTBEAT_KEY = 'shipit-agent-runner-heartbeat';
+// Written by agent-runner every 15s with a 60s TTL; absent means no runner.
+// Defined in @shipit-ai/agents, which the runner also writes it from.
+export { RUNNER_HEARTBEAT_KEY };
 
 export type AiCheckName = 'enabled' | 'database' | 'schema' | 'models' | 'runner';
 
```
<!-- prettier-ignore-end -->

`packages/api-server/src/index.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/index.ts b/packages/api-server/src/index.ts
index 5cbba10..be3bf29 100644
--- a/packages/api-server/src/index.ts
+++ b/packages/api-server/src/index.ts
@@ -28,7 +28,14 @@ import { OidcSettingsService } from './services/auth/oidc-settings-service.js';
 import { SetupService } from './services/setup-service.js';
 import { SettingsService } from './services/settings-service.js';
 import { FeedbackService } from './services/feedback-service.js';
-import { AgentStore, createDb, createPool, type Db } from '@shipit-ai/agents';
+import {
+  AgentStore,
+  RunQueue,
+  RunStore,
+  createDb,
+  createPool,
+  type Db,
+} from '@shipit-ai/agents';
 import { AiStatusService } from './services/ai/ai-status-service.js';
 import {
   applyDerivedAuthConfig,
@@ -437,6 +444,12 @@ async function main() {
       ? createPool({ connectionString: config.ai.database.url })
       : null;
   const agentDb: Db | null = agentPool ? createDb(agentPool) : null;
+  // Runs are queued for the agent runner on Redis; with no Redis there is no
+  // queue, and the run routes answer 503 instead of creating runs nobody works.
+  const runQueue =
+    agentDb && config.backend.redis.url
+      ? new RunQueue({ redisUrl: config.backend.redis.url })
+      : undefined;
   const aiStatus = new AiStatusService({
     config: config.ai,
     db: agentDb,
@@ -479,6 +492,8 @@ async function main() {
     redis: runStoreRedis ?? undefined,
     resolved,
     agentStore: agentDb ? new AgentStore(agentDb) : undefined,
+    runStore: agentDb ? new RunStore(agentDb) : undefined,
+    runQueue,
     aiStatus,
   });
 
@@ -530,6 +545,7 @@ async function main() {
     // close() only tears down the worker/queue it created), so close it here.
     if (eventBus) await eventBus.close();
     if (runStoreRedis) runStoreRedis.disconnect();
+    if (runQueue) await runQueue.close();
     if (agentPool) await agentPool.end();
     await neo4jService.close();
     process.exit(0);
```
<!-- prettier-ignore-end -->

- [ ] **Step 5: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/api-server typecheck && pnpm --filter @shipit-ai/api-server exec vitest run && DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit REDIS_TEST_URL=redis://localhost:6379 \
  pnpm --filter @shipit-ai/api-server run test:integration
```

Expected: PASS — unit 677 tests; integration 32 passed, 42 skipped (the Neo4j suites skip without `NEO4J_TEST_URI`), runs 19.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/api-server/src/__tests__/routes/runs.integration.test.ts packages/api-server/src/index.ts packages/api-server/src/routes/runs.ts packages/api-server/src/server.ts packages/api-server/src/services/ai/ai-status-service.ts packages/api-server/vitest.config.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/api-server/src/__tests__/routes/runs.integration.test.ts packages/api-server/src/index.ts packages/api-server/src/routes/runs.ts packages/api-server/src/server.ts packages/api-server/src/services/ai/ai-status-service.ts packages/api-server/vitest.config.ts
git commit -m "api-server: the runs API (start, list, read, chat, cancel)"
```

---

## Task 9: The live run stream (api-server)

`GET /api/runs/:id/stream` sends Server-Sent Events: `run` (the record) on connect and whenever its status changes, `message` (id = its sequence number) as the transcript grows, `end` once the run has finished. The server holds one Redis subscription for all viewers. A stream subscribes before it reads, and treats every notification as "catch up from Postgres", so nothing written in between is missed and events never need to be complete. Reconnecting with `Last-Event-ID` resumes. Fastify's `close()` waits for open responses, and a stream never finishes on its own, so open streams are ended in `preClose` (found by a SIGTERM that hung); `shutdown` runs once, since a second signal ended the Postgres pool twice.

**Files:**

- Test: `packages/api-server/src/__tests__/routes/run-stream.integration.test.ts` (create)
- Modify: `packages/api-server/src/index.ts`
- Modify: `packages/api-server/src/routes/runs.ts`
- Modify: `packages/api-server/src/server.ts`
- Create: `packages/api-server/src/services/ai/run-event-hub.ts`

**Interfaces:**

- Consumes: `RUN_EVENTS_CHANNEL`, `TERMINAL_RUN_STATUSES` (Tasks 2, 3); the runs routes (Task 8).
- Produces: `GET /api/runs/:id/stream`; `class RunEventHub { constructor(source: MessageSource); subscribe(runId, listener): () => void; listeners(runId) }`; `CreateServerOptions.runEvents?`.

- [ ] **Step 1: Write the failing test**

Create `packages/api-server/src/__tests__/routes/run-stream.integration.test.ts`:

<!-- prettier-ignore-start -->
```ts
// GET /api/runs/:id/stream over a real HTTP connection (inject() cannot read a
// response that stays open). Postgres is real; the Redis subscription is a
// local EventEmitter the test publishes on, as the runner would.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import {
  AgentStore,
  RUN_EVENTS_CHANNEL,
  RunStore,
  type AgentDefinition,
  type RunEvent,
  type RunRecord,
} from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import { RunEventHub } from '../../services/ai/run-event-hub.js';
import type { AiStatus, AiStatusService } from '../../services/ai/ai-status-service.js';

const definition: AgentDefinition = {
  instructions: 'Answer questions about service ownership.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
  output: { schema: null },
};

const AVAILABLE: AiStatus = {
  available: true,
  definitionsAvailable: true,
  checks: [],
};

interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

/** Reads server-sent events from a streaming response until `stop` says so. */
async function readEvents(
  res: Response,
  stop: (events: SseEvent[]) => boolean,
  ms = 5_000,
): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  while (!stop(events)) {
    if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(events)}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(':')) continue; // keep-alive comment
      const fields = Object.fromEntries(
        block
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
      );
      events.push({ event: fields.event!, id: fields.id, data: JSON.parse(fields.data!) });
    }
  }
  await reader.cancel();
  return events;
}

describe.skipIf(!DATABASE_TEST_URL)('GET /api/runs/:id/stream', () => {
  let database: TestDatabase;
  let agents: AgentStore;
  let runs: RunStore;
  let server: FastifyInstance;
  let base: string;
  const redis = new EventEmitter();
  const announce = (event: RunEvent) =>
    redis.emit('message', RUN_EVENTS_CHANNEL, JSON.stringify(event));

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    agents = new AgentStore(database.db);
    runs = new RunStore(database.db);
    server = await createServer({
      config: makeTestConfig(),
      agentStore: agents,
      runStore: runs,
      runQueue: { enqueue: async () => {} },
      runEvents: new RunEventHub(redis),
      aiStatus: { status: async () => AVAILABLE } as unknown as AiStatusService,
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await server.close();
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.query('DELETE FROM runs');
  });

  async function startedRun(): Promise<RunRecord> {
    const agent = await agents.create({
      slug: `owners-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Owners',
      definition,
      actor: 'dev@shipit.local',
    });
    return runs.create({
      agentId: agent.id,
      agentVersion: null,
      definition,
      triggerKind: 'manual',
      triggeredBy: 'dev@shipit.local',
      mode: 'task',
      input: { text: 'Who owns x?' },
      messages: [{ role: 'user', content: 'Who owns x?' }],
    });
  }

  it('replays the run so far, follows new messages, and ends when the run does', async () => {
    const run = await startedRun();
    const res = await fetch(`${base}/api/runs/${run.id}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reading = readEvents(res, (events) => events.some((e) => e.event === 'end'));
    // Let the replay go out before the runner "works".
    await new Promise((r) => setTimeout(r, 100));
    await runs.claim(run.id, 'w', 60);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'team-a' }], 'w');
    announce({ runId: run.id, seq: 1 });
    await runs.finish(run.id, { status: 'succeeded', output: { text: 'team-a' } }, 'w');
    announce({ runId: run.id, status: 'succeeded' });
    // An event for another run never reaches this stream.
    announce({ runId: '00000000-0000-0000-0000-000000000000', seq: 9 });

    const events = await reading;
    expect(events.map((e) => [e.event, e.id ?? null])).toEqual([
      ['run', null],
      ['message', '0'],
      ['message', '1'],
      ['run', null],
      ['end', null],
    ]);
    expect(events[0]!.data).toMatchObject({ id: run.id, status: 'queued' });
    expect(events[2]!.data).toMatchObject({
      seq: 1,
      content: { role: 'assistant', content: 'team-a' },
    });
    expect(events[3]!.data).toMatchObject({ status: 'succeeded', output: { text: 'team-a' } });
  });

  it('resumes after the last event the client saw, without repeating it', async () => {
    const run = await startedRun();
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'one' }]);
    await runs.appendMessages(run.id, [{ role: 'assistant', content: 'two' }]);
    await runs.finish(run.id, { status: 'succeeded', output: null });

    const res = await fetch(`${base}/api/runs/${run.id}/stream`, {
      headers: { 'last-event-id': '1' },
    });
    const events = await readEvents(res, (e) => e.some((x) => x.event === 'end'));
    expect(events.map((e) => [e.event, e.id ?? null])).toEqual([
      ['run', null],
      ['message', '2'],
      ['end', null],
    ]);
  });

  it('answers 404 for an unknown run, before any stream starts', async () => {
    const res = await fetch(`${base}/api/runs/00000000-0000-0000-0000-000000000000/stream`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('stops listening when the client goes away', async () => {
    const run = await startedRun();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
    await readEvents(res, (e) => e.length >= 2);
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(redis.listenerCount('message')).toBe(1); // the hub's own listener only
    expect((server.runEvents as RunEventHub).listeners(run.id)).toBe(0);
  });

  it('ends open streams when the server shuts down, so the process can exit', async () => {
    const own = await createServer({
      config: makeTestConfig(),
      agentStore: agents,
      runStore: runs,
      runQueue: { enqueue: async () => {} },
      runEvents: new RunEventHub(new EventEmitter()),
      aiStatus: { status: async () => AVAILABLE } as unknown as AiStatusService,
    });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.server.address() as { port: number };
    const run = await startedRun();
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/stream`);
    const reader = res.body!.getReader();
    await reader.read(); // the stream is open

    const closed = Promise.race([
      own.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('still open'), 3_000)),
    ]);
    expect(await closed).toBe('closed');
    // The client sees the stream end and can reconnect elsewhere with Last-Event-ID.
    let done = false;
    while (!done) done = (await reader.read()).done;
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/run-stream.integration.test.ts
```

Expected: FAIL — cannot resolve `../../services/ai/run-event-hub.js`.

- [ ] **Step 3: Implement**

Create `packages/api-server/src/services/ai/run-event-hub.ts`:

<!-- prettier-ignore-start -->
```ts
// One Redis subscription for the whole api-server, fanned out to the open run
// streams. The runner publishes { runId, seq?, status? } on shipit-run-events
// after every write; a stream treats each one as "something changed, catch up
// from Postgres", so the events themselves never need to be complete.
import { RUN_EVENTS_CHANNEL, type RunEvent } from '@shipit-ai/agents';

/** The part of an ioredis subscriber connection the hub uses. */
export interface MessageSource {
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

type Listener = (event: RunEvent) => void;

export class RunEventHub {
  private readonly byRun = new Map<string, Set<Listener>>();

  constructor(source: MessageSource) {
    source.on('message', (channel, text) => {
      if (channel !== RUN_EVENTS_CHANNEL) return;
      let event: RunEvent;
      try {
        event = JSON.parse(text) as RunEvent;
      } catch {
        return;
      }
      for (const listener of this.byRun.get(event.runId) ?? []) listener(event);
    });
  }

  /** Calls `listener` for each event of one run. Returns the unsubscribe function. */
  subscribe(runId: string, listener: Listener): () => void {
    const set = this.byRun.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.byRun.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.byRun.delete(runId);
    };
  }

  /** How many streams follow a run. */
  listeners(runId: string): number {
    return this.byRun.get(runId)?.size ?? 0;
  }
}
```
<!-- prettier-ignore-end -->

`packages/api-server/src/routes/runs.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/routes/runs.ts b/packages/api-server/src/routes/runs.ts
index c2837e9..6ed4472 100644
--- a/packages/api-server/src/routes/runs.ts
+++ b/packages/api-server/src/routes/runs.ts
@@ -11,6 +11,7 @@ import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
 import { hasCapability, type AiConfig } from '@shipit-ai/shared';
 import {
   RUN_STATUSES,
+  TERMINAL_RUN_STATUSES,
   RunNotFoundError,
   RunNotWaitingError,
   type AgentDefinition,
@@ -22,6 +23,7 @@ import {
   type StoredMessage,
 } from '@shipit-ai/agents';
 import { requireCapability } from '../middleware/require-auth.js';
+import type { RunEventHub } from '../services/ai/run-event-hub.js';
 
 /** Anything that can put a run id on the agent-runs queue. */
 export interface RunEnqueuer {
@@ -32,10 +34,14 @@ declare module 'fastify' {
   interface FastifyInstance {
     runStore?: RunStore;
     runQueue?: RunEnqueuer;
+    runEvents?: RunEventHub;
   }
 }
 
 const MAX_TEXT = 20_000;
+// A comment line this often keeps proxies and load balancers from closing an
+// idle stream.
+const KEEPALIVE_MS = 15_000;
 const MAX_INPUT_JSON = 64_000;
 const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 
@@ -72,6 +78,15 @@ function openingMessage(input: string | Record<string, unknown>): StoredMessage
 }
 
 const runsRoutes: FastifyPluginAsync = async (server) => {
+  // Open run streams never finish on their own, and Fastify's close() waits for
+  // every in-flight response: without this a SIGTERM with a viewer connected
+  // hangs until the pod is killed. Ending them first lets the server close;
+  // clients reconnect (to another pod) and resume with Last-Event-ID.
+  const openStreams = new Set<() => void>();
+  server.addHook('preClose', async () => {
+    for (const end of [...openStreams]) end();
+  });
+
   // `needRunner`: starting work needs the whole platform (models and a working
   // runner); reading needs only the stored definitions and runs.
   async function ready(
@@ -320,6 +335,104 @@ const runsRoutes: FastifyPluginAsync = async (server) => {
     },
   );
 
+  // Server-sent events: `run` (the run record) on connect and whenever its
+  // status changes, `message` (one transcript message, id = its seq) as the
+  // transcript grows, and `end` once the run has finished. Reconnecting with
+  // Last-Event-ID (or ?afterSeq) resumes after that message.
+  server.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>(
+    '/runs/:id/stream',
+    { preHandler: requireCapability('agents:read') },
+    async (request, reply) => {
+      const ctx = await ready(reply, false);
+      if (!ctx) return reply;
+      const hub = server.runEvents;
+      if (!hub) {
+        return fail(
+          reply,
+          503,
+          'AI_UNAVAILABLE',
+          'Live run updates are not available on this server.',
+        );
+      }
+      const run = await ctx.runs.get(request.params.id);
+      if (!run) return fail(reply, 404, 'NOT_FOUND', `Run ${request.params.id} not found`);
+      if (!(await canSeeContent(request, run, ctx.agents))) {
+        return fail(
+          reply,
+          403,
+          'FORBIDDEN',
+          "Only the run's starter, the agent's author and admins can read it.",
+        );
+      }
+      const resumeFrom = Number(request.headers['last-event-id'] ?? request.query.afterSeq);
+      let lastSeq = Number.isInteger(resumeFrom) ? resumeFrom : -1;
+
+      reply.hijack();
+      const out = reply.raw;
+      out.writeHead(200, {
+        'Content-Type': 'text/event-stream',
+        'Cache-Control': 'no-cache, no-transform',
+        Connection: 'keep-alive',
+        // nginx and some ingresses buffer responses unless told not to.
+        'X-Accel-Buffering': 'no',
+      });
+      const send = (event: string, data: unknown, id?: number) =>
+        out.write(
+          `event: ${event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`,
+        );
+
+      let closed = false;
+      let first = true;
+      // Catch-ups run one at a time, in order, so messages never interleave.
+      let chain = Promise.resolve();
+      const catchUp = (statusChanged: boolean) => {
+        chain = chain
+          .then(async () => {
+            if (closed) return;
+            const current = await ctx.runs.get(run.id);
+            if (!current || closed) return;
+            let sentRun = false;
+            if (first || statusChanged) {
+              send('run', current);
+              sentRun = true;
+              first = false;
+            }
+            for (const message of await ctx.runs.listMessages(run.id, { afterSeq: lastSeq })) {
+              if (closed) return;
+              send('message', message, message.seq);
+              lastSeq = message.seq;
+            }
+            if (TERMINAL_RUN_STATUSES.has(current.status)) {
+              if (!sentRun) send('run', current);
+              send('end', { status: current.status });
+              stop();
+              out.end();
+            }
+          })
+          .catch((err: Error) => {
+            request.log.warn({ err, runId: run.id }, 'runs: stream catch-up failed');
+          });
+      };
+      // Subscribe before the first catch-up, so nothing written in between is missed.
+      const unsubscribe = hub.subscribe(run.id, (event) => catchUp(event.status !== undefined));
+      const keepalive = setInterval(() => out.write(': ping\n\n'), KEEPALIVE_MS);
+      const stop = () => {
+        if (closed) return;
+        closed = true;
+        clearInterval(keepalive);
+        unsubscribe();
+        openStreams.delete(endStream);
+      };
+      const endStream = () => {
+        stop();
+        out.end();
+      };
+      openStreams.add(endStream);
+      request.raw.on('close', stop);
+      catchUp(false);
+    },
+  );
+
   server.post<{ Params: { id: string }; Body: unknown }>(
     '/runs/:id/messages',
     { preHandler: requireCapability('agents:run') },
```
<!-- prettier-ignore-end -->

`packages/api-server/src/server.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/server.ts b/packages/api-server/src/server.ts
index 1c2580b..f8550be 100644
--- a/packages/api-server/src/server.ts
+++ b/packages/api-server/src/server.ts
@@ -46,6 +46,7 @@ import feedbackRoutes from './routes/feedback.js';
 import aiRoutes from './routes/ai.js';
 import agentsRoutes from './routes/agents.js';
 import runsRoutes, { type RunEnqueuer } from './routes/runs.js';
+import type { RunEventHub } from './services/ai/run-event-hub.js';
 import type { AgentStore, RunStore } from '@shipit-ai/agents';
 import type { AiStatusService } from './services/ai/ai-status-service.js';
 import type { FeedbackService } from './services/feedback-service.js';
@@ -121,6 +122,9 @@ export interface CreateServerOptions {
   // Agent runs and the queue the runner works from. Optional for the same reason.
   runStore?: RunStore;
   runQueue?: RunEnqueuer;
+  // Fan-out of the runner's run events to open streams. Optional: without it
+  // GET /api/runs/:id/stream answers 503.
+  runEvents?: RunEventHub;
 }
 
 declare module 'fastify' {
@@ -426,6 +430,9 @@ export async function createServer(opts: CreateServerOptions = {}): Promise<Fast
   if (opts.runQueue) {
     server.decorate('runQueue', opts.runQueue);
   }
+  if (opts.runEvents) {
+    server.decorate('runEvents', opts.runEvents);
+  }
 
   // Register routes
   await server.register(healthRoutes, { prefix: '/api' });
```
<!-- prettier-ignore-end -->

`packages/api-server/src/index.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/index.ts b/packages/api-server/src/index.ts
index be3bf29..da041c2 100644
--- a/packages/api-server/src/index.ts
+++ b/packages/api-server/src/index.ts
@@ -30,6 +30,7 @@ import { SettingsService } from './services/settings-service.js';
 import { FeedbackService } from './services/feedback-service.js';
 import {
   AgentStore,
+  RUN_EVENTS_CHANNEL,
   RunQueue,
   RunStore,
   createDb,
@@ -37,6 +38,7 @@ import {
   type Db,
 } from '@shipit-ai/agents';
 import { AiStatusService } from './services/ai/ai-status-service.js';
+import { RunEventHub } from './services/ai/run-event-hub.js';
 import {
   applyDerivedAuthConfig,
   evaluateAuthBootability,
@@ -450,6 +452,20 @@ async function main() {
     agentDb && config.backend.redis.url
       ? new RunQueue({ redisUrl: config.backend.redis.url })
       : undefined;
+  // Live run updates: one subscriber connection (a subscribed ioredis client
+  // can do nothing else) fanned out to every open /api/runs/:id/stream.
+  let runEventsSubscriber: Redis | null = null;
+  let runEvents: RunEventHub | undefined;
+  if (agentDb && config.backend.redis.url) {
+    runEventsSubscriber = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
+    runEventsSubscriber.on('error', (err: Error) => {
+      console.warn(`Run events subscriber error (live run updates degraded): ${err.message}`);
+    });
+    runEventsSubscriber.subscribe(RUN_EVENTS_CHANNEL).catch((err: Error) => {
+      console.warn(`Run events subscribe failed (live run updates off): ${err.message}`);
+    });
+    runEvents = new RunEventHub(runEventsSubscriber);
+  }
   const aiStatus = new AiStatusService({
     config: config.ai,
     db: agentDb,
@@ -494,6 +510,7 @@ async function main() {
     agentStore: agentDb ? new AgentStore(agentDb) : undefined,
     runStore: agentDb ? new RunStore(agentDb) : undefined,
     runQueue,
+    runEvents,
     aiStatus,
   });
 
@@ -536,7 +553,12 @@ async function main() {
     process.exit(1);
   }
 
+  // Runs once: a second signal (Kubernetes, or an impatient Ctrl-C) must not
+  // close everything twice; pg's pool, for one, throws on a second end().
+  let shuttingDown = false;
   const shutdown = async () => {
+    if (shuttingDown) return;
+    shuttingDown = true;
     await server.close();
     if (scheduler) await scheduler.close();
     if (webhookRefetch) await webhookRefetch.close();
@@ -546,6 +568,7 @@ async function main() {
     if (eventBus) await eventBus.close();
     if (runStoreRedis) runStoreRedis.disconnect();
     if (runQueue) await runQueue.close();
+    if (runEventsSubscriber) runEventsSubscriber.disconnect();
     if (agentPool) await agentPool.end();
     await neo4jService.close();
     process.exit(0);
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/api-server typecheck && DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit REDIS_TEST_URL=redis://localhost:6379 \
  pnpm --filter @shipit-ai/api-server run test:integration
```

Expected: PASS — 37 passed, 42 skipped (stream 5).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/api-server/src/__tests__/routes/run-stream.integration.test.ts packages/api-server/src/index.ts packages/api-server/src/routes/runs.ts packages/api-server/src/server.ts packages/api-server/src/services/ai/run-event-hub.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/api-server/src/__tests__/routes/run-stream.integration.test.ts packages/api-server/src/index.ts packages/api-server/src/routes/runs.ts packages/api-server/src/server.ts packages/api-server/src/services/ai/run-event-hub.ts
git commit -m "api-server: live run stream over server-sent events"
```

---

## Task 10: The built-in Graph assistant

Seeded by the api-server at boot (not by a migration: the definition depends on the model catalog): read-only graph grants, the default model, limits within the instance ceilings, published. It never overwrites an edit; it publishes a copy an interrupted boot left unpublished; a second replica creating it at the same moment is harmless. Without a model it waits and retries every minute.

**Files:**

- Test: `packages/api-server/src/__tests__/services/ai/builtin-agents.integration.test.ts` (create)
- Modify: `packages/api-server/src/index.ts`
- Create: `packages/api-server/src/services/ai/builtin-agents.ts`

**Interfaces:**

- Consumes: `AgentStore` (foundation); `AiConfig`.
- Produces: `ensureBuiltinAgents(store, ai, log): Promise<boolean>`, `GRAPH_ASSISTANT_SLUG = 'graph-assistant'`.

- [ ] **Step 1: Write the failing test**

Create `packages/api-server/src/__tests__/services/ai/builtin-agents.integration.test.ts`:

<!-- prettier-ignore-start -->
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { AgentStore } from '@shipit-ai/agents';
import {
  createMigratedTestDatabase,
  DATABASE_TEST_URL,
  type TestDatabase,
} from '@shipit-ai/agents/testing';
import { makeTestConfig } from '../../test-config.js';
import { GRAPH_ASSISTANT_SLUG, ensureBuiltinAgents } from '../../../services/ai/builtin-agents.js';

describe.skipIf(!DATABASE_TEST_URL)('ensureBuiltinAgents', () => {
  let database: TestDatabase;
  let store: AgentStore;
  const ai = makeTestConfig().ai;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    store = new AgentStore(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.query('DELETE FROM agent_versions');
    await database.db.query('DELETE FROM agents');
  });

  it('creates and publishes the Graph assistant when it is missing', async () => {
    const log = vi.fn();
    await ensureBuiltinAgents(store, { ...ai, defaultModel: 'gemini' }, log);
    const agent = await store.getBySlug(GRAPH_ASSISTANT_SLUG);
    expect(agent).toMatchObject({
      name: 'Graph assistant',
      builtin: true,
      enabled: true,
      publishedVersion: 1,
      createdBy: 'system',
    });
    const version = await store.getVersion(agent!.id, 1);
    expect(version!.definition).toMatchObject({
      model: 'gemini',
      grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
    });
    expect(version!.definition.instructions).toMatch(/knowledge graph/);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Created the built-in Graph assistant'),
    );
  });

  it('leaves an existing assistant alone, edits included', async () => {
    await ensureBuiltinAgents(store, ai, () => {});
    const agent = (await store.getBySlug(GRAPH_ASSISTANT_SLUG))!;
    await store.update(agent.id, undefined, { name: 'Our graph helper' }, 'admin@example.com');
    await ensureBuiltinAgents(store, ai, () => {});
    expect(await store.getBySlug(GRAPH_ASSISTANT_SLUG)).toMatchObject({
      name: 'Our graph helper',
      publishedVersion: 1,
    });
    expect(await store.listVersions(agent.id)).toHaveLength(1);
  });

  it('publishes an assistant that an interrupted boot created but never published', async () => {
    await store.create({
      slug: GRAPH_ASSISTANT_SLUG,
      name: 'Graph assistant',
      builtin: true,
      definition: {
        instructions: 'x',
        model: 'gemini',
        limits: { maxSteps: 5, maxTokens: 10_000, timeoutSeconds: 60, dailyTokens: 100_000 },
        grants: { services: {}, tools: {} },
        output: { schema: null },
      },
      actor: 'system',
    });
    await ensureBuiltinAgents(store, ai, () => {});
    expect((await store.getBySlug(GRAPH_ASSISTANT_SLUG))!.publishedVersion).toBe(1);
  });

  it('uses the first catalog model when no default is set, within the instance ceilings', async () => {
    await ensureBuiltinAgents(
      store,
      { ...ai, defaultModel: '', limits: { ...ai.limits, maxSteps: 5, maxTokens: 50_000 } },
      () => {},
    );
    const agent = (await store.getBySlug(GRAPH_ASSISTANT_SLUG))!;
    expect(agent.draftDefinition.model).toBe(ai.models[0]!.key);
    expect(agent.draftDefinition.limits).toMatchObject({ maxSteps: 5, maxTokens: 50_000 });
  });

  it('waits, saying why, when the instance offers no model', async () => {
    const log = vi.fn();
    expect(await ensureBuiltinAgents(store, { ...ai, models: [], defaultModel: '' }, log)).toBe(
      false,
    );
    expect(await store.getBySlug(GRAPH_ASSISTANT_SLUG)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no model'));
  });

  it('tolerates another api-server creating it at the same moment', async () => {
    const results = await Promise.all([
      ensureBuiltinAgents(store, ai, () => {}),
      ensureBuiltinAgents(store, ai, () => {}),
    ]);
    expect(results).toEqual([true, true]);
    expect((await store.list({})).total).toBe(1);
  });
});
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Run it to verify it fails**

Run:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/ai/builtin-agents.integration.test.ts
```

Expected: FAIL — cannot resolve `../../../services/ai/builtin-agents.js`.

- [ ] **Step 3: Implement**

Create `packages/api-server/src/services/ai/builtin-agents.ts`:

<!-- prettier-ignore-start -->
```ts
// Agents every instance has (design §Built-in agent). Seeded by the api-server
// at boot rather than by a migration, because the definition depends on the
// instance's model catalog. An admin may edit and republish one; it cannot be
// archived (AgentStore refuses), and the seed never overwrites an edit.
import { AgentSlugTakenError, type AgentDefinition, type AgentStore } from '@shipit-ai/agents';
import type { AiConfig } from '@shipit-ai/shared';

export const GRAPH_ASSISTANT_SLUG = 'graph-assistant';

const GRAPH_ASSISTANT_INSTRUCTIONS = `You answer questions about this organisation's software catalog, which is stored in a knowledge graph: services, repositories, teams, people, pipelines, deployments and how they relate.

Use the graph tools to look things up. Never guess an owner, a dependency or any other fact: if the graph does not say, say so.

Entities have canonical ids such as shipit://repository/default/<org>/<repo>. When you only know a name, find the id with search_entities or graph_query first, then use the dedicated tools (find_owners, blast_radius, dependency_chain, entity_detail).

Answer briefly and directly. Name the entities you relied on, with their canonical ids, so the reader can check them.`;

// Kept well under the default ceilings: an assistant answering questions
// should not need a long run.
const LIMITS = { maxSteps: 12, maxTokens: 200_000, timeoutSeconds: 300, dailyTokens: 2_000_000 };

/**
 * Makes sure the built-in agents exist and are published. Returns false when
 * it cannot yet (no model configured); the caller tries again later.
 */
export async function ensureBuiltinAgents(
  store: AgentStore,
  ai: AiConfig,
  log: (message: string) => void,
): Promise<boolean> {
  const existing = await store.getBySlug(GRAPH_ASSISTANT_SLUG);
  if (existing) {
    // An earlier boot created it but stopped before publishing.
    if (existing.builtin && existing.publishedVersion === null) {
      await store.publish(existing.id, undefined, 'Built-in agent', 'system');
    }
    return true;
  }
  const model = ai.defaultModel || ai.models[0]?.key;
  if (!model) {
    log('Built-in Graph assistant not created yet: the instance offers no model (ai.models).');
    return false;
  }
  const definition: AgentDefinition = {
    instructions: GRAPH_ASSISTANT_INSTRUCTIONS,
    model,
    limits: {
      maxSteps: Math.min(LIMITS.maxSteps, ai.limits.maxSteps),
      maxTokens: Math.min(LIMITS.maxTokens, ai.limits.maxTokens),
      timeoutSeconds: Math.min(LIMITS.timeoutSeconds, ai.limits.timeoutSeconds),
      dailyTokens: Math.min(LIMITS.dailyTokens, ai.limits.dailyTokens),
    },
    grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
    output: { schema: null },
  };
  try {
    const agent = await store.create({
      slug: GRAPH_ASSISTANT_SLUG,
      name: 'Graph assistant',
      description: 'Answers questions about the catalog from the knowledge graph. Read-only.',
      definition,
      builtin: true,
      actor: 'system',
    });
    await store.publish(agent.id, undefined, 'Built-in agent', 'system');
    log(`Created the built-in Graph assistant on model ${model}.`);
  } catch (err) {
    // Another api-server replica created it first.
    if (!(err instanceof AgentSlugTakenError)) throw err;
  }
  return true;
}
```
<!-- prettier-ignore-end -->

`packages/api-server/src/index.ts`:

<!-- prettier-ignore-start -->
```diff
diff --git a/packages/api-server/src/index.ts b/packages/api-server/src/index.ts
index da041c2..9a8d3be 100644
--- a/packages/api-server/src/index.ts
+++ b/packages/api-server/src/index.ts
@@ -39,6 +39,7 @@ import {
 } from '@shipit-ai/agents';
 import { AiStatusService } from './services/ai/ai-status-service.js';
 import { RunEventHub } from './services/ai/run-event-hub.js';
+import { ensureBuiltinAgents } from './services/ai/builtin-agents.js';
 import {
   applyDerivedAuthConfig,
   evaluateAuthBootability,
@@ -446,6 +447,7 @@ async function main() {
       ? createPool({ connectionString: config.ai.database.url })
       : null;
   const agentDb: Db | null = agentPool ? createDb(agentPool) : null;
+  const agentStore = agentDb ? new AgentStore(agentDb) : undefined;
   // Runs are queued for the agent runner on Redis; with no Redis there is no
   // queue, and the run routes answer 503 instead of creating runs nobody works.
   const runQueue =
@@ -507,13 +509,32 @@ async function main() {
     // of a Redis URL stays a soft warning rather than a hard boot failure.
     redis: runStoreRedis ?? undefined,
     resolved,
-    agentStore: agentDb ? new AgentStore(agentDb) : undefined,
+    agentStore,
     runStore: agentDb ? new RunStore(agentDb) : undefined,
     runQueue,
     runEvents,
     aiStatus,
   });
 
+  // The built-in Graph assistant backs Ask. Seeded once the database answers
+  // and a model is configured; until then it retries every minute, quietly.
+  if (agentStore) {
+    const seed = async (): Promise<boolean> => {
+      try {
+        return await ensureBuiltinAgents(agentStore, config.ai, (m) => console.log(m));
+      } catch (err) {
+        console.warn(`Built-in agents not seeded yet: ${(err as Error).message}`);
+        return false;
+      }
+    };
+    if (!(await seed())) {
+      const retry = setInterval(() => {
+        void seed().then((done) => done && clearInterval(retry));
+      }, 60_000);
+      retry.unref();
+    }
+  }
+
   // Start any pre-configured connectors after the server is constructed so
   // the runner attaches once the rest of the wiring (event bus, etc.) is in
   // place. Tests typically skip this entirely.
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
pnpm --filter @shipit-ai/api-server typecheck && DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit REDIS_TEST_URL=redis://localhost:6379 \
  pnpm --filter @shipit-ai/api-server run test:integration
```

Expected: PASS — 43 passed, 42 skipped (built-in agents 6).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/api-server/src/__tests__/services/ai/builtin-agents.integration.test.ts packages/api-server/src/index.ts packages/api-server/src/services/ai/builtin-agents.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/api-server/src/__tests__/services/ai/builtin-agents.integration.test.ts packages/api-server/src/index.ts packages/api-server/src/services/ai/builtin-agents.ts
git commit -m "api-server: seed the built-in Graph assistant"
```

---

## Task 11: Local development, the hands-on check, and the infra brief

Make the runner part of `pnpm start:backend`, document running agents locally, record the milestone, and hand infra its second brief. Then check the whole thing by hand against real services, which no suite does end to end.

**Files:**

- Create: `docs/agent/briefs/infra-agent-runner.md`
- Modify: `docs/agent/plans/ai-agents-and-workflows.md`
- Modify: `docs/local-development.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing other tasks use.

- [ ] **Step 1: Start the runner with the backend**

`package.json`:

<!-- prettier-ignore-start -->
```diff
diff --git a/package.json b/package.json
index 9792f83..820ae44 100644
--- a/package.json
+++ b/package.json
@@ -15,7 +15,7 @@
     "setup": "bash scripts/setup.sh",
     "preflight": "bash scripts/preflight.sh",
     "start:infra": "bash scripts/preflight.sh && bash scripts/infra.sh",
-    "start:backend": "bash scripts/preflight.sh && bash scripts/infra.sh && bash scripts/maybe-seed.sh && turbo dev --filter=@shipit-ai/api-server --filter=@shipit-ai/core-writer --filter=@shipit-ai/mcp-server",
+    "start:backend": "bash scripts/preflight.sh && bash scripts/infra.sh && bash scripts/maybe-seed.sh && turbo dev --filter=@shipit-ai/api-server --filter=@shipit-ai/core-writer --filter=@shipit-ai/mcp-server --filter=@shipit-ai/agent-runner",
     "start:frontend": "bash scripts/preflight.sh && turbo dev --filter=@shipit-ai/web-ui",
     "start:mcp": "bash scripts/preflight.sh && turbo dev --filter=@shipit-ai/mcp-server",
     "start:all": "bash scripts/preflight.sh && bash scripts/infra.sh && bash scripts/maybe-seed.sh && turbo dev",
```
<!-- prettier-ignore-end -->

- [ ] **Step 2: Document it**

`docs/local-development.md`:

<!-- prettier-ignore-start -->
````diff
diff --git a/docs/local-development.md b/docs/local-development.md
index c03a6ea..e321647 100644
--- a/docs/local-development.md
+++ b/docs/local-development.md
@@ -163,16 +163,16 @@ concurrently, the loser sees a 409 and a "reload and rebase" dialog.
 
 ### Recommended: scripted starts
 
-| Script                | What it starts                                                             |
-| --------------------- | -------------------------------------------------------------------------- |
-| `pnpm start:infra`    | Docker: Neo4j + Redis + Postgres, then applies database migrations         |
-| `pnpm start:backend`  | Infra + `api-server` + `core-writer` (auto-seeds demo data if graph empty) |
-| `pnpm start:frontend` | Web UI dev server only                                                     |
-| `pnpm start:mcp`      | MCP server only (stdio)                                                    |
-| `pnpm start:all`      | Everything in parallel                                                     |
-| `pnpm stop`           | Bring all docker-compose services down                                     |
-| `pnpm stop:clean`     | Down + delete volumes (wipes Neo4j, Redis and Postgres data)               |
-| `pnpm db:migrate`     | Apply pending files in `db/migrations/` (needs `DATABASE_URL`)             |
+| Script                | What it starts                                                                                |
+| --------------------- | --------------------------------------------------------------------------------------------- |
+| `pnpm start:infra`    | Docker: Neo4j + Redis + Postgres, then applies database migrations                            |
+| `pnpm start:backend`  | Infra + `api-server` + `core-writer` + `agent-runner` (seeds demo data if the graph is empty) |
+| `pnpm start:frontend` | Web UI dev server only                                                                        |
+| `pnpm start:mcp`      | MCP server only (stdio)                                                                       |
+| `pnpm start:all`      | Everything in parallel                                                                        |
+| `pnpm stop`           | Bring all docker-compose services down                                                        |
+| `pnpm stop:clean`     | Down + delete volumes (wipes Neo4j, Redis and Postgres data)                                  |
+| `pnpm db:migrate`     | Apply pending files in `db/migrations/` (needs `DATABASE_URL`)                                |
 
 ### Manual paths
 
@@ -191,6 +191,9 @@ pnpm --filter @shipit-ai/core-writer dev
 
 # Terminal 4 — web-ui (Next.js dev server)
 pnpm --filter @shipit-ai/web-ui dev
+
+# Terminal 5 — agent-runner (watch mode; see "Running agents locally")
+GOOGLE_CLOUD_PROJECT=<your project> pnpm --filter @shipit-ai/agent-runner dev
 ```
 
 ### Ports
@@ -220,9 +223,9 @@ ai:
     url: postgres://shipit:shipit-dev@localhost:5432/shipit
 ```
 
-`GET http://localhost:3001/api/ai/status` then reports each prerequisite. The
-`runner` check stays red until the agent runner exists; definitions work
-without it.
+`GET http://localhost:3001/api/ai/status` then reports each prerequisite.
+Definitions work with the database alone; running agents also needs the
+runner and a model (next section).
 
 The schema is plain SQL in `db/migrations/`, named `NNNN_description.sql` and
 forward-only: never edit a file that has been applied, add a new one. The app
@@ -240,6 +243,44 @@ DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
 
 Each suite creates and drops its own schema, so it does not touch your data.
 
+### Running agents locally
+
+Runs are worked by the `agent-runner` process, which calls models on Vertex AI
+and runs the graph tools against your local Neo4j. It needs:
+
+- **Application Default Credentials:** `gcloud auth application-default login`.
+- **A Vertex project:** `GOOGLE_CLOUD_PROJECT` in the runner's environment (or
+  `ai.vertex.project` in `shipit.config.local.yaml`), with the models in
+  `ai.models` enabled, and given quota, in that project.
+- **A local dev user that may run agents.** With auth off, the dev user's
+  capabilities come from `frontend.devUser.capabilities` in
+  `shipit.config.local.yaml`; use `'*'`. (`admin` is not a capability name,
+  so it grants nothing.)
+
+`pnpm start:backend` starts the runner with the rest of the backend. On its
+first boot with a database, the api-server creates the built-in **Graph
+assistant**. Try it from a terminal:
+
+```bash
+AGENT=$(curl -s localhost:3001/api/agents | jq -r '.items[] | select(.slug=="graph-assistant") | .id')
+RUN=$(curl -s -X POST localhost:3001/api/agents/$AGENT/runs \
+  -H 'content-type: application/json' \
+  -d '{"input":"Which pipelines build the shipit-ai repository?","mode":"chat"}' | jq -r .id)
+curl -N localhost:3001/api/runs/$RUN/stream          # live events; Ctrl-C when it waits
+curl -s -X POST localhost:3001/api/runs/$RUN/messages \
+  -H 'content-type: application/json' -d '{"text":"Who owns it?"}'
+curl -s localhost:3001/api/runs/$RUN/messages | jq '.toolCalls[] | {toolId, status}'
+```
+
+The runner's suites need Postgres and Redis; the live model check needs ADC:
+
+```bash
+DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit REDIS_TEST_URL=redis://localhost:6379 \
+  pnpm --filter @shipit-ai/agent-runner run test:integration
+VERTEX_TEST_PROJECT=<your project> VERTEX_TEST_MODELS=gemini:gemini-3.8-flash \
+  pnpm --filter @shipit-ai/agent-runner run test:live
+```
+
 ---
 
 ## 6. Day-to-day commands
````
<!-- prettier-ignore-end -->

`docs/agent/plans/ai-agents-and-workflows.md`:

<!-- prettier-ignore-start -->
```diff
diff --git a/docs/agent/plans/ai-agents-and-workflows.md b/docs/agent/plans/ai-agents-and-workflows.md
index b2405f1..d514184 100644
--- a/docs/agent/plans/ai-agents-and-workflows.md
+++ b/docs/agent/plans/ai-agents-and-workflows.md
@@ -140,6 +140,14 @@ placeholder pages (Agents, Workflows, Tools) until their milestones land.
 `/api/ai/status`, `/api/ai/models` and the `/api/agents` definitions API. No runner, model
 layer or UI yet.
 
+**Milestone 1, second half (backend) implemented** per
+`docs/superpowers/plans/2026-10-03-agent-runner.md`: the `agent-runner` process (BullMQ
+worker, Vertex model client, graph read tools via `@shipit-ai/mcp-server/tools`, the run
+loop with leases, limits, cancel, chat turns and crash recovery), migration `0002_runs.sql`,
+the runs API and live stream in api-server, and the built-in Graph assistant. Approvals
+(Milestone 3) are not in it: a tool whose grant is `ask` is not offered yet. The UI half
+(agent editor, test panel, run view, Ask) is the next plan.
+
 ## Related
 
 - [api-server-config-persistence-strategy](../decisions/api-server-config-persistence-strategy.md) — Postgres as planned Phase 2; scheduler must leave api-server before replicas > 1
```
<!-- prettier-ignore-end -->

- [ ] **Step 3: Write infra brief 2**

Create `docs/agent/briefs/infra-agent-runner.md`:

<!-- prettier-ignore-start -->
```markdown
# Infra brief 2 — the `agent-runner` Deployment

**For:** `Ship-It-Ops/shipit-ai-infra` (the `charts/shipit-ai` umbrella chart, `build-images.yml`, `deploy.yml`).
**From:** app repo, 2026-10-03. **Follows:** [infra-postgres-and-vertex-for-agents](infra-postgres-and-vertex-for-agents.md)
(brief 1, worked in your PR #91: Postgres 17, the migration hook, the Vertex GSAs).
**Plan:** `docs/superpowers/plans/2026-10-03-agent-runner.md` in the app repo.

You are working in the infra repo. Read its `docs/agent/MANIFEST.md`, `status/` and
`instructions/` first; its standing instructions apply. Where this says "infra decides",
pick what fits the chart's conventions and record it.

## What the app now has

A new long-running worker, **`agent-runner`** (`packages/agent-runner`). It takes run ids
from the BullMQ queue `shipit-agent-runs` on the existing Redis, calls models on Vertex AI,
runs the graph read tools against Neo4j, and records every step in Postgres. It serves no
HTTP and has no Service. It writes a heartbeat (`shipit-agent-runner-heartbeat`, 60 s
expiry) that `GET /api/ai/status` reads; with no runner, agent runs answer 503 and the rest
of the product is unaffected.

## Required changes

### 1. Image

Build and publish `packages/agent-runner/Dockerfile` (repo root as context) in
`build-images.yml`, alongside api-server, core-writer and mcp-server, with the same
tagging, scanning and pinning. The app repo's CI builds it in its docker matrix too.

### 2. Deployment

- `replicas: 1`. More would work (runs are leased in Postgres), but v1 does not exercise it.
- **KSA `shipit/agent-runner`**, which PR #91 already bound to the GSA
  `shipit-agent-runner` with `roles/aiplatform.user`. No other Google role.
- Config: mount `shipit.config.yaml` at `/app/shipit.config.yaml` like the other workers.
- Environment, the same names the other services use where they overlap:

  | Variable                                                     | Value                                                     |
  | ------------------------------------------------------------ | --------------------------------------------------------- |
  | `DATABASE_URL`                                               | from the ExternalSecret `shipit-agent-secrets` (app role) |
  | `REDIS_URL`                                                  | the in-cluster Redis                                      |
  | `NEO4J_URI`, `NEO4J_PASSWORD` (and user, as core-writer has) | the graph                                                 |
  | `GOOGLE_CLOUD_PROJECT`                                       | `ship-it-ai-portal`                                       |
  | `GOOGLE_CLOUD_LOCATION`                                      | `global`                                                  |

  It does **not** need `SHIPIT_AGENT_PLATFORM_KEY` yet (graph-write tools and connection
  secrets arrive with Milestone 3; a later brief will say so). Do not route `envFrom` the
  whole `shipit-agent-secrets` Secret into it for that reason.

- Resources: infra decides. It is I/O-bound (waiting on Vertex and Postgres); requests
  around `100m / 256Mi` and a `512Mi` limit should be ample at `ai.runner.concurrency: 4`.
- Probes: none needed. A crash restarts the pod; a hung process is caught by the app (runs
  without progress are failed by the sweeper, and `/ai/status` shows the runner as down).
- `terminationGracePeriodSeconds: 60`. On SIGTERM the runner stops taking jobs and waits
  for runs in progress; a run cut off by the kill resumes on the next pod within about a
  minute (its lease expires and the sweeper re-queues it). A write that was in flight is
  reported to the model as "outcome unknown" and never repeated.
- Rollout: `deploy.yml` / `helm-spin-up.yml` after `shipit-postgres` (the runner waits for
  the schema itself, so ordering against the migration hook is not critical).

### 3. Egress

To `aiplatform.googleapis.com` (Vertex) only, for now. GitHub and external MCP hosts come
with Milestone 3.

### 4. Streaming through the load balancer (api-server, not the runner)

`GET /api/runs/:id/stream` is a long-lived Server-Sent Events response. The app sends a
keep-alive comment every 15 s and the browser resumes with `Last-Event-ID` after any cut,
so nothing is lost, but GCLB's backend service timeout (30 s by default) would cut every
stream at 30 s. If the api-server sits behind GCE Ingress, give it a `BackendConfig` with a
longer `timeoutSec` (an hour is common for SSE). Infra decides the value.

## Not in this brief

- `SHIPIT_AGENT_PLATFORM_KEY` for the runner, GitHub and MCP egress (Milestone 3).
- Any change to Postgres sizing: the runner adds about six connections.

## How the app checks it

`GET /api/ai/status` on portal-demo answers `"available": true` with every check green, and
asking the built-in Graph assistant a question from AI → Ask (or `POST
/api/agents/:id/runs`) returns an answer with its tool calls recorded.
```
<!-- prettier-ignore-end -->

- [ ] **Step 4: Check it by hand**

Prerequisites: Docker running; `gcloud auth application-default login`; in `shipit.config.local.yaml`, the `ai.database.url` block (foundation plan) and `frontend.devUser.capabilities: ['*']`.

```bash
DATABASE_URL=postgres://shipit:shipit-dev@localhost:5432/shipit pnpm db:migrate
GOOGLE_CLOUD_PROJECT=ship-it-ai-portal pnpm start:backend
```

Expected in the logs: `applied 0002_runs.sql` (first time only), `Created the built-in Graph assistant on model gemini.`, and `Agent runner <host>-<pid> working (concurrency 4, 4 models).`

```bash
curl -s localhost:3001/api/ai/status | jq '{available, failing: [.checks[] | select(.ok | not) | .name]}'
```

Expected: `"available": true`, `"failing": []`.

Then run the commands in docs/local-development.md, "Running agents locally". Expected: the stream shows `run`, `message` events for the user message, each tool call and its result, and the answer, then a `run` event with status `waiting_input`; after the follow-up the stream (reconnect with `-H 'Last-Event-ID: <last seq>'`) continues from the next message; `toolCalls` lists `graph.*` calls with status `succeeded`. Answers come from your local graph: on a seeded graph, "Which pipelines build the shipit-ai repository?" lists its pipelines by canonical id.

The conditions tests cannot pin:

```bash
# A viewer connected while the api-server stops: it exits within a few seconds.
RUN=<a chat run id waiting for input>
curl -s -N localhost:3001/api/runs/$RUN/stream > /dev/null &
kill -TERM $(lsof -iTCP:3001 -sTCP:LISTEN -t)   # stop the api-server
```

Expected: the api-server exits within a few seconds and logs no `Called end on pool more than once`. Start it again.

```bash
# Postgres stops under a running runner: neither process crashes.
docker compose -f docker/docker-compose.yml stop postgres; sleep 10
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/api/health
docker compose -f docker/docker-compose.yml start postgres
```

Expected: `200`; the runner logs `sweep failed` or lease errors and carries on; after Postgres is back a new run works without restarting anything.

- [ ] **Step 5: Commit**

```bash
npx prettier --write docs/agent/briefs/infra-agent-runner.md docs/agent/plans/ai-agents-and-workflows.md docs/local-development.md package.json
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add docs/agent/briefs/infra-agent-runner.md docs/agent/plans/ai-agents-and-workflows.md docs/local-development.md package.json
git commit -m "docs: running agents locally, and infra brief 2 for the agent runner"
```

---

## Self-review notes

- **Spec coverage (Milestone 1, backend):** runner process and loop (Tasks 6, 7), model client (Task 4), limits (Task 6), MCP handler reuse and graph read tools (Tasks 1, 5), the runs routes of §API (Task 8) and the stream (Task 9), feature gating for runs (Task 8: starting work needs the whole platform, reading needs definitions only), the built-in agent (Task 10), compose, image and CI (Task 7), infra brief 2 (Task 11). The UI half of Milestone 1 (agent editor, test panel, run view, Ask, off-states) is the next plan; it consumes Tasks 8 to 10.
- **Deviations from the spec, on purpose, each pinned by a test:**
  - **Handler reuse:** a registry captures each tool's handler through its existing `register*` function, instead of rewriting eight closures into exported functions. One handler per tool either way.
  - **Graph results:** the runner strips the MCP envelope itself and keeps `truncated` and `warnings`, instead of `compact: true`, which drops them and is not offered by every tool.
  - **Run leases** in Postgres decide who works a run, instead of relying on BullMQ's stalled-job redelivery: a duplicate job is a no-op, a dead worker's run is taken over after 60 s, and a worker that lost its lease cannot write.
  - **Last step:** the run asks the model for an answer instead of failing at the limit; it still fails with `STEP_LIMIT` if the model insists on a tool.
  - **Chat limits per turn:** steps, tokens and time count per turn for chat runs; per run would end Ask after a few questions.
  - **`ask` grants:** not offered until approvals exist (Milestone 3); the run records a warning naming the tool.
  - **Structured output** (`submit_result`) is deferred to the workflows milestone, which is what needs it; a run with `output.schema` returns text and a warning.
  - **Text deltas** are not streamed: the model client makes one non-streaming call per step, and the stream relays whole messages. The deltas channel is not defined until something publishes on it.
  - **Unknown tools** are audited with `service` and `effect` NULL rather than a made-up value.
- **Found along the way, fixed separately (`8825bd3`):** the mcp-server entry started its server whenever the process script ended in `index.js`, so every api-server process (`node dist/index.js`) also ran an MCP server on port 3002, and `pnpm start:mcp` (`tsx src/index.ts`) ran none. It now compares real paths, and the api-server imports `@shipit-ai/mcp-server/metadata`. Rebase onto it with the K0 work.
- **Not in this plan:** approvals and write tools (Milestone 3), triggers (Milestone 2), the UI. `seed:reset` does not clear runs yet; the plan that adds run history to the UI adds that, per the pattern `reset-script-must-drain-redis-surfaces`.
