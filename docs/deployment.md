# Deployment

ShipIt-AI ships with a Docker Compose configuration for running the full stack.

## Docker Compose Services

The compose file is at `docker/docker-compose.yml`:

| Service       | Image                                        | Ports      | Description                     |
| ------------- | -------------------------------------------- | ---------- | ------------------------------- |
| `neo4j`       | `neo4j:5-community`                          | 7474, 7687 | Knowledge graph database        |
| `redis`       | `redis:7-alpine`                             | 6379       | Event bus and queue backend     |
| `api-server`  | Built from `packages/api-server/Dockerfile`  | 3001       | REST API                        |
| `core-writer` | Built from `packages/core-writer/Dockerfile` | —          | Graph writer (no external port) |
| `mcp-server`  | Built from `packages/mcp-server/Dockerfile`  | —          | MCP tools (stdio transport)     |
| `web-ui`      | Built from `packages/web-ui/Dockerfile`      | 3000       | Dashboard                       |

### Starting the Stack

```bash
# Full stack
docker compose -f docker/docker-compose.yml up -d

# Infrastructure only (for local development)
docker compose -f docker/docker-compose.yml up -d neo4j redis

# Rebuild after code changes
docker compose -f docker/docker-compose.yml up -d --build
```

### Service Dependencies

```
neo4j (healthy) ──┬──▶ api-server ──▶ web-ui
                  ├──▶ core-writer
                  └──▶ mcp-server
redis (healthy) ──┬──▶ api-server
                  └──▶ core-writer
```

Services wait for health checks on Neo4j and Redis before starting.

## Neo4j Configuration

The Docker Compose Neo4j service includes:

- **APOC plugin** enabled (`NEO4J_PLUGINS=["apoc"]`)
- **Heap size**: 512MB initial, 1GB max
- **Init script**: `docker/neo4j/init.cypher` runs on first startup
- **Auth**: Set via `NEO4J_AUTH=neo4j/shipit-dev`

### Volumes

| Volume       | Purpose              |
| ------------ | -------------------- |
| `neo4j_data` | Graph database files |
| `neo4j_logs` | Neo4j log files      |
| `redis_data` | Redis persistence    |

### Accessing Neo4j Browser

Open http://localhost:7474 and connect with:

- URI: `bolt://localhost:7687`
- Username: `neo4j`
- Password: `shipit-dev` (or your configured password)

## Environment Variables Reference

### Core Infrastructure

| Variable         | Default                  | Used By                             | Description                  |
| ---------------- | ------------------------ | ----------------------------------- | ---------------------------- |
| `NEO4J_URI`      | `bolt://localhost:7687`  | api-server, core-writer, mcp-server | Neo4j Bolt URI               |
| `NEO4J_USER`     | `neo4j`                  | api-server, mcp-server              | Neo4j username               |
| `NEO4J_USERNAME` | `neo4j`                  | core-writer                         | Neo4j username (core-writer) |
| `NEO4J_PASSWORD` | `shipit-dev`             | all backend services                | Neo4j password               |
| `NEO4J_DATABASE` | `neo4j`                  | core-writer                         | Neo4j database name          |
| `REDIS_URL`      | `redis://localhost:6379` | api-server, core-writer             | Redis connection URL         |

### API Server

| Variable                   | Default                | Description                 |
| -------------------------- | ---------------------- | --------------------------- |
| `API_SERVER_PORT` / `PORT` | `3001`                 | HTTP port                   |
| `SCHEMA_PATH`              | `./shipit-schema.yaml` | Path to default schema YAML |

### MCP Server

| Variable                | Default  | Description                                 |
| ----------------------- | -------- | ------------------------------------------- |
| `MCP_API_KEY_SECRET`    | _(none)_ | Optional API key for authentication         |
| `MCP_GRAPH_QUERY_LIMIT` | `100`    | `graph_query` calls per day                 |
| `MCP_ROW_LIMIT`         | `1000`   | Max rows per `graph_query` result           |
| `MCP_HOP_LIMIT`         | `6`      | Max hops in variable-length Cypher patterns |
| `MCP_QUERY_TIMEOUT_MS`  | `10000`  | Query timeout in milliseconds               |

### Web UI

| Variable              | Default                 | Description    |
| --------------------- | ----------------------- | -------------- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | API Server URL |

### GitHub Connector

| Variable                      | Description                                |
| ----------------------------- | ------------------------------------------ |
| `GITHUB_APP_ID`               | GitHub App ID                              |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to GitHub App private key PEM file    |
| `GITHUB_APP_INSTALLATION_ID`  | GitHub App installation ID                 |
| `GITHUB_ORG`                  | GitHub organization name                   |
| `GITHUB_TOKEN`                | Personal Access Token (alternative to App) |

## Resource Requirements

### Minimum (development)

| Service     | CPU       | Memory |
| ----------- | --------- | ------ |
| Neo4j       | 1 core    | 1 GB   |
| Redis       | 0.5 core  | 256 MB |
| API Server  | 0.5 core  | 256 MB |
| Core Writer | 0.5 core  | 256 MB |
| MCP Server  | 0.25 core | 128 MB |
| Web UI      | 0.5 core  | 256 MB |

### Recommended (small production)

| Service     | CPU      | Memory |
| ----------- | -------- | ------ |
| Neo4j       | 4 cores  | 4 GB   |
| Redis       | 1 core   | 512 MB |
| API Server  | 1 core   | 512 MB |
| Core Writer | 1 core   | 512 MB |
| MCP Server  | 0.5 core | 256 MB |
| Web UI      | 1 core   | 512 MB |

## Production Notes

### Neo4j

- Use Neo4j Enterprise for clustering and high availability (see [ADR-007](../designDocs/ADRs/ADR-007-neo4j-ha-strategy.md))
- Configure APOC plugin for advanced graph operations
- Set appropriate heap and page cache sizes based on graph size
- Enable backups (online backup for Enterprise, `neo4j-admin dump` for Community)

### Redis

- Enable AOF persistence for durability
- Configure `maxmemory` and eviction policy
- Consider Redis Sentinel or Cluster for high availability

### Event Bus

- Phase 1 uses BullMQ/Redis (Lite Mode) — suitable for moderate throughput
- Phase 2 supports Kafka/Redpanda for production scale (see [ADR-004](../designDocs/ADRs/ADR-004-event-bus-strategy.md))
- Event retention defaults to 7 days

### Security

- Change default Neo4j password in production
- Set `MCP_API_KEY_SECRET` to enable MCP authentication
- Configure CORS origins in API Server for production domains
- Use TLS for all service-to-service communication
- Store secrets in a vault, not environment files

### Docker Images

All backend services use Node.js 22 base images. The Web UI uses a multi-stage build with Node.js 22 for building and a lightweight image for serving.
