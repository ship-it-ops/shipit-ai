# Schema Guide

ShipIt-AI uses a YAML schema to define the node types, relationship types and resolution strategies of your knowledge graph. The schema is a file on the API server (`backend.schema.path` in `shipit.config.yaml`, `./config/shipit-schema.yaml` by default); the API server keeps a version history next to it and serves it over `/api/schema`. The web UI edits the same schema on a canvas at `/configure/schema`.

## Schema File Format

```yaml
version: '1.0'
mode: full # or "simple"

node_types:
  LogicalService:
    description: A named, team-owned service concept
    constraints:
      unique_key: name
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      tier:
        type: integer
        resolution_strategy: MANUAL_OVERRIDE_FIRST
      owner:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      # ... more properties

relationship_types:
  IMPLEMENTED_BY:
    from: LogicalService
    to: Repository
    cardinality: '1:N'
    description: LogicalService is implemented by this repository
  OWNS:
    from: Team
    to: LogicalService
    cardinality: '1:N'
    semantics: ownership # see "Ownership semantics" below

resolution_defaults:
  owner: HIGHEST_CONFIDENCE
  tier: MANUAL_OVERRIDE_FIRST
  status: LATEST_TIMESTAMP
  tags: MERGE_SET
  name: HIGHEST_CONFIDENCE
```

The committed default is [`config/shipit-schema.yaml`](../config/shipit-schema.yaml). The parser and validator live in `packages/shared/src/schema/`.

## Schema Modes

| Mode     | Description                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`   | The four-node service model with all 12 node types and 18 relationship types. What every connector, tool and page is built for today.                                                                                         |
| `simple` | Accepted by the validator but **not implemented**: nothing reads `mode` yet. [ADR-011](adrs/ADR-011-service-model-simple-mode.md) describes the intent — one `Service` node in place of the four — for smaller organizations. |

## Node Types

| Node Type        | Description                          | Unique Key | Key Properties                                                    |
| ---------------- | ------------------------------------ | ---------- | ----------------------------------------------------------------- |
| `LogicalService` | A named, team-owned service concept  | `name`     | name, tier, owner, lifecycle, language, domain, tags, description |
| `Repository`     | A source code repository             | `name`     | name, url, default_branch, visibility, language, topics           |
| `Deployment`     | A running instance in an environment | `name`     | name, namespace, cluster, environment, image, replicas, status    |
| `RuntimeService` | Identity seen by observability tools | `name`     | name, dd_service, apm_name, environment                           |
| `BuildArtifact`  | A built container image or binary    | `name`     | name, image_tag, sha, registry                                    |
| `Environment`    | A deployment target                  | `name`     | name, type, region, classification                                |
| `Team`           | An engineering team or squad         | `name`     | name, slug, description                                           |
| `Person`         | An individual                        | `email`    | name, email, github_handle, role                                  |
| `Pipeline`       | A CI/CD workflow                     | `name`     | name, trigger, status, last_run                                   |
| `Monitor`        | An observability check               | `name`     | name, type, query, status, threshold                              |
| `Namespace`      | A Kubernetes namespace               | `name`     | name, cluster, labels                                             |
| `Cluster`        | A Kubernetes cluster                 | `name`     | name, provider, region, version                                   |

Which connector fills which type: the GitHub connector emits `Repository`, `Team`, `Person` and `Pipeline`; the Kubernetes connector emits `Cluster`, `Namespace`, `Environment`, `Deployment`, `BuildArtifact` and `LogicalService`; a login upserts the signed-in user's `Person`. See [connectors.md](connectors.md).

### Property Types

- `string` — Text value
- `integer` — Whole number
- `boolean` — True/false
- `string[]` — Array of strings (use `MERGE_SET` resolution)

### Enums

Some properties accept a fixed set of values:

- `LogicalService.lifecycle`: `experimental`, `production`, `deprecated`, `decommissioned`
- `Repository.visibility`: `public`, `private`, `internal`
- `Environment.type`: `development`, `staging`, `production`

### Internal nodes and properties

Labels that start with an underscore (`_AccessToken`, `_IdempotencyLog`, `_LinkingKey`, …) are the application's own records. They are withheld from the catalog, the graph explorer, the MCP tools and the Query Playground. Properties that start with an underscore (`_claims`, `_source_system`, `_source_connector_id`, `_last_synced`, `_absent_since`, …) are written by the core-writer, not by the schema. Do not name your own labels or properties this way.

## Relationship Types

| Relationship         | From           | To             | Cardinality | Description                                 |
| -------------------- | -------------- | -------------- | ----------- | ------------------------------------------- |
| `IMPLEMENTED_BY`     | LogicalService | Repository     | 1:N         | Service is implemented by this repo         |
| `DEPLOYED_AS`        | LogicalService | Deployment     | 1:N         | Service has this deployment                 |
| `EMITS_TELEMETRY_AS` | Deployment     | RuntimeService | N:M         | Deployment observed as this runtime service |
| `BUILT_FROM`         | BuildArtifact  | Repository     | N:1         | Artifact built from this repo               |
| `RUNS_IMAGE`         | Deployment     | BuildArtifact  | N:1         | Deployment runs this image                  |
| `RUNS_IN_ENV`        | Deployment     | Environment    | N:1         | Deployment runs in this environment         |
| `DEPENDS_ON`         | LogicalService | LogicalService | N:M         | Service dependency                          |
| `CALLS`              | RuntimeService | RuntimeService | N:M         | Runtime call relationship                   |
| `OWNS`               | Team           | LogicalService | 1:N         | Team owns this service _(ownership)_        |
| `MEMBER_OF`          | Person         | Team           | N:M         | Person belongs to this team                 |
| `CONTRIBUTES_TO`     | Person         | Repository     | N:M         | Person contributes to this repo             |
| `RUNS_IN`            | Deployment     | Namespace      | N:1         | Deployment runs in this namespace           |
| `PART_OF`            | Namespace      | Cluster        | N:1         | Namespace is part of this cluster           |
| `BUILT_BY`           | LogicalService | Pipeline       | 1:N         | Service is built by this pipeline           |
| `TRIGGERS`           | Pipeline       | Pipeline       | N:M         | Pipeline triggers another                   |
| `MONITORS`           | Monitor        | LogicalService | N:M         | Monitor watches this service                |
| `CODEOWNER_OF`       | Person         | Repository     | N:M         | Person is a code owner _(ownership)_        |
| `ON_CALL_FOR`        | Person         | LogicalService | N:M         | Person is on-call for this service          |

### Ownership semantics

A relationship type may carry `semantics: ownership`. Every ownership-class edge — `OWNS` and `CODEOWNER_OF` in the default schema — is walked by the places that answer "who owns this": the `find_owners` MCP tool, the team pages and blast-radius views in the web UI, and `/api/teams`. Mark your own ownership edges the same way instead of adding them to those consumers one by one.

Note that the GitHub connector emits `CODEOWNER_OF` from a `Team` as well as from a `Person` when a CODEOWNERS entry names a team (`@org/team`), although the default schema declares the edge from `Person` only.

## Resolution Strategies

When multiple connectors report different values for the same property, the resolution strategy determines which value becomes the "effective" value on the node. Every claim keeps its source, confidence and timestamp (`_claims` on the node, see [ADR-002](adrs/ADR-002-propertyclaim-storage.md)); resolution only decides which one is shown.

### `HIGHEST_CONFIDENCE`

The claim with the highest effective confidence wins. Confidence decays over time:

```
effective_confidence = max(0, base_confidence - 0.01 * weeks_since_ingestion)
```

Human attestations (`manual:<user>`, `verified:<user>`) do not decay. Ties are broken by most recent ingestion timestamp.

### `MANUAL_OVERRIDE_FIRST`

Claims from people always win: a `verified:<user>` claim outranks a `manual:<user>` claim, and either outranks every connector. Equally ranked human claims resolve deterministically, so the writer and the API read path agree. If no human claim exists, falls back to `HIGHEST_CONFIDENCE`.

### `AUTHORITATIVE_ORDER`

Source systems are ranked in a fixed priority order (`SOURCE_PRIORITY_ORDER` in `packages/shared/src/config/source-reliability.ts`):

```
verified > manual > backstage > github > login > kubernetes > datadog > jira > identity
```

The claim from the highest-priority source wins. A source that is not in the list ranks last.

### `LATEST_TIMESTAMP`

The most recently ingested claim wins, regardless of source or confidence.

### `MERGE_SET`

All values from all claims are merged into a single array (union). Best for properties like `tags` or `topics` where values from multiple sources should be combined.

## Source Reliability and Per-field Confidence

Connectors no longer hard-code a confidence per claim. A claim's base confidence comes from one registry, `SOURCE_RELIABILITY` in `packages/shared/src/config/source-reliability.ts`:

| Source       | Base reliability | Independence group | Decays |
| ------------ | ---------------- | ------------------ | ------ |
| `verified`   | 0.99             | human              | no     |
| `manual`     | 0.95             | human              | no     |
| `github`     | 0.90             | scm                | yes    |
| `backstage`  | 0.85             | catalog (from scm) | yes    |
| `login`      | 0.85             | scm (from github)  | yes    |
| `kubernetes` | 0.85             | runtime            | yes    |
| `datadog`    | 0.85             | apm                | yes    |
| `identity`   | 0.85             | idp                | yes    |
| `jira`       | 0.80             | tracker            | yes    |
| _(unknown)_  | 0.70             | unknown            | yes    |

On top of resolution, each field gets a derived confidence and a verification status (`UNVERIFIED`, `CORROBORATED`, `USER_VERIFIED`, `DISPUTED`, `STALE`): independent sources that agree raise it, disagreeing sources lower it, and a person can verify a value from the catalog (a verified value that a later sync contradicts is flagged `needs_review`). Sources in the same independence group, or one that derives from another (Backstage re-imports GitHub metadata), do not count as corroboration. The engine is `packages/shared/src/utils/confidence.ts`; the design and the constants are in [ADR-029](adrs/ADR-029-per-field-confidence-and-verification.md). The catalog shows the breakdown per field, and `/api/claims` returns it.

## Managing the Schema

The schema routes need a signed-in session or a bearer token when `accessControl.auth.enabled` is on; they are not role-gated yet (schema edits are treated as an operator action). With auth off (the local default) the examples below work as written.

### View current schema

```bash
curl -i http://localhost:3001/api/schema
```

The response carries an `ETag` header. Keep it: a `PUT` must send it back as `If-Match`, so two people editing the schema at once cannot silently overwrite each other ([ADR-016](adrs/ADR-016-optimistic-concurrency-for-editable-config.md)).

### Update schema

```bash
curl -X PUT http://localhost:3001/api/schema \
  -H 'Content-Type: text/yaml' \
  -H 'If-Match: "<etag from GET>"' \
  --data-binary @config/shipit-schema.yaml
```

Every successful `PUT` writes the previous version to `schema-history/` next to the schema file.

### Validate without persisting

```bash
curl -X POST http://localhost:3001/api/schema/validate \
  -H 'Content-Type: text/yaml' \
  --data-binary @config/shipit-schema.yaml
```

### Preview, history and rollback

| Route                                | What it does                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/schema/diff`              | Diff a candidate YAML against the active schema                                                                           |
| `POST /api/schema/migration-preview` | The diff plus, per removed or changed type, how many existing nodes and edges it affects (`affected: null` without Neo4j) |
| `GET /api/schema/history`            | List saved versions                                                                                                       |
| `GET /api/schema/history/:version`   | Fetch one saved version as YAML                                                                                           |
| `POST /api/schema/rollback`          | Make a saved version the active schema (returns a new ETag)                                                               |

The web UI's schema editor (`/configure/schema`) uses the same routes: it diffs before saving, shows the migration preview, and lists history with one-click rollback.

## Customization

### Adding a custom node type

Add a new entry under `node_types` in your schema YAML:

```yaml
node_types:
  Database:
    description: A database instance
    constraints:
      unique_key: name
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      engine:
        type: string
        resolution_strategy: AUTHORITATIVE_ORDER
        enum: [postgres, mysql, redis, mongodb]
      version:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
```

### Adding a custom relationship type

```yaml
relationship_types:
  READS_FROM:
    from: LogicalService
    to: Database
    cardinality: N:M
    description: Service reads from this database
```

After updating the schema via the API, connectors can begin emitting entities with the new types. A custom connector ([connectors.md](connectors.md#building-a-custom-connector)) chooses the labels it emits; the core-writer merges any label the schema declares.
