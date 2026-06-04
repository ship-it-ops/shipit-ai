# Architecture

## System Overview

ShipIt-AI is a TypeScript monorepo that builds and maintains a knowledge graph of your software ecosystem. Data flows in one direction: connectors pull from external sources, normalize into canonical entities, publish through an event bus, and a single Core Writer merges everything into Neo4j with conflict resolution.

```
External Sources           Event Bus              Graph              Consumers
┌──────────┐          ┌──────────────┐      ┌──────────┐      ┌──────────────┐
│  GitHub   │──┐      │              │      │          │      │  MCP Server  │
├──────────┤  │      │   BullMQ     │      │  Neo4j   │      ├──────────────┤
│  K8s     │──┼──▶   │   Redis      │──▶   │  5.x     │──▶   │  API Server  │
├──────────┤  │      │   Streams    │      │          │      ├──────────────┤
│ Custom   │──┘      │              │      │          │      │   Web UI     │
└──────────┘          └──────────────┘      └──────────┘      └──────────────┘
                      Connector SDK           Core Writer         Fastify/MCP/Next.js
```

## Package Dependency Graph

```
@shipit-ai/shared                    (no internal deps)
    │
    ├── @shipit-ai/event-bus
    │       │
    │       ├── @shipit-ai/core-writer
    │       │
    │       └── @shipit-ai/connector-sdk
    │               │
    │               ├── @shipit-ai/connector-github       (packages/connectors/github)
    │               └── @shipit-ai/connector-kubernetes   (packages/connectors/kubernetes)
    │
    ├── @shipit-ai/mcp-server
    │
    ├── @shipit-ai/api-server
    │       depends on: shared, event-bus, connector-sdk,
    │                   connector-github, mcp-server
    │
    └── @shipit-ai/web-ui
            depends on: shared, mcp-server
            (talks to api-server over HTTP at runtime)
```

All internal dependencies use `workspace:*` protocol via pnpm workspaces.

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

Supporting node types (Team, Person, Environment, Pipeline, Monitor, Namespace, Cluster) connect to the core four via relationships like `OWNS`, `MEMBER_OF`, `RUNS_IN_ENV`, `BUILT_BY`, and `MONITORS`.

## Data Flow

### 1. Connector → Event Bus

Connectors implement the `ShipItConnector` interface:

```
authenticate() → discover() → fetch() → normalize() → sync()
```

The `ConnectorHarness` wraps connectors and handles:

- Sync state management (IDLE → SYNCING → COMPLETING → IDLE/FAILED/DEGRADED)
- Batch publishing to the event bus (default batch size: 100)
- Error handling and state transitions

Each entity is normalized into a `CanonicalEntity` containing `CanonicalNode[]` and `CanonicalEdge[]`.

### 2. Event Bus

Events are published as `EventEnvelope` messages:

```typescript
{
  id: string,              // UUID
  timestamp: string,       // ISO 8601
  connector_id: string,
  idempotency_key: string, // {connector_id}:{entity_key}:{event_version}
  payload: CanonicalEntity
}
```

The event bus uses BullMQ queues for processing and Redis Streams for replay support. Events are retained for 7 days by default.

### 3. Core Writer → Neo4j

The Core Writer is the **sole writer** to Neo4j. For each event it:

1. **Idempotency check** — Skips duplicate events using `_IdempotencyLog` nodes (TTL: 30 days)
2. **Identity reconciliation** — Matches incoming entities to existing nodes:
   - Step 1: Primary Key match (canonical ID)
   - Step 2: Linking Key match (source-specific ID like `github://org/repo`)
   - Step 3: Create new entity if no match
3. **Claim resolution** — Merges PropertyClaims and resolves effective values per the configured strategy
4. **Node merge** — `MERGE` node by label + canonical ID, `SET` resolved properties and serialized `_claims` JSON
5. **Edge merge** — `MATCH` source/target nodes, `MERGE` relationship with metadata

Batching: Events are buffered and flushed at 500 events or every 5 seconds.

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

| Strategy                | Behavior                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `HIGHEST_CONFIDENCE`    | Effective confidence (with time decay) wins; tiebreak by recency                      |
| `MANUAL_OVERRIDE_FIRST` | Manual claims always win; fallback to `HIGHEST_CONFIDENCE`                            |
| `AUTHORITATIVE_ORDER`   | Source priority: manual > backstage > github > kubernetes > datadog > jira > identity |
| `LATEST_TIMESTAMP`      | Most recently ingested value wins                                                     |
| `MERGE_SET`             | Union all values into an array (for tags, labels)                                     |

Confidence decays over time: `effective = max(0, base - 0.01 * weeks_since_ingestion)`.

Claims are stored as a JSON `_claims` array on each node (see [ADR-002](adrs/ADR-002-propertyclaim-storage.md)), reducing write operations from ~45 to ~2 per entity update.

## Identity Reconciliation

Entities are identified across sources using a two-step ladder (Phase 1):

1. **Primary Key** — Canonical ID (`shipit://label/namespace/name`). Exact match.
2. **Linking Key** — Source-specific ID (e.g., `github://acme-corp/config-service`, `k8s://prod-cluster/default/config-svc`). Stored as `_LinkingKey` nodes in Neo4j.

Phase 2 will add fuzzy matching for entities that can't be linked by exact keys.

### Canonical ID Format

```
shipit://{label}/{namespace}/{name}
```

For entities owned by a multi-tenant source (e.g., GitHub orgs), `{name}` is
scoped by the owning tenant to avoid silent cross-tenant collisions:

```
shipit://{label}/{namespace}/{scope}/{name}
```

Examples:

- `shipit://repository/default/acme-corp/config-service`
- `shipit://team/default/acme-corp/platform-team`
- `shipit://pipeline/default/acme-corp/config-service-ci`
- `shipit://deployment/production/config-svc-prod`
- `shipit://person/default/alice` _(unscoped — GitHub logins are globally unique)_

## Access Control & Identity

Authentication and request-context plumbing for the API Server is governed by the top-level `accessControl:` block in `shipit.config.yaml` and lives in `packages/api-server/src/middleware/require-auth.ts` plus `packages/api-server/src/services/auth/`.

- **Master flag** — `accessControl.auth.enabled`. When **off** (the local-dev default), every request is admitted and a principal is synthesized from `frontend.devUser` (role `admin`). When **on**, the auth boundary runs the resolution order below.
- **Identity providers** — `OidcProvider` (any OIDC-compliant IdP) and `GitHubProvider` (GitHub OAuth). Each can be independently enabled under `accessControl.auth.providers.{oidc,github}`. At least one must be enabled when `auth.enabled` is true, or the server fails closed at boot.
- **Sessions** — cookie-backed via `@fastify/session` + `@fastify/cookie`, persisted in Redis via `RedisSessionStore`. Cookie security is forced to `secure: true` in production regardless of the configured value.
- **Personal access tokens** — `Authorization: Bearer …` tokens stored as `_AccessToken` nodes in Neo4j by `TokenService`. Issued one-time-plaintext from the Settings → API Keys tab in the web UI; validated by the same `require-auth` middleware. The `/api/tokens` route is only mounted when auth is enabled.
- **Authorization** — `role ∈ {admin, member}` is resolved from `accessControl.auth.admins[]` (admin allow-list). A capability set is derived per request by `buildCapabilitySet` (admins get the wildcard, members get a read-only set).
- **Request context** — every authenticated request is annotated with a `RequestContext` (`packages/shared/src/auth/request-context.ts`) that carries principal, role, capabilities, and tenant `org`. This is threaded into `Neo4jService` methods so graph queries can be scoped by org (work-in-progress — see open question `tenant-to-source-org-mapping`).
- **`require-auth` resolution order**:
  1. `auth.enabled === false` → dev-fallback principal.
  2. Public path allow-list (`/api/health`, `/api/auth/{providers,login/*,callback/*,logout}`, `/api/mcp/info`).
  3. `Authorization: Bearer <token>` → token path (`TokenService.validate`).
  4. `request.session.principal` set by an earlier OIDC/GitHub callback.
  5. Otherwise `401`.

## MCP Server

The MCP Server connects to Neo4j directly (read-only, `defaultAccessMode: READ`) and exposes 8 tools via the Model Context Protocol. It supports both **stdio** and **Streamable HTTP** transports; `MCP_TRANSPORT` selects the active transport and defaults to `http`. All responses are wrapped in a standard envelope with metadata (`_meta`) including query time, data quality indicators, and suggested follow-up queries.

The 8 tools — `blast_radius`, `entity_detail`, `schema_info`, `find_owners`, `dependency_chain`, `graph_stats`, `search_entities`, `graph_query` — are declared in `packages/mcp-server/src/tools/metadata.ts` (a pure data module; see decision `mcp-tool-metadata-as-pure-data-module`).

Guardrails for the `graph_query` tool (configured under `backend.mcp.rateLimits` in `shipit.config.yaml`):

- Write operations are rejected
- Variable-length patterns are limited to 6 hops (`hopLimit`)
- Results are capped at 1000 rows (`rowLimit`); a `LIMIT` clause is appended if the caller didn't supply one
- Queries timeout after 10 seconds (`queryTimeoutMs`)
- Configurable daily call quota (`graphQueryPerDay`, default 100)

## API Server

Fastify 5 with OpenAPI documentation via `@fastify/swagger` and a global rate limit via `@fastify/rate-limit` (200 req/min per IP by default). Every request passes through the `registerRequireAuth` preHandler — see [Access Control & Identity](#access-control--identity).

Route prefixes (registered in `packages/api-server/src/server.ts`):

- `/api/health` — Liveness check
- `/api/auth` — Auth flow: providers list, login start, OIDC + GitHub callbacks, `/me`, logout
- `/api/tokens` — Personal access tokens _(only when `accessControl.auth.enabled`)_
- `/api/connectors` — Connector CRUD, sync triggers, run history
- `/api/schema` — Schema management (YAML)
- `/api/graph` — Graph queries: stats, neighborhood, search _(requires Neo4j)_
- `/api/query` — Saved/ad-hoc Cypher queries _(requires Neo4j)_
- `/api/claims`, `/api/conflicts` — PropertyClaim inspection and conflict review _(requires Neo4j)_
- `/api/teams` — Team detail, members, owned entities _(requires Neo4j)_
- `/api/reconciliation` — Reconciliation candidates and review _(requires Neo4j)_
- `/api/incident-events` — Incident-mode dashboard view log (no Neo4j dependency)
- `/api/mcp` — MCP server metadata for the in-app `/configure/mcp` page

The api-server also bootstraps the connector registry (`ConnectorRegistry`), schema service (`SchemaService`), optional GitHub App services (`GitHubAppService`, `GitHubAppManifestService`), and the optional `Neo4jService`. Routes that need Neo4j are skipped when no Neo4j service is injected, which keeps the server usable in offline / pre-bootstrap modes.

## Web UI

Next.js 16 (App Router) on React 19. The visual layer is the in-house **`@ship-it-ui/*`** design system — `tokens`, `ui`, `shipit`, `icons`, `cytoscape`, `graph-editor`, `next` (see [ADR-013](adrs/ADR-013-web-design-system.md)). Notable libraries:

- **Cytoscape.js** for the interactive graph viewer (`components/graph/graph-canvas.tsx`)
- **`@xyflow/react`** (React Flow) for the schema editor canvas (`components/schema/schema-canvas.tsx`)
- **Zustand** for client-side state
- **TanStack React Query** for data fetching against the API server
- **Tailwind CSS 4** for utility styling, layered over `@ship-it-ui/tokens`
- **Next.js middleware** (`src/middleware.ts`) for layout-level 401 redirects when auth is enabled

The web-ui depends on `@shipit-ai/shared` (for canonical types) and `@shipit-ai/mcp-server` (for MCP tool metadata surfaced on the `/configure/mcp` page). All other backend communication goes through HTTP to the api-server, with `credentials: 'include'` so the session cookie travels with every request.
