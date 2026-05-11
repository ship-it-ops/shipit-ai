# ShipIt-AI Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Phase 1a Walking Skeleton (Weeks 1-4) and Phase 1b Second Connector (Weeks 5-8) of ShipIt-AI -- an AI-Ready Knowledge Graph Builder that maps software ecosystems into a queryable Neo4j graph exposed via MCP tools.

**Architecture:** TypeScript monorepo (Turborepo) with 8 packages: shared types, event-bus SDK (BullMQ/Redis), core-writer (sole Neo4j writer), connector-sdk, github-connector, api-server (Fastify), mcp-server, and web-ui (Next.js 14). All data flows through an Event Bus abstraction. Connectors normalize raw data into CanonicalEntities with PropertyClaims stored as JSON on Neo4j nodes. The Core Writer is the sole graph writer, applying claim resolution and identity matching (primary key + linking key in Phase 1).

**Tech Stack:** TypeScript 5.x, Node.js 20+, Turborepo, Neo4j 5.x, Redis 7+, BullMQ, Fastify, Next.js 14 (App Router), React 18, Tailwind CSS, shadcn/ui, Cytoscape.js, Vitest, Docker Compose

**Design Document:** `designDocs/ShipIt-AI_Design_Document_v0.3.md`
**ADRs:** `designDocs/ADRs/ADR-001` through `ADR-012`

---

## Execution Strategy: 3 Waves, 7 Teams

```
Wave 1 (Foundation) ─────────────────────────────────────────────
  Team 1: Project Scaffolding    ┐
  Team 2: Data Model & Schema    ┘ parallel

Wave 2 (Core Backend) ───────────────────────────────────────────
  Team 3: Event Bus + Core Writer    ┐
  Team 4: Connector SDK + GitHub     ├ parallel (depends on Wave 1)
  Team 5: API Server                 ┘

Wave 3 (Interface Layer) ─────────────────────────────────────────
  Team 6: MCP Server                 ┐ parallel (depends on Wave 2)
  Team 7: Web UI                     ┘
```

---

## Project Structure

```
ShipIt-AI/
├── packages/
│   ├── shared/              # Shared types, interfaces, utilities
│   │   ├── src/
│   │   │   ├── types/       # CanonicalNode, CanonicalEdge, PropertyClaim
│   │   │   ├── schema/      # YAML schema parser, validation
│   │   │   ├── identity/    # Canonical ID utilities
│   │   │   └── utils/       # Common utilities
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── event-bus/           # Event Bus SDK (BullMQ implementation)
│   │   ├── src/
│   │   │   ├── interface.ts
│   │   │   ├── bullmq/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── core-writer/         # Core Writer (sole Neo4j writer)
│   │   ├── src/
│   │   │   ├── writer.ts
│   │   │   ├── claims/
│   │   │   ├── identity/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── connector-sdk/       # Connector SDK framework
│   │   ├── src/
│   │   │   ├── interface.ts
│   │   │   ├── harness.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── connectors/
│   │   ├── github/          # GitHub connector
│   │   │   ├── src/
│   │   │   ├── package.json
│   │   │   └── tsconfig.json
│   │   └── kubernetes/      # Kubernetes connector (Phase 1b)
│   │       ├── src/
│   │       ├── package.json
│   │       └── tsconfig.json
│   ├── api-server/          # API Server (Fastify)
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   ├── services/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── mcp-server/          # MCP Server (tool implementations)
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── tools/
│   │   │   ├── cypher/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web-ui/              # Next.js dashboard
│       ├── src/
│       │   └── app/
│       ├── package.json
│       └── tsconfig.json
├── config/
│   └── shipit-schema.yaml   # Default schema configuration
├── docker/
│   ├── docker-compose.yml
│   ├── neo4j/
│   │   └── init.cypher      # Neo4j init script (indexes, constraints)
│   └── .env.example
├── docs/
│   └── plans/
├── turbo.json
├── tsconfig.base.json
├── package.json
├── .gitignore
└── vitest.workspace.ts
```

---

## WAVE 1: FOUNDATION

---

### Task 1: Project Scaffolding (Team 1)

**Goal:** Set up the Turborepo monorepo with all 8 packages, shared TypeScript config, Docker Compose for Neo4j + Redis, and CI-ready test infrastructure.

**Files:**

- Create: `package.json` (root workspace)
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/event-bus/package.json`
- Create: `packages/event-bus/tsconfig.json`
- Create: `packages/event-bus/src/index.ts`
- Create: `packages/core-writer/package.json`
- Create: `packages/core-writer/tsconfig.json`
- Create: `packages/core-writer/src/index.ts`
- Create: `packages/connector-sdk/package.json`
- Create: `packages/connector-sdk/tsconfig.json`
- Create: `packages/connector-sdk/src/index.ts`
- Create: `packages/connectors/github/package.json`
- Create: `packages/connectors/github/tsconfig.json`
- Create: `packages/connectors/github/src/index.ts`
- Create: `packages/api-server/package.json`
- Create: `packages/api-server/tsconfig.json`
- Create: `packages/api-server/src/index.ts`
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts`
- Create: `packages/web-ui/package.json`
- Create: `packages/web-ui/tsconfig.json`
- Create: `docker/docker-compose.yml`
- Create: `docker/neo4j/init.cypher`
- Create: `docker/.env.example`

**Step 1: Create root package.json with npm workspaces**

```json
{
  "name": "shipit-ai",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["packages/*", "packages/connectors/*"],
  "scripts": {
    "build": "turbo build",
    "dev": "turbo dev",
    "test": "turbo test",
    "test:watch": "turbo test:watch",
    "lint": "turbo lint",
    "clean": "turbo clean",
    "typecheck": "turbo typecheck"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "prettier": "^3.5.0"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "packageManager": "npm@10.9.0"
}
```

**Step 2: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test:watch": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "clean": {
      "cache": false
    }
  }
}
```

**Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create vitest.workspace.ts**

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/event-bus',
  'packages/core-writer',
  'packages/connector-sdk',
  'packages/connectors/github',
  'packages/connectors/kubernetes',
  'packages/api-server',
  'packages/mcp-server',
]);
```

**Step 5: Create each package with package.json, tsconfig.json, and stub index.ts**

Each package follows this pattern (example for `packages/shared`):

```json
// packages/shared/package.json
{
  "name": "@shipit-ai/shared",
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
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/shared/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

Package-specific dependencies:

| Package                       | Extra Dependencies                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@shipit-ai/shared`           | `yaml`, `zod`                                                                                               |
| `@shipit-ai/event-bus`        | `bullmq`, `ioredis`, `@shipit-ai/shared`                                                                    |
| `@shipit-ai/core-writer`      | `neo4j-driver`, `@shipit-ai/shared`, `@shipit-ai/event-bus`                                                 |
| `@shipit-ai/connector-sdk`    | `@shipit-ai/shared`, `@shipit-ai/event-bus`                                                                 |
| `@shipit-ai/connector-github` | `@octokit/rest`, `@octokit/auth-app`, `@shipit-ai/connector-sdk`, `@shipit-ai/shared`                       |
| `@shipit-ai/api-server`       | `fastify`, `@fastify/cors`, `@fastify/swagger`, `neo4j-driver`, `@shipit-ai/shared`, `@shipit-ai/event-bus` |
| `@shipit-ai/mcp-server`       | `@modelcontextprotocol/sdk`, `neo4j-driver`, `@shipit-ai/shared`                                            |
| `@shipit-ai/web-ui`           | `next`, `react`, `react-dom`, `tailwindcss`, `cytoscape`, `@tanstack/react-query`, `zustand`                |

**Step 6: Create Docker Compose**

```yaml
# docker/docker-compose.yml
services:
  neo4j:
    image: neo4j:5-community
    ports:
      - '7474:7474' # Browser
      - '7687:7687' # Bolt
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD:-shipit-dev}
      NEO4J_PLUGINS: '["apoc"]'
      NEO4J_dbms_memory_heap_initial__size: 512m
      NEO4J_dbms_memory_heap_max__size: 1G
    volumes:
      - neo4j_data:/data
      - neo4j_logs:/logs
      - ./neo4j/init.cypher:/var/lib/neo4j/import/init.cypher
    healthcheck:
      test: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:7474 || exit 1']
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    volumes:
      - redis_data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 10s
      timeout: 5s
      retries: 5

  api-server:
    build:
      context: ..
      dockerfile: packages/api-server/Dockerfile
    ports:
      - '3001:3001'
    environment:
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: ${NEO4J_PASSWORD:-shipit-dev}
      REDIS_URL: redis://redis:6379
      PORT: 3001
    depends_on:
      neo4j:
        condition: service_healthy
      redis:
        condition: service_healthy

  core-writer:
    build:
      context: ..
      dockerfile: packages/core-writer/Dockerfile
    environment:
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: ${NEO4J_PASSWORD:-shipit-dev}
      REDIS_URL: redis://redis:6379
    depends_on:
      neo4j:
        condition: service_healthy
      redis:
        condition: service_healthy

  web-ui:
    build:
      context: ..
      dockerfile: packages/web-ui/Dockerfile
    ports:
      - '3000:3000'
    environment:
      API_SERVER_URL: http://api-server:3001
    depends_on:
      - api-server

volumes:
  neo4j_data:
  neo4j_logs:
  redis_data:
```

**Step 7: Create Neo4j init script**

```cypher
// docker/neo4j/init.cypher
// Unique constraints for canonical IDs
CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT logical_service_id IF NOT EXISTS FOR (n:LogicalService) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT repository_id IF NOT EXISTS FOR (n:Repository) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT deployment_id IF NOT EXISTS FOR (n:Deployment) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT runtime_service_id IF NOT EXISTS FOR (n:RuntimeService) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT team_id IF NOT EXISTS FOR (n:Team) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT person_id IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT pipeline_id IF NOT EXISTS FOR (n:Pipeline) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT monitor_id IF NOT EXISTS FOR (n:Monitor) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT namespace_id IF NOT EXISTS FOR (n:Namespace) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT cluster_id IF NOT EXISTS FOR (n:Cluster) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT build_artifact_id IF NOT EXISTS FOR (n:BuildArtifact) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT environment_id IF NOT EXISTS FOR (n:Environment) REQUIRE n.id IS UNIQUE;

// Indexes for common queries
CREATE INDEX entity_name IF NOT EXISTS FOR (n:LogicalService) ON (n.name);
CREATE INDEX repo_name IF NOT EXISTS FOR (n:Repository) ON (n.name);
CREATE INDEX deployment_name IF NOT EXISTS FOR (n:Deployment) ON (n.name);
CREATE INDEX team_name IF NOT EXISTS FOR (n:Team) ON (n.name);
CREATE INDEX person_name IF NOT EXISTS FOR (n:Person) ON (n.name);
CREATE INDEX person_email IF NOT EXISTS FOR (n:Person) ON (n.email);

// Indexes for sync/staleness queries
CREATE INDEX last_synced IF NOT EXISTS FOR (n:LogicalService) ON (n._last_synced);
CREATE INDEX source_system IF NOT EXISTS FOR (n:LogicalService) ON (n._source_system);

// Linking key index
CREATE INDEX linking_key IF NOT EXISTS FOR (n:LinkingKey) REQUIRE n.key IS UNIQUE;

// Idempotency log
CREATE CONSTRAINT idempotency_key IF NOT EXISTS FOR (n:IdempotencyLog) REQUIRE n.key IS UNIQUE;

// Schema meta-nodes (ADR-009)
CREATE CONSTRAINT schema_node_type IF NOT EXISTS FOR (n:SchemaNodeType) REQUIRE n.label IS UNIQUE;
CREATE CONSTRAINT schema_rel_type IF NOT EXISTS FOR (n:SchemaRelType) REQUIRE n.type IS UNIQUE;
```

**Step 8: Create .gitignore**

```
node_modules/
dist/
.turbo/
.next/
.env
.env.local
*.log
coverage/
.DS_Store
```

**Step 9: Create .env.example**

```bash
# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=shipit-dev

# Redis
REDIS_URL=redis://localhost:6379

# API Server
API_SERVER_PORT=3001
API_SERVER_URL=http://localhost:3001

# Web UI
NEXT_PUBLIC_API_URL=http://localhost:3001

# GitHub Connector
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=
GITHUB_APP_INSTALLATION_ID=
GITHUB_ORG=
```

**Step 10: Install dependencies and verify build**

Run: `npm install && npx turbo build`
Expected: All packages build successfully with empty index.ts stubs.

**Step 11: Verify Docker Compose**

Run: `cd docker && docker compose up -d neo4j redis`
Expected: Neo4j accessible at http://localhost:7474, Redis at localhost:6379.

**Step 12: Commit**

```bash
git add .
git commit -m "feat: scaffold monorepo with Turborepo, Docker Compose, Neo4j, Redis"
```

---

### Task 2: Data Model & Schema (Team 2)

**Goal:** Implement all shared TypeScript interfaces (CanonicalNode, CanonicalEdge, PropertyClaim, etc.), the YAML schema parser, schema validation, canonical ID utilities, and resolution strategy types. This is the type foundation for every other package.

**Files:**

- Create: `packages/shared/src/types/canonical.ts`
- Create: `packages/shared/src/types/claims.ts`
- Create: `packages/shared/src/types/schema.ts`
- Create: `packages/shared/src/types/events.ts`
- Create: `packages/shared/src/types/identity.ts`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/schema/parser.ts`
- Create: `packages/shared/src/schema/validator.ts`
- Create: `packages/shared/src/schema/defaults.ts`
- Create: `packages/shared/src/identity/canonical-id.ts`
- Create: `packages/shared/src/identity/linking-key.ts`
- Create: `packages/shared/src/utils/confidence.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/canonical-id.test.ts`
- Create: `packages/shared/src/__tests__/schema-parser.test.ts`
- Create: `packages/shared/src/__tests__/claims.test.ts`
- Create: `packages/shared/src/__tests__/confidence.test.ts`
- Create: `config/shipit-schema.yaml`

**Step 1: Write CanonicalNode and CanonicalEdge interfaces**

```typescript
// packages/shared/src/types/canonical.ts
import type { PropertyClaim } from './claims.js';

export interface CanonicalNode {
  id: string; // shipit://{label}/{namespace}/{name}
  label: string; // Node label (e.g., 'LogicalService')
  properties: Record<string, unknown>;
  _claims: PropertyClaim[];
  _source_system: string; // e.g., 'github', 'kubernetes'
  _source_org: string; // e.g., 'github/acme-corp'
  _source_id: string; // Linking key from source system
  _last_synced: string; // ISO 8601
  _event_version: number | string; // Monotonic integer or ISO 8601 only
}

export interface CanonicalEdge {
  type: string; // e.g., 'DEPENDS_ON'
  from: string; // Source node canonical ID
  to: string; // Target node canonical ID
  properties?: Record<string, unknown>;
  _source: string;
  _confidence: number; // 0.0-1.0
  _ingested_at: string; // ISO 8601
}

export interface CanonicalEntity {
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
}
```

**Step 2: Write PropertyClaim and Resolution Strategy types**

```typescript
// packages/shared/src/types/claims.ts
export interface PropertyClaim {
  property_key: string;
  value: unknown;
  source: string;
  source_id: string;
  ingested_at: string; // ISO 8601
  confidence: number; // 0.0-1.0
  evidence: string | null;
}

export type ResolutionStrategy =
  | 'MANUAL_OVERRIDE_FIRST'
  | 'HIGHEST_CONFIDENCE'
  | 'AUTHORITATIVE_ORDER'
  | 'LATEST_TIMESTAMP'
  | 'MERGE_SET';

export interface EdgeClaim {
  source: string;
  confidence: number;
  ingested_at: string;
  retracted: boolean;
  retracted_at?: string;
}

export interface ClaimResolutionResult {
  effective_value: unknown;
  winning_claim: PropertyClaim;
  strategy: ResolutionStrategy;
  all_claims: PropertyClaim[];
}
```

**Step 3: Write Schema types (for YAML parsing)**

```typescript
// packages/shared/src/types/schema.ts
import type { ResolutionStrategy } from './claims.js';

export type SchemaMode = 'full' | 'simple';

export interface SchemaPropertyDef {
  type: string; // 'string', 'integer', 'boolean', 'string[]'
  required?: boolean;
  resolution_strategy: ResolutionStrategy;
  enum?: string[];
  description?: string;
}

export interface SchemaNodeTypeDef {
  description: string;
  properties: Record<string, SchemaPropertyDef>;
  constraints?: {
    unique_key?: string;
  };
}

export interface SchemaRelTypeDef {
  from: string;
  to: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  properties?: Record<string, SchemaPropertyDef>;
  description?: string;
}

export interface ShipItSchema {
  version: string;
  mode: SchemaMode;
  node_types: Record<string, SchemaNodeTypeDef>;
  relationship_types: Record<string, SchemaRelTypeDef>;
  resolution_defaults?: Record<string, ResolutionStrategy>;
}
```

**Step 4: Write Event Bus event types**

```typescript
// packages/shared/src/types/events.ts
import type { CanonicalEntity } from './canonical.js';

export interface EventEnvelope {
  id: string; // UUID
  timestamp: string; // ISO 8601
  connector_id: string;
  idempotency_key: string; // {connector_id}:{entity_primary_key}:{event_version}
  payload: CanonicalEntity;
}

export interface EventHandler {
  (event: EventEnvelope): Promise<void>;
}

export interface EventBusClient {
  publish(events: CanonicalEntity[], connectorId: string): Promise<void>;
  subscribe(handler: EventHandler): Promise<void>;
  replay(fromTimestamp: string): Promise<void>;
  close(): Promise<void>;
}
```

**Step 5: Write Identity types**

```typescript
// packages/shared/src/types/identity.ts
export interface RenameSignal {
  old_linking_key: string;
  new_linking_key: string;
  source: string;
  timestamp: string;
}

export interface MergeEvent {
  source_id: string;
  target_id: string;
  actor: string;
  timestamp: string;
  method: 'primary_key' | 'linking_key' | 'fuzzy' | 'manual';
  confidence_score: number;
}

export type IdentityMatchStep = 'primary_key' | 'linking_key' | 'fuzzy' | 'manual';
```

**Step 6: Write Canonical ID utilities**

```typescript
// packages/shared/src/identity/canonical-id.ts

const CANONICAL_ID_REGEX = /^shipit:\/\/([a-z-]+)\/([a-z0-9-]+)\/(.+)$/;

export function buildCanonicalId(label: string, namespace: string, name: string): string {
  const normalizedLabel = label.replace(/([A-Z])/g, (match, char, index) =>
    index > 0 ? `-${char.toLowerCase()}` : char.toLowerCase(),
  );
  return `shipit://${normalizedLabel}/${namespace}/${name}`;
}

export function parseCanonicalId(
  id: string,
): { label: string; namespace: string; name: string } | null {
  const match = id.match(CANONICAL_ID_REGEX);
  if (!match) return null;
  return {
    label: match[1],
    namespace: match[2],
    name: match[3],
  };
}

export function isValidCanonicalId(id: string): boolean {
  return CANONICAL_ID_REGEX.test(id);
}
```

**Step 7: Write Linking Key utilities**

```typescript
// packages/shared/src/identity/linking-key.ts

export type ConnectorType = 'github' | 'kubernetes' | 'datadog' | 'backstage' | 'jira' | 'identity';

export function buildLinkingKey(connector: ConnectorType, ...parts: string[]): string {
  const prefix = getLinkingKeyPrefix(connector);
  return `${prefix}://${parts.join('/')}`;
}

function getLinkingKeyPrefix(connector: ConnectorType): string {
  switch (connector) {
    case 'github':
      return 'github';
    case 'kubernetes':
      return 'k8s';
    case 'datadog':
      return 'dd';
    case 'backstage':
      return 'backstage';
    case 'jira':
      return 'jira';
    case 'identity':
      return 'idp';
  }
}

export function parseLinkingKey(key: string): { connector: string; parts: string[] } | null {
  const match = key.match(/^([a-z0-9]+):\/\/(.+)$/);
  if (!match) return null;
  return {
    connector: match[1],
    parts: match[2].split('/'),
  };
}
```

**Step 8: Write Confidence Decay utility**

```typescript
// packages/shared/src/utils/confidence.ts

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DECAY_RATE = 0.01; // per week

export function computeEffectiveConfidence(
  baseConfidence: number,
  ingestedAt: string,
  now: Date = new Date(),
  decayRate: number = DEFAULT_DECAY_RATE,
): number {
  const ingestedDate = new Date(ingestedAt);
  const weeksSinceIngested = (now.getTime() - ingestedDate.getTime()) / MS_PER_WEEK;
  const decayed = baseConfidence - decayRate * weeksSinceIngested;
  return Math.max(0, Math.min(1, decayed));
}
```

**Step 9: Write YAML Schema Parser**

```typescript
// packages/shared/src/schema/parser.ts
import { parse as parseYaml } from 'yaml';
import type { ShipItSchema } from '../types/schema.js';
import { validateSchema } from './validator.js';

export function parseSchemaFile(yamlContent: string): ShipItSchema {
  const raw = parseYaml(yamlContent);
  const validated = validateSchema(raw);
  return validated;
}
```

**Step 10: Write Schema Validator (using Zod)**

```typescript
// packages/shared/src/schema/validator.ts
import { z } from 'zod';
import type { ShipItSchema } from '../types/schema.js';

const resolutionStrategySchema = z.enum([
  'MANUAL_OVERRIDE_FIRST',
  'HIGHEST_CONFIDENCE',
  'AUTHORITATIVE_ORDER',
  'LATEST_TIMESTAMP',
  'MERGE_SET',
]);

const propertyDefSchema = z.object({
  type: z.string(),
  required: z.boolean().optional().default(false),
  resolution_strategy: resolutionStrategySchema,
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const nodeTypeDefSchema = z.object({
  description: z.string(),
  properties: z.record(z.string(), propertyDefSchema),
  constraints: z
    .object({
      unique_key: z.string().optional(),
    })
    .optional(),
});

const relTypeDefSchema = z.object({
  from: z.string(),
  to: z.string(),
  cardinality: z.enum(['1:1', '1:N', 'N:1', 'N:M']),
  properties: z.record(z.string(), propertyDefSchema).optional(),
  description: z.string().optional(),
});

const schemaSchema = z.object({
  version: z.string(),
  mode: z.enum(['full', 'simple']),
  node_types: z.record(z.string(), nodeTypeDefSchema),
  relationship_types: z.record(z.string(), relTypeDefSchema),
  resolution_defaults: z.record(z.string(), resolutionStrategySchema).optional(),
});

export function validateSchema(raw: unknown): ShipItSchema {
  return schemaSchema.parse(raw) as ShipItSchema;
}

export function validateSchemaRelationships(schema: ShipItSchema): string[] {
  const errors: string[] = [];
  const nodeLabels = new Set(Object.keys(schema.node_types));

  for (const [relType, relDef] of Object.entries(schema.relationship_types)) {
    if (!nodeLabels.has(relDef.from)) {
      errors.push(`Relationship ${relType}: 'from' label '${relDef.from}' not found in node_types`);
    }
    if (!nodeLabels.has(relDef.to)) {
      errors.push(`Relationship ${relType}: 'to' label '${relDef.to}' not found in node_types`);
    }
  }

  return errors;
}
```

**Step 11: Write Default Schema YAML**

```yaml
# config/shipit-schema.yaml
version: '1.0'
mode: full

node_types:
  LogicalService:
    description: 'A named, team-owned service concept'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      tier:
        type: integer
        required: false
        resolution_strategy: MANUAL_OVERRIDE_FIRST
      owner:
        type: string
        required: false
        resolution_strategy: HIGHEST_CONFIDENCE
      lifecycle:
        type: string
        enum: [experimental, production, deprecated, decommissioned]
        resolution_strategy: LATEST_TIMESTAMP
      language:
        type: string
        resolution_strategy: AUTHORITATIVE_ORDER
      domain:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      tags:
        type: 'string[]'
        resolution_strategy: MERGE_SET
      description:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
    constraints:
      unique_key: name

  Repository:
    description: 'A source code repository'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      url:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      default_branch:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      visibility:
        type: string
        enum: [public, private, internal]
        resolution_strategy: LATEST_TIMESTAMP
      language:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      topics:
        type: 'string[]'
        resolution_strategy: MERGE_SET
    constraints:
      unique_key: name

  Deployment:
    description: 'A running instance in a specific environment/cluster'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      namespace:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      cluster:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      environment:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      image:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      replicas:
        type: integer
        resolution_strategy: LATEST_TIMESTAMP
      status:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
    constraints:
      unique_key: name

  RuntimeService:
    description: 'The identity seen by observability tools'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      dd_service:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      apm_name:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      environment:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
    constraints:
      unique_key: name

  Team:
    description: 'An engineering team or squad'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      slug:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      description:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
    constraints:
      unique_key: name

  Person:
    description: 'An individual (engineer, PM, etc.)'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      email:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      github_handle:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      role:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
    constraints:
      unique_key: email

  Pipeline:
    description: 'A CI/CD workflow'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      trigger:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      status:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      last_run:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
    constraints:
      unique_key: name

  Monitor:
    description: 'An observability check (alert, SLO)'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      type:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      query:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      status:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      threshold:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
    constraints:
      unique_key: name

  Namespace:
    description: 'A Kubernetes namespace'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      cluster:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      labels:
        type: 'string[]'
        resolution_strategy: MERGE_SET
    constraints:
      unique_key: name

  Cluster:
    description: 'A Kubernetes cluster'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      provider:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
      region:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      version:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
    constraints:
      unique_key: name

  BuildArtifact:
    description: 'A built container image or binary'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      image_tag:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      sha:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      registry:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
    constraints:
      unique_key: name

  Environment:
    description: 'A deployment target environment'
    properties:
      name:
        type: string
        required: true
        resolution_strategy: HIGHEST_CONFIDENCE
      type:
        type: string
        enum: [development, staging, production]
        resolution_strategy: HIGHEST_CONFIDENCE
      region:
        type: string
        resolution_strategy: LATEST_TIMESTAMP
      classification:
        type: string
        resolution_strategy: HIGHEST_CONFIDENCE
    constraints:
      unique_key: name

relationship_types:
  IMPLEMENTED_BY:
    from: LogicalService
    to: Repository
    cardinality: '1:N'
    description: 'LogicalService is implemented by this repo'

  DEPLOYED_AS:
    from: LogicalService
    to: Deployment
    cardinality: '1:N'
    description: 'LogicalService has this running deployment'

  EMITS_TELEMETRY_AS:
    from: Deployment
    to: RuntimeService
    cardinality: 'N:M'
    description: 'Deployment is observed as this RuntimeService'

  BUILT_FROM:
    from: BuildArtifact
    to: Repository
    cardinality: 'N:1'

  RUNS_IMAGE:
    from: Deployment
    to: BuildArtifact
    cardinality: 'N:1'

  RUNS_IN_ENV:
    from: Deployment
    to: Environment
    cardinality: 'N:1'

  DEPENDS_ON:
    from: LogicalService
    to: LogicalService
    cardinality: 'N:M'

  CALLS:
    from: RuntimeService
    to: RuntimeService
    cardinality: 'N:M'

  OWNS:
    from: Team
    to: LogicalService
    cardinality: '1:N'

  MEMBER_OF:
    from: Person
    to: Team
    cardinality: 'N:M'

  CONTRIBUTES_TO:
    from: Person
    to: Repository
    cardinality: 'N:M'

  RUNS_IN:
    from: Deployment
    to: Namespace
    cardinality: 'N:1'

  PART_OF:
    from: Namespace
    to: Cluster
    cardinality: 'N:1'

  BUILT_BY:
    from: LogicalService
    to: Pipeline
    cardinality: '1:N'

  TRIGGERS:
    from: Pipeline
    to: Pipeline
    cardinality: 'N:M'

  MONITORS:
    from: Monitor
    to: LogicalService
    cardinality: 'N:M'

  CODEOWNER_OF:
    from: Person
    to: Repository
    cardinality: 'N:M'

  ON_CALL_FOR:
    from: Person
    to: LogicalService
    cardinality: 'N:M'

resolution_defaults:
  owner: HIGHEST_CONFIDENCE
  tier: MANUAL_OVERRIDE_FIRST
  status: LATEST_TIMESTAMP
  tags: MERGE_SET
  name: HIGHEST_CONFIDENCE
```

**Step 12: Write tests for canonical ID utilities**

```typescript
// packages/shared/src/__tests__/canonical-id.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildCanonicalId,
  parseCanonicalId,
  isValidCanonicalId,
} from '../identity/canonical-id.js';

describe('buildCanonicalId', () => {
  it('builds from PascalCase label', () => {
    expect(buildCanonicalId('LogicalService', 'default', 'payments-api')).toBe(
      'shipit://logical-service/default/payments-api',
    );
  });

  it('builds from simple label', () => {
    expect(buildCanonicalId('Repository', 'default', 'config-service')).toBe(
      'shipit://repository/default/config-service',
    );
  });
});

describe('parseCanonicalId', () => {
  it('parses valid canonical ID', () => {
    const result = parseCanonicalId('shipit://logical-service/default/payments-api');
    expect(result).toEqual({
      label: 'logical-service',
      namespace: 'default',
      name: 'payments-api',
    });
  });

  it('returns null for invalid ID', () => {
    expect(parseCanonicalId('invalid')).toBeNull();
  });
});

describe('isValidCanonicalId', () => {
  it('validates correct format', () => {
    expect(isValidCanonicalId('shipit://repository/default/my-repo')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(isValidCanonicalId('github://org/repo')).toBe(false);
  });
});
```

**Step 13: Write tests for confidence decay**

```typescript
// packages/shared/src/__tests__/confidence.test.ts
import { describe, it, expect } from 'vitest';
import { computeEffectiveConfidence } from '../utils/confidence.js';

describe('computeEffectiveConfidence', () => {
  it('returns base confidence for freshly ingested claim', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    expect(computeEffectiveConfidence(0.95, '2026-03-01T00:00:00Z', now)).toBe(0.95);
  });

  it('decays by 0.01 per week', () => {
    const now = new Date('2026-03-08T00:00:00Z'); // 1 week later
    const result = computeEffectiveConfidence(0.95, '2026-03-01T00:00:00Z', now);
    expect(result).toBeCloseTo(0.94, 2);
  });

  it('decays to 0.69 after 26 weeks', () => {
    const ingested = new Date('2026-01-01T00:00:00Z');
    const now = new Date(ingested.getTime() + 26 * 7 * 24 * 60 * 60 * 1000);
    const result = computeEffectiveConfidence(0.95, ingested.toISOString(), now);
    expect(result).toBeCloseTo(0.69, 2);
  });

  it('floors at 0', () => {
    const now = new Date('2028-01-01T00:00:00Z'); // far future
    const result = computeEffectiveConfidence(0.5, '2026-01-01T00:00:00Z', now);
    expect(result).toBe(0);
  });
});
```

**Step 14: Write tests for schema parser**

```typescript
// packages/shared/src/__tests__/schema-parser.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSchemaFile } from '../schema/parser.js';

describe('parseSchemaFile', () => {
  it('parses the default schema YAML', () => {
    const yaml = readFileSync(join(__dirname, '../../../../config/shipit-schema.yaml'), 'utf-8');
    const schema = parseSchemaFile(yaml);
    expect(schema.version).toBe('1.0');
    expect(schema.mode).toBe('full');
    expect(schema.node_types.LogicalService).toBeDefined();
    expect(schema.node_types.LogicalService.properties.name.resolution_strategy).toBe(
      'HIGHEST_CONFIDENCE',
    );
  });

  it('validates relationship from/to labels exist', () => {
    const yaml = readFileSync(join(__dirname, '../../../../config/shipit-schema.yaml'), 'utf-8');
    const schema = parseSchemaFile(yaml);
    expect(schema.relationship_types.IMPLEMENTED_BY.from).toBe('LogicalService');
    expect(schema.relationship_types.IMPLEMENTED_BY.to).toBe('Repository');
  });

  it('rejects invalid resolution strategy', () => {
    const yaml = `
version: "1.0"
mode: full
node_types:
  Foo:
    description: test
    properties:
      name:
        type: string
        resolution_strategy: INVALID_STRATEGY
relationship_types: {}
`;
    expect(() => parseSchemaFile(yaml)).toThrow();
  });
});
```

**Step 15: Export everything from index.ts**

```typescript
// packages/shared/src/index.ts
export * from './types/index.js';
export * from './identity/canonical-id.js';
export * from './identity/linking-key.js';
export * from './schema/parser.js';
export * from './schema/validator.js';
export * from './utils/confidence.js';
```

```typescript
// packages/shared/src/types/index.ts
export * from './canonical.js';
export * from './claims.js';
export * from './schema.js';
export * from './events.js';
export * from './identity.js';
```

**Step 16: Run tests**

Run: `cd packages/shared && npx vitest run`
Expected: All tests pass.

**Step 17: Commit**

```bash
git add packages/shared/ config/shipit-schema.yaml
git commit -m "feat: add shared types, schema parser, canonical ID utilities, confidence decay"
```

---

## WAVE 2: CORE BACKEND

---

### Task 3: Event Bus SDK (Team 3, Part 1)

**Goal:** Implement the Event Bus SDK abstraction with a BullMQ/Redis implementation for Lite Mode. This provides the publish/subscribe/replay interface used by the Connector SDK and Core Writer.

**Files:**

- Create: `packages/event-bus/src/interface.ts`
- Create: `packages/event-bus/src/bullmq/client.ts`
- Create: `packages/event-bus/src/bullmq/producer.ts`
- Create: `packages/event-bus/src/bullmq/consumer.ts`
- Create: `packages/event-bus/src/bullmq/replay.ts`
- Create: `packages/event-bus/src/config.ts`
- Create: `packages/event-bus/src/index.ts`
- Create: `packages/event-bus/src/__tests__/bullmq-client.test.ts`

**Step 1: Implement EventBus interface and BullMQ client**

The BullMQ client wraps BullMQ queues with the EventBusClient interface from `@shipit-ai/shared`. Events are keyed by canonical entity ID for ordering guarantees per entity.

Key implementation details:

- Queue name: `shipit-events`
- Jobs keyed by entity canonical ID (ensures ordering per entity)
- At-least-once delivery via BullMQ's built-in retry with exponential backoff
- Dead letter queue after 3 retries (configurable)
- Redis Streams for event replay (store published events in a stream)

**Step 2: Write integration tests using a real Redis instance (Docker)**

Tests should verify:

- Publish events and consume them
- Events for the same entity are processed in order
- Failed events go to DLQ after max retries
- Replay from timestamp returns correct events

**Step 3: Commit**

```bash
git add packages/event-bus/
git commit -m "feat: implement Event Bus SDK with BullMQ/Redis for Lite Mode"
```

---

### Task 4: Core Writer (Team 3, Part 2)

**Goal:** Implement the Core Writer -- the sole component that writes to Neo4j. It consumes events from the Event Bus, resolves identity (primary key + linking key), applies claim resolution, materializes effective properties, and maintains the idempotency log.

**Files:**

- Create: `packages/core-writer/src/writer.ts`
- Create: `packages/core-writer/src/claims/resolver.ts`
- Create: `packages/core-writer/src/claims/strategies.ts`
- Create: `packages/core-writer/src/identity/reconciler.ts`
- Create: `packages/core-writer/src/identity/linking-key-index.ts`
- Create: `packages/core-writer/src/neo4j/client.ts`
- Create: `packages/core-writer/src/neo4j/queries.ts`
- Create: `packages/core-writer/src/idempotency.ts`
- Create: `packages/core-writer/src/batch.ts`
- Create: `packages/core-writer/src/config.ts`
- Create: `packages/core-writer/src/index.ts`
- Create: `packages/core-writer/src/__tests__/resolver.test.ts`
- Create: `packages/core-writer/src/__tests__/strategies.test.ts`
- Create: `packages/core-writer/src/__tests__/reconciler.test.ts`
- Create: `packages/core-writer/src/__tests__/writer.integration.test.ts`

**Step 1: Implement Claim Resolution Strategies**

```typescript
// packages/core-writer/src/claims/strategies.ts
import type { PropertyClaim, ResolutionStrategy, ClaimResolutionResult } from '@shipit-ai/shared';
import { computeEffectiveConfidence } from '@shipit-ai/shared';

export function resolveClaims(
  claims: PropertyClaim[],
  strategy: ResolutionStrategy,
  decayRate?: number,
  now?: Date,
): ClaimResolutionResult | null {
  if (claims.length === 0) return null;

  switch (strategy) {
    case 'MANUAL_OVERRIDE_FIRST':
      return resolveManualOverrideFirst(claims, decayRate, now);
    case 'HIGHEST_CONFIDENCE':
      return resolveHighestConfidence(claims, decayRate, now);
    case 'AUTHORITATIVE_ORDER':
      return resolveAuthoritativeOrder(claims);
    case 'LATEST_TIMESTAMP':
      return resolveLatestTimestamp(claims);
    case 'MERGE_SET':
      return resolveMergeSet(claims);
  }
}

function resolveManualOverrideFirst(
  claims: PropertyClaim[],
  decayRate?: number,
  now?: Date,
): ClaimResolutionResult {
  const manualClaim = claims.find((c) => c.source.startsWith('manual:'));
  if (manualClaim) {
    return {
      effective_value: manualClaim.value,
      winning_claim: manualClaim,
      strategy: 'MANUAL_OVERRIDE_FIRST',
      all_claims: claims,
    };
  }
  return resolveHighestConfidence(claims, decayRate, now);
}

function resolveHighestConfidence(
  claims: PropertyClaim[],
  decayRate?: number,
  now?: Date,
): ClaimResolutionResult {
  const scored = claims.map((c) => ({
    claim: c,
    effective: computeEffectiveConfidence(c.confidence, c.ingested_at, now, decayRate),
  }));
  scored.sort((a, b) => {
    if (b.effective !== a.effective) return b.effective - a.effective;
    return new Date(b.claim.ingested_at).getTime() - new Date(a.claim.ingested_at).getTime();
  });
  const winner = scored[0].claim;
  return {
    effective_value: winner.value,
    winning_claim: winner,
    strategy: 'HIGHEST_CONFIDENCE',
    all_claims: claims,
  };
}

function resolveAuthoritativeOrder(claims: PropertyClaim[]): ClaimResolutionResult {
  // Default source priority: manual > backstage > github > kubernetes > datadog > jira > identity
  const priority = ['manual', 'backstage', 'github', 'kubernetes', 'datadog', 'jira', 'identity'];
  const sorted = [...claims].sort((a, b) => {
    const aIdx = priority.findIndex((p) => a.source.startsWith(p));
    const bIdx = priority.findIndex((p) => b.source.startsWith(p));
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });
  const winner = sorted[0];
  return {
    effective_value: winner.value,
    winning_claim: winner,
    strategy: 'AUTHORITATIVE_ORDER',
    all_claims: claims,
  };
}

function resolveLatestTimestamp(claims: PropertyClaim[]): ClaimResolutionResult {
  const sorted = [...claims].sort(
    (a, b) => new Date(b.ingested_at).getTime() - new Date(a.ingested_at).getTime(),
  );
  const winner = sorted[0];
  return {
    effective_value: winner.value,
    winning_claim: winner,
    strategy: 'LATEST_TIMESTAMP',
    all_claims: claims,
  };
}

function resolveMergeSet(claims: PropertyClaim[]): ClaimResolutionResult {
  const allValues = new Set<string>();
  for (const claim of claims) {
    if (Array.isArray(claim.value)) {
      claim.value.forEach((v) => allValues.add(String(v)));
    } else {
      allValues.add(String(claim.value));
    }
  }
  const mergedValue = Array.from(allValues);
  return {
    effective_value: mergedValue,
    winning_claim: claims[0],
    strategy: 'MERGE_SET',
    all_claims: claims,
  };
}
```

**Step 2: Implement Identity Reconciler (Primary Key + Linking Key)**

The reconciler checks:

1. Primary key match: if the node has a canonical `shipit://` ID, use it directly
2. Linking key match: look up `_source_id` in the linking key index; if found, merge onto existing node

**Step 3: Implement the Core Writer main loop**

The writer:

- Subscribes to the Event Bus
- Consumes events in micro-batches (default: 500)
- For each batch: check idempotency, resolve identity, apply claims, materialize effective properties
- All writes in a single Neo4j transaction per batch
- Acknowledges events after successful commit

Key Cypher patterns:

```cypher
// MERGE entity with claims
MERGE (n:{label} {id: $id})
SET n += $properties,
    n._claims = $claims_json,
    n._last_synced = $last_synced,
    n._source_system = $source_system,
    n._source_org = $source_org

// MERGE relationship with edge claims
MERGE (from)-[r:{type}]->(to)
SET r._source = $source,
    r._confidence = $confidence,
    r._ingested_at = $ingested_at
```

**Step 4: Write unit tests for claim resolution strategies**

Test each strategy with multiple claims and verify the correct winner.

**Step 5: Write integration test with Neo4j**

Use the Docker Compose Neo4j instance. Test end-to-end: publish events -> Core Writer consumes -> verify nodes/edges in Neo4j.

**Step 6: Commit**

```bash
git add packages/core-writer/
git commit -m "feat: implement Core Writer with claim resolution, identity reconciliation, idempotency"
```

---

### Task 5: Connector SDK (Team 4, Part 1)

**Goal:** Implement the Connector SDK framework -- the interface that all connectors implement, plus the SDK harness that auto-publishes `normalize()` output to the Event Bus.

**Files:**

- Create: `packages/connector-sdk/src/interface.ts`
- Create: `packages/connector-sdk/src/harness.ts`
- Create: `packages/connector-sdk/src/types.ts`
- Create: `packages/connector-sdk/src/dry-run.ts`
- Create: `packages/connector-sdk/src/sync-state.ts`
- Create: `packages/connector-sdk/src/index.ts`
- Create: `packages/connector-sdk/src/__tests__/harness.test.ts`

**Step 1: Implement the ShipItConnector interface**

```typescript
// packages/connector-sdk/src/interface.ts
import type { CanonicalEntity } from '@shipit-ai/shared';

export interface ConnectorConfig {
  id: string; // Unique connector instance ID
  type: string; // e.g., 'github', 'kubernetes'
  credentials: Record<string, string>;
  scope: Record<string, unknown>; // Connector-specific scope config
  schedule?: string; // Cron expression
}

export interface AuthResult {
  success: boolean;
  error?: string;
  expires_at?: string;
}

export interface DiscoveryResult {
  entity_types: string[];
  total_entities: Record<string, number>; // by type
}

export interface FetchResult {
  entities: unknown[]; // Raw entities from source
  cursor?: string; // For pagination
  has_more: boolean;
}

export interface SyncResult {
  status: 'success' | 'partial' | 'failed';
  entities_synced: number;
  errors: string[];
  duration_ms: number;
}

export interface WebhookEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface ConnectorManifest {
  name: string;
  version: string;
  schema_version: string;
  min_sdk_version: string;
  supported_entity_types: string[];
}

export interface ShipItConnector {
  readonly manifest: ConnectorManifest;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  discover(): Promise<DiscoveryResult>;
  fetch(entityType: string, cursor?: string): Promise<FetchResult>;
  normalize(raw: unknown[]): CanonicalEntity;
  sync(mode: 'full' | 'incremental'): Promise<SyncResult>;
  handleWebhook?(event: WebhookEvent): Promise<void>;
}
```

**Step 2: Implement the SDK Harness (auto-publish)**

The harness wraps a connector and handles:

- Calling `discover()` -> `fetch()` -> `normalize()` in sequence
- Auto-publishing `normalize()` output to the Event Bus
- Dry-run mode (preview without publishing)
- Sync state machine (IDLE -> SYNCING -> COMPLETING -> IDLE/DEGRADED/FAILED)

**Step 3: Write tests for the harness using a mock connector**

**Step 4: Commit**

```bash
git add packages/connector-sdk/
git commit -m "feat: implement Connector SDK with auto-publish harness and dry-run mode"
```

---

### Task 6: GitHub Connector (Team 4, Part 2)

**Goal:** Implement the GitHub connector that ingests repositories, teams, persons, pipelines (Actions workflows), and CODEOWNERS into the knowledge graph.

**Files:**

- Create: `packages/connectors/github/src/connector.ts`
- Create: `packages/connectors/github/src/auth.ts`
- Create: `packages/connectors/github/src/fetchers/repositories.ts`
- Create: `packages/connectors/github/src/fetchers/teams.ts`
- Create: `packages/connectors/github/src/fetchers/workflows.ts`
- Create: `packages/connectors/github/src/fetchers/codeowners.ts`
- Create: `packages/connectors/github/src/normalizers/repository.ts`
- Create: `packages/connectors/github/src/normalizers/team.ts`
- Create: `packages/connectors/github/src/normalizers/person.ts`
- Create: `packages/connectors/github/src/normalizers/pipeline.ts`
- Create: `packages/connectors/github/src/normalizers/codeowner.ts`
- Create: `packages/connectors/github/src/index.ts`
- Create: `packages/connectors/github/src/__tests__/normalizers.test.ts`
- Create: `packages/connectors/github/src/__tests__/connector.test.ts`

**Step 1: Implement GitHub App authentication**

Use `@octokit/auth-app` for GitHub App auth. Fallback to PAT via `@octokit/rest`.

**Step 2: Implement fetchers for each entity type**

Each fetcher handles pagination, rate limiting (respect `x-ratelimit-remaining` headers), and cursor-based iteration.

**Step 3: Implement normalizers**

Transform GitHub API responses into `CanonicalEntity` objects with proper claims:

| GitHub Entity    | Graph Mapping                                                         |
| ---------------- | --------------------------------------------------------------------- |
| Repository       | `Repository` node, `IMPLEMENTED_BY` edges (if service mapping exists) |
| Team             | `Team` node                                                           |
| Team members     | `Person` nodes + `MEMBER_OF` edges                                    |
| Actions workflow | `Pipeline` node + `BUILT_BY` edges                                    |
| CODEOWNERS       | `CODEOWNER_OF` edges to `Repository`                                  |

Linking keys follow the format: `github://{org}/{repo-name}` for repos, `github://{org}/team/{team-slug}` for teams.

**Step 4: Write tests with mocked GitHub API responses**

**Step 5: Commit**

```bash
git add packages/connectors/github/
git commit -m "feat: implement GitHub connector with repos, teams, workflows, CODEOWNERS"
```

---

### Task 7: API Server (Team 5)

**Goal:** Implement the Fastify API server that orchestrates connectors, manages schema, serves as the central API for the Web UI and MCP Server, and handles configuration.

**Files:**

- Create: `packages/api-server/src/server.ts`
- Create: `packages/api-server/src/config.ts`
- Create: `packages/api-server/src/routes/connectors.ts`
- Create: `packages/api-server/src/routes/schema.ts`
- Create: `packages/api-server/src/routes/graph.ts`
- Create: `packages/api-server/src/routes/health.ts`
- Create: `packages/api-server/src/services/connector-manager.ts`
- Create: `packages/api-server/src/services/schema-service.ts`
- Create: `packages/api-server/src/services/neo4j-service.ts`
- Create: `packages/api-server/src/middleware/error-handler.ts`
- Create: `packages/api-server/src/index.ts`
- Create: `packages/api-server/src/__tests__/routes/connectors.test.ts`
- Create: `packages/api-server/src/__tests__/routes/schema.test.ts`
- Create: `packages/api-server/Dockerfile`

**Step 1: Set up Fastify server with CORS, Swagger, health check**

```typescript
// packages/api-server/src/server.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';

export async function createServer() {
  const server = Fastify({ logger: true });

  await server.register(cors, { origin: true });
  await server.register(swagger, {
    openapi: {
      info: { title: 'ShipIt-AI API', version: '0.1.0' },
    },
  });

  // Register routes
  await server.register(import('./routes/health.js'), { prefix: '/api' });
  await server.register(import('./routes/connectors.js'), { prefix: '/api/connectors' });
  await server.register(import('./routes/schema.js'), { prefix: '/api/schema' });
  await server.register(import('./routes/graph.js'), { prefix: '/api/graph' });

  return server;
}
```

**Step 2: Implement connector management routes**

| Method | Path                         | Description                |
| ------ | ---------------------------- | -------------------------- |
| GET    | `/api/connectors`            | List configured connectors |
| POST   | `/api/connectors`            | Add a new connector        |
| GET    | `/api/connectors/:id`        | Get connector details      |
| POST   | `/api/connectors/:id/sync`   | Trigger sync               |
| GET    | `/api/connectors/:id/status` | Get sync status            |
| DELETE | `/api/connectors/:id`        | Remove connector           |

**Step 3: Implement schema management routes**

| Method | Path                   | Description                      |
| ------ | ---------------------- | -------------------------------- |
| GET    | `/api/schema`          | Get current schema               |
| PUT    | `/api/schema`          | Update schema (YAML body)        |
| POST   | `/api/schema/validate` | Validate schema without applying |

**Step 4: Implement graph query routes (BFF for Web UI)**

| Method | Path                          | Description                             |
| ------ | ----------------------------- | --------------------------------------- |
| GET    | `/api/graph/stats`            | Graph statistics                        |
| GET    | `/api/graph/neighborhood/:id` | Bounded neighborhood for Graph Explorer |
| GET    | `/api/graph/search`           | Entity search                           |

**Step 5: Write the Dockerfile**

```dockerfile
# packages/api-server/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json turbo.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/event-bus/ packages/event-bus/
COPY packages/api-server/ packages/api-server/
RUN npm ci
RUN npx turbo build --filter=@shipit-ai/api-server

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/packages/api-server/dist ./dist
COPY --from=builder /app/packages/api-server/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

**Step 6: Write tests**

**Step 7: Commit**

```bash
git add packages/api-server/
git commit -m "feat: implement API Server with connector, schema, and graph routes"
```

---

## WAVE 3: INTERFACE LAYER

---

### Task 8: MCP Server (Team 6)

**Goal:** Implement the MCP Server that exposes the knowledge graph as structured tool calls for AI agents. Phase 1a tools: `blast_radius`, `entity_detail`, `schema_info`. Phase 1b tools: `find_owners`, `dependency_chain`, `graph_stats`, `search_entities`.

**Files:**

- Create: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/src/tools/blast-radius.ts`
- Create: `packages/mcp-server/src/tools/entity-detail.ts`
- Create: `packages/mcp-server/src/tools/schema-info.ts`
- Create: `packages/mcp-server/src/tools/find-owners.ts`
- Create: `packages/mcp-server/src/tools/dependency-chain.ts`
- Create: `packages/mcp-server/src/tools/graph-stats.ts`
- Create: `packages/mcp-server/src/tools/search-entities.ts`
- Create: `packages/mcp-server/src/tools/graph-query.ts`
- Create: `packages/mcp-server/src/cypher/generator.ts`
- Create: `packages/mcp-server/src/cypher/traversal.ts`
- Create: `packages/mcp-server/src/envelope.ts`
- Create: `packages/mcp-server/src/errors.ts`
- Create: `packages/mcp-server/src/auth.ts`
- Create: `packages/mcp-server/src/config.ts`
- Create: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/src/__tests__/blast-radius.test.ts`
- Create: `packages/mcp-server/src/__tests__/entity-detail.test.ts`
- Create: `packages/mcp-server/src/__tests__/find-owners.test.ts`
- Create: `packages/mcp-server/src/__tests__/fixtures/reference-graph.ts`

**Step 1: Set up MCP Server using `@modelcontextprotocol/sdk`**

```typescript
// packages/mcp-server/src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function createMcpServer(neo4jDriver: Driver) {
  const server = new McpServer({
    name: 'shipit-ai',
    version: '0.1.0',
  });

  // Register tools
  registerBlastRadius(server, neo4jDriver);
  registerEntityDetail(server, neo4jDriver);
  registerSchemaInfo(server, neo4jDriver);
  registerFindOwners(server, neo4jDriver);
  registerDependencyChain(server, neo4jDriver);
  registerGraphStats(server, neo4jDriver);
  registerSearchEntities(server, neo4jDriver);
  registerGraphQuery(server, neo4jDriver);

  return server;
}
```

**Step 2: Implement the response envelope (ADR-008)**

```typescript
// packages/mcp-server/src/envelope.ts
export interface McpResponseMeta {
  tool: string;
  version: string;
  query_time_ms: number;
  node_count: number;
  truncated: boolean;
  data_quality: {
    stale_nodes: number;
    single_source_nodes: number;
  };
  cache_hit: boolean;
  next_cursor?: string;
  warnings: string[];
  suggested_follow_up: string[];
}

export interface McpResponse<T> {
  _meta: McpResponseMeta;
  data: T;
}

export function wrapResponse<T>(
  tool: string,
  data: T,
  opts: Partial<McpResponseMeta>,
): McpResponse<T> {
  return {
    _meta: {
      tool,
      version: '1.0',
      query_time_ms: opts.query_time_ms ?? 0,
      node_count: opts.node_count ?? 0,
      truncated: opts.truncated ?? false,
      data_quality: opts.data_quality ?? { stale_nodes: 0, single_source_nodes: 0 },
      cache_hit: opts.cache_hit ?? false,
      warnings: opts.warnings ?? [],
      suggested_follow_up: opts.suggested_follow_up ?? [],
    },
    data,
  };
}
```

**Step 3: Implement error responses**

```typescript
// packages/mcp-server/src/errors.ts
export type ErrorCode =
  | 'NODE_NOT_FOUND'
  | 'INVALID_CANONICAL_ID'
  | 'INVALID_PARAMETER'
  | 'DEPTH_EXCEEDED'
  | 'HOP_LIMIT_EXCEEDED'
  | 'QUERY_TIMEOUT'
  | 'ROW_LIMIT_EXCEEDED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'RBAC_DENIED'
  | 'TOOL_NOT_AVAILABLE'
  | 'INTERNAL_ERROR';

export interface McpError {
  error: {
    code: ErrorCode;
    message: string;
    suggestions: string[];
  };
}

export function createError(
  code: ErrorCode,
  message: string,
  suggestions: string[] = [],
): McpError {
  return { error: { code, message, suggestions } };
}
```

**Step 4: Implement `blast_radius` tool**

Parameters: `node` (canonical ID), `depth` (1-6, default 3), `direction` (DOWNSTREAM/UPSTREAM/BOTH), `production_only` (boolean).

Cypher pattern for downstream blast radius:

```cypher
MATCH path = (start {id: $node})-[*1..$depth]->(affected)
WHERE ALL(r IN relationships(path) WHERE type(r) IN $edge_types)
RETURN DISTINCT affected, length(path) as depth
ORDER BY depth
```

Edge types for downstream: IMPLEMENTED_BY^-1, DEPLOYED_AS, EMITS_TELEMETRY_AS, CALLS^-1, DEPENDS_ON^-1

**Step 5: Implement `entity_detail` tool**

Parameters: `entity` (canonical ID), `include_claims` (boolean), `include_neighbors` (boolean).

**Step 6: Implement `schema_info` tool**

No parameters. Returns schema from Neo4j meta-nodes or YAML config cache.

**Step 7: Implement `find_owners` tool**

Parameters: `entity` (canonical ID), `include_chain` (boolean).
Traverses: OWNS^-1, CODEOWNER_OF^-1, MEMBER_OF, ON_CALL_FOR^-1

**Step 8: Implement `graph_stats` tool**

No parameters. Returns node counts by label, edge counts by type, environments, freshness.

**Step 9: Implement `search_entities` tool**

Parameters: `label`, `property_filters`, `limit`, `sort_by`.

**Step 10: Implement `graph_query` (raw Cypher escape hatch)**

With guardrails: parameterized queries only, hop limit, timeout, row limit.

**Step 11: Create reference graph fixture for tests**

```typescript
// packages/mcp-server/src/__tests__/fixtures/reference-graph.ts
// A small deterministic graph for acceptance tests:
// - 5 LogicalServices (payments-api, config-service, ledger-service, card-issuance, auth-service)
// - 5 Repositories
// - 10 Deployments (2 per service: staging + prod)
// - 10 RuntimeServices
// - 3 Teams
// - 10 Persons
// - 5 Pipelines
// - 3 Monitors
// - 20+ relationships
```

**Step 12: Write acceptance tests for each tool**

Each test loads the reference graph, calls a tool, and asserts the response matches expected output.

**Step 13: Commit**

```bash
git add packages/mcp-server/
git commit -m "feat: implement MCP Server with blast_radius, entity_detail, find_owners, search, graph_stats tools"
```

---

### Task 9: Web UI - Foundation & Home View (Team 7, Part 1)

**Goal:** Set up the Next.js 14 application with App Router, Tailwind CSS, shadcn/ui, navigation structure, and the Home/Overview view.

**Files:**

- Create: `packages/web-ui/` (Next.js app via `create-next-app`)
- Create: `packages/web-ui/src/app/layout.tsx`
- Create: `packages/web-ui/src/app/page.tsx`
- Create: `packages/web-ui/src/app/globals.css`
- Create: `packages/web-ui/src/components/layout/sidebar.tsx`
- Create: `packages/web-ui/src/components/layout/header.tsx`
- Create: `packages/web-ui/src/components/layout/search-dialog.tsx`
- Create: `packages/web-ui/src/components/dashboard/graph-health.tsx`
- Create: `packages/web-ui/src/components/dashboard/quick-actions.tsx`
- Create: `packages/web-ui/src/components/dashboard/activity-feed.tsx`
- Create: `packages/web-ui/src/components/dashboard/stats-cards.tsx`
- Create: `packages/web-ui/src/lib/api.ts`
- Create: `packages/web-ui/src/lib/hooks/use-graph-stats.ts`
- Create: `packages/web-ui/src/stores/ui-store.ts`
- Create: `packages/web-ui/Dockerfile`

**Step 1: Initialize Next.js 14 with App Router**

```bash
cd packages && npx create-next-app@latest web-ui --typescript --tailwind --app --src-dir --no-import-alias
```

**Step 2: Install and configure shadcn/ui**

```bash
cd packages/web-ui && npx shadcn@latest init
npx shadcn@latest add button card badge input dialog command sheet tabs separator
```

**Step 3: Implement sidebar navigation**

Navigation structure per design doc Section 10.10:

- Home (overview)
- Explore > Graph Explorer
- Configure > Connector Hub
- Operations > Incident Mode

**Step 4: Implement Home/Overview page**

Components:

- Graph Health Summary (node/edge counts, staleness %, last sync)
- Quick Actions (Add connector, Explore graph)
- Stats Cards (services, repos, deployments, teams)
- Activity Feed (last 50 events)

**Step 5: Implement Global Search (Cmd/Ctrl+K)**

Using shadcn Command component for the search dialog.

**Step 6: Set up API client and React Query provider**

```typescript
// packages/web-ui/src/lib/api.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function fetchGraphStats() {
  const res = await fetch(`${API_URL}/api/graph/stats`);
  return res.json();
}
```

**Step 7: Write Dockerfile**

**Step 8: Commit**

```bash
git add packages/web-ui/
git commit -m "feat: implement Web UI foundation with Home view, sidebar, global search"
```

---

### Task 10: Web UI - Graph Explorer (Team 7, Part 2)

**Goal:** Implement the Graph Explorer view with Cytoscape.js visualization, server-side aggregation, filter panel, and node interactions.

**Files:**

- Create: `packages/web-ui/src/app/explore/page.tsx`
- Create: `packages/web-ui/src/components/graph/graph-canvas.tsx`
- Create: `packages/web-ui/src/components/graph/graph-controls.tsx`
- Create: `packages/web-ui/src/components/graph/filter-panel.tsx`
- Create: `packages/web-ui/src/components/graph/node-detail-panel.tsx`
- Create: `packages/web-ui/src/components/graph/search-bar.tsx`
- Create: `packages/web-ui/src/lib/graph/cytoscape-config.ts`
- Create: `packages/web-ui/src/lib/graph/layouts.ts`
- Create: `packages/web-ui/src/lib/graph/styles.ts`
- Create: `packages/web-ui/src/lib/hooks/use-graph-data.ts`
- Create: `packages/web-ui/src/stores/graph-store.ts`

**Step 1: Set up Cytoscape.js with React wrapper**

```bash
npm install cytoscape cytoscape-dagre cytoscape-cose-bilkent @types/cytoscape
```

**Step 2: Implement graph canvas with layout switching**

Support 3 layouts:

- Dagre (hierarchical) -- default
- Force-directed (CoSE) -- general exploration
- Concentric -- blast radius visualization

**Step 3: Implement filter panel**

Filters: node labels, environment, tier, owner team. Real-time filtering.

**Step 4: Implement node interactions**

- Single-click: slide-in detail panel
- Double-click: navigate to entity detail
- Right-click: context menu

**Step 5: Implement server-side neighborhood fetching**

BFF endpoint: `/api/graph/neighborhood/:id` returns Cytoscape-compatible JSON.

**Step 6: Commit**

```bash
git add packages/web-ui/
git commit -m "feat: implement Graph Explorer with Cytoscape.js, filters, node interactions"
```

---

### Task 11: Web UI - Connector Hub (Team 7, Part 3)

**Goal:** Implement the Connector Hub view for managing integrations.

**Files:**

- Create: `packages/web-ui/src/app/connectors/page.tsx`
- Create: `packages/web-ui/src/components/connectors/connector-card.tsx`
- Create: `packages/web-ui/src/components/connectors/connector-detail.tsx`
- Create: `packages/web-ui/src/components/connectors/add-connector-dialog.tsx`
- Create: `packages/web-ui/src/components/connectors/sync-history.tsx`
- Create: `packages/web-ui/src/components/connectors/dlq-inspector.tsx`

**Step 1: Implement connector grid**

Grid of connector cards showing: icon, name, status badge, last sync, entity count.

**Step 2: Implement connector detail panel**

Shows sync history, error log, DLQ inspector, re-sync button, configuration.

**Step 3: Implement "Add Connector" dialog**

Step-by-step wizard: Select type -> Authenticate -> Scope -> Sync.

**Step 4: Commit**

```bash
git add packages/web-ui/
git commit -m "feat: implement Connector Hub with connector grid, detail panel, add wizard"
```

---

### Task 12: Integration & Docker Compose (All Teams)

**Goal:** Wire everything together. Ensure `docker-compose up` starts all services and the Walking Skeleton milestone works: connect GitHub -> answer a blast radius question in < 15 minutes.

**Files:**

- Modify: `docker/docker-compose.yml` (finalize all service definitions)
- Create: `packages/core-writer/Dockerfile`
- Create: `scripts/seed-demo.ts` (optional demo data seeder)

**Step 1: Build and test all Docker images**

Run: `docker compose build`

**Step 2: Run the full stack**

Run: `cd docker && docker compose up`
Expected: All services start, Web UI accessible at http://localhost:3000.

**Step 3: End-to-end test: GitHub connector -> graph query**

1. Configure GitHub connector via UI or API
2. Trigger sync
3. Open Graph Explorer, verify nodes appear
4. Use MCP tools to run blast_radius query

**Step 4: Final commit**

```bash
git add .
git commit -m "feat: complete Phase 1a Walking Skeleton - Docker Compose, full integration"
```

---

## Phase 1b Additions (Weeks 5-8)

### Task 13: Kubernetes Connector

Implement the K8s connector with Watch API streaming + hourly reconciliation. Entity types: Namespaces, Deployments, StatefulSets, Services, CronJobs.

### Task 14: Additional MCP Tools

Implement Phase 1b tools: `recent_changes`, `health_check`, `list_violations`, `change_impact`, `team_topology`.

### Task 15: Onboarding Wizard

Implement the 7-step first-run onboarding flow in the Web UI.

### Task 16: Acceptance Test Suite

Build reference graph fixtures and comprehensive acceptance tests for all MCP tools.

---

## Dependency Graph

```
Task 1 (Scaffolding) ──┐
                        ├──> Task 3 (Event Bus) ──┐
Task 2 (Data Model) ───┤                          ├──> Task 8 (MCP Server)
                        ├──> Task 4 (Core Writer) ─┤
                        ├──> Task 5 (Conn SDK) ────┤──> Task 9-11 (Web UI)
                        ├──> Task 6 (GitHub Conn)  │
                        └──> Task 7 (API Server) ──┘
                                                    └──> Task 12 (Integration)
```

---

## Walking Skeleton Milestone Criteria

> `docker-compose up` -> connect GitHub -> answer a blast radius question in < 15 minutes from cold start.

| Criterion              | Target                     |
| ---------------------- | -------------------------- |
| Time-to-first-insight  | < 15 minutes               |
| Memory footprint       | < 4 GB                     |
| Blast radius accuracy  | > 70% on reference queries |
| MCP tool response time | < 3s P95                   |
