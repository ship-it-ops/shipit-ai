# Architecture

## System Overview

ShipIt-AI is a TypeScript monorepo that builds and maintains a knowledge graph of your software ecosystem. Graph data flows in one direction: connectors pull from external sources, normalize into canonical entities, publish through an event bus, and the Core Writer merges everything into Neo4j with conflict resolution. Beside the graph, Postgres holds what the AI side needs — agent definitions and runs, and the knowledge layer's documents and embeddings — worked by two more processes.

```
External sources          Event bus            Graph                 Consumers
┌──────────┐          ┌──────────────┐     ┌──────────┐      ┌──────────────────┐
│  GitHub  │──┐       │              │     │          │      │   API Server     │ Fastify, :3001
├──────────┤  ├──▶    │ BullMQ/Redis │──▶  │  Neo4j 5 │──▶   ├──────────────────┤
│   K8s    │──┘       │              │     │          │      │   MCP Server     │ HTTP :3002 / stdio
└──────────┘          └──────────────┘     └──────────┘      ├──────────────────┤
 Connector SDK          Core Writer                          │   Web UI         │ Next.js, :3000
 (run inside the                                             └──────────────────┘
  api-server's sync
  scheduler)
                      ┌───────────────────────┐     ┌──────────────┐  ┌──────────────────┐
                      │ Postgres 17 + pgvector │◀──▶ │ agent-runner │  │ knowledge-worker │
                      │ agents · runs · docs   │     │  (Vertex AI) │  │   (Vertex AI)    │
                      └───────────────────────┘     └──────────────┘  └──────────────────┘
```

Six processes run in a deployment: `api-server`, `core-writer`, `mcp-server`, `web-ui`, and the two optional workers `agent-runner` and `knowledge-worker`. Three stores: Neo4j (the graph and the application's own `_`-prefixed records), Redis (queues, sessions, connector run history, worker heartbeats) and Postgres (agents and knowledge; optional — without it the AI pages show setup guidance and `/api/agents` answers `503 AI_UNAVAILABLE`).

## Packages

Thirteen workspace packages, all `workspace:*` via pnpm:

```
@shipit-ai/shared                 types, config loader + Zod schema, canonical IDs, claims,
    │                             auth context, source reliability, the Cypher read-only check
    ├── event-bus                 BullMQ producer/consumer, job retention
    ├── connector-sdk             ShipItConnector interface, harness, sync state machine,
    │       │                     dry-run, knowledge-connector contract
    │       ├── connectors/github       (@shipit-ai/connector-github)
    │       └── connectors/kubernetes   (@shipit-ai/connector-kubernetes)
    ├── core-writer               depends on: shared, event-bus, both connectors
    ├── mcp-server                depends on: shared
    ├── agents                    Postgres access, agent + run stores, migrations CLI (no internal deps)
    ├── knowledge                 depends on: agents, connector-sdk — documents, chunks, embeddings
    ├── agent-runner              depends on: agents, mcp-server, shared
    ├── knowledge-worker          depends on: agents, knowledge, shared
    ├── api-server                depends on: shared, event-bus, connector-sdk, both connectors,
    │                             mcp-server, agents, knowledge
    └── web-ui                    depends on: shared, mcp-server (tool metadata only);
                                  talks to api-server over HTTP at runtime
```

## Four-Node Service Model

The knowledge graph centers on four core node types that model the lifecycle of a service:

```
                    ┌─────────────────┐
                    │ LogicalService  │
                    │ "config-service"│
                    └──┬──────────┬───┘
                       │          │
              IMPLEMENTED_BY   DEPLOYED_AS
                       │          │
              ┌────────▼──┐  ┌────▼────────┐
              │ Repository │  │ Deployment  │
              │ "config-   │  │ "config-svc │
              │  service"  │  │  -prod"     │
              └────────┬───┘  └──┬──────┬───┘
                       │         │      │
                  BUILT_FROM  RUNS_IMAGE  EMITS_TELEMETRY_AS
                       │         │      │
              ┌────────▼──┐      │  ┌───▼──────────┐
              │  Build     │◀────┘  │RuntimeService│
              │  Artifact  │        │"config-svc"  │
              └────────────┘        └──────────────┘
```

**LogicalService** is the anchor — a named, team-owned concept that persists across deployments, repos, and renames. The other three types capture implementation, runtime, and observability aspects.

Supporting node types (Team, Person, Environment, Pipeline, Monitor, Namespace, Cluster) connect to the core four via relationships like `OWNS`, `MEMBER_OF`, `RUNS_IN_ENV`, `BUILT_BY`, and `MONITORS`. Relationship types that mean ownership carry `semantics: ownership` in the schema, and every consumer that answers "who owns this" walks all of them. The full list is in [schema-guide.md](schema-guide.md).

## Data Flow

### 1. Connector → Event Bus

Connectors implement the `ShipItConnector` interface:

```
authenticate() → discover() → fetch() → normalize() → sync()
```

The `ConnectorHarness` wraps a connector and handles sync state (IDLE → SYNCING → COMPLETING → IDLE/FAILED/DEGRADED), publishes each fetched page of normalized entities to the event bus, and ends a run with a control envelope so the writer knows the run is complete.

Syncs run **inside the api-server**: its `SyncScheduler` is a BullMQ worker that runs each connector instance on its cron schedule (GitHub every 30 minutes by default, Kubernetes every 5) and on demand (`POST /api/connectors/:id/sync`). The GitHub webhook receiver (`POST /api/webhooks/github`) verifies each delivery's HMAC signature and enqueues a coalesced refetch of the affected repository or workflows, so the graph is fresh between polls. The knowledge layer's `KnowledgeSyncScheduler` runs on its own queue.

Each entity is normalized into a `CanonicalEntity` of `CanonicalNode[]` and `CanonicalEdge[]`; every node carries `_source_system`, `_source_connector_id`, `_source_id`, `_last_synced` and its `_claims`.

### 2. Event Bus

Events are published as `EventEnvelope` messages on BullMQ queues:

```typescript
{
  id: string,              // UUID
  timestamp: string,       // ISO 8601
  connector_id: string,
  idempotency_key: string, // {connector_id}~{entity_primary_key}~{event_version} (`~`: BullMQ forbids `:` in job ids)
  payload: CanonicalEntity,
  kind?: 'entities' | ...  // control envelopes mark the end of a run
}
```

Completed jobs are kept for 24 hours (at most 1,000), failed jobs for 7 days (at most 5,000). An optional Redis Stream audit log (`shipit-event-log`) is off by default: nothing consumes it, and a full-entity stream is unbounded in bytes (it was the dominant share of a Redis out-of-memory incident).

### 3. Core Writer → Neo4j

The Core Writer is the only process that writes **connector data** to Neo4j. For each event it:

1. **Idempotency check** — skips an event already applied, through `_IdempotencyLog` nodes with a TTL and a content hash, so a re-run of the same sync writes nothing
2. **Identity reconciliation** — matches the incoming entity to an existing node:
   - Step 1: Primary key match (canonical ID)
   - Step 2: Linking key match (source-specific ID such as `github://org/repo`, stored as `_LinkingKey` nodes)
   - Step 3: Create a new entity if no match
3. **Claim resolution** — merges PropertyClaims and resolves the effective value per the configured strategy
4. **Node merge** — `MERGE` by label + canonical ID, `SET` resolved properties and the serialized `_claims` JSON
5. **Edge merge** — `MATCH` source/target nodes, `MERGE` the relationship with metadata

Events are written in batches of 500. After a successful full run of a connector type that opts in (Kubernetes does, GitHub does not), the writer marks the connector's unseen nodes `_absent_since` — nothing is deleted, and the catalog, graph and MCP tools hide absent nodes unless asked.

### Who else writes to Neo4j

The api-server writes the application's own records directly: `_AccessToken` nodes (personal access tokens), manual claim and relationship edits with their `GraphEditEvent` audit trail (gated by `accessControl.manualWrite`, audit events retained 90 days by default), and the reconciliation candidates and merge events of the identity review queue. A sign-in upserts the user's `Person` through the event bus like any connector. The MCP server opens Neo4j read-only.

## Claim Resolution Lifecycle

Every property value in the graph is backed by one or more PropertyClaims:

```typescript
{
  property_key: "owner",
  value: "platform-team",
  source: "github",
  source_id: "github://acme/config-service",
  ingested_at: "2026-02-28T12:00:00Z",
  confidence: 0.9,
  evidence: "CODEOWNERS file"
}
```

When multiple sources assert different values for the same property, the resolution strategy determines the winner:

| Strategy                | Behavior                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `HIGHEST_CONFIDENCE`    | Effective confidence (with time decay) wins; tiebreak by recency                                         |
| `MANUAL_OVERRIDE_FIRST` | Human claims always win (`verified:` above `manual:`); fallback to `HIGHEST_CONFIDENCE`                  |
| `AUTHORITATIVE_ORDER`   | Source priority: verified > manual > backstage > github > login > kubernetes > datadog > jira > identity |
| `LATEST_TIMESTAMP`      | Most recently ingested value wins                                                                        |
| `MERGE_SET`             | Union all values into an array (for tags, labels)                                                        |

A claim's base confidence comes from the source-reliability registry in `@shipit-ai/shared` (github 0.9, kubernetes 0.85, manual 0.95, verified 0.99, …) and decays by 0.01 per week — except human attestations, which do not decay. On top of resolution, a per-field confidence engine adds corroboration from independent sources, subtracts for conflict and ambiguity, and derives a verification status (`UNVERIFIED`, `CORROBORATED`, `USER_VERIFIED`, `DISPUTED`, `STALE`) that the catalog shows and a person can change by verifying a value ([ADR-029](adrs/ADR-029-per-field-confidence-and-verification.md)).

Claims are stored as a JSON `_claims` array on each node (see [ADR-002](adrs/ADR-002-propertyclaim-storage.md)), reducing write operations from ~45 to ~2 per entity update.

## Identity Reconciliation

Entities are identified across sources by a ladder:

1. **Primary Key** — Canonical ID (`shipit://label/namespace/name`). Exact match.
2. **Linking Key** — Source-specific ID (e.g., `github://acme-corp/config-service`, `k8s://prod-cluster/default/config-svc`). Stored as `_LinkingKey` nodes in Neo4j.
3. **Fuzzy candidates** — the api-server's `ReconciliationService` scans for likely duplicates with lexical similarity (Jaro-Winkler on names, trigrams on namespaces, Jaccard on tag and label sets) above `backend.reconciliation.threshold` (0.85). Candidates are never merged automatically: they wait in **Operations → Reconciliation** (`/api/reconciliation`) for a person to merge or mark distinct, and every merge is recorded as a `MergeEvent`.

### Canonical ID Format

```
shipit://{label}/{namespace}/{name}
```

For entities owned by a multi-tenant source (e.g., GitHub orgs), `{name}` is
scoped by the owning tenant to avoid silent cross-tenant collisions
([ADR-021](adrs/ADR-021-org-scoped-canonical-ids-and-source-connector.md)):

```
shipit://{label}/{namespace}/{scope}/{name}
```

Examples:

- `shipit://repository/default/acme-corp/config-service`
- `shipit://team/default/acme-corp/platform-team`
- `shipit://pipeline/default/acme-corp/config-service-ci`
- `shipit://deployment/production/config-svc-prod`
- `shipit://person/default/alice` _(unscoped — GitHub logins are globally unique; lower-cased on both the connector and the login side)_

Labels are kebab-cased in the ID (`LogicalService` → `logical-service`), so build IDs with `buildCanonicalId` / `buildScopedCanonicalId` from `@shipit-ai/shared` rather than by hand.

## Access Control & Identity

Authentication for `/api/*` and the web UI is governed by the top-level `accessControl:` block in `shipit.config.yaml` and lives in `packages/api-server/src/middleware/require-auth.ts` plus `packages/api-server/src/services/auth/` ([ADR-027](adrs/ADR-027-login-and-access-model.md)).

- **Master flag** — `accessControl.auth.enabled`. Committed default **on**, with no provider and no admins, so an unconfigured deployment fails loud at boot instead of opening up. When **off** (the local-dev default via `shipit.config.local.yaml`), every request is admitted as a principal synthesized from `frontend.devUser` (role `admin`, the capabilities listed there).
- **First-boot setup mode** — a fresh deployment whose only failing gates are the ones a wizard can fix (provider, admins) boots into setup mode: `/api/health` reports `mode: "setup"`, only `/api/setup/*`, the GitHub App manifest flow and the webhook receiver answer, and everything else is `401 SETUP_MODE`. `POST /api/setup/complete` writes a one-way latch and restarts the process with auth enforced ([ADR-026](adrs/ADR-026-first-boot-setup-mode.md)).
- **Identity providers** — `OidcProvider` (any OIDC-compliant IdP) and `GitHubProvider` (a classic GitHub OAuth App, separate from the connector's GitHub App). At least one must be enabled when auth is on. `providers.github.allowedOrgs` gates sign-in by org membership.
- **Who may sign in** — `accessControl.auth.admins[]` land as `admin`; everyone else is `member`, or is rejected when `allowList[]` is non-empty. Both lists are delivered as secrets on a deployment and editable from **Admin → Access Control**.
- **Sessions** — cookie-backed via `@fastify/session` + `@fastify/cookie`, persisted in Redis (`RedisSessionStore`), 12-hour TTL. The cookie is `secure` in production, which needs `backend.api.trustProxy: true` behind a TLS-terminating ingress.
- **Personal access tokens** — `Authorization: Bearer shipit_pat_<id>.<secret>`, stored as `_AccessToken` nodes (salted hash) by `TokenService`, minted once-plaintext from **Settings → API Keys**. Scopes: `mcp:invoke`, `graph:read`, `catalog:read`, `graph:query`; a token can only carry scopes its minter holds (so today only administrators can mint `mcp:invoke` and `graph:query`). A token principal is a member whose capabilities are exactly its scopes. `/api/tokens` is mounted only when auth is enforced.
- **Authorization** — `role ∈ {admin, member}`. Admins hold the `*` capability; members hold `graph:read`, `catalog:read`, `graph:write`, `agents:read`, `agents:run` (`capabilitiesForRole` in `routes/auth.ts`). Routes check `requireAdmin` or `requireCapability('…')`; raw Cypher (`POST /api/query`, `graph_query`) needs `admin` or `graph:query`.
- **Request context** — every request is annotated with a `RequestContext` (`packages/shared/src/auth/request-context.ts`) carrying principal, role and capabilities. There is **no per-tenant read isolation**: an authenticated user sees every org, connector and entity; the connector is the per-org view (decision `no-tenant-read-isolation-authenticated-sees-all`).
- **`require-auth` resolution order**:
  1. Setup mode → only the setup allow-list answers, as the synthesized `setup` admin.
  2. `auth.enabled === false` → dev-fallback principal.
  3. Public path allow-list (`/api/health`, `/api/auth/{providers,login/*,callback/*,logout}`, `/api/mcp/info`, `/api/webhooks/github`).
  4. `Authorization: Bearer <token>` → token path (`TokenService.validate`).
  5. `request.session.principal` set by an earlier OIDC/GitHub callback.
  6. Otherwise `401`.

## API Server

Fastify 5 with a global rate limit via `@fastify/rate-limit` (200 req/min per IP by default; stricter on expensive routes) and `@fastify/swagger` registered for route metadata (no documentation UI route is mounted). Every request passes through the `registerRequireAuth` preHandler — see [Access Control & Identity](#access-control--identity). CORS allows the origins in `accessControl.web.allowedOrigins` with credentials when auth is on, and any origin when it is off.

Route prefixes (registered in `packages/api-server/src/server.ts`; the full inventory is [api-reference.md](api-reference.md)):

- `/api/health` — Liveness, mode (`setup` / `active`) and uptime
- `/api/setup` — First-boot wizard
- `/api/auth` — Providers list, login start, OIDC + GitHub callbacks, `/me`, logout
- `/api/tokens` — Personal access tokens _(only when auth is enforced)_
- `/api/connectors` — Connector CRUD, probe, sync, run history, GitHub App manifest flow and installations, Kubernetes credentials; `/:id/containers` lists and selects what a knowledge connector indexes. Reading is open to every signed-in user; every mutation needs an admin
- `/api/schema` — Schema read/write with ETag locking, validate, diff, migration preview, history, rollback
- `/api/graph` — Stats, neighborhood, search _(requires Neo4j)_
- `/api/query` — Raw read-only Cypher for administrators _(requires Neo4j)_
- `/api/claims`, `/api/conflicts`, `/api/relations` — PropertyClaim inspection, manual edits and verification, conflict review, relationship edits _(require Neo4j)_
- `/api/teams` — Team detail, members, owned entities _(requires Neo4j)_
- `/api/reconciliation` — Candidate scan and review _(requires Neo4j)_
- `/api/incident-events` — Incident-mode dashboard view log
- `/api/mcp` — MCP server metadata for the in-app `/ai/mcp` page
- `/api/config` — Scrubbed configuration export for the next deployment seed (admin)
- `/api/settings` — Portal settings: webhook secret, OAuth client, admins, allow-list (admin)
- `/api/feedback` — The in-app "Report a problem" widget ([ADR-031](adrs/ADR-031-feedback-widget-service-identity.md))
- `/api/ai`, `/api/agents`, `/api/runs` — Model catalog and platform status; agent definitions; runs with their message log, event stream (SSE) and cancel
- `/api/knowledge` — Knowledge layer status
- `/api/webhooks` — GitHub webhook receiver

At boot the api-server hydrates secrets (from files or Google Secret Manager, before the configuration loads — [ADR-025](adrs/ADR-025-secrets-in-google-secret-manager.md)), loads the configuration, decides on setup mode, and wires the `ConnectorRegistry`, `SchemaService`, the GitHub App services, the optional `Neo4jService` (routes that need Neo4j are skipped without it), the token, settings and feedback services, the sync and knowledge schedulers, the webhook refetch queue, the audit-retention job, and — with a database — the agent and knowledge stores and the run queue.

## MCP Server

The MCP server connects to Neo4j directly (read-only, `defaultAccessMode: READ`) and exposes 8 tools via the Model Context Protocol. It supports two transports: **Streamable HTTP** (the default; `/mcp` on port 3002, every request authenticated with a personal access token carrying `mcp:invoke`, [ADR-028](adrs/ADR-028-mcp-token-auth.md)) and **stdio** (`MCP_TRANSPORT=stdio`, no token — whoever can start the process can read the graph). All responses are wrapped in a standard envelope with metadata (`_meta`) including query time, data quality indicators, and suggested follow-up queries.

The 8 tools — `blast_radius`, `entity_detail`, `schema_info`, `find_owners`, `dependency_chain`, `graph_stats`, `search_entities`, `graph_query` — are declared in `packages/mcp-server/src/tools/metadata.ts` (a pure data module; [ADR-022](adrs/ADR-022-claude-code-plugin-and-tool-metadata.md)). The same registry serves the in-app agents, which get the first seven: `graph_query` is marked `agents: false`.

`graph_query` and the Query Playground (`POST /api/query`) share one read-only guard ([ADR-036](adrs/ADR-036-raw-cypher-read-only-check-and-executor.md)): a text check in `@shipit-ai/shared` (writing, schema and administration clauses refused; procedures and namespaced functions allowed by name; internal `_` labels refused; one ASCII statement of at most 100,000 characters) in front of an executor that runs the query in a read-access transaction that is always rolled back, with a timeout, a row limit that no `LIMIT` in the query can raise, a value limit, four queries at a time per process, and internal nodes withheld from results. Over HTTP the tool additionally needs the `graph:query` scope, every variable-length pattern needs an explicit upper bound within `hopLimit`, and each token owner has a daily budget counted per process. The limits are `backend.mcp.rateLimits.*` in `shipit.config.yaml`; the reference is [mcp-tools.md](mcp-tools.md).

## Agent Platform

User-defined agents (ADR-034) live in Postgres: definitions, runs, messages, tool calls and token usage, in a schema applied from the forward-only SQL files in `db/migrations/` by the `@shipit-ai/agents` CLI (`pnpm db:migrate`, the compose `migrate` service, or the infrastructure repository's deploy hook) — never at application boot. The api-server validates and queues a run on the BullMQ queue `shipit-agent-runs`; the **agent-runner** process works it: it calls the chosen model on Vertex AI (authenticated by application-default credentials locally and Workload Identity on GKE; the catalog is `ai.models`, the ceilings `ai.limits`), runs the graph tools the agent is granted, records every step, and heartbeats to Redis so `GET /api/ai/status` can show whether a runner is up. Clients follow a run over `GET /api/runs/:id/stream` (server-sent events) and continue a chat with `POST /api/runs/:id/messages`. On its first boot with a database the api-server creates a built-in **Graph assistant**.

The AI section of the web UI is ahead of its backend wiring: **AI → Ask** is a mocked preview, and the Agents, Workflows, Activity and Tools pages are placeholders; **AI → MCP Access** is live. The builder UI is the next milestone of `docs/agent/plans/ai-agents-and-workflows.md`.

## Knowledge Layer

Knowledge connectors (ADR-035) do not add resources to the graph. They produce documents, which the api-server's `KnowledgeSyncScheduler` fetches on its own BullMQ queue and stores in Postgres through a redacting sink (`@shipit-ai/knowledge`). The first and so far only source is the **GitHub connector's text facet** — pull requests, issues and Markdown docs of the repositories an administrator selects through `/api/connectors/:id/containers`; the Slack, Confluence and Jira sources of the design are not built yet, and neither are the graph suggestions it describes (`/api/knowledge` has only `GET /status`). The **knowledge-worker** claims pending documents straight from Postgres, chunks and embeds them through Vertex AI (`gemini-embedding-2`, 768 dimensions, pgvector `halfvec`), and writes the chunks back. The layer is off in the committed configuration (`knowledge.enabled: false`) until its first release. Design: `docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`.

## Web UI

Next.js 16 (App Router) on React 19. The visual layer is the in-house **`@ship-it-ui/*`** design system — `tokens`, `ui`, `shipit`, `icons`, `cytoscape`, `graph-editor`, `next` (see [ADR-013](adrs/ADR-013-web-design-system.md)). Notable libraries:

- **Cytoscape.js** for the interactive graph viewer (`components/graph/graph-canvas.tsx`)
- **`@xyflow/react`** (React Flow) for the schema editor canvas (`components/schema/schema-canvas.tsx`)
- **Zustand** for client-side state
- **TanStack React Query** for data fetching against the API server
- **Tailwind CSS 4** for utility styling, layered over `@ship-it-ui/tokens`
- **Next.js middleware** (`src/middleware.ts`) for layout-level 401 redirects when auth is enabled

The sidebar: **Explore** (Graph Explorer; Query Playground, administrators only) · **AI** (Ask, MCP Access, and the agent pages) · **Catalog** (Entities, Team Dashboard) · **Configure** (Connector Hub, Schema Editor) · **Operations** (Incident Mode, Claim Explorer, Reconciliation) · **Admin** (Audit Log, Access Control, Settings) — plus `/login`, `/setup` and `/profile`.

The web-ui depends on `@shipit-ai/shared` (canonical types) and `@shipit-ai/mcp-server` (tool metadata for the `/ai/mcp` page). All backend communication goes over HTTP to the api-server with `credentials: 'include'`, so the session cookie travels with every request. The API URL is `frontend.api.url`, baked into the bundle at build time as `NEXT_PUBLIC_SHIPIT_API_URL` (`/api` on a single-origin deployment).

## Configuration

Every backend process reads the same two files through `loadConfig()` in `@shipit-ai/shared`: the committed `shipit.config.yaml` and, merged on top, the gitignored `shipit.config.local.yaml`, found by walking up from the working directory or named by `SHIPIT_CONFIG`. After the merge, `${ENV_VAR}` and `${ENV_VAR:-default}` placeholders are substituted — a placeholder without a fallback and without a value fails the boot — and the result is validated with Zod. Top-level sections: `backend` (Neo4j, Redis, API, schema path, Cypher limits, reconciliation threshold, MCP limits), `secrets` (the registry of every logical secret and where it lives, [ADR-025](adrs/ADR-025-secrets-in-google-secret-manager.md)), `connectors` (the GitHub App and the connector instances), `feedback`, `ai`, `knowledge`, `frontend` and `accessControl` ([ADR-014](adrs/ADR-014-layered-local-configuration.md), [ADR-024](adrs/ADR-024-runtime-config-persistence.md)).

## Deployment

Docker Compose runs the whole stack for development; the hosted instance runs on GKE, with images built and deployed by the private infrastructure repository ([ADR-023](adrs/ADR-023-hosting-on-gke-images-built-by-infra.md)). See [deployment.md](deployment.md).
