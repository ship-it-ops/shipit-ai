# API Reference

The ShipIt-AI API Server is built on Fastify 4 with OpenAPI documentation via `@fastify/swagger`. By default it runs on port `3001`.

Base URL: `http://localhost:3001`

## Health

### `GET /api/health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 3600
}
```

## Connectors

### `GET /api/connectors`

List all registered connectors.

**Response:**

```json
[
  {
    "id": "github-main",
    "type": "github",
    "name": "GitHub - My Org",
    "config": { "org": "acme-corp" },
    "enabled": true
  }
]
```

---

### `POST /api/connectors`

Register a new connector.

**Request Body:**

```json
{
  "id": "github-main",
  "type": "github",
  "name": "GitHub - My Org",
  "config": { "org": "acme-corp" },
  "enabled": true
}
```

**Response:** `201 Created`

```json
{
  "id": "github-main",
  "type": "github",
  "name": "GitHub - My Org",
  "config": { "org": "acme-corp" },
  "enabled": true
}
```

---

### `GET /api/connectors/:id`

Get a connector by ID.

**Response:**

```json
{
  "id": "github-main",
  "type": "github",
  "name": "GitHub - My Org",
  "config": { "org": "acme-corp" },
  "enabled": true
}
```

---

### `POST /api/connectors/:id/sync`

Trigger a sync for a connector.

**Request Body:**

```json
{
  "mode": "full"
}
```

`mode` is optional — accepts `"full"` or `"incremental"`.

**Response:**

```json
{
  "status": "started",
  "connector_id": "github-main",
  "mode": "full"
}
```

---

### `GET /api/connectors/:id/status`

Get the sync status of a connector.

**Response:**

```json
{
  "connector_id": "github-main",
  "state": "IDLE",
  "last_sync": {
    "status": "success",
    "entities_synced": 150,
    "errors": [],
    "duration_ms": 4500,
    "completed_at": "2026-02-28T12:00:00Z"
  }
}
```

---

### `DELETE /api/connectors/:id`

Remove a connector.

**Response:** `204 No Content`

## Schema

### `GET /api/schema`

Get the current graph schema.

**Response:**

```json
{
  "version": "1.0",
  "mode": "full",
  "node_types": {
    "LogicalService": {
      "description": "A named, team-owned service concept",
      "constraints": { "unique_key": "name" },
      "properties": {
        "name": { "type": "string", "required": true, "resolution_strategy": "HIGHEST_CONFIDENCE" },
        "tier": { "type": "integer", "resolution_strategy": "MANUAL_OVERRIDE_FIRST" },
        "owner": { "type": "string", "resolution_strategy": "HIGHEST_CONFIDENCE" }
      }
    }
  },
  "relationship_types": {
    "DEPENDS_ON": {
      "from": "LogicalService",
      "to": "LogicalService",
      "cardinality": "N:M"
    }
  }
}
```

---

### `PUT /api/schema`

Update the graph schema. Accepts YAML as the request body.

**Content-Type:** `text/yaml`, `text/plain`, or `application/x-yaml`

**Request Body:**

```yaml
version: '1.0'
mode: full
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
```

**Response:** `200 OK` with the parsed schema as JSON.

---

### `POST /api/schema/validate`

Validate a schema without persisting it.

**Content-Type:** `text/yaml`, `text/plain`, or `application/x-yaml`

**Request Body:** YAML schema string (same format as PUT).

**Response:**

```json
{
  "valid": true
}
```

On validation failure:

```json
{
  "valid": false,
  "errors": ["node_types.Foo: missing required field 'description'"]
}
```

## Graph

Graph endpoints are available when the API server is connected to Neo4j.

### `GET /api/graph/stats`

Get aggregate graph statistics.

**Response:**

```json
{
  "node_counts_by_label": {
    "LogicalService": 15,
    "Repository": 42,
    "Team": 8,
    "Person": 25
  },
  "edge_counts_by_type": {
    "IMPLEMENTED_BY": 15,
    "DEPENDS_ON": 30,
    "MEMBER_OF": 25,
    "OWNS": 15
  },
  "total_nodes": 200,
  "total_edges": 350
}
```

---

### `GET /api/graph/neighborhood/:id`

Get the neighborhood subgraph around an entity.

**Path Parameters:**

| Parameter | Type   | Description                       |
| --------- | ------ | --------------------------------- |
| `id`      | string | Entity canonical ID (URL-encoded) |

**Query Parameters:**

| Parameter | Type    | Default | Description             |
| --------- | ------- | ------- | ----------------------- |
| `depth`   | integer | 1       | Traversal depth (max 5) |

**Response:**

```json
{
  "center": { "id": "shipit://logicalservice/default/config-service", "label": "LogicalService", "properties": {} },
  "nodes": [...],
  "edges": [...]
}
```

---

### `GET /api/graph/search`

Search entities in the graph.

**Query Parameters:**

| Parameter | Type    | Description              |
| --------- | ------- | ------------------------ |
| `label`   | string  | Filter by node label     |
| `q`       | string  | Text search query        |
| `tier`    | integer | Filter by tier           |
| `owner`   | string  | Filter by owner          |
| `limit`   | integer | Max results (default 25) |

**Response:**

```json
{
  "entities": [
    {
      "id": "shipit://logicalservice/default/config-service",
      "label": "LogicalService",
      "properties": { "name": "config-service", "tier": 1, "owner": "platform-team" }
    }
  ],
  "total": 15,
  "returned": 15
}
```

## Configuration

| Environment Variable       | Default                  | Description                 |
| -------------------------- | ------------------------ | --------------------------- |
| `API_SERVER_PORT` / `PORT` | `3001`                   | Server port                 |
| `NEO4J_URI`                | `bolt://localhost:7687`  | Neo4j connection URI        |
| `NEO4J_USER`               | `neo4j`                  | Neo4j username              |
| `NEO4J_PASSWORD`           | —                        | Neo4j password              |
| `REDIS_URL`                | `redis://localhost:6379` | Redis connection URL        |
| `SCHEMA_PATH`              | `./shipit-schema.yaml`   | Path to default schema file |
