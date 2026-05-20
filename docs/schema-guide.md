# Schema Guide

ShipIt-AI uses a YAML schema to define the node types, relationships, and resolution strategies in your knowledge graph. The schema is stored in Neo4j and managed via the API.

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

resolution_defaults:
  owner: HIGHEST_CONFIDENCE
  tier: MANUAL_OVERRIDE_FIRST
  status: LATEST_TIMESTAMP
  tags: MERGE_SET
  name: HIGHEST_CONFIDENCE
```

## Schema Modes

| Mode     | Description                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `full`   | All 12 node types and 16+ relationship types. For organizations with complex service architectures.     |
| `simple` | Reduced set focused on LogicalService, Repository, Team, and Person. For smaller teams getting started. |

See [ADR-011](adrs/ADR-011-service-model-simple-mode.md) for the design rationale.

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
| `OWNS`               | Team           | LogicalService | 1:N         | Team owns this service                      |
| `MEMBER_OF`          | Person         | Team           | N:M         | Person belongs to this team                 |
| `CONTRIBUTES_TO`     | Person         | Repository     | N:M         | Person contributes to this repo             |
| `RUNS_IN`            | Deployment     | Namespace      | N:1         | Deployment runs in this namespace           |
| `PART_OF`            | Namespace      | Cluster        | N:1         | Namespace is part of this cluster           |
| `BUILT_BY`           | LogicalService | Pipeline       | 1:N         | Service is built by this pipeline           |
| `TRIGGERS`           | Pipeline       | Pipeline       | N:M         | Pipeline triggers another                   |
| `MONITORS`           | Monitor        | LogicalService | N:M         | Monitor watches this service                |
| `CODEOWNER_OF`       | Person         | Repository     | N:M         | Person is a code owner                      |
| `ON_CALL_FOR`        | Person         | LogicalService | N:M         | Person is on-call for this service          |

## Resolution Strategies

When multiple connectors report different values for the same property, the resolution strategy determines which value becomes the "effective" value on the node.

### `HIGHEST_CONFIDENCE`

The claim with the highest effective confidence wins. Confidence decays over time:

```
effective_confidence = max(0, base_confidence - 0.01 * weeks_since_ingestion)
```

Ties are broken by most recent ingestion timestamp.

### `MANUAL_OVERRIDE_FIRST`

Claims from manual sources (source starts with `manual:`) always win. If no manual claims exist, falls back to `HIGHEST_CONFIDENCE`.

### `AUTHORITATIVE_ORDER`

Source systems are ranked in a fixed priority order:

```
manual > backstage > github > kubernetes > datadog > jira > identity
```

The claim from the highest-priority source wins.

### `LATEST_TIMESTAMP`

The most recently ingested claim wins, regardless of source or confidence.

### `MERGE_SET`

All values from all claims are merged into a single array (union). Best for properties like `tags` or `topics` where values from multiple sources should be combined.

## Managing the Schema

### View current schema

```bash
curl http://localhost:3001/api/schema
```

### Update schema

```bash
curl -X PUT http://localhost:3001/api/schema \
  -H 'Content-Type: text/yaml' \
  --data-binary @shipit-schema.yaml
```

### Validate without persisting

```bash
curl -X POST http://localhost:3001/api/schema/validate \
  -H 'Content-Type: text/yaml' \
  --data-binary @shipit-schema.yaml
```

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

After updating the schema via the API, connectors can begin emitting entities with the new types.
