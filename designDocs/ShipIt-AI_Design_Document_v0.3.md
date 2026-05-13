# ShipIt-AI -- AI-Ready Knowledge Graph Builder

**Product Requirements & Technical Design Document**

**Version 0.3 -- Draft Under Review**\
**Date: 2026-02-28**\
**Author: Mohamed El-Malah**\
**Classification: Confidential**

---

## Document Control

| Field            | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Document Title   | ShipIt-AI -- AI-Ready Knowledge Graph Builder         |
| Version          | 0.3                                                   |
| Author           | Mohamed El-Malah                                      |
| Status           | Draft -- Under Review                                 |
| Last Updated     | 2026-02-28                                            |
| Licensing Model  | Open-Core (Free base + Paid team/enterprise features) |
| Deployment Model | Self-hosted (Docker/K8s) and Managed SaaS             |

---

## Change Log

| Version | Date       | Summary of Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1     | 2026-02-15 | Initial draft -- core concept, ontology sketch, connector list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.2     | 2026-02-27 | Full design document -- claim-based provenance, Event Bus architecture, MCP tool contracts, identity strategy, Schema Editor, deployment architecture, roadmap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.3     | 2026-02-28 | **Major revision.** PropertyClaims stored as JSON on nodes (ADR-002). Phase 1 scope reduced -- no Vector DB, no Kafka requirement, no Schema Editor UI. Tiered Event Bus: BullMQ/Redis for Lite Mode, Kafka/Redpanda for Production (ADR-004). YAML-first schema configuration (ADR-006). Three-tier licensing (Community/Team/Enterprise). Phased identity resolution -- fuzzy match deferred to Phase 2 (ADR-010). "AI-Native" renamed to "AI-Ready." Connector SDK removes `publish()` -- SDK harness auto-publishes. Core Writer changed to partition-affine stateful. Confidence decay model added. New MCP tools: `graph_stats`, `search_entities`, `recent_changes`, `health_check`, `list_violations`. Raw Cypher available in all tiers with limits. BuildArtifact and Environment entity types added. Simple Mode for small orgs (ADR-011). |

---

## Referenced ADRs

| ADR     | Title                                                              | Status   |
| ------- | ------------------------------------------------------------------ | -------- |
| ADR-001 | Commit to TypeScript for API Server                                | Accepted |
| ADR-002 | Store PropertyClaims as JSON on Entity Nodes                       | Accepted |
| ADR-003 | Phase 1 MVP Scope Definition                                       | Accepted |
| ADR-004 | Tiered Event Bus: In-Process Queue for Small, Kafka for Production | Accepted |
| ADR-005 | Defer Vector Database and Semantic Search to Phase 2               | Accepted |
| ADR-006 | Schema Configuration Phasing -- YAML First, Visual Editor Later    | Accepted |
| ADR-007 | Neo4j High Availability Strategy                                   | Accepted |
| ADR-008 | MCP Response Envelope Standard                                     | Accepted |
| ADR-009 | Store Schema in Neo4j as Meta-Nodes                                | Accepted |
| ADR-010 | Identity Resolution Phasing                                        | Accepted |
| ADR-011 | Service Model Simple Mode                                          | Accepted |
| ADR-012 | Accessibility Standards                                            | Accepted |

---

## Table of Contents (Part 1 -- Sections 1-9)

1. [Executive Summary](#1-executive-summary)
2. [Product Vision & Scope](#2-product-vision--scope)
3. [System Architecture](#3-system-architecture)
4. [Knowledge Graph Ontology](#4-knowledge-graph-ontology)
5. [Identity Strategy & Entity Deduplication](#5-identity-strategy--entity-deduplication)
6. [Ingestion Architecture](#6-ingestion-architecture)
7. [Conflict Resolution & Provenance](#7-conflict-resolution--provenance)
8. [Integration Connectors](#8-integration-connectors)
9. [MCP Server (AI Agent Interface)](#9-mcp-server-ai-agent-interface)

---

## 1. Executive Summary

### 1.1 TL;DR

ShipIt-AI is an open-core, AI-Ready knowledge graph platform that automatically discovers, maps, and maintains your entire software ecosystem -- logical services, repositories, CI/CD pipelines, runtime deployments, monitors, teams, and their relationships -- into a queryable Neo4j knowledge graph.

It exposes this graph via an MCP (Model Context Protocol) server with structured, safe tool calls, enabling AI agents (Claude, GPT, Copilot) to answer complex topology questions like:

- "If I push a commit to repo X, what is the blast radius across all environments?"
- "Which LogicalServices have no active on-call rotation?"
- "What is the dependency chain from this Kubernetes deployment back to its CODEOWNERS?"
- "Show me all RuntimeServices owned by Team Y that have degraded SLOs."

**v0.3 emphasizes a phased approach.** Phase 1 delivers the core graph, claim-based provenance with JSON storage, a Lite Mode deployment (BullMQ on Redis -- no Kafka, no Vector DB), YAML-driven schema configuration, and the MCP server with structural query tools. Semantic search (vector embeddings), the visual Schema Editor UI, and fuzzy identity matching are deferred to Phase 2. This scope reduction accelerates time-to-value from months to weeks.

### 1.2 Problem Statement

Engineering organizations accumulate institutional knowledge across dozens of disconnected systems: GitHub, Kubernetes, Datadog, Backstage, Jira, identity providers, CI/CD platforms. No single system holds the full picture. Engineers context-switch between tools to answer basic questions about ownership, dependencies, and blast radius.

Current approaches fail in predictable ways:

- **Catalogs are incomplete.** Backstage, ServiceNow, and similar catalogs contain valuable data but lack deep relationship traversal, multi-source provenance, and AI-optimized query interfaces.
- **CMDBs are write-only graveyards.** ServiceNow and similar tools accumulate stale data because they depend on manual entry with no automated reconciliation.
- **Tribal knowledge is volatile.** Critical context lives in Slack threads, people's heads, and undiscoverable wiki pages.
- **AI agents are blind.** LLMs cannot reason about your infrastructure because the data is not connected, attributed, or queryable through structured tool calls.

**ShipIt-AI treats Backstage, ServiceNow, and other catalogs as data sources, not competitors to replace.** It is a companion that adds a connected graph, multi-source provenance, conflict resolution, and an AI-optimized query layer on top of your existing tools. If you already have Backstage, ShipIt-AI makes it more valuable by connecting its data to Kubernetes, Datadog, GitHub, Jira, and identity providers in a single traversable graph.

### 1.3 Key Design Decisions (v0.3)

This version commits to several hard architectural decisions, each backed by a formal ADR:

| Decision                       | Detail                                                                                                                                                                 | ADR     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **TypeScript committed**       | API Server, Core Writer, Connector SDK, MCP Server -- all TypeScript. Single-language stack with the Next.js frontend.                                                 | ADR-001 |
| **Claims as JSON on nodes**    | PropertyClaims stored as a `_claims` JSON property on entity nodes, not as separate graph nodes. Reduces write amplification from ~45 ops to ~2 ops per entity update. | ADR-002 |
| **Phase 1 scope reduction**    | No Vector DB, no Kafka requirement, no visual Schema Editor, no fuzzy identity matching in Phase 1.                                                                    | ADR-003 |
| **Lite Mode event queue**      | BullMQ on Redis for Lite Mode; Kafka/Redpanda for Production. SDK abstracts the difference.                                                                            | ADR-004 |
| **No Vector DB Phase 1**       | Structural search only in Phase 1. Vector embeddings and semantic search deferred to Phase 2.                                                                          | ADR-005 |
| **YAML schema config**         | Phase 1 schema configuration via YAML/JSON files. Form-based UI in Phase 2, full visual editor in Phase 3.                                                             | ADR-006 |
| **Phased identity resolution** | Primary Key + Linking Key in Phase 1. Fuzzy matching with vector similarity in Phase 2.                                                                                | ADR-010 |

### 1.4 Value Proposition

| Capability            | Without ShipIt-AI               | With ShipIt-AI                                     |
| --------------------- | ------------------------------- | -------------------------------------------------- |
| Blast radius analysis | Manual repo-by-repo tracing     | AI agent traverses graph in seconds                |
| Ownership discovery   | Grep CODEOWNERS + Slack someone | Query: "who owns this LogicalService?"             |
| Dependency mapping    | Out-of-date wiki diagrams       | Live, auto-updated graph with provenance           |
| Incident response     | War room context-building       | Agent pre-loads full context from graph            |
| Compliance auditing   | Spreadsheet hell                | Graph query: unmonitored services, missing on-call |
| Onboarding            | 3-week ramp-up                  | "Explain the payment processing domain"            |

---

## 2. Product Vision & Scope

### 2.1 Design Principles

| Principle                              | Description                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI-Ready with roadmap to AI-Native** | The graph is designed to be consumed by AI agents, not just humans. Schema, traversal patterns, and tool contracts are optimized for LLM tool use. Phase 1 delivers structural queries; Phase 2 adds vector embeddings and semantic search for full AI-Native capability.           |
| **Discover > Declare**                 | Automate data ingestion from source-of-truth systems. Manual declaration is a fallback, not the primary input mechanism.                                                                                                                                                            |
| **Schema Flexibility**                 | Provide a comprehensive starter template, but let users add/remove/edit node types and relationships before and after graph population.                                                                                                                                             |
| **Living Graph**                       | Continuous sync, not one-time import. Event-driven updates via Event Bus keep the graph fresh.                                                                                                                                                                                      |
| **Provenance Everywhere**              | Every property has a source, confidence, and evidence trail. No magic values without attribution.                                                                                                                                                                                   |
| **Open-Core**                          | Free self-hosted base with community integrations. Team and Enterprise tiers add SSO, RBAC, premium connectors, and managed hosting.                                                                                                                                                |
| **Backstage Coexistence**              | ShipIt-AI is designed to work alongside Backstage, not replace it. Backstage is a first-class data source. Organizations with existing Backstage investments gain immediate value by connecting their catalog data to runtime, observability, and identity data in a unified graph. |

### 2.2 User Personas

| Persona                       | Role                            | Primary Use Case                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform Engineer             | Builds & operates the IDP       | Deploy ShipIt-AI, configure integrations, define schema, manage connectors                                                                                                                                                                                                                                                                                                                                                                                                  |
| Staff/Principal Engineer      | Architecture & system design    | Blast radius analysis, dependency reviews, migration planning                                                                                                                                                                                                                                                                                                                                                                                                               |
| SRE / On-Call                 | Incident response & reliability | "What depends on this failing service?" during incidents                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Engineering Manager           | Team ownership & planning       | Ownership gaps, team topology, tech debt visibility                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AI Agent (Claude/GPT/Copilot) | Automated reasoning             | MCP tool calls to traverse graph and answer topology questions. Agents operate within tool contracts -- they call `blast_radius`, `find_owners`, `entity_detail`, etc. with structured parameters and receive structured JSON responses. Agents never write raw Cypher by default. In multi-agent workflows, agents can compose tool calls (e.g., `blast_radius` followed by `find_owners` for each affected service) to build comprehensive incident context autonomously. |

### 2.3 Licensing & Tier Structure

| Feature                                                             | Community (Free)                                   | Team ($)                       | Enterprise ($$)              |
| ------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------ | ---------------------------- |
| Core graph engine (Neo4j)                                           | Yes                                                | Yes                            | Yes                          |
| MCP Server (structured tools)                                       | Yes                                                | Yes                            | Yes                          |
| All V1 connectors (GitHub, K8s, Datadog, Backstage, Jira, Identity) | Yes                                                | Yes                            | Yes                          |
| YAML schema configuration                                           | Yes                                                | Yes                            | Yes                          |
| Basic audit logging (stdout/file)                                   | Yes                                                | Yes                            | Yes                          |
| Read-only team-scoped views                                         | Yes                                                | Yes                            | Yes                          |
| Raw Cypher (`graph_query`)                                          | 100 queries/day, read-only, 10s timeout, 1000 rows | 500 queries/day, saved queries | Unlimited + full audit trail |
| Basic Claim Explorer (effective values + source attribution)        | Yes                                                | Yes                            | Yes                          |
| SSO / SAML                                                          | --                                                 | Yes                            | Yes                          |
| Basic RBAC                                                          | --                                                 | Yes                            | Yes                          |
| Premium connectors (up to 3)                                        | --                                                 | Yes (3 included)               | All premium connectors       |
| Enhanced Claim Explorer                                             | --                                                 | Yes                            | Yes                          |
| Query Playground with saved queries                                 | --                                                 | Yes                            | Yes                          |
| Full RBAC with graph-level ACLs                                     | --                                                 | --                             | Yes                          |
| Full Claim Explorer with override                                   | --                                                 | --                             | Yes                          |
| Multi-tenant isolation                                              | --                                                 | --                             | Yes                          |
| Managed SaaS hosting                                                | --                                                 | --                             | Yes                          |
| SLA-backed support                                                  | --                                                 | --                             | Yes                          |

---

## 3. System Architecture

### 3.1 High-Level Architecture

ShipIt-AI is built entirely in **TypeScript** (ADR-001). The architecture consists of six core subsystems connected through a tiered Event Bus.

```
                         ┌──────────────────────────────────┐
                         │           Web UI (Next.js)        │
                         │  Graph Explorer, Claim Explorer,  │
                         │  Connector Hub, Schema Config     │
                         └──────────────┬───────────────────┘
                                        │ REST / GraphQL
                                        ▼
┌─────────────────┐     ┌──────────────────────────────────┐     ┌──────────────────┐
│   Connectors    │     │         API Server (TS)           │     │   MCP Server     │
│                 │     │  Orchestration, Auth, Schema Mgmt │     │  (Tool Calls)    │
│  GitHub         │     └──────────┬───────────┬───────────┘     └────────┬─────────┘
│  Kubernetes     │                │           │                          │
│  Datadog        │                │           │                          │
│  Backstage      │                │           ▼                          │
│  Jira           │     ┌─────────▼──────────────────────┐               │
│  Identity       │     │     Event Bus Interface SDK     │               │
└────────┬────────┘     │  ┌───────────┐ ┌─────────────┐ │               │
         │              │  │  BullMQ   │ │   Kafka /   │ │               │
         │ normalize()  │  │ (on Redis)│ │  Redpanda   │ │               │
         ▼              │  │ Lite Mode │ │ Production  │ │               │
┌────────────────┐      │  └───────────┘ └─────────────┘ │               │
│ Connector SDK  │──────▶  (ADR-004: same interface)     │               │
│ auto-publishes │      └──────────────┬─────────────────┘               │
└────────────────┘                     │                                  │
                                       ▼                                  │
                         ┌──────────────────────────────────┐             │
                         │       Core Writer (TS)            │             │
                         │  Sole writer to Neo4j             │             │
                         │  Claim resolution, materialization│             │
                         │  Idempotency, partition-affine    │             │
                         └──────────────┬───────────────────┘             │
                                        │                                  │
                                        ▼                                  │
                         ┌──────────────────────────────────┐             │
                         │         Neo4j (Graph DB)          │◀────────────┘
                         │  Nodes, Edges, Claims (JSON),     │   Cypher queries
                         │  Effective properties, Indexes    │
                         └──────────────────────────────────┘
```

> **Phase 1 note:** No Vector DB. Semantic search is deferred to Phase 2 (ADR-005). The diagram above reflects the Phase 1 architecture. Phase 2 adds a Vector Store (Weaviate/Qdrant) downstream of the Core Writer with an Embedding Generator consumer.

| Subsystem          | Responsibility                                                                                                 | Technology                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Web UI (Dashboard) | Schema config viewer, graph visualization, connector config, onboarding wizard, claim explorer                 | Next.js + React, Tailwind, Cytoscape.js            |
| API Server         | REST + GraphQL API, orchestrates connectors, manages schema, serves MCP tools                                  | Node.js (TypeScript)                               |
| Event Bus          | Decouples connectors from graph writes; at-least-once delivery, replay support                                 | BullMQ/Redis (Lite) or Kafka/Redpanda (Production) |
| Core Writer        | Sole component that writes to Neo4j. Consumes from Event Bus, applies claims, resolves conflicts, materializes | Partition-affine stateful consumer (TS)            |
| Graph Engine       | Stores and queries the knowledge graph (nodes, edges, claims as JSON)                                          | Neo4j, Cypher query language                       |
| Connector Runtime  | Executes data ingestion pipelines per integration, publishes to Event Bus via SDK                              | Plugin-based, containerized workers                |

### 3.2 Data Flow (Ingestion Pipeline)

All data flows through the **Event Bus Interface** abstraction layer. Connectors never call `publish()` directly -- the Connector SDK harness auto-publishes the output of `normalize()`.

```
Source System      Connector         SDK Harness        Event Bus         Core Writer        Neo4j
     │                │                   │                │                  │                │
     │◄──fetch()──────│                   │                │                  │                │
     │───raw data────►│                   │                │                  │                │
     │                │──normalize()──────►                │                  │                │
     │                │                   │                │                  │                │
     │                │  CanonicalEntity[] │                │                  │                │
     │                │◄──────────────────│                │                  │                │
     │                │                   │──publish()────►│                  │                │
     │                │                   │  (auto)        │                  │                │
     │                │                   │                │──consume()──────►│                │
     │                │                   │                │                  │──MERGE────────►│
     │                │                   │                │                  │  claims (JSON) │
     │                │                   │                │                  │  effective props│
     │                │                   │                │                  │◄──ack──────────│
```

**Step-by-step:**

1. **Connector** calls `fetch()` to pull raw data from the source system (GitHub API, K8s API, Datadog API, etc.)
2. **Connector** calls `normalize()` to transform raw data into `CanonicalEntity[]` payloads with claims
3. **SDK Harness** auto-publishes normalized events to the Event Bus, keyed by canonical entity ID
4. **Core Writer** consumes events as the sole writer to Neo4j
5. **Core Writer** applies claim resolution -- evaluates conflict resolution strategy per property, updates the `_claims` JSON property, materializes effective properties on entity nodes
6. **MCP Server** exposes graph traversal as structured tool calls for AI agents

### 3.3 Deployment Architecture

ShipIt-AI supports self-hosted and managed SaaS deployment. Phase 1 introduces **Lite Mode** -- a minimal deployment that requires only four components.

#### Lite Mode Deployment (Phase 1 Default)

```
┌─────────────────────────────────────────────────┐
│              Docker Compose / Single Host         │
│                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │  API Server │  │  Core      │  │  Web UI    │ │
│  │  + MCP      │  │  Writer    │  │  (Next.js) │ │
│  │  Server     │  │            │  │            │ │
│  └──────┬─────┘  └──────┬─────┘  └────────────┘ │
│         │               │                         │
│         ▼               ▼                         │
│  ┌────────────┐  ┌────────────┐                  │
│  │   Neo4j    │  │   Redis    │                  │
│  │ (Graph DB) │  │ (BullMQ)   │                  │
│  └────────────┘  └────────────┘                  │
└─────────────────────────────────────────────────┘
```

No Kafka. No Vector DB. No Weaviate. Just the API Server, Neo4j, Redis (for BullMQ event queue), and the Web UI.

#### Production Deployment

| Component         | Self-Hosted                          | Managed SaaS                        |
| ----------------- | ------------------------------------ | ----------------------------------- |
| Web UI            | Docker container / K8s Deployment    | CDN + managed Next.js               |
| API Server        | Docker container on K8s              | Auto-scaled container fleet         |
| Event Bus         | Kafka/Redpanda (Docker or Helm)      | Managed Kafka or cloud-native queue |
| Core Writer       | K8s Deployment (1+ replicas)         | Auto-scaled consumer fleet          |
| Neo4j             | Self-hosted Docker or Neo4j Aura     | Neo4j Aura (managed)                |
| Vector Store      | Weaviate/Qdrant container (Phase 2+) | Managed Weaviate Cloud (Phase 2+)   |
| Connector Workers | K8s Jobs or CronJobs                 | Managed job scheduler               |

#### Hardware Requirements

| Size   | Services  | RAM     | CPU      | Disk    | Notes                                               |
| ------ | --------- | ------- | -------- | ------- | --------------------------------------------------- |
| Small  | <100      | 4 GB    | 2 cores  | 20 GB   | Lite Mode. Single Docker Compose host.              |
| Medium | 100-1,000 | 8-16 GB | 4 cores  | 100 GB  | Lite or Production mode. Neo4j needs dedicated RAM. |
| Large  | 1,000+    | 32 GB+  | 8+ cores | 500 GB+ | Production mode with Kafka. K8s recommended.        |

### 3.4 Neo4j High Availability (ADR-007)

| Tier       | Strategy                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Community  | Single Neo4j instance + daily backups + Event Bus replay for disaster recovery. RPO = 24 hours (backup) or near-zero (event replay). RTO = minutes (restore backup) to hours (full replay). |
| Enterprise | Neo4j causal clustering. Write leader for Core Writer. Read replicas for MCP Server queries. Automatic leader election on failure. RPO = near-zero. RTO = seconds.                          |

---

## 4. Knowledge Graph Ontology

### 4.1 Ontology Design Philosophy

The ontology separates **logical identity** from **runtime behavior** from **deployment topology**. A single "service" is not one node -- it is a constellation of related nodes:

- **LogicalService** -- The named, team-owned concept (e.g., "payments-api"). Exists regardless of how many places it is deployed.
- **Repository** -- The source code that implements a LogicalService. One LogicalService may be implemented by one or more repositories.
- **Deployment** -- A running instance of a LogicalService in a specific environment/cluster/namespace. One LogicalService has many Deployments (dev, staging, prod, multi-region).
- **RuntimeService** -- What the observability stack sees. The name Datadog, Jaeger, or APM tools use for this service. One Deployment may emit telemetry as one or more RuntimeServices.

This four-node model eliminates the "Service means different things to different connectors" problem and enables precise blast radius analysis across the full stack.

```
  ┌─────────────────┐
  │  LogicalService  │──IMPLEMENTED_BY──>┌────────────┐
  │  payments-api    │                    │ Repository │
  │                  │──IMPLEMENTED_BY──>│ pay-api    │
  └────────┬────────┘                    │ pay-config │
           │                              └────────────┘
     DEPLOYED_AS
           │
    ┌──────┴──────────────────────┐
    v              v              v
┌──────────┐ ┌──────────┐ ┌──────────┐
│Deployment│ │Deployment│ │Deployment│
│  dev     │ │ staging  │ │  prod    │
└────┬─────┘ └────┬─────┘ └────┬─────┘
     │             │             │
 EMITS_TELEMETRY_AS         EMITS_TELEMETRY_AS
     │             │             │
     v             v        ┌────┴────┐
┌──────────┐ ┌──────────┐  v         v
│ Runtime  │ │ Runtime  │┌────────┐┌────────┐
│ pay-api  │ │ pay-api  ││pay-api ││pay-wkr │
│  -dev    │ │ -staging │└────────┘└────────┘
└──────────┘ └──────────┘  (prod)    (prod)
```

**Simple Mode (ADR-011).** For organizations with fewer than 100 services, the four-node model may be unnecessary overhead. Simple Mode collapses LogicalService, Deployment, and RuntimeService into a single `Service` node. This is a schema configuration option (`mode: simple` in `shipit-schema.yaml`). Migration from Simple Mode to Full Mode is supported -- the migration tool splits `Service` nodes into the full constellation based on available linking keys and source data. Simple Mode is a starting point, not a dead end.

**Monorepo guidance.** A single Repository can have multiple `IMPLEMENTED_BY` edges from different LogicalServices. This is the expected pattern for monorepos: `payments-api`, `payments-worker`, and `payments-cron` may all point to `IMPLEMENTED_BY -> monorepo-payments`. The Repository node represents the repo, not the service.

**Sidecar guidance.** A single Deployment can have `DEPLOYED_AS` edges from multiple LogicalServices when a pod runs multiple containers (e.g., main app + envoy sidecar + log shipper). Each logical service maps to its own `DEPLOYED_AS` edge to the shared Deployment.

### 4.2 Core Entity Types (Starter Template)

| Node Label     | Description                                  | Primary Source(s)            | Key Properties                                           |
| -------------- | -------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| LogicalService | A named, team-owned service concept          | Backstage, manual            | name, tier, lifecycle, domain, language                  |
| Repository     | A source code repository                     | GitHub                       | name, url, default_branch, visibility, language          |
| Deployment     | A running instance in a specific env/cluster | K8s, ArgoCD                  | namespace, cluster, environment, image, replicas, status |
| RuntimeService | The identity seen by observability tools     | Datadog, APM tools           | name, dd_service, apm_name, environment                  |
| BuildArtifact  | A built container image or binary            | CI/CD, Registry              | name, image_tag, sha, build_time, registry               |
| Environment    | A deployment target environment              | K8s, Cloud provider, manual  | name, type, region, cluster, classification              |
| Team           | An engineering team or squad                 | Identity Provider, Backstage | name, slug, cost_center, manager                         |
| Person         | An individual (engineer, PM, etc.)           | Identity Provider, GitHub    | name, email, role, github_handle                         |
| ServiceAccount | A non-human identity (bot, CI, AI agent)     | GitHub, K8s, Cloud IAM       | name, type, owner_team, permissions                      |
| Pipeline       | A CI/CD workflow                             | GitHub Actions, ArgoCD       | name, trigger, repo, status, last_run                    |
| Monitor        | An observability check (alert, SLO)          | Datadog                      | name, type, query, threshold, status                     |
| Namespace      | A Kubernetes namespace                       | K8s                          | name, cluster, labels                                    |
| Cluster        | A Kubernetes cluster                         | K8s, Cloud provider          | name, provider, region, version                          |
| Domain         | A business domain grouping                   | Backstage, Manual            | name, description, owner_team                            |
| API            | A published API (REST, gRPC, event)          | Backstage, OpenAPI specs     | name, type, version, spec_url                            |
| Library        | A shared internal package/dependency         | GitHub, Package registries   | name, version, language                                  |
| Infrastructure | A cloud resource (RDS, S3, SQS, etc.)        | Terraform state, Cloud APIs  | type, arn, region, tags                                  |
| Document       | A runbook, ADR, or wiki page                 | Confluence, GitHub, Notion   | title, url, last_updated, author                         |
| WorkItem       | A Jira issue (story, task, bug)              | Jira                         | key, summary, status, priority, type                     |
| Epic           | A Jira epic grouping work items              | Jira                         | key, summary, status, owner, target_date                 |

#### Jira Extended (Optional)

These node types are only created when the Jira connector is enabled and the `jira_extended` schema option is set to `true`:

| Node Label | Description                  | Primary Source | Key Properties                              |
| ---------- | ---------------------------- | -------------- | ------------------------------------------- |
| Sprint     | A Jira sprint                | Jira           | name, board, start_date, end_date, velocity |
| Release    | A Jira fix version / release | Jira           | name, release_date, status                  |

### 4.3 Core Relationship Types (Starter Template)

| Relationship       | From -> To                                          | Description                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMPLEMENTED_BY     | LogicalService -> Repository                        | LogicalService is implemented by this repo                                                                                                                                                                                            |
| DEPLOYED_AS        | LogicalService -> Deployment                        | LogicalService has this running deployment                                                                                                                                                                                            |
| EMITS_TELEMETRY_AS | Deployment -> RuntimeService                        | Deployment is observed as this RuntimeService by APM/monitoring. **N:M** -- one Deployment can emit as multiple RuntimeServices (sidecar pattern), and one RuntimeService name can be emitted by multiple Deployments (multi-region). |
| BUILT_FROM         | BuildArtifact -> Repository                         | Build artifact was built from this repository                                                                                                                                                                                         |
| RUNS_IMAGE         | Deployment -> BuildArtifact                         | Deployment runs this container image / build artifact                                                                                                                                                                                 |
| RUNS_IN_ENV        | Deployment -> Environment                           | Deployment runs in this environment                                                                                                                                                                                                   |
| HOSTED_ON          | Environment -> Cluster                              | Environment is hosted on this cluster                                                                                                                                                                                                 |
| DEPENDS_ON         | LogicalService -> LogicalService                    | Logical dependency between services (design-time)                                                                                                                                                                                     |
| CALLS              | RuntimeService -> RuntimeService                    | Observed runtime call between services (from tracing/service map)                                                                                                                                                                     |
| OWNS               | Team -> LogicalService/Repository                   | Team is the owner                                                                                                                                                                                                                     |
| MEMBER_OF          | Person -> Team                                      | Person belongs to a team                                                                                                                                                                                                              |
| CONTRIBUTES_TO     | Person -> Repository                                | Person has committed to this repo                                                                                                                                                                                                     |
| RUNS_IN            | Deployment -> Namespace                             | Deployment runs in this K8s namespace                                                                                                                                                                                                 |
| PART_OF            | Namespace -> Cluster                                | Namespace belongs to a cluster                                                                                                                                                                                                        |
| BUILT_BY           | LogicalService -> Pipeline                          | LogicalService is built/deployed by this pipeline                                                                                                                                                                                     |
| TRIGGERS           | Pipeline -> Pipeline                                | Pipeline triggers another pipeline                                                                                                                                                                                                    |
| MONITORS           | Monitor -> LogicalService/Deployment/RuntimeService | Monitor watches this entity                                                                                                                                                                                                           |
| EXPOSES            | LogicalService -> API                               | LogicalService exposes this API                                                                                                                                                                                                       |
| CONSUMES           | LogicalService -> API                               | LogicalService consumes this API                                                                                                                                                                                                      |
| USES               | LogicalService -> Infrastructure                    | LogicalService depends on this infra resource                                                                                                                                                                                         |
| MANAGED_BY         | ServiceAccount -> Team                              | Service account is managed by this team                                                                                                                                                                                               |
| HAS_ACCESS_TO      | ServiceAccount -> LogicalService/Infrastructure     | Service account can access this resource                                                                                                                                                                                              |
| IMPLEMENTS         | LogicalService -> Domain                            | LogicalService belongs to this business domain                                                                                                                                                                                        |
| DOCUMENTED_BY      | LogicalService -> Document                          | LogicalService is documented by this resource                                                                                                                                                                                         |
| IMPORTS            | Repository -> Library                               | Repo imports/depends on this library                                                                                                                                                                                                  |
| CODEOWNER_OF       | Person/Team -> Repository                           | CODEOWNERS entry for this repo path                                                                                                                                                                                                   |
| ON_CALL_FOR        | Person -> LogicalService                            | Person is in the on-call rotation                                                                                                                                                                                                     |
| ASSIGNED_TO        | WorkItem -> Person                                  | Issue is assigned to this person                                                                                                                                                                                                      |
| CONTAINS           | Sprint/Epic -> WorkItem                             | Sprint or epic contains this work item                                                                                                                                                                                                |
| BLOCKS             | WorkItem -> WorkItem                                | Issue blocks another issue                                                                                                                                                                                                            |
| TRACKS_WORK_ON     | WorkItem -> LogicalService/Repository               | Issue tracks work on this entity                                                                                                                                                                                                      |
| INCLUDES           | Release -> WorkItem                                 | Release includes this work item                                                                                                                                                                                                       |

### 4.4 Schema Configuration (ADR-006)

Schema configuration follows a phased approach:

| Phase   | Capability                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 | **YAML/JSON config file** (`shipit-schema.yaml`). Define node types, properties, resolution strategies, relationship types, cardinality constraints. Validated on startup and via CLI. |
| Phase 2 | **Form-based UI** with read-only visual preview. Edit schema through structured forms. See a graph visualization of the schema (non-interactive).                                      |
| Phase 3 | **Full interactive visual editor.** Drag-and-drop node/relationship creation, live property panels, version history with migration diffs.                                              |

#### YAML Schema Format (Phase 1)

```yaml
# shipit-schema.yaml
version: '1.0'
mode: full # or "simple" for <100 services (ADR-011)

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
      tags:
        type: string[]
        resolution_strategy: MERGE_SET
    constraints:
      unique_key: name

  # ... additional node types ...

relationship_types:
  IMPLEMENTED_BY:
    from: LogicalService
    to: Repository
    cardinality: '1:N'
    properties:
      path_prefix:
        type: string
        description: 'Subdirectory in monorepo, if applicable'

  EMITS_TELEMETRY_AS:
    from: Deployment
    to: RuntimeService
    cardinality: 'N:M'

  # ... additional relationship types ...

resolution_defaults:
  owner: HIGHEST_CONFIDENCE
  tier: MANUAL_OVERRIDE_FIRST
  status: LATEST_TIMESTAMP
  tags: MERGE_SET
```

Users can add custom node types (e.g., `CostCenter`, `SecurityZone`, `FeatureFlag`), remove node/relationship types they do not need, edit property schemas, and configure conflict resolution strategies -- all by editing this YAML file and reloading.

### 4.5 Vector Embedding Strategy

**Deferred to Phase 2 (see ADR-005).** Phase 1 uses structural search only -- all queries are resolved via Neo4j Cypher against indexed node properties and graph traversals. Phase 2 will introduce vector embeddings for LogicalService descriptions, runbooks, API specifications, incident postmortems, and code summaries, enabling semantic search ("find services related to payment processing") alongside structural queries.

---

## 5. Identity Strategy & Entity Deduplication

### 5.1 The Problem

A single logical entity (e.g., the "payments-api" LogicalService) will appear across multiple connectors: as a Backstage Component, a Kubernetes Deployment, a Datadog RuntimeService, a GitHub Repository, and a Jira component. Without a deterministic identity strategy, the graph fragments into duplicates.

### 5.2 Identity Model

Every entity in the graph has a layered identity. **Phase 1 implements Primary Key and Linking Key only.** Alias Keys and fuzzy matching are deferred to Phase 2 (ADR-010).

| Identity Layer | Definition                                                                             | Example                                                                            | Phase |
| -------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----- |
| Primary Key    | Globally unique canonical ID. Format: `shipit://{label}/{namespace}/{name}`            | `shipit://logical-service/default/payments-api`                                    | 1     |
| Linking Keys   | Source-system IDs that deterministically map to a canonical ID. Defined per connector. | `github://org/repo-name`, `k8s://cluster/ns/deploy-name`                           | 1     |
| Alias Keys     | Alternative names or IDs that may refer to the same entity. Used for fuzzy matching.   | `dd-service:payments-api-prod`, `backstage:payments-api`                           | 2     |
| Merge History  | Audit trail of all identity merge/split events with actor, timestamp, and reason.      | Merged `github://org/payments-api` into `shipit://repository/default/payments-api` | 1     |

### 5.3 Reconciliation Ladder

When a connector produces an entity, the Core Writer resolves identity using this ladder (evaluated in order, first match wins):

| Step | Name                          | Phase | Behavior                                                                                                                                                                                                                                            |
| ---- | ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Primary Key Match**         | 1     | If the connector provides a canonical `shipit://` ID, use it directly. Exact match.                                                                                                                                                                 |
| 2    | **Linking Key Match**         | 1     | Look up the source-system ID in the linking key index. If found, merge onto the existing node.                                                                                                                                                      |
| 3    | **Fuzzy Match with Evidence** | 2     | Compare name, labels, tags, and namespace against existing nodes using vector embedding similarity + weighted features. Require configurable confidence threshold before auto-merging. Below threshold, create a candidate match for manual review. |
| 4    | **Manual Review**             | 2     | Unresolved candidates appear in the Reconciliation UI. User confirms or rejects proposed merges.                                                                                                                                                    |

**Phase 2 fuzzy match specification (Step 3):**

- **Method:** Vector embedding similarity + weighted feature comparison
- **Feature weights:** name=0.5, namespace=0.2, tags=0.2, labels=0.1
- **Threshold:** 0.85 (configurable). Above threshold: auto-merge. Below threshold: candidate for manual review.

#### 5.3.1 Cross-Label Rules

Fuzzy matching is only performed **within the same node label**. A LogicalService is never fuzzy-matched against a Repository or a Deployment. Cross-label identity resolution (e.g., "this Backstage Component and this K8s Deployment represent the same logical service") is handled exclusively via linking keys -- connectors declare which linking keys they produce, and the Core Writer uses the linking key index to connect entities across labels.

#### 5.3.2 Entity Rename Detection

When an entity is renamed in a source system (e.g., a GitHub repository is renamed), the connector signals the rename by including both the old and new linking keys in the event payload:

```typescript
interface RenameSignal {
  old_linking_key: string; // e.g., "github://org/old-repo-name"
  new_linking_key: string; // e.g., "github://org/new-repo-name"
  source: string;
  timestamp: string;
}
```

The Core Writer updates the linking key index to point the new key at the existing canonical node and retains the old key as an alias. No new node is created.

### 5.4 Linking Key Registry

Each connector declares which linking keys it produces. The Core Writer maintains a global index:

| Connector         | Linking Key Format                                        | Maps To Label               |
| ----------------- | --------------------------------------------------------- | --------------------------- |
| GitHub            | `github://{org}/{repo-name}`                              | Repository                  |
| Kubernetes        | `k8s://{cluster}/{namespace}/{kind}/{name}`               | Deployment, Namespace       |
| Datadog           | `dd://{org}/{service-name}`                               | RuntimeService              |
| Backstage         | `backstage://{namespace}/{kind}/{name}`                   | LogicalService, API, Domain |
| Jira              | `jira://{instance}/{project-key}/{issue-key}`             | WorkItem, Epic              |
| Identity Provider | `idp://{tenant}/{user-id}` or `idp://{tenant}/{group-id}` | Person, Team                |

### 5.5 Merge Auditability & Reversibility

Every merge operation is recorded as a `MergeEvent` node in the graph: `source_id`, `target_id`, `actor`, `timestamp`, `method` (`primary_key | linking_key | fuzzy | manual`), `confidence_score`.

Merges are **reversible**: a "split" operation restores the original two nodes and re-assigns claims to the correct entity.

The Reconciliation UI (Phase 2) shows all pending candidates, recent merges, and a "split" button for reversals. In Phase 1, merge events are queryable via Cypher and the `entity_detail` MCP tool.

---

## 6. Ingestion Architecture

### 6.1 Event Bus Interface (ADR-004)

All connectors publish normalized events to an Event Bus rather than writing directly to Neo4j. This decouples ingestion rate from graph write throughput and enables replay, backpressure, and multi-consumer patterns.

**Tiered approach:**

| Mode       | Implementation   | When to Use                                   | Features                                                                                             |
| ---------- | ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Lite Mode  | BullMQ on Redis  | <1,000 services, self-hosted, Phase 1 default | At-least-once delivery, job ordering per entity, retry with backoff, basic DLQ, replay via event log |
| Production | Kafka / Redpanda | 1,000+ services, high throughput required     | Full partitioning, consumer groups, native replay, configurable retention, horizontal scaling        |

Both modes implement the same TypeScript SDK interface:

```typescript
interface EventBusClient {
  publish(events: CanonicalEntity[]): Promise<void>;
  subscribe(handler: EventHandler): Promise<void>;
  replay(fromTimestamp: string): Promise<void>;
}

type EventHandler = (event: CanonicalEntity) => Promise<void>;
```

**Event Bus contract (both modes):**

- **Delivery guarantee:** At-least-once. Consumers must be idempotent.
- **Partitioning:** Events are partitioned by canonical entity ID (or linking key hash). This guarantees ordering per entity.
- **Retention:** Configurable retention window. Initial default: 7 days. Enables replay for recovery and re-processing.
- **Consumer groups:** Core Writer runs as a consumer group with N partitions for horizontal scaling.
- **Dead-letter queue:** Events that fail processing after max retries are routed to a DLQ for inspection and manual replay.

**Supported implementations (phased):**

| Implementation      | Phase | Notes                                                                                  |
| ------------------- | ----- | -------------------------------------------------------------------------------------- |
| BullMQ on Redis     | 1     | Default for Lite Mode. Jobs keyed by entity ID for ordering. Redis Streams for replay. |
| Kafka / Redpanda    | 2     | Full feature set: partitioning, ordering, retention, replay, consumer groups.          |
| AWS SQS + Event Log | 3     | SQS for delivery + DynamoDB/S3 Event Log for replay (SQS has no native replay).        |
| GCP Pub/Sub         | 3     | Native ordering via ordering keys, seek-to-timestamp for replay.                       |
| Azure Service Bus   | 3     | Sessions for ordering, dead-letter sub-queue built-in.                                 |

### 6.2 Core Writer

The Core Writer is the **sole component that writes to Neo4j**. No connector, no API endpoint, no other process writes directly to the graph.

**Key change from v0.2:** The Core Writer is **partition-affine stateful**, not stateless. A single partition is processed by one consumer instance at a time. This eliminates write conflicts on the same entity across parallel consumers and simplifies idempotency checking.

The Core Writer provides:

- **Single point of consistency** -- all claim resolution, dedup, and materialization happens in one place.
- **Idempotency** -- every write uses an idempotency key: `{connector_id}:{entity_primary_key}:{event_version}`. The idempotency log lives **in Neo4j**, checked transactionally within the same transaction as the graph write. This guarantees atomic check-and-write with no race conditions.
- **Batched writes** -- events are consumed in micro-batches for Neo4j write efficiency (initial default: 500 entities per transaction).
- **Claim application** -- when writing a property, the Core Writer updates the `_claims` JSON property on the entity node and re-evaluates the resolution strategy to compute the effective value.
- **Materialization** -- after claim resolution, the Core Writer writes the effective value directly onto the entity node (e.g., `owner_effective`, `tier_effective`) for fast read queries.

**Write amplification analysis (ADR-002):** With JSON claims stored on nodes, a single entity update requires:

| Operation                          | v0.2 (Separate Claim Nodes)                            | v0.3 (JSON on Node)                 |
| ---------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| Entity MERGE                       | 1 op                                                   | 1 op                                |
| Property claims (5 properties)     | 15 ops (MERGE claim + SET + relationship per property) | 1 op (SET `_claims` JSON)           |
| Effective property materialization | 5 ops (SET per property)                               | Combined with entity MERGE          |
| Idempotency log check + write      | 2 ops (separate store)                                 | 0 additional ops (same transaction) |
| **Total per entity**               | **~23 ops**                                            | **~2 ops**                          |

For a batch of 500 entities, this reduces from ~11,500 Neo4j operations to ~1,000 operations per transaction.

### 6.3 Idempotency Key Strategy

Every event published to the Event Bus carries an idempotency key:

**Format:** `{connector_id}:{entity_primary_key}:{event_version}`

- `connector_id`: Unique identifier for the connector instance (e.g., `github-acme-org`)
- `entity_primary_key`: The canonical or linking key of the entity (e.g., `github://acme/payments-api`)
- `event_version`: **Monotonic integer or ISO 8601 timestamp only.** No SHAs, no etags. This constraint simplifies version comparison -- the Core Writer can determine "is this event newer?" with a simple numeric or lexicographic comparison.

The Core Writer maintains an idempotency log (last processed version per connector+entity) in Neo4j. Duplicate events are detected and skipped. Initial default: idempotency log TTL 30 days; configurable.

---

## 7. Conflict Resolution & Provenance

### 7.1 Claim-Based Property Model

Properties on nodes are not flat key-value pairs. Each property value is backed by one or more **PropertyClaims** from different sources. In v0.3, claims are stored as a **JSON property on the entity node** (ADR-002), not as separate graph nodes.

Each node carries a `_claims` JSON property: an array of claim objects. This enables:

- **Multi-source truth:** Multiple connectors can assert different values for the same property.
- **Explainability:** "Why does this LogicalService show tier=1?" -> "Because Backstage asserted tier=1 with confidence 0.95 on 2026-03-01."
- **Conflict visibility:** The UI highlights properties with conflicting claims.
- **Write efficiency:** Updating claims is a single JSON property SET, not a subgraph mutation.

### 7.2 PropertyClaim Structure (JSON)

Claims are stored as the `_claims` property on each entity node:

```json
{
  "_claims": [
    {
      "property_key": "tier",
      "value": 1,
      "source": "backstage",
      "source_id": "backstage://default/component/payments-api",
      "ingested_at": "2026-02-28T10:00:00Z",
      "confidence": 0.95,
      "evidence": "parsed from backstage catalog-info.yaml"
    },
    {
      "property_key": "tier",
      "value": 2,
      "source": "manual:admin@company.com",
      "source_id": "manual://admin@company.com",
      "ingested_at": "2026-02-27T15:30:00Z",
      "confidence": 0.8,
      "evidence": "manual override via Claim Explorer"
    },
    {
      "property_key": "owner",
      "value": "payments-team",
      "source": "github",
      "source_id": "github://acme/payments-api",
      "ingested_at": "2026-02-28T09:00:00Z",
      "confidence": 0.9,
      "evidence": "parsed from CODEOWNERS file"
    }
  ]
}
```

| Field        | Type            | Description                                                                            |
| ------------ | --------------- | -------------------------------------------------------------------------------------- |
| property_key | string          | The property name (e.g., "tier", "owner", "lifecycle")                                 |
| value        | any             | The claimed value                                                                      |
| source       | string          | Connector or actor that made the claim (e.g., "backstage", "github", "manual:user@co") |
| source_id    | string          | Linking key of the source entity that produced this claim                              |
| ingested_at  | ISO 8601        | When the claim was ingested into ShipIt-AI                                             |
| confidence   | float (0.0-1.0) | Confidence level of the claim. Connectors set this based on data quality signals.      |
| evidence     | string or null  | Human-readable justification (e.g., "parsed from backstage catalog-info.yaml")         |

#### 7.2.1 Confidence Decay

Claim confidence **decreases over time** if the source does not refresh it. This prevents stale authoritative sources from permanently dominating resolution.

- **Decay rate:** Configurable. Default: 0.01 per week.
- **Mechanism:** When the Core Writer evaluates resolution, it computes `effective_confidence = confidence - (decay_rate * weeks_since_ingested)`, floored at 0.0.
- **Example:** A claim with confidence 0.95 that has not been refreshed for 6 months (~26 weeks) has effective confidence: `0.95 - (0.01 * 26) = 0.69`.
- **Refresh resets decay:** When a connector re-asserts the same claim (same source + property_key), `ingested_at` is updated and decay resets to zero.
- **Rationale:** An authoritative source that stops syncing should not permanently own a property. After sufficient decay, a fresher source with lower base confidence can take over.

### 7.3 Resolution Strategies

Each property key in the schema has a configurable resolution strategy. The Core Writer applies the strategy when multiple claims exist for the same property on the same node:

| Strategy              | Behavior                                                                                                      | Best For                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| MANUAL_OVERRIDE_FIRST | If a manual claim exists, it always wins. Otherwise fall through to next strategy.                            | tier, lifecycle, domain -- human judgment    |
| HIGHEST_CONFIDENCE    | Claim with the highest **effective confidence** (after decay) wins. Ties broken by most recent `ingested_at`. | owner, name, description                     |
| AUTHORITATIVE_ORDER   | Claims ranked by user-defined source priority list. Highest-priority source wins.                             | language -- clear source of truth            |
| LATEST_TIMESTAMP      | Most recently ingested claim wins.                                                                            | status, replicas -- fast-changing properties |
| MERGE_SET             | All unique values merged into an array/set. No single winner.                                                 | tags, labels, topics -- additive properties  |

**Default resolution strategies (v0.3):**

| Property | v0.2 Default          | v0.3 Default          | Rationale                                        |
| -------- | --------------------- | --------------------- | ------------------------------------------------ |
| owner    | AUTHORITATIVE_ORDER   | HIGHEST_CONFIDENCE    | With decay, stale ownership claims lose priority |
| tier     | MANUAL_OVERRIDE_FIRST | MANUAL_OVERRIDE_FIRST | No change -- human judgment is authoritative     |
| status   | LATEST_TIMESTAMP      | LATEST_TIMESTAMP      | No change -- operational data is time-sensitive  |
| tags     | MERGE_SET             | MERGE_SET             | No change -- additive by nature                  |

#### 7.3.1 Re-Resolution

When a resolution strategy is changed in `shipit-schema.yaml` (e.g., `owner` changed from `AUTHORITATIVE_ORDER` to `HIGHEST_CONFIDENCE`), a background job re-evaluates all affected entities and updates their `_effective` properties.

- **Scope:** Only entities with multiple claims for the affected property are re-evaluated.
- **Performance target:** <5 minutes for 10,000 entities.
- **Safety:** Re-resolution is non-destructive. No claims are deleted. Only the materialized effective values change.
- **Audit:** Re-resolution events are logged with the old and new effective values.

### 7.4 Materialized Effective Properties

For query performance, the Core Writer materializes the resolved "effective" value of each claimed property directly onto the entity node:

- Entity node carries both raw source properties and `_effective` suffixed properties: `owner_effective`, `tier_effective`, `lifecycle_effective`.
- All PropertyClaims are retained in the `_claims` JSON property on the node for explainability.
- MCP tools and dashboard queries use `_effective` properties for fast reads without claim resolution at query time.
- The Claim Explorer UI (Section 10 in Part 2) allows users to inspect all claims for a property, see the resolution audit trail, and (in Enterprise tier) override with a manual claim.

### 7.5 Edge Claims

Relationships also carry provenance. Each edge has `_source`, `_confidence`, and `_ingested_at` properties indicating which connector asserted the relationship and with what confidence.

**Resolution for edges:**

- If multiple connectors assert the **same edge** (same type, same from/to), the edge exists once with the **highest confidence** from any source. All source attributions are recorded in an `_edge_claims` JSON property on the edge.
- If connectors **disagree** (one asserts an edge, another does not), the edge exists if any active claim supports it.
- **Confidence boost:** If two independent sources agree on an edge, the effective confidence is boosted: `min(1.0, max(c1, c2) + 0.1)`.

**Claim retraction model:** When a connector that previously asserted an edge no longer asserts it (e.g., the Datadog service map no longer shows a `CALLS` edge), the connector's claim on that edge is marked as `retracted` with a retraction timestamp. If **no active (non-retracted) claims remain**, the edge is **soft-deleted** (`_deleted=true`, `_deleted_at` timestamp). Soft-deleted edges are excluded from MCP queries by default but retained for audit purposes for 30 days (configurable).

### 7.6 Data Quality Signals

ShipIt-AI computes and exposes data quality signals to help users and AI agents assess trustworthiness:

| Signal                         | Description                                                                                                    | Detection Method                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Cross-source disagreement rate | Percentage of properties on an entity where multiple sources claim different values                            | Count claims per property with distinct values |
| Cardinality anomaly            | Entity has unusually many or few relationships compared to peers of the same label                             | Statistical outlier detection (>2 std dev)     |
| Temporal anomaly               | Data has not changed in an unexpectedly long time (e.g., CODEOWNERS unchanged in 12+ months on an active repo) | Compare `_last_synced` with activity signals   |
| Single-source warning          | Entity has claims from only one source, reducing provenance confidence                                         | Count distinct sources per entity              |
| Stale claim warning            | A claim's effective confidence has decayed below 0.5                                                           | Decay calculation at query time                |

These signals are:

- Returned in MCP responses via the `_meta.data_quality` field in the response envelope (ADR-008).
- Surfaced in the Claim Explorer UI.
- Available as properties on entity nodes (`_quality_score`, `_source_count`).

### 7.7 Claim Conflict Dashboard

The Claim Conflict Dashboard is a dedicated view (separate from the Claim Explorer) that **proactively surfaces only properties with active disagreements**. It is not buried inside individual entity detail pages.

**Features:**

- Filterable by node label, property key, team, and severity (number of conflicting sources).
- Sorted by impact: Tier-1 service conflicts appear first.
- One-click navigation to the entity's Claim Explorer for resolution.
- Bulk resolution: apply a resolution strategy change to multiple entities at once.
- Metrics: total open conflicts, conflict trend over time, average time-to-resolution.

---

## 8. Integration Connectors

### 8.1 Connector Architecture

Each connector is a self-contained plugin that implements the ShipIt Connector Interface. Connectors never write directly to Neo4j -- they produce normalized entities, and the **SDK harness auto-publishes** them to the Event Bus.

**Key change from v0.2:** The `publish()` method has been **removed from the connector interface**. Connectors implement `normalize()` to transform raw data into canonical entities. The SDK harness calls `normalize()` and then publishes the output to the Event Bus automatically. This eliminates a class of bugs where connectors could publish malformed events or bypass normalization.

```typescript
interface ShipItConnector {
  name: string;
  version: string;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  discover(): Promise<DiscoveryResult>;
  fetch(entityType: string, cursor?: string): Promise<FetchResult>;
  normalize(raw: RawEntity[]): CanonicalEntity[];
  sync(mode: 'full' | 'incremental'): Promise<SyncResult>;
  handleWebhook?(event: WebhookEvent): Promise<void>;
}
```

| Method             | Responsibility                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `authenticate()`   | Validate credentials and establish connection to the source system                             |
| `discover()`       | List all available entities from the source system (repos, deployments, monitors, etc.)        |
| `fetch()`          | Pull full data for a given entity type, with cursor-based pagination                           |
| `normalize()`      | Transform source data into `CanonicalEntity[]` with claims. **SDK auto-publishes output.**     |
| `sync()`           | Execute full or incremental sync (orchestrates discover -> fetch -> normalize)                 |
| `handleWebhook?()` | Handle real-time events from the source system (optional, for connectors with webhook support) |

#### 8.1.1 Connector Dry-Run Mode

Before writing to the Event Bus, connectors support a **dry-run mode** that previews the data that would be ingested:

- Runs the full `discover()` -> `fetch()` -> `normalize()` pipeline.
- Displays a sample: **50 nodes and 20 edges** with full claim details.
- Provides summary statistics: total entities by type, total relationships by type, estimated sync time.
- Requires explicit **"proceed / cancel"** confirmation before publishing to the Event Bus.
- Dry-run mode is the default for first-time connector runs. Subsequent syncs can skip dry-run via configuration.

#### 8.1.2 Connector Rollback ("Detach Connector")

If a connector produces bad data or is no longer needed, a **"detach connector"** operation removes all data sourced from that connector:

- Removes all nodes where `_source_system` matches the connector.
- Removes all edges where `_source` matches the connector.
- Removes all claims within `_claims` JSON arrays where `source` matches the connector.
- Re-evaluates effective properties on any nodes that had claims from the detached connector (other sources may now win resolution).
- Records the detachment as an audit event.
- **Safety:** Requires confirmation with entity count. Large detachments (>10,000 entities) are processed as a background job.

#### 8.1.3 Connector Versioning

Connectors declare a **canonical schema version** that indicates which version of the `CanonicalEntity` format they produce.

```typescript
interface ConnectorManifest {
  name: string;
  version: string; // Connector version (e.g., "1.2.0")
  schema_version: string; // Canonical schema version (e.g., "1.0")
  min_sdk_version: string; // Minimum SDK version required
  supported_entity_types: string[];
}
```

- **Compatibility layer:** The SDK harness includes adapters for older schema versions. A connector built against schema v1.0 continues to work when the platform upgrades to schema v1.1.
- **Deprecation policy:** Schema versions are supported for at least 6 months after a new version is released. Deprecated connectors emit a warning in the Connector Hub UI and in sync logs.

### 8.2 V1 Connectors

#### 8.2.1 GitHub Connector

**Authentication:** GitHub App (recommended).

The GitHub connector authenticates via a dedicated GitHub App installation:

- Fine-grained permissions -- request only the scopes needed
- Org-level installation -- single install covers all repos; no per-user token management
- Higher rate limits -- 5,000 requests/hour per installation vs 5,000/hour per PAT
- No token rotation -- App uses short-lived installation tokens auto-generated from a private key
- Webhook delivery -- GitHub App receives webhook events natively

**Setup (documented in onboarding wizard):**

1. Create a GitHub App in your org (Settings -> Developer settings -> GitHub Apps)
2. Permissions: Repository (contents:read, metadata:read, actions:read, pull_requests:read, dependabot_alerts:read), Organization (members:read, team:read)
3. Webhook events: push, pull_request, workflow_run, repository, team, membership
4. Generate private key (.pem), note App ID
5. Install on org (all repos or select repos)
6. In ShipIt-AI: upload private key, enter App ID + Installation ID

**Fallback:** PAT auth for GHES environments where GitHub App is restricted.

**Sync:** Full scan (scheduled) + GitHub App webhook events (push, PR, workflow_run).

**Entities pulled:**

| Entity            | Data Pulled                                                | Graph Mapping                                        |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Repositories      | Name, URL, language, visibility, branch protection, topics | Repository node + IMPLEMENTED_BY from LogicalService |
| CODEOWNERS        | Parsed ownership rules per path                            | CODEOWNER_OF relationships                           |
| Teams             | Org teams, membership                                      | Team nodes + MEMBER_OF edges                         |
| Actions Workflows | Workflow YAML, run history, status                         | Pipeline nodes + BUILT_BY edges                      |
| Pull Requests     | Open PRs, reviewers, approval status (last N)              | CONTRIBUTES_TO edges, metadata                       |
| Dependencies      | Package manifests, security alerts                         | IMPORTS edges to Library nodes                       |

#### 8.2.2 Kubernetes / ArgoCD Connector

**Sync:** Watch API (streaming) + periodic reconciliation (hourly).

| Entity                   | Data Pulled                                 | Graph Mapping                                      |
| ------------------------ | ------------------------------------------- | -------------------------------------------------- |
| Namespaces               | Name, labels, annotations, resource quotas  | Namespace nodes                                    |
| Deployments/StatefulSets | Replicas, image, env vars, resource limits  | Deployment nodes + DEPLOYED_AS from LogicalService |
| Services/Ingress         | Endpoints, ports, DNS entries               | API nodes + EXPOSES edges                          |
| ConfigMaps/Secrets       | Names and references (not values)           | Metadata on Deployment nodes                       |
| ArgoCD Applications      | Sync status, source repo, target cluster/ns | Pipeline nodes + TRIGGERS edges                    |
| CronJobs                 | Schedule, last run, associated service      | Pipeline nodes                                     |

#### 8.2.3 Datadog Connector

**Sync:** Polling (Datadog API) + webhook (monitor state changes).

| Entity          | Data Pulled                                      | Graph Mapping                               |
| --------------- | ------------------------------------------------ | ------------------------------------------- |
| Monitors        | Name, query, status, tags, notification channels | Monitor nodes + MONITORS edges              |
| SLOs            | Target, status, error budget remaining           | Properties on LogicalService/RuntimeService |
| Service Map     | Datadog-detected service dependencies            | CALLS edges between RuntimeService nodes    |
| Dashboards      | Dashboard IDs, titles, linked services           | Metadata / Document nodes                   |
| Synthetic Tests | Endpoints tested, status, locations              | Monitor nodes (type=synthetic)              |

#### 8.2.4 Backstage Catalog Connector

**Sync:** Backstage catalog API polling + entity refresh events.

| Entity       | Data Pulled                          | Graph Mapping                                         |
| ------------ | ------------------------------------ | ----------------------------------------------------- |
| Components   | Name, type, lifecycle, owner, system | LogicalService nodes (reconciled via identity ladder) |
| Systems      | System groupings                     | Domain nodes or grouping relationships                |
| APIs         | API specs, consumers, providers      | API nodes + EXPOSES/CONSUMES edges                    |
| Groups/Users | Team structure, membership           | Team/Person nodes (reconciled with IdP)               |
| Resources    | Databases, queues, buckets           | Infrastructure nodes + USES edges                     |

#### 8.2.5 Jira Connector

**Authentication:** OAuth 2.0 (Atlassian Cloud) or API token + email (Jira Data Center).

**Sync:** Jira webhooks (issue_created, issue_updated, sprint events) + scheduled reconciliation (daily).

| Entity              | Data Pulled                                   | Graph Mapping                                                        |
| ------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Projects            | Key, name, lead, category                     | Metadata on Domain/Team nodes                                        |
| Epics               | Summary, status, owner, linked issues, labels | Epic node + IMPLEMENTS edges to Domain                               |
| Stories / Tasks     | Summary, status, assignee, sprint, priority   | WorkItem node + ASSIGNED_TO Person edges                             |
| Sprints             | Name, start/end date, velocity, board         | Sprint node + CONTAINS edges to WorkItem (if jira_extended enabled)  |
| Components          | Name, lead, associated issues                 | PART_OF edges to LogicalService nodes (reconciled)                   |
| Issue Links         | Blocks, is-blocked-by, relates-to             | BLOCKS / RELATES_TO edges between WorkItem nodes                     |
| Versions / Releases | Name, release date, status                    | Release node + INCLUDES edges to WorkItem (if jira_extended enabled) |

#### 8.2.6 Identity Connector (People & Service Accounts)

**Providers (V1):** Okta, Azure AD / Entra ID, LDAP. Community: Google Workspace, GitHub org.

**Sync:** SCIM push (Enterprise) + polling (Community).

| Entity              | Data Pulled                                | Graph Mapping                           |
| ------------------- | ------------------------------------------ | --------------------------------------- |
| Users               | Name, email, role, department, manager     | Person nodes                            |
| Groups / Teams      | Group name, members, nested groups         | Team nodes + MEMBER_OF edges            |
| Service Accounts    | Name, type (bot/CI/AI), owner, scopes      | ServiceAccount nodes + MANAGED_BY edges |
| AI Agents           | Agent name, model, permissions, owner team | ServiceAccount nodes (type=ai_agent)    |
| Roles / Permissions | Role assignments, access scope             | HAS_ACCESS_TO edges                     |

#### Time-to-Value Estimates

| Connector  | Initial Sync Time         | Time to First Value |
| ---------- | ------------------------- | ------------------- |
| GitHub     | 5-15 min (1K repos)       | ~10 min             |
| Kubernetes | 2-5 min (500 deployments) | ~5 min              |
| Datadog    | 10-20 min                 | ~15 min             |
| Backstage  | 5-10 min                  | ~8 min              |
| Jira       | 15-30 min (10K issues)    | ~20 min             |
| Identity   | 5-10 min                  | ~8 min              |

> **Note:** "Time to First Value" is measured from connector configuration to the first successful MCP query that returns data from that connector.

#### Credential Rotation & Expiry Warnings

All connectors monitor credential health and proactively warn before expiration:

- **OAuth tokens:** Auto-refreshed using refresh tokens. If refresh fails, alert is raised 7 days before expiry.
- **API keys:** Expiry date tracked if provided by the source API. Warning at 14 days, critical at 3 days.
- **GitHub App private keys:** No expiry, but if the key is revoked, the connector detects auth failure on next sync and raises an alert immediately.
- **Credential health** is visible in the Connector Hub UI with traffic-light status (green/yellow/red).

### 8.3 Connector Onboarding Flow

#### First Run Setup (7 steps)

| Step | Action                 | Description                                                                                     |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| 1    | Select Integrations    | Check which systems to connect (GitHub, K8s, Datadog, etc.)                                     |
| 2    | Authenticate           | OAuth flows or API key / GitHub App setup per integration                                       |
| 3    | Scope                  | Select orgs, clusters, namespaces, Jira projects, Datadog accounts                              |
| 4    | Schema Review          | Show which node/relationship types will be populated; customize. **Skippable via Quick Start.** |
| 5    | Initial Sync (Dry Run) | Run full discovery + normalization, show sample data for review                                 |
| 6    | Verify                 | Interactive graph explorer to validate data, flag issues                                        |
| 7    | Schedule               | Configure sync frequency and webhook registrations                                              |

**Quick Start option:** Steps 4 (Schema Review) can be skipped. The default schema template is applied. Users can customize later by editing `shipit-schema.yaml`.

#### Add Connector (3 steps)

| Step | Action       | Description                                     |
| ---- | ------------ | ----------------------------------------------- |
| 1    | Select       | Choose connector type from available connectors |
| 2    | Authenticate | Complete auth flow for the selected connector   |
| 3    | Sync         | Run initial sync (dry-run first if configured)  |

---

## 9. MCP Server (AI Agent Interface)

### 9.1 Overview

The MCP server is the primary interface for AI agents. It exposes the knowledge graph as structured tool calls (not raw Cypher). Every tool has a defined contract: input schema, edge types traversed, directionality, default depth, and response schema.

**Response envelope (ADR-008):** All MCP tool responses are wrapped in a standard `_meta` envelope:

```json
{
  "_meta": {
    "tool": "blast_radius",
    "version": "1.0",
    "query_time_ms": 142,
    "node_count": 12,
    "truncated": false,
    "data_quality": {
      "stale_nodes": 0,
      "single_source_nodes": 3
    },
    "cache_hit": false
  },
  "data": { ... }
}
```

**Compact mode:** All tools accept an optional `compact: boolean` parameter (default: `false`). When `compact=true`, the response omits `_meta`, claim details, and neighbor lists -- returning only the minimal data needed for the query. Useful when an AI agent is composing multiple tool calls and needs to conserve context window tokens.

### 9.2 Tool Contracts

#### 9.2.1 blast_radius

**Parameters:**

| Parameter            | Type                  | Default    | Description                                                                              |
| -------------------- | --------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| node                 | string (canonical ID) | Required   | Starting node (e.g., `shipit://repository/default/config-service`)                       |
| depth                | integer               | 3 (max: 6) | Max traversal hops                                                                       |
| direction            | enum                  | DOWNSTREAM | DOWNSTREAM, UPSTREAM, or BOTH                                                            |
| include_environments | string[]              | all        | Filter deployments by environment. Use `production_only: true` as convenience shorthand. |
| production_only      | boolean               | false      | Convenience flag: equivalent to `include_environments: ['production']`                   |

**Edge types traversed (downstream):** IMPLEMENTED_BY^-1 -> DEPLOYED_AS -> EMITS_TELEMETRY_AS -> CALLS^-1, DEPENDS_ON^-1, BUILT_BY^-1 -> TRIGGERS^-1

**Response schema:**

```json
{
  "affected_nodes": [
    {
      "id": "...",
      "label": "...",
      "name": "...",
      "tier_effective": 1,
      "environment": "production",
      "owner_effective": "payments-team"
    }
  ],
  "paths": [{ "from": "...", "to": "...", "relationship": "DEPENDS_ON", "depth": 2 }],
  "summary": {
    "total_services": 6,
    "total_teams": 3,
    "tier1_count": 2
  }
}
```

> **v0.3 change:** Default `include_environments` changed from `['production']` to `all`. The `production_only` flag is provided for convenience.

#### 9.2.2 find_owners

**Parameters:**

| Parameter     | Type                  | Default  | Description                                                              |
| ------------- | --------------------- | -------- | ------------------------------------------------------------------------ |
| entity        | string (canonical ID) | Required | Entity to find owners for                                                |
| include_chain | boolean               | false    | If true, return the full ownership chain (CODEOWNERS -> Team -> Manager) |

**Edge types traversed:** OWNS^-1, CODEOWNER_OF^-1, MEMBER_OF, ON_CALL_FOR^-1

**Response schema:**

```json
{
  "owners": [{ "type": "team", "name": "payments-team", "email": null, "role": "owner" }],
  "on_call": [{ "name": "Jane Doe", "email": "jane@co.com", "rotation": "primary" }],
  "codeowners": [{ "path_pattern": "src/payments/**", "team_or_person": "payments-team" }]
}
```

#### 9.2.3 dependency_chain

**Parameters:**

| Parameter | Type                  | Default     | Description     |
| --------- | --------------------- | ----------- | --------------- |
| from      | string (canonical ID) | Required    | Source node     |
| to        | string (canonical ID) | Required    | Target node     |
| max_depth | integer               | 6 (max: 10) | Max path length |

**Edge types traversed:** DEPENDS_ON, CALLS, USES, CONSUMES, DEPLOYED_AS, RUNS_IN, PART_OF, IMPLEMENTED_BY

**Response schema:**

```json
{
  "paths": [{ "nodes": ["..."], "edges": ["..."], "length": 3 }],
  "shortest_path_length": 3,
  "total_paths_found": 5
}
```

#### 9.2.4 change_impact

**Parameters:**

| Parameter   | Type                  | Default    | Description                                                                       |
| ----------- | --------------------- | ---------- | --------------------------------------------------------------------------------- |
| entity      | string (canonical ID) | Required   | Entity being changed                                                              |
| change_type | enum                  | Required   | `code_change`, `schema_migration`, `config_change`, `deprecation`, `decommission` |
| depth       | integer               | 4 (max: 6) | Max impact hops                                                                   |

**Edge types traversed:** Superset of blast_radius + CONSUMES^-1, IMPORTS^-1 (for library changes), USES^-1 (for infra changes)

**Response schema:**

```json
{
  "impact_zones": [{ "entity": "...", "impact_type": "direct", "depth": 1, "risk_tier": 1 }],
  "summary": {
    "total": 12,
    "by_tier": { "1": 2, "2": 5, "3": 5 },
    "by_team": { "payments": 4, "platform": 8 }
  },
  "recommended_actions": [
    "Coordinate with payments-team before deploying",
    "Run integration tests for tier-1 services"
  ]
}
```

#### 9.2.5 semantic_search

**Deferred to Phase 2 (ADR-005).** Phase 1 returns an error response directing callers to use `search_entities` for structural filtering.

**Parameters (Phase 2):**

| Parameter    | Type     | Default      | Description                   |
| ------------ | -------- | ------------ | ----------------------------- |
| query        | string   | Required     | Natural language search query |
| entity_types | string[] | all          | Filter by node label(s)       |
| limit        | integer  | 10 (max: 50) | Max results                   |

**Backend (Phase 2):** Vector DB similarity search. Returns nodes ranked by cosine similarity.

#### 9.2.6 entity_detail

**Parameters:**

| Parameter         | Type                  | Default  | Description                                                  |
| ----------------- | --------------------- | -------- | ------------------------------------------------------------ |
| entity            | string (canonical ID) | Required | Entity to inspect                                            |
| include_claims    | boolean               | false    | If true, return all PropertyClaims for each property         |
| include_neighbors | boolean               | true     | If true, return 1-hop neighbors grouped by relationship type |

**Response schema:**

```json
{
  "node": {
    "id": "...",
    "label": "LogicalService",
    "properties": { "name": "payments-api" },
    "effective_properties": { "owner_effective": "payments-team", "tier_effective": 1 }
  },
  "claims": [{ "property_key": "tier", "value": 1, "source": "backstage", "confidence": 0.95 }],
  "neighbors": {
    "DEPENDS_ON": [{ "id": "...", "label": "LogicalService", "name": "config-service" }]
  }
}
```

#### 9.2.7 team_topology

**Parameters:**

| Parameter        | Type    | Default  | Description                                            |
| ---------------- | ------- | -------- | ------------------------------------------------------ |
| team             | string  | Required | Team name or canonical ID                              |
| include_members  | boolean | true     | Include team member list                               |
| include_services | boolean | true     | Include owned LogicalServices with tier and SLO status |

**Edge types traversed:** OWNS, MEMBER_OF^-1, ON_CALL_FOR, MANAGED_BY^-1

**Response schema:**

```json
{
  "team": { "name": "payments-team", "members": ["..."], "manager": "VP Engineering" },
  "services": [{ "name": "payments-api", "tier": 1, "slo_status": "OK" }],
  "repos": ["payments-api", "payments-config"],
  "service_accounts": [{ "name": "payments-ci-bot", "type": "ci" }]
}
```

#### 9.2.8 schema_info

No parameters. Returns the current graph schema: all node labels with property definitions and resolution strategies, all relationship types with direction and cardinality.

**Response schema:**

```json
{
  "node_types": [
    {
      "label": "LogicalService",
      "properties": [
        { "key": "name", "type": "string", "resolution_strategy": "HIGHEST_CONFIDENCE" }
      ]
    }
  ],
  "relationship_types": [
    { "type": "DEPENDS_ON", "from": "LogicalService", "to": "LogicalService", "cardinality": "N:M" }
  ]
}
```

#### 9.2.9 list_unmonitored

> **Superseded by `list_violations` (9.2.14).** Retained for backward compatibility. Calls `list_violations(check_type='unmonitored')` internally.

**Parameters:**

| Parameter   | Type   | Default        | Description                       |
| ----------- | ------ | -------------- | --------------------------------- |
| entity_type | enum   | LogicalService | LogicalService or Deployment      |
| environment | string | production     | Filter deployments by environment |

**Response schema:**

```json
{
  "unmonitored": [
    {
      "id": "...",
      "label": "LogicalService",
      "name": "...",
      "tier_effective": 2,
      "owner_effective": "platform-team"
    }
  ],
  "total": 5
}
```

#### 9.2.10 graph_stats

**Parameters:** None.

Returns aggregate statistics about the knowledge graph. Useful for AI agents to understand the scope and freshness of available data before making specific queries.

**Response schema:**

```json
{
  "node_counts_by_label": {
    "LogicalService": 142,
    "Repository": 230,
    "Deployment": 580,
    "RuntimeService": 310
  },
  "edge_counts_by_type": { "DEPENDS_ON": 420, "CALLS": 890, "OWNS": 142, "IMPLEMENTED_BY": 230 },
  "environments": ["dev", "staging", "production"],
  "total_nodes": 2450,
  "total_edges": 5200,
  "freshness_summary": {
    "healthy": 2300,
    "stale": 120,
    "orphaned": 30
  }
}
```

#### 9.2.11 search_entities

**Parameters:**

| Parameter        | Type                     | Default       | Description                                                                                    |
| ---------------- | ------------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| label            | string                   | any           | Filter by node label (e.g., "LogicalService")                                                  |
| property_filters | object (key-value pairs) | {}            | Filter by property values (e.g., `{"tier_effective": 1, "lifecycle_effective": "production"}`) |
| limit            | integer                  | 25 (max: 100) | Max results                                                                                    |
| sort_by          | string                   | name          | Property to sort by                                                                            |

Structured filtering without Cypher. Supports equality, array-contains (for tags), and `null` checks.

**Response schema:**

```json
{
  "entities": [
    {
      "id": "...",
      "label": "LogicalService",
      "name": "payments-api",
      "tier_effective": 1,
      "owner_effective": "payments-team"
    }
  ],
  "total_matching": 42,
  "returned": 25
}
```

#### 9.2.12 recent_changes

**Parameters:**

| Parameter    | Type              | Default       | Description             |
| ------------ | ----------------- | ------------- | ----------------------- |
| since        | string (ISO 8601) | Required      | Start of time window    |
| entity_types | string[]          | all           | Filter by node label(s) |
| limit        | integer           | 50 (max: 200) | Max results             |

Returns entities added, modified, or deleted within the specified time window. Useful for AI agents tracking recent infrastructure changes.

**Response schema:**

```json
{
  "changes": [
    {
      "id": "...",
      "label": "Deployment",
      "name": "...",
      "change_type": "modified",
      "changed_at": "2026-02-28T10:00:00Z",
      "changed_properties": ["replicas", "image"]
    }
  ],
  "summary": { "added": 3, "modified": 12, "deleted": 1 }
}
```

#### 9.2.13 health_check

**Parameters:**

| Parameter | Type                  | Default  | Description            |
| --------- | --------------------- | -------- | ---------------------- |
| entity    | string (canonical ID) | Required | Entity to check health |

Aggregates monitor status, SLO status, and deployment health for the specified entity into a synthesized health status. Traverses MONITORS, DEPLOYED_AS, and EMITS_TELEMETRY_AS relationships.

**Response schema:**

```json
{
  "entity": "shipit://logical-service/default/payments-api",
  "overall_status": "degraded",
  "monitors": [
    { "name": "payments-api-latency", "status": "ALERT", "last_triggered": "2026-02-28T09:30:00Z" },
    { "name": "payments-api-error-rate", "status": "OK" }
  ],
  "slos": [{ "name": "availability-99.9", "status": "OK", "error_budget_remaining": 0.42 }],
  "deployments": [
    { "environment": "production", "status": "running", "replicas": "3/3" },
    { "environment": "staging", "status": "running", "replicas": "1/1" }
  ]
}
```

#### 9.2.14 list_violations

**Parameters:**

| Parameter   | Type   | Default        | Description                                                          |
| ----------- | ------ | -------------- | -------------------------------------------------------------------- |
| check_type  | enum   | Required       | `unmonitored`, `no_owner`, `no_ci`, `no_docs`, `no_oncall`, `custom` |
| entity_type | string | LogicalService | Filter by node label                                                 |
| environment | string | all            | Filter deployments by environment                                    |

Generalized compliance/hygiene check. Replaces the narrower `list_unmonitored` tool.

| check_type  | Logic                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| unmonitored | Entities with no incoming MONITORS relationship                                  |
| no_owner    | Entities with no incoming OWNS relationship                                      |
| no_ci       | LogicalServices with no BUILT_BY relationship to a Pipeline                      |
| no_docs     | LogicalServices with no DOCUMENTED_BY relationship                               |
| no_oncall   | LogicalServices with no ON_CALL_FOR relationship                                 |
| custom      | User-defined check (Cypher expression in schema config, evaluated at query time) |

**Response schema:**

```json
{
  "violations": [
    {
      "id": "...",
      "label": "LogicalService",
      "name": "...",
      "tier_effective": 2,
      "owner_effective": "platform-team"
    }
  ],
  "check_type": "unmonitored",
  "total": 5
}
```

### 9.3 Query Routing

| Query Type | Phase 1                                | Phase 2                                                       |
| ---------- | -------------------------------------- | ------------------------------------------------------------- |
| Structural | Neo4j Cypher (generated by tool layer) | Neo4j Cypher (generated by tool layer)                        |
| Semantic   | Not available (returns error)          | Vector DB similarity search                                   |
| Hybrid     | Not available (returns error)          | Vector DB for candidate nodes, then Neo4j for graph traversal |

Phase 1 supports **structural queries only** -- explicit entity names, relationships, and traversals resolved via Neo4j Cypher. Cypher is generated by the tool layer; user-supplied queries go through `graph_query` with guardrails.

### 9.4 Raw Cypher Escape Hatch (graph_query)

**v0.3 change:** Raw Cypher is now available in **all tiers** with usage limits, not Enterprise-only.

| Guardrail             | Community     | Team       | Enterprise        |
| --------------------- | ------------- | ---------- | ----------------- |
| Queries per day       | 100           | 500        | Unlimited         |
| Read-only enforcement | Yes           | Yes        | Yes               |
| Timeout               | 10 seconds    | 10 seconds | Configurable      |
| Row limit             | 1,000         | 5,000      | Configurable      |
| Hop limit             | 6 hops        | 6 hops     | Configurable      |
| APOC procedures       | Disabled      | Disabled   | Configurable      |
| Audit logging         | Basic (count) | Full       | Full              |
| Saved queries         | No            | Yes        | Yes               |
| RBAC post-filtering   | N/A           | Basic      | Full (graph ACLs) |

**Additional guardrails:**

- **Parameterized query enforcement:** All `graph_query` calls must use parameterized queries (`$param` syntax). String interpolation in Cypher text is rejected. This prevents injection attacks.
- **Hop limit enforcement:** The MCP server parses the Cypher AST to detect variable-length path patterns (e.g., `-[*1..N]-`). If `N` exceeds the configured hop limit, the query is rejected with an explanation and a suggestion to use a structured tool instead.
- **RBAC enforcement (Enterprise):** If graph-level RBAC is active, `graph_query` results are post-filtered to remove nodes/edges the caller's role cannot see. If post-filtering cannot be guaranteed (complex aggregations), the query is rejected with an explanation.

### 9.5 Per-Tool Latency Targets

> **All targets labeled "Unvalidated -- pending benchmark."** These are design-time goals, not measured SLAs. Benchmarks will be run against reference graphs during Phase 1 development.

| Tool                      | P95 Target | Notes                         |
| ------------------------- | ---------- | ----------------------------- |
| entity_detail             | <200ms     | Single node + 1-hop neighbors |
| find_owners               | <500ms     | 2-3 hop traversal             |
| blast_radius (depth <= 3) | <1s        | Common case                   |
| blast_radius (depth 4-6)  | <3s        | Deep traversal                |
| graph_stats               | <500ms     | Cached, refreshed every 60s   |
| search_entities           | <1s        | Index-backed property filters |
| recent_changes            | <1s        | Index on `_last_synced`       |
| health_check              | <500ms     | Aggregation of 1-2 hop data   |
| list_violations           | <2s        | Full label scan with filter   |
| dependency_chain          | <2s        | Shortest path algorithm       |
| change_impact             | <3s        | Superset of blast_radius      |
| team_topology             | <500ms     | 1-2 hop from team node        |
| schema_info               | <100ms     | Cached in memory              |
| semantic_search           | <1s        | Phase 2, vector ANN           |

### 9.6 Error Responses

All MCP tools return errors in a standard schema:

```json
{
  "error": {
    "code": "NODE_NOT_FOUND",
    "message": "Entity 'shipit://logical-service/default/paymets-api' not found in the graph.",
    "suggestions": ["Did you mean 'shipit://logical-service/default/payments-api'?"]
  }
}
```

**Error codes:**

| Code                 | HTTP-Equivalent | Description                                                   |
| -------------------- | --------------- | ------------------------------------------------------------- |
| NODE_NOT_FOUND       | 404             | The specified canonical ID does not exist in the graph        |
| INVALID_CANONICAL_ID | 400             | The canonical ID format is malformed                          |
| INVALID_PARAMETER    | 400             | A required parameter is missing or has an invalid value       |
| DEPTH_EXCEEDED       | 400             | Requested depth exceeds the maximum allowed                   |
| HOP_LIMIT_EXCEEDED   | 400             | Cypher query contains variable-length pattern exceeding limit |
| QUERY_TIMEOUT        | 408             | Query exceeded the configured timeout                         |
| ROW_LIMIT_EXCEEDED   | 413             | Query would return more rows than the configured limit        |
| RATE_LIMIT_EXCEEDED  | 429             | Daily query limit reached (for `graph_query`)                 |
| RBAC_DENIED          | 403             | Caller does not have permission to access the requested data  |
| TOOL_NOT_AVAILABLE   | 501             | Tool is deferred to a future phase (e.g., `semantic_search`)  |
| INTERNAL_ERROR       | 500             | Unexpected server error                                       |

**Suggestions:** When `NODE_NOT_FOUND` is returned, the MCP server performs a fuzzy name search (Levenshtein distance <= 2) and returns up to 3 suggestions. This helps AI agents self-correct without requiring human intervention.

### 9.7 Acceptance Tests

Every MCP tool has a regression test suite based on reference graphs -- small, deterministic Neo4j fixtures with known topology:

- **Reference graph:** A YAML/JSON-defined graph loaded into a test Neo4j instance (e.g., 20 LogicalServices, 50 Deployments, 100 relationships).
- **Expected outputs:** For each tool + parameter combination, the expected response is defined as a JSON assertion.
- **CI integration:** Acceptance tests run on every PR that touches MCP tool logic or Cypher generation.
- **Regression detection:** Any change to tool output that does not match the expected response fails the build.
- **Coverage target:** 100% of tool contracts have at least one happy-path and one error-path test.

### 9.8 Context Window Optimization

MCP responses are designed to be consumed by AI agents with limited context windows. Optimization strategies:

- **Summarization:** Large result sets are summarized (e.g., "42 downstream dependencies found, top 5 by criticality: ...").
- **Pagination:** Results support cursor-based navigation. AI agents can request more pages if needed.
- **Metadata hints:** Responses include contextual hints ("this is Tier-1, PCI-scoped") to help agents prioritize without fetching additional data.
- **Progressive detail:** `entity_detail` returns summary by default; full claims only on `include_claims=true`.
- **Default token budget:** Each tool targets a response size of ~4,000 tokens or less. Responses exceeding this budget are automatically truncated with a `truncated: true` flag in `_meta` and a cursor for fetching the remainder.
- **Compact mode:** The `compact` parameter strips `_meta`, claim details, and verbose neighbor lists for multi-tool composition workflows.

---

_End of Part 1 (Sections 1-9). Sections 10-22 continue in Part 2._

## 10. Web Dashboard

### 10.1 View Phasing

| Phase   | Views                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| Phase 1 | Home/Overview, Graph Explorer, Connector Hub, Onboarding Wizard                                                |
| Phase 2 | Entity Detail, Schema Editor (form-based), Claim Explorer, Reconciliation UI, Query Playground, Team Dashboard |
| Phase 3 | Platform Health (merged into Connector Hub as a tab), Audit Log, AI Agent Activity                             |

### 10.2 Home/Overview View

The Home view is a role-aware landing page that serves as the primary entry point after login.

**Core Components:**

- **Graph Health Summary** -- Node/edge counts, staleness percentage, most recent sync timestamp, connector status indicators.
- **Quick Actions** -- Add connector, explore graph, view reconciliation candidates, trigger re-sync.
- **Recent Activity Feed** -- Last 50 events: connector syncs, identity merges, schema changes, MCP tool calls.

**Role-Specific Panels:**

| Role                | Panel Content                                                                         |
| ------------------- | ------------------------------------------------------------------------------------- |
| Platform Engineer   | Connector health grid, DLT depth, Event Bus consumer lag, recent sync failures        |
| Engineering Manager | Ownership gap count, services without on-call, team topology summary                  |
| SRE                 | Degraded monitors, Tier-1 service status, blast radius quick-search                   |
| Default             | Graph stats, recent activity, getting started checklist (if <3 connectors configured) |

Role detection is based on team membership and permissions from the Identity connector. Falls back to Default if no role mapping is configured.

### 10.3 Entity Detail View

A dedicated single-entity page accessible from Graph Explorer, Global Search, or direct URL (`/entity/{canonical_id}`).

**Layout:**

- **Header** -- Entity label badge, canonical name, canonical ID, tier badge, lifecycle status, last synced timestamp.
- **Effective Properties** -- Key-value table of materialized `_effective` properties. Each property row includes an inline provenance indicator: source icon, confidence badge, and a "View Claims" link that navigates to Claim Explorer filtered to this entity and property.
- **Relationship Summary** -- Two-column layout:
  - **Upstream** -- Entities this entity depends on (DEPENDS_ON, CALLS, CONSUMES, IMPORTS).
  - **Downstream** -- Entities that depend on this entity (reverse of upstream edges).
  - Each relationship row shows entity name, label, tier, and link to its Entity Detail page.
- **Sync History** -- Chronological list of sync events for this entity: connector, timestamp, properties changed, event version.
- **Linked Views** -- Quick-nav links:
  - "View in Graph Explorer" (opens Graph Explorer centered on this node).
  - "Inspect Claims" (opens Claim Explorer filtered to this entity).
  - "Related Work Items" (lists WorkItem nodes with TRACKS_WORK_ON edges to this entity).

### 10.4 Graph Explorer

#### 10.4.1 Graph Rendering Strategy

Rendering the full knowledge graph in the browser is infeasible for any non-trivial installation. The Graph Explorer uses server-side aggregation and progressive loading.

**Server-Side Aggregation:**

- The BFF (Next.js API route) queries Neo4j for a bounded neighborhood -- default 2-hop from the focused node or search result set.
- Nodes beyond the rendered boundary are represented as aggregate "cluster" nodes with a count badge (e.g., "+12 Deployments").
- The BFF returns Cytoscape.js-compatible JSON: `{ nodes: [...], edges: [...] }` with pre-computed positions for the selected layout.

**Progressive Loading:**

- Initial render loads Tier-1 LogicalServices and their 1-hop neighbors.
- Expanding a cluster node triggers a BFF call to fetch the next level of detail.
- Viewport-based culling: nodes outside the visible viewport are removed from the Cytoscape instance and re-added on pan/zoom.

**Layout Algorithms:**

| Layout                | Use Case                                                     | Library                |
| --------------------- | ------------------------------------------------------------ | ---------------------- |
| Dagre (hierarchical)  | Dependency chains, upstream/downstream views                 | cytoscape-dagre        |
| Force-directed (CoSE) | General exploration, no clear hierarchy                      | cytoscape-cose-bilkent |
| Concentric            | Blast radius visualization (origin at center, hops as rings) | cytoscape-concentric   |

Users can switch layouts via a toolbar dropdown. Layout selection persists per session in Zustand.

#### 10.4.2 Interaction Patterns

- **Search Bar** -- Top of Graph Explorer. Searches by name, canonical ID, or linking key. Results appear as a dropdown; selecting a result centers the graph on that node.
- **Filter Panel** -- Collapsible sidebar with checkboxes for:
  - Node labels (LogicalService, Deployment, RuntimeService, etc.)
  - Environment (production, staging, dev)
  - Tier (1, 2, 3, untiered)
  - Owner team
  - Connector source
  - Filters apply in real-time, hiding non-matching nodes and their disconnected edges.
- **Click Interactions:**
  - Single-click: Opens a summary panel (slide-in from right) with entity name, label, tier, owner, last synced, and top 5 properties.
  - Double-click: Navigates to the Entity Detail view for that node.
  - Right-click: Contextual menu with actions: "Expand neighbors," "Show blast radius," "Find owners," "Copy canonical ID," "Open in new tab."
- **Edge Interactions:**
  - Hover: Tooltip showing relationship type, source connector, confidence score.
  - Click: Highlights the full path and shows edge properties in the summary panel.
- **Breadcrumb Trail** -- Tracks navigation history within the Graph Explorer session. Clicking a breadcrumb re-centers the graph on that node.

### 10.5 Schema Editor (Phase 2)

The Schema Editor provides form-based ontology management. Drag-and-drop visual editing is deferred beyond Phase 2.

**Capabilities:**

- **Node Type List** -- Scrollable list of all node labels. Each entry expands to show:
  - Property definitions (name, type, required/optional, default value).
  - Resolution strategy per property, configured via dropdown with inline explanations:
    - `MANUAL_OVERRIDE_FIRST` -- "Human claims always win. Best for: tier, lifecycle."
    - `AUTHORITATIVE_ORDER` -- "Ranked source priority. Best for: owner, language."
    - `HIGHEST_CONFIDENCE` -- "Highest confidence score wins. Best for: name, description."
    - `LATEST_TIMESTAMP` -- "Most recent claim wins. Best for: status, replicas."
    - `MERGE_SET` -- "All values combined into a set. Best for: tags, labels."
  - Live preview: selecting a strategy shows how it would resolve a sample conflict (e.g., "Backstage says tier=1, Kubernetes says tier=2 -> Resolved: tier=1 via AUTHORITATIVE_ORDER [backstage > kubernetes]").
- **Add/Remove Operations** -- Form-based. Adding a node type requires: label, at least one property, unique constraint key. Removing a node type shows an impact analysis: "This will delete 342 nodes and 1,208 relationships. Type the label name to confirm."
- **Schema Validation** -- Before applying changes, the editor runs validation:
  - No duplicate labels or relationship types.
  - All relationship `from`/`to` labels exist.
  - Required properties have resolution strategies defined.
  - Circular relationship definitions are flagged as warnings.
- **Read-Only Visual Preview** -- Cytoscape.js rendering of the schema as a meta-graph: node types as nodes, relationship types as edges. Non-interactive; for orientation only.
- **Version History** -- List of schema versions with diff view (added/removed/changed types and properties). Rollback available for the last 10 versions.

### 10.6 Connector Hub

The Connector Hub is the central management interface for all integrations.

**Primary Tab: Integrations**

- Grid of configured connectors, each showing: connector icon, name, status badge (healthy/degraded/failed/disabled), last sync time, entity count, next scheduled sync.
- Clicking a connector opens its detail panel: sync history, error log (last 100 entries), DLQ inspector (view/replay/purge failed items), re-sync button (full or incremental), configuration editor (credentials, scope, schedule).
- "Add Connector" button launches the Onboarding Wizard (Section 8.3) scoped to a single connector.

**Secondary Tab: Platform Health**

Rather than a separate Platform Health view, operational metrics are consolidated here as a second tab:

- **Consumer Lag** -- Real-time chart of Event Bus consumer lag (P50, P95, P99) with SLO threshold line.
- **DLT Depth** -- Per-connector dead letter topic item count with trend sparklines.
- **Throughput** -- Core Writer entities/minute over the last 24 hours.
- **Graph Stats** -- Total nodes by label, total edges by type, staleness percentage, orphan count.
- **System Resources** -- Neo4j heap usage, disk usage, connection pool utilization; Event Bus disk/retention usage.

Real-time updates via WebSocket/SSE for consumer lag and DLT depth. All other metrics refresh on a 30-second polling interval.

### 10.7 SRE Incident Mode

A streamlined view optimized for on-call incident response. Accessible from the sidebar and via keyboard shortcut (Cmd/Ctrl+I).

**Layout:**

- **Single Search Box** -- Prominent, auto-focused on view load. Placeholder: "What service is having problems?" Searches by service name, canonical ID, RuntimeService name (Datadog service name), or Kubernetes deployment name.
- **Blast Radius Panel** -- Immediately renders on search result selection. Pre-configured defaults:
  - Direction: DOWNSTREAM
  - Environment: production
  - Depth: 3
  - Layout: Concentric (origin service at center)
- **Affected Services Table** -- Below the blast radius visualization. Columns: service name, tier, owner team, environment, monitor status. Sorted by tier (Tier-1 first).
- **On-Call Contacts** -- For each affected team: on-call person name, email, Slack handle, PagerDuty link. Sourced from ON_CALL_FOR relationships.
- **Recent Changes** -- Changes to the origin service and its 1-hop neighbors in the last 24 hours: connector syncs, property changes, new/removed relationships.
- **Runbook Links** -- DOCUMENTED_BY relationships where the Document type is "runbook." Direct links to Confluence/GitHub/Notion pages.

### 10.8 AI Agent Activity View (Phase 3)

A dashboard for understanding how AI agents interact with the knowledge graph via MCP tools.

**Panels:**

- **Tool Call Analytics** -- Time-series chart of MCP tool invocations, filterable by tool name, agent API key, and time range. Table view with columns: timestamp, tool, agent name, parameters (truncated), response time (ms), result count, status (success/error).
- **Most Queried Entities** -- Ranked list of entities by MCP query frequency. Identifies "hot" nodes that agents frequently reason about.
- **Failed Queries & Error Patterns** -- Grouped by error code (NODE_NOT_FOUND, TIMEOUT, PERMISSION_DENIED). Each group shows frequency, example queries, and suggested fixes.
- **Usage Trends** -- Weekly/monthly aggregates: total calls, unique agents, unique entities queried, average response time. Trend arrows for week-over-week changes.

### 10.9 Global Search

A persistent search bar accessible from any view via Cmd/Ctrl+K keyboard shortcut.

**Behavior:**

- Searches all entity types by: name, canonical ID, linking key, and indexed properties.
- Results are grouped by entity type with type badges: `[LogicalService]`, `[Repository]`, `[Deployment]`, etc.
- Each result shows: entity name, canonical ID (truncated), owner team, last synced.
- Selecting a result navigates to the Entity Detail view. Holding Shift+Enter opens in Graph Explorer centered on that node.

**Structured Filters:**

- `type:LogicalService` -- Filter by entity type.
- `tier:1` -- Filter by tier.
- `owner:payments-team` -- Filter by owner.
- `source:github` -- Filter by source connector.
- Filters can be combined: `type:LogicalService tier:1 owner:payments-team`.

**Phase 2 Enhancement:**

- Natural language search via the vector store (semantic_search tool). Results include a relevance score and snippet.
- Toggle between "Exact" and "Semantic" search modes.

### 10.10 Navigation Structure

**Grouped Sidebar:**

```
Primary Navigation (left sidebar):
  Home (overview)
  Explore
    Graph Explorer
    Query Playground (Phase 2)
  Catalog
    Entity Detail (dynamic, not in sidebar -- accessed via search/links)
    Team Dashboard (Phase 2)
  Configure
    Schema Editor (Phase 2; YAML file editing in Phase 1)
    Connector Hub
  Operations
    Claim Explorer (Phase 2)
    Reconciliation UI (Phase 2)
    Incident Mode
  Admin (Enterprise)
    Audit Log
    Access Control
```

**Cross-View Linking:**

| From              | Action                        | To                                              |
| ----------------- | ----------------------------- | ----------------------------------------------- |
| Graph Explorer    | Click node                    | Entity Detail for that node                     |
| Entity Detail     | "Inspect Claims" link         | Claim Explorer filtered to that entity          |
| Entity Detail     | "View in Graph Explorer" link | Graph Explorer centered on that node            |
| Connector Hub     | Click connector error         | DLQ inspector for that connector                |
| Connector Hub     | Platform Health tab           | Consumer lag, throughput, graph stats           |
| Team Dashboard    | Click service                 | Entity Detail for that service                  |
| Team Dashboard    | "View Team Graph"             | Graph Explorer filtered to that team's entities |
| Reconciliation UI | Click merge candidate         | Side-by-side Entity Detail comparison           |

### 10.11 Tech Stack

| Layer               | Technology                                                                 | Rationale                                                                                 |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Framework           | Next.js 14+ (App Router)                                                   | SSR for initial load, RSC for streaming, API routes for BFF pattern                       |
| UI Components       | shadcn/ui + Tailwind CSS                                                   | Accessible, customizable, no vendor lock-in                                               |
| Graph Visualization | Cytoscape.js (Phase 2: evaluate WebGL alternatives for >10K visible nodes) | Mature graph rendering with plugin ecosystem                                              |
| Server State        | TanStack Query (React Query)                                               | Caching, background refetching, optimistic updates, request deduplication                 |
| Client State        | Zustand                                                                    | Lightweight stores for UI-only state: viewport position, filter selections, sidebar state |
| Real-time           | WebSocket/SSE                                                              | Sync progress indicators, consumer lag streaming, DLT alert notifications                 |
| Auth                | NextAuth.js (Community) / Enterprise SSO adapter                           | OAuth2 for Community, SAML/OIDC for Enterprise                                            |

**BFF Pattern:**

Next.js API routes serve as a Backend-for-Frontend layer, aggregating data from the API Server for specific view requirements:

- **Graph Explorer BFF** (`/api/graph/neighborhood`) -- Queries the API Server for a bounded neighborhood, transforms the response into Cytoscape.js-compatible JSON (`{ nodes: [{data: {id, label, ...}, position: {x, y}}], edges: [{data: {source, target, ...}}] }`), and pre-computes layout positions.
- **Home BFF** (`/api/dashboard/overview`) -- Aggregates graph stats, connector health, recent activity, and role-specific panels into a single response.
- **Incident Mode BFF** (`/api/incident/context`) -- Combines blast radius, on-call contacts, recent changes, and runbook links into a single payload optimized for the Incident Mode view.

---

## 11. Multi-Org & Multi-Cluster Support

ShipIt-AI is designed for multi-org from day one. Every node in the graph carries a `_source_org` property that identifies the originating organization, cluster, or tenant.

**Phase 1: Single-Org Implementation**

- All nodes share a single implicit org context.
- `_source_org` is populated on every node by connectors, establishing the data model even though the UI does not expose multi-org features.
- The Connector Hub supports configuring a single instance of each connector type.

**Phase 2: Multi-Org Activation**

- The Connector Hub UI supports adding multiple instances of the same connector type (e.g., two GitHub orgs, three Kubernetes clusters).
- Each connector instance has its own credentials, scope, and sync schedule.
- Graph Explorer adds an org filter to the filter panel.
- Cross-org relationships are supported (e.g., a LogicalService in org-a DEPENDS_ON a LogicalService in org-b).

**Source Org Namespacing:**

| Source System     | `_source_org` Format            | Example             |
| ----------------- | ------------------------------- | ------------------- |
| GitHub            | `github/{org-name}`             | `github/acme-corp`  |
| Kubernetes        | `k8s/{cluster-name}`            | `k8s/us-east-prod`  |
| Jira              | `jira/{instance}/{project-key}` | `jira/acme/PLAT`    |
| Datadog           | `datadog/{org-name}`            | `datadog/acme-prod` |
| Backstage         | `backstage/{instance}`          | `backstage/acme`    |
| Identity Provider | `idp/{tenant-name}`             | `idp/acme-okta`     |

---

## 12. Connector Resilience & Failure Handling

### 12.1 Failure Modes

| Failure Mode             | Impact                          | Mitigation                                                                                     |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Rate limiting (429)      | Sync slows temporarily          | Exponential backoff with jitter, respect Retry-After headers, per-connector rate budget        |
| Auth expiration          | All API calls fail              | Auto-refresh tokens (OAuth), alert user for PAT/API key rotation                               |
| Partial fetch failure    | Some entities not synced        | Checkpoint-based sync; resume from last cursor, not restart                                    |
| Source API outage        | Connector cannot reach source   | Circuit breaker: open after 5 consecutive failures, half-open retry every 5 min (configurable) |
| Schema mismatch          | Source returns unexpected shape | Normalizer catches errors, routes to DLT, continues with valid data                            |
| Webhook delivery failure | Real-time events lost           | Webhook idempotency keys + scheduled reconciliation as safety net                              |
| Graph write failure      | Core Writer rejects a write     | Core Writer retries with backoff, DLT for persistent failures, alert in UI                     |

### 12.2 Connector-Specific Staleness Windows

Different connectors have fundamentally different data velocity. A Kubernetes Deployment that hasn't synced in 10 minutes is concerning; a Backstage catalog entry that hasn't synced in 12 hours is normal.

| Connector                | Healthy Window | Stale Window  | Orphan Threshold |
| ------------------------ | -------------- | ------------- | ---------------- |
| Kubernetes               | < 5 minutes    | 5-30 minutes  | > 2 hours        |
| GitHub (webhooks active) | < 15 minutes   | 15-60 minutes | > 6 hours        |
| GitHub (polling only)    | < 2 hours      | 2-6 hours     | > 24 hours       |
| Datadog                  | < 10 minutes   | 10-60 minutes | > 6 hours        |
| Backstage                | < 24 hours     | 24-48 hours   | > 7 days         |
| Jira                     | < 1 hour       | 1-6 hours     | > 24 hours       |
| Identity Provider        | < 24 hours     | 24-72 hours   | > 7 days         |

### 12.3 Reconciliation Intervals

Each connector type has a recommended reconciliation interval -- a full re-sync that catches any events missed by real-time mechanisms.

| Connector         | Reconciliation Interval | Rationale                                                            |
| ----------------- | ----------------------- | -------------------------------------------------------------------- |
| Kubernetes        | Hourly                  | Watch API is reliable but can miss events during API server restarts |
| GitHub            | Hourly                  | Webhook delivery is best-effort; hourly reconciliation catches gaps  |
| Datadog           | Daily                   | Monitor and service map data changes infrequently                    |
| Backstage         | Hourly                  | Primary catalog source; frequent polling ensures freshness           |
| Jira              | Daily                   | Issue data is additive; daily reconciliation is sufficient           |
| Identity Provider | Daily                   | Org structure changes infrequently                                   |

### 12.4 Dead Letter Topic (DLT)

- Inspectable from the Connector Hub UI -- view failed entities, error messages, and source payloads.
- Retryable -- one-click replay for individual items or bulk replay from the DLT.
- Alertable -- configurable thresholds (default: >10 DLT items triggers warning notification, >50 triggers critical; configurable).
- Expiring -- DLT items older than 7 days auto-purged (default; configurable). Next full sync re-discovers them.

### 12.5 Sync State Machine

```
IDLE ──(sync triggered)──> SYNCING
SYNCING ──(all entities processed)──> COMPLETING
SYNCING ──(unrecoverable error)──> FAILED
COMPLETING ──(post-sync validation passed, DLT=0)──> IDLE
COMPLETING ──(post-sync validation passed, DLT>0)──> DEGRADED
DEGRADED ──(DLT drained or next sync triggered)──> SYNCING
FAILED ──(manual retry or next scheduled sync)──> SYNCING
```

- **IDLE** -- No sync in progress.
- **SYNCING** -- Active sync, progress tracked (entities discovered / published to Event Bus).
- **COMPLETING** -- Sync finished, running post-sync validation (orphan detection, relationship consistency).
- **FAILED** -- Unrecoverable error, DLT populated, alert raised.
- **DEGRADED** -- Completed with partial failures (DLT items > 0), graph is usable but incomplete.

---

## 13. Data Lifecycle & Retention

### 13.1 Data Classification

| Classification  | Description                                 | Examples                                                                   | Default TTL                                                                                |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Source Ingested | Data pulled directly from source systems    | LogicalService nodes, Deployment nodes, PropertyClaims, relationships      | Retained while source exists; orphan detection per connector staleness window              |
| Derived         | Data computed by ShipIt-AI from source data | Vector embeddings, code summaries, risk scores, LLM-generated descriptions | 90 days since last regeneration (configurable). Re-derived on next sync if source changes. |
| Operational     | Internal platform data                      | Sync logs, idempotency keys, DLT contents, MCP query audit logs            | 30 days (configurable). Idempotency log: 30 days. DLT: 7 days.                             |

### 13.2 Staleness Detection

Every node carries a `_last_synced` timestamp and a `_source_system` label. A background job evaluates staleness using connector-specific windows (see Section 12.2):

| Status   | Definition                                             | Visual Indicator           |
| -------- | ------------------------------------------------------ | -------------------------- |
| Healthy  | Synced within the connector's healthy window           | Green dot                  |
| Stale    | Past healthy window but within the stale window        | Yellow dot + "Stale" badge |
| Orphaned | Past the orphan threshold, flagged for review/deletion | Red dot + "Orphaned" badge |

Staleness thresholds are configurable per connector type in the Connector Hub settings. Orphaned nodes are not auto-deleted; they are flagged in the Reconciliation UI for human review. After 30 days in orphaned status with no action, they are soft-deleted (`_deleted=true`).

### 13.3 Right-to-Forget

When an entity is deleted from the source system (person leaves org, repo archived, service decommissioned):

- **Source Ingested data:** Node is marked as `_deleted=true` with a `_deleted_at` timestamp. Retained for 30 days (configurable) for audit trail, then hard-deleted.
- **Derived data:** Embeddings and summaries are purged immediately upon source deletion.
- **Claims:** PropertyClaims from the deleted entity are archived (not queryable) for 90 days (configurable), then purged.
- **Merge history:** Retained permanently for audit trail, even after entity deletion.

### 13.4 Graph Backup & Restore

**Backup Strategy:**

- **Daily Neo4j Backups** -- Automated `neo4j-admin database dump` to a mounted volume. Retention: 7 daily backups + 4 weekly backups (configurable).
- **Backup Location** -- Docker Compose: mounted host volume (`./backups/`). Kubernetes: PersistentVolumeClaim with optional cloud storage sync (S3, GCS, Azure Blob).
- **Backup Verification** -- Weekly automated restore-to-temp-instance test. Alert if verification fails.

**Restore Procedures:**

| Scenario                           | Procedure                                                                             | RTO       |
| ---------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| Neo4j corruption / data loss       | Restore from latest daily backup using `neo4j-admin database load`                    | < 1 hour  |
| Accidental mass deletion           | Restore from backup, then replay Event Bus events from the deletion timestamp forward | < 2 hours |
| Event Bus data loss (< 7 days old) | Replay from Event Bus retention window                                                | < 1 hour  |
| Full disaster recovery             | Restore Neo4j from backup + trigger full re-sync from all connectors                  | < 4 hours |

**Event Bus as DR Mechanism:**

For data less than 7 days old (the default Event Bus retention window), replaying the event stream from a given timestamp is the fastest recovery path. This re-applies all connector events through the Core Writer, rebuilding the graph state.

For data older than 7 days, full re-sync from connectors is the fallback. Each connector re-discovers and re-publishes all entities, and the Core Writer's idempotency logic ensures no duplicates.

---

## 14. Performance Budgets & Backpressure

> **All targets in this section are Targets (Unvalidated -- pending benchmark).** They will be validated against synthetic test data during Phase 1a and updated based on empirical results.

### 14.1 Ingestion Performance Targets

| Metric                    | Community (Neo4j CE)      | Enterprise (Neo4j EE)      | Notes                                                                    |
| ------------------------- | ------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| Core Writer batch size    | 500 entities/transaction  | 1,000 entities/transaction | CE lacks causal clustering; smaller batches reduce lock contention       |
| Core Writer throughput    | > 3,000 entities/min      | > 5,000 entities/min       | Per consumer instance. EE benefits from causal clustering read replicas. |
| Event Bus lag (P95)       | < 90 seconds              | < 60 seconds               | Community has single Core Writer instance                                |
| Event Bus lag (P99)       | < 10 minutes              | < 5 minutes                | Acceptable during full-sync bursts                                       |
| Connector full sync       | < 30 min for 10K entities | < 30 min for 10K entities  | Bottlenecked by source API rate limits, not ShipIt-AI                    |
| Neo4j write latency (P95) | < 150ms per batch MERGE   | < 100ms per batch MERGE    | Requires indexes on canonical IDs and linking keys                       |

### 14.2 MCP Tool Latency Targets

Per-tool latency decomposition (reference Section 9.5):

| Tool             | Target P95 | Cypher Execution                       | Post-processing                   | Network Overhead |
| ---------------- | ---------- | -------------------------------------- | --------------------------------- | ---------------- |
| blast_radius     | < 800ms    | ~400ms (variable-length path, depth 3) | ~200ms (result shaping)           | ~200ms           |
| find_owners      | < 500ms    | ~200ms (1-2 hop traversal)             | ~100ms                            | ~200ms           |
| dependency_chain | < 1,000ms  | ~500ms (shortest path, max depth 6)    | ~300ms                            | ~200ms           |
| entity_detail    | < 400ms    | ~150ms (single node + 1-hop)           | ~50ms                             | ~200ms           |
| search_entities  | < 600ms    | ~300ms (index lookup)                  | ~100ms                            | ~200ms           |
| schema_info      | < 300ms    | ~50ms (meta-node read, cached)         | ~50ms                             | ~200ms           |
| graph_stats      | < 500ms    | ~200ms (count queries)                 | ~100ms                            | ~200ms           |
| semantic_search  | < 1,500ms  | ~800ms (vector similarity)             | ~200ms (re-rank + metadata fetch) | ~200ms           |

### 14.3 Write Amplification Analysis

With the JSON claims model (ADR-002), property claims are stored as a JSON array on the entity node rather than as separate PropertyClaim nodes with HAS_CLAIM relationships.

| Operation                         | Separate Claim Nodes (v0.2)                                                               | JSON Claims (v0.3)                                       | Reduction  |
| --------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------- |
| Write 1 entity with 10 properties | ~45 Neo4j ops (1 MERGE entity + 10 MERGE claims + 10 MERGE HAS_CLAIM + ~24 index updates) | ~2 Neo4j ops (1 MERGE entity with JSON + 1 index update) | ~95%       |
| Read entity with claims           | 1 node read + 10 claim traversals                                                         | 1 node read (claims inline)                              | ~90%       |
| Claim resolution                  | Query 10 claim nodes, sort, update effective                                              | Parse JSON array in application, update effective        | Comparable |

**Trade-off:** JSON claims sacrifice graph-native claim querying (no direct Cypher traversal of claims). The Claim Explorer UI handles this by parsing the JSON in the API Server. For the expected claim volume per entity (typically 5-20 claims), JSON parsing overhead is negligible.

### 14.4 Graph Size Projections

| Installation Size        | Entities    | Relationships | Estimated Neo4j Storage | Recommended Neo4j Heap |
| ------------------------ | ----------- | ------------- | ----------------------- | ---------------------- |
| Small (< 100 services)   | ~2K nodes   | ~5K edges     | < 1 GB                  | 1 GB                   |
| Medium (100-1K services) | ~20K nodes  | ~80K edges    | 5-10 GB                 | 4 GB                   |
| Large (1K+ services)     | ~200K nodes | ~1M edges     | 50-100 GB               | 16 GB                  |

### 14.5 Degradation Plan

| Entity Count | Expected Behavior                                                                                              | Action Required                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| < 10K        | All operations within target latency. Single Core Writer instance sufficient.                                  | None                                                                                                        |
| 10K-50K      | MCP tool latency may increase 2-3x for deep traversals (depth > 3). Core Writer throughput may require tuning. | Optimize Cypher queries, increase batch size, add Neo4j indexes for hot query patterns                      |
| 50K-100K     | blast_radius and dependency_chain may exceed 2s P95. Graph Explorer may lag on initial load.                   | Mandatory result pagination. Server-side graph aggregation. Consider Neo4j EE with read replicas.           |
| 100K-500K    | Single-instance Neo4j CE may hit memory limits. Full-graph queries become impractical.                         | Migrate to Neo4j EE. Implement query-level circuit breakers (abort if > 5s). Pre-compute common traversals. |
| > 500K       | Beyond validated scale.                                                                                        | Requires architectural review: sharding strategy, federated graph, or graph-per-org.                        |

### 14.6 Performance Validation Plan

Before committing to Phase 1b, the following benchmarks must be completed:

1. **Synthetic Graph Generation** -- Build a script that generates a realistic graph at 5K entities (Small installation + headroom) with realistic relationship density.
2. **Core Writer Throughput** -- Measure entities/minute for full sync and incremental sync scenarios. Validate against Community targets.
3. **MCP Tool Latency** -- Benchmark each tool against the synthetic graph. Record P50, P95, P99.
4. **Memory Footprint** -- Measure Neo4j heap usage and Docker Compose total memory at 5K entities. Validate < 4 GB total for Phase 1 target.
5. **Scale Extrapolation** -- Run the same benchmarks at 10K and 20K entities to validate degradation projections.

Results will be documented and targets revised if empirical data diverges significantly from estimates.

### 14.7 Backpressure Strategy

When Event Bus consumer lag exceeds the P95 SLO:

1. **Auto-scale consumers** -- If running on Kubernetes, HPA scales Core Writer replicas based on consumer lag metric.
2. **Adaptive connector scheduling** -- If lag exceeds 2x SLO, scheduled connectors defer their next sync until lag recovers. Real-time webhooks continue.
3. **Circuit breaker on ingestion** -- If lag exceeds 5x SLO (critical), new connector syncs are paused. Alert raised. Existing in-flight events continue draining.
4. **Manual intervention** -- Platform Health tab in Connector Hub surfaces lag metrics, DLT depth, and consumer throughput for operator action.

### 14.8 Dead Letter & Replay

- Events that fail Core Writer processing after 3 retries (configurable) are routed to the Dead Letter Topic.
- DLT events retain the full event payload, error message, retry count, and last attempt timestamp.
- Replay: operator can replay DLT events back to the main topic (one-click from Connector Hub UI).
- Full replay: operator can replay the entire Event Bus retention window (e.g., last 7 days) for disaster recovery or re-processing after a bug fix.

---

## 15. Extensibility Model

### 15.1 Adding New Connectors

#### 15.1.1 Scaffold CLI

```bash
shipit connector create --name terraform-cloud --language typescript
```

Generates:

- Connector class implementing the `ShipItConnector` interface (see Appendix A.3).
- Auth configuration template (OAuth2, API key, or custom).
- Entity type stubs with `normalize()` methods that output `CanonicalNode`/`CanonicalEdge` with claims.
- Test harness with mock API responses.
- Dockerfile for containerized execution.
- README with registration and publishing instructions.

> **v0.3 Change:** The `publish()` method has been removed from the Connector SDK. The SDK auto-publishes the output of `normalize()` to the Event Bus. Connector authors implement `normalize()` and the framework handles publishing. This reduces boilerplate and ensures consistent event formatting.

#### 15.1.2 Canonical Data Format

```typescript
interface CanonicalNode {
  id: string; // Canonical ID: shipit://{label}/{namespace}/{name}
  label: string; // Node label (e.g., 'LogicalService', 'Repository')
  properties: Record<string, any>;
  _claims: PropertyClaim[]; // JSON array stored on entity node (v0.3: replaces separate claim nodes)
  _source_system: string;
  _source_org: string;
  _source_id: string;
  _last_synced: string; // ISO 8601
  _event_version: number | string; // Monotonic integer or ISO 8601 timestamp only
}

interface CanonicalEdge {
  type: string; // Relationship type (e.g., 'DEPENDS_ON')
  from: string; // Source node canonical ID
  to: string; // Target node canonical ID
  properties?: Record<string, any>;
  _source: string; // Connector that asserted this edge
  _confidence: number; // Confidence level (0.0-1.0)
}
```

> **v0.3 Change:** `_event_version` is constrained to monotonic integers or ISO 8601 timestamps. Arbitrary strings (e.g., Git SHAs) are not permitted because they cannot be reliably compared for ordering. Connectors using Git SHAs should map them to a monotonic counter or use the commit timestamp.

### 15.2 Adding Custom Node Types & Relationships

Users extend the ontology without writing code via the Schema Editor UI (Phase 2) or YAML configuration (Phase 1):

- **Add Node Type** -- Define label, properties (with types and resolution strategies), constraints (unique key), and source connector.
- **Add Relationship** -- Define type, direction (From -> To labels), cardinality (1:1, 1:N, N:M), optional edge properties.
- **Schema Versioning** -- Every change increments the version. Adding types requires no migration; removing types deletes nodes (with confirmation + impact count). Rollback available via version history.

---

## 16. Accessibility

ShipIt-AI targets **WCAG 2.1 Level AA** compliance for all web dashboard views.

### 16.1 Keyboard Navigation

- All interactive elements (buttons, links, form controls, tabs, menus) are keyboard-operable.
- Tab order follows logical reading order within each view.
- Graph Explorer: keyboard shortcuts for zoom (+ / -), pan (arrow keys), select next/previous node (Tab / Shift+Tab), expand node (Enter), context menu (Shift+F10).
- Modal dialogs trap focus. Escape key closes modals and slide-in panels.

### 16.2 Screen Reader Support

- All custom components (Graph Explorer summary panel, filter panel, Connector Hub grid) include ARIA labels, roles, and live regions.
- Dynamic content updates (sync progress, real-time metrics) use `aria-live="polite"` regions.
- Graph Explorer visualizations include a screen reader description summarizing the visible graph ("Showing 12 nodes centered on payments-api, 3 downstream dependencies, 2 Tier-1 services").

### 16.3 Color & Visual Design

- Color is never the sole indicator of state or meaning. All status indicators pair color with icons, patterns, or text labels:
  - Healthy: Green dot + checkmark icon + "Healthy" text.
  - Stale: Yellow dot + clock icon + "Stale" text.
  - Failed: Red dot + exclamation icon + "Failed" text.
- Contrast ratios meet WCAG AA minimums: 4.5:1 for normal text, 3:1 for large text and UI components.
- Graph node colors are paired with distinct shapes per entity type (circle for LogicalService, rectangle for Deployment, diamond for RuntimeService, etc.).

### 16.4 Focus Management

- Multi-step flows (Onboarding Wizard, Reconciliation UI merge confirmation) manage focus explicitly: focus moves to the next step's first interactive element on step transition.
- Toast notifications do not steal focus. They are announced via `aria-live` and auto-dismiss after 5 seconds.
- Error messages move focus to the error summary at the top of the form.

### 16.5 Graph Explorer Alternative View

For users who cannot interact with the visual graph (or prefer tabular data):

- A "Table View" toggle in the Graph Explorer toolbar switches to a tabular representation: rows are nodes, columns are properties, with expandable relationship sub-rows.
- Table View supports the same filter panel and search as the visual graph.
- Table View is the default for screen reader users (detected via `prefers-reduced-motion` or explicit user preference).

### 16.6 Responsive Design

| Breakpoint               | Experience                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop (>= 1280px)      | Full feature set. Primary target.                                                                                                                                          |
| Tablet (1024px - 1279px) | Sidebar collapses to icons. Graph Explorer uses simplified layout. Full interactivity.                                                                                     |
| Mobile (< 1024px)        | Read-only mode. Entity Detail, search, and Incident Mode search are available. Graph Explorer and Schema Editor are disabled with a "Use desktop for full access" message. |

---

## 17. Self-Telemetry & Observability

### 17.1 Metrics

| Category         | Metric                                          | Alert Threshold                                          |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Connector Health | Sync duration per connector (P50, P95, P99)     | P95 > 2x baseline                                        |
| Connector Health | Sync failure rate per connector                 | > 3 consecutive failures                                 |
| Connector Health | DLT depth per connector                         | > 10 items (warning), > 50 (critical); configurable      |
| Ingestion        | Event Bus consumer lag (P95, P99)               | P95 > 60s (warning), P99 > 5min (critical); configurable |
| Ingestion        | Core Writer throughput (entities/min)           | Below 80% of expected baseline                           |
| Ingestion        | Core Writer batch latency (P95)                 | > 200ms per batch                                        |
| Graph Integrity  | Total node count by label                       | Sudden drop > 10%                                        |
| Graph Integrity  | Orphaned node count                             | > 5% of total nodes                                      |
| Graph Integrity  | Staleness percentage by connector               | > 10% stale nodes                                        |
| Graph Integrity  | Dangling edges (referencing non-existent nodes) | Any detected                                             |
| MCP Server       | Tool call latency (P50, P95, P99)               | P95 > 3 seconds                                          |
| MCP Server       | Tool call error rate                            | > 1%                                                     |
| MCP Server       | `graph_query` (raw Cypher) audit count          | Trending (no threshold; audit-only)                      |
| Platform         | Neo4j disk usage                                | > 80% capacity                                           |
| Platform         | Vector DB index size                            | > 80% capacity                                           |
| Platform         | Event Bus disk usage / retention                | > 80% capacity                                           |

### 17.2 MCP Tool Usage Analytics

In addition to standard latency and error metrics, the following MCP-specific analytics are collected:

- **Tool frequency** -- Invocations per tool per day/week, broken down by agent API key.
- **Agent profiles** -- Which agents call which tools, with what parameters, and how often.
- **Failed query analysis** -- Queries that returned errors or empty results, grouped by error code and tool. Used to identify ontology gaps (e.g., agents repeatedly querying for entity types that don't exist).
- **Usage trends** -- Week-over-week change in total calls, unique agents, unique entities queried.

These analytics are surfaced in the AI Agent Activity view (Phase 3, Section 10.8) and exported via the `/metrics` endpoint for external dashboarding.

### 17.3 Observability Stack

| Layer    | Tool                                  | Notes                                                       |
| -------- | ------------------------------------- | ----------------------------------------------------------- |
| Metrics  | Prometheus + Grafana or Datadog       | ShipIt-AI exports `/metrics` endpoint in OpenMetrics format |
| Logging  | Structured JSON logs to stdout        | Compatible with any log aggregator (Loki, ELK, CloudWatch)  |
| Tracing  | OpenTelemetry SDK                     | Distributed traces for ingestion pipeline and MCP queries   |
| Alerting | Grafana Alerting or PagerDuty webhook | Configurable alert channels (Slack, email, PagerDuty)       |

---

## 18. Security & Access Control

### 18.1 Core Security Model

| Concern                   | Approach                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Credential storage        | Encrypted at rest (AES-256), never logged, never stored in Neo4j. Vault integration (Enterprise).             |
| Connector auth            | OAuth2 preferred, GitHub App for GitHub, API keys as fallback. Scoped to minimum required permissions.        |
| Graph access (Community)  | Single-tenant, all-or-nothing access to the graph.                                                            |
| Graph access (Enterprise) | RBAC: define which teams can see which node types/namespaces. Graph-level ACLs enforced at tool layer.        |
| MCP Server auth           | API key per agent. Rate limiting. Audit logging of all tool calls.                                            |
| `graph_query` RBAC        | Admin-only. Read-only DB role. RBAC post-filtering on results. If RBAC cannot be enforced, query is rejected. |
| Event Bus auth            | mTLS between connectors, Event Bus, and Core Writer. Credentials rotated automatically.                       |
| Data sensitivity          | Connectors never pull secret values. ConfigMap/Secret names only, not contents.                               |
| Network                   | All external API calls over TLS. Internal traffic on private network / mTLS (Kubernetes).                     |

### 18.2 Community Tier Credential Storage

For self-hosted Community installations that do not have HashiCorp Vault or equivalent:

- Connector credentials (API keys, OAuth tokens, GitHub App private keys) are stored in an encrypted local file on the API Server host.
- Encryption: AES-256-GCM with a machine-generated encryption key stored at `~/.shipit/encryption.key` (file permissions: `0600`).
- The encryption key is generated on first run and is unique per installation.
- **Limitation:** If the encryption key file is lost, all stored credentials must be re-entered. This is documented in the onboarding flow.
- **Upgrade path:** Enterprise tier replaces this with Vault integration.

### 18.3 Per-Agent API Keys

MCP Server access is authenticated via API keys. Each key is associated with metadata:

| Field          | Description                                        | Example                                            |
| -------------- | -------------------------------------------------- | -------------------------------------------------- |
| `key_id`       | Unique identifier (UUID)                           | `ak_7f3b2a1e`                                      |
| `agent_name`   | Human-readable name                                | "Claude Code Agent"                                |
| `agent_model`  | LLM model identifier (optional)                    | "claude-opus-4-6"                                  |
| `owner`        | Person or team responsible for the agent           | "platform-team"                                    |
| `created_at`   | Key creation timestamp                             | `2026-02-28T10:00:00Z`                             |
| `last_used_at` | Last successful API call                           | `2026-02-28T14:30:00Z`                             |
| `expires_at`   | Expiration timestamp (optional)                    | `2026-08-28T10:00:00Z`                             |
| `scopes`       | Allowed tool names (default: all structured tools) | `["blast_radius", "find_owners", "entity_detail"]` |

### 18.4 API Key Rotation & Revocation

- **Rotation:** New keys can be generated at any time from the Connector Hub admin panel. Old keys can be given a grace period (default: 24 hours) during which both old and new keys are valid.
- **Revocation:** Immediate revocation via UI or API. Revoked keys return `401 Unauthorized` on next use.
- **Expiration:** Keys can have an optional expiration date. Expired keys are automatically revoked. A warning notification is sent 7 days before expiration.

### 18.5 Rate Limiting

| Parameter                       | Default                                                | Configurable |
| ------------------------------- | ------------------------------------------------------ | ------------ |
| Requests per minute per API key | 60                                                     | Yes          |
| Burst allowance                 | 10 requests above limit                                | Yes          |
| Rate limit window               | Sliding 1-minute window                                | No           |
| Response on limit exceeded      | HTTP `429 Too Many Requests` with `Retry-After` header | N/A          |
| `graph_query` (raw Cypher) rate | 10 per minute per key (Enterprise only)                | Yes          |

Rate limiting state is stored in Redis (shared with the in-process event queue). Rate limit headers are included in every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## 19. Data Freshness & Sync Strategy

### 19.1 Sync Modes

| Mode           | Mechanism                            | Latency   | Use Case                                              |
| -------------- | ------------------------------------ | --------- | ----------------------------------------------------- |
| Real-time      | Webhooks -> Event Bus                | Seconds   | GitHub push, K8s watch, Datadog alerts, Jira events   |
| Near-real-time | Polling at short intervals (1-5 min) | Minutes   | APIs without webhook support                          |
| Scheduled      | Full reconciliation (hourly/daily)   | Hours     | Backstage catalog, identity provider, drift detection |
| Manual         | User-triggered re-sync from UI       | On-demand | After config changes, debugging                       |

### 19.2 Connector-Specific Freshness Expectations

| Connector         | Real-time                               | Near-real-time              | Scheduled                 |
| ----------------- | --------------------------------------- | --------------------------- | ------------------------- |
| GitHub            | Webhooks (push, PR, workflow_run)       | --                          | Hourly reconciliation     |
| Kubernetes        | Watch API (streaming)                   | --                          | Hourly reconciliation     |
| Datadog           | Monitor webhooks (state changes)        | 5-min polling (service map) | Daily reconciliation      |
| Backstage         | --                                      | --                          | Hourly polling            |
| Jira              | Webhooks (issue_created, issue_updated) | --                          | Daily reconciliation      |
| Identity Provider | SCIM push (Enterprise)                  | --                          | Daily polling (Community) |

**Phase 1 Freshness:**

In Phase 1 (GitHub + Kubernetes connectors only), the expected freshness model is:

- GitHub: Polling-based (webhooks deferred to Phase 2). Hourly full reconciliation ensures freshness within 1 hour.
- Kubernetes: Watch API provides near-real-time streaming from Phase 1b.

---

## 20. Graph Stewardship

### 20.1 Ontology Ownership

The knowledge graph ontology (node types, relationships, resolution strategies, connector configuration) requires ongoing stewardship. The recommended owner is the **Platform Engineering team** -- the same team that operates the internal developer platform.

Responsibilities:

- Review and approve schema changes (add/remove node types, adjust resolution strategies).
- Monitor connector health and resolve degraded/failed syncs.
- Review Reconciliation UI merge candidates on a weekly cadence.
- Tune fuzzy match thresholds based on false positive/negative feedback.
- Respond to data quality reports from users.

### 20.2 Operational Cost Estimate

| Task                                                    | Frequency  | Estimated Time    |
| ------------------------------------------------------- | ---------- | ----------------- |
| Reconciliation review (merge candidates)                | Weekly     | 30 minutes        |
| Schema tuning (resolution strategies, property updates) | Bi-weekly  | 30 minutes        |
| Connector health checks (DLT review, sync failures)     | Weekly     | 30 minutes        |
| Data quality review (orphans, staleness, conflicts)     | Weekly     | 30 minutes        |
| **Total**                                               | **Weekly** | **~2 hours/week** |

### 20.3 Neglect Handling

If nobody reviews the Reconciliation UI for an extended period, pending merge candidates accumulate and graph accuracy degrades. The following automated policies mitigate neglect:

| Candidate Confidence | Auto-Action After 3 Months Pending                             | Rationale                                                |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| >= 0.95              | Auto-approve merge                                             | Very high confidence; manual review unlikely to override |
| < 0.70               | Auto-reject (keep separate)                                    | Low confidence; merge is risky without human review      |
| 0.70 - 0.95          | Remain pending; escalating alerts at 1 week, 1 month, 3 months | Requires human judgment; alerts ensure visibility        |

Escalation path: Reconciliation UI badge count -> weekly email digest -> Slack notification to the configured stewardship channel.

### 20.4 Graph Health Score

A single composite metric displayed prominently on the Home view dashboard:

**Graph Health Score = weighted average of:**

| Component     | Weight | Calculation                                                                  |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| Freshness     | 30%    | % of nodes within their connector-specific healthy window                    |
| Orphan Rate   | 20%    | 1 - (orphaned nodes / total nodes)                                           |
| Conflict Rate | 20%    | 1 - (properties with active claim disagreements / total properties)          |
| Coverage      | 30%    | LogicalServices in graph / LogicalServices expected (from connected sources) |

Score is displayed as a percentage with color coding: >= 90% green, 70-89% yellow, < 70% red.

Trend sparkline shows the last 30 days. Clicking the score navigates to a breakdown view explaining each component.

---

## 21. Data Quality

### 21.1 Data Quality Signals

Beyond staleness and orphan detection, ShipIt-AI monitors for the following data quality anomalies:

**Cross-Source Disagreement Rate:**

- Properties where multiple connectors assert different values (after resolution). A high disagreement rate on a property suggests the resolution strategy may be misconfigured or the connectors are ingesting inconsistent data.
- Threshold: > 10% disagreement rate on a property key triggers a warning in the Claim Conflict Dashboard.

**Cardinality Anomaly Detection:**

- Entities with abnormally high relationship counts are flagged. For example, a LogicalService with > 50 DEPENDS_ON edges is likely a misconfigured or overly broad dependency declaration.
- Thresholds are configurable per relationship type. Defaults:
  - DEPENDS_ON: warn > 20, critical > 50
  - CALLS: warn > 30, critical > 100
  - MEMBER_OF: warn > 50 (team with 50+ members is suspicious)

**Temporal Anomalies:**

- Properties that have not changed for an unexpectedly long time on active entities. For example, CODEOWNERS unchanged for 12+ months on a repository with recent commits suggests stale ownership data.
- Detected by comparing `_last_synced` of the entity vs. the `ingested_at` of specific claims.

### 21.2 "Report Inaccuracy" UX

Every Entity Detail page includes a "Report Inaccuracy" button. Clicking it:

1. Opens a form: select the inaccurate property, provide the correct value (optional), add a note.
2. Creates a manual claim with `source="user_report:{user_email}"` and `confidence=1.0` (manual claims override automated claims when using `MANUAL_OVERRIDE_FIRST` strategy).
3. The report appears in the Reconciliation UI for stewardship review.
4. If the `MANUAL_OVERRIDE_FIRST` strategy is active for that property, the correction takes effect immediately.

### 21.3 Proactive Notifications

Configurable notifications for data quality events, delivered via Slack, email, or webhook:

| Event                                                                 | Default Channel | Frequency      |
| --------------------------------------------------------------------- | --------------- | -------------- |
| Ownership gaps (LogicalService with no OWNS relationship)             | Weekly digest   | Weekly         |
| New dependencies detected (new DEPENDS_ON or CALLS edges)             | Real-time       | Per occurrence |
| Blast radius changes (Tier-1 service gains new downstream dependency) | Real-time       | Per occurrence |
| Stale entity threshold exceeded                                       | Daily digest    | Daily          |
| Connector sync failure                                                | Real-time       | Per occurrence |
| Reconciliation candidates pending > 7 days                            | Weekly reminder | Weekly         |

Notification channels and frequency are configurable per event type in the Connector Hub settings.

### 21.4 Claim Conflict Dashboard

A dedicated panel (accessible from Operations > Claim Explorer in Phase 2) that surfaces only properties with active disagreements:

- **Conflict List** -- Sorted by severity (Tier-1 entities first, then by conflict age). Each row shows: entity name, property key, conflicting values, sources, and resolution strategy in effect.
- **Quick Resolve** -- Inline actions: accept a specific claim, add a manual override, change the resolution strategy for this property.
- **Bulk Operations** -- Select multiple conflicts and apply a resolution (e.g., "Accept all Backstage claims for `owner` property").

---

## 22. AI Integration Strategy

### 22.1 Current Status: AI-Ready

ShipIt-AI is designed from the ground up for AI agent consumption. The MCP server provides structured, safe tool calls with well-defined schemas, predictable response formats, and metadata envelopes (see Appendix A.4). AI agents do not need to write Cypher, understand the graph schema, or manage pagination -- the tool layer handles all of this.

This positions ShipIt-AI as **AI-Ready**: the infrastructure is in place for AI agents to query and reason about the knowledge graph effectively.

### 22.2 Roadmap to AI-Native

**Phase 2: AI-Assisted Operations**

- **LLM-Assisted Identity Resolution** -- For fuzzy match candidates that fall below the auto-merge threshold (but above the auto-reject threshold), an LLM reviews the candidate pair and makes a merge recommendation. The LLM receives: both entities' properties, linking keys, relationship context, and the confidence score. It returns: merge/no-merge recommendation with reasoning. Human approval is still required; the LLM recommendation is surfaced in the Reconciliation UI as a suggestion.
- **AI Feedback Loop** -- MCP query patterns inform graph maintenance priorities. If agents repeatedly query for entities that don't exist (NODE_NOT_FOUND errors), those missing entities are flagged as ontology gaps. If agents frequently traverse specific relationship paths, those paths are prioritized for freshness.

**Phase 3: AI-Augmented Graph**

- **Self-Healing Graph** -- An LLM periodically reviews stale and orphaned nodes and suggests corrections: "This LogicalService hasn't been synced in 14 days. The matching Kubernetes Deployment still exists. Likely cause: connector misconfiguration. Suggested action: re-authenticate GitHub connector."
- **Adaptive Ontology** -- The system analyzes MCP query patterns and suggests new node types or relationships. Example: "Agents have queried for 'feature flag' entities 47 times this month. Consider adding a FeatureFlag node type with GATES relationship to LogicalService."

### 22.3 Future AI Integrations

- **GitHub PR Blast Radius** -- A GitHub Check or PR comment that auto-generates a blast radius analysis for every pull request. Uses the repository -> LogicalService -> downstream traversal to show affected services, teams, and Tier-1 exposure. Configurable: opt-in per repository, threshold for comment (e.g., only comment if Tier-1 services are affected).
- **Slack Bot** -- On-demand queries via Slack: `@shipit blast radius config-service`, `@shipit who owns payments-api`, `@shipit what changed in the last 24h`. Uses the same MCP tool layer, wrapped in a Slack bot interface.
- **Graph-Powered Incident Runbooks** -- During incidents, the graph provides pre-built context: affected services, owners, recent changes, dependencies, and linked runbooks. This context is formatted for LLM consumption, enabling AI agents to generate incident-specific runbooks on the fly.

---

## 23. Roadmap

### Phase 1a -- Walking Skeleton (Weeks 1-4)

| Deliverable            | Details                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GitHub connector       | Polling-based (no webhooks). GitHub App authentication.                                                            |
| In-process event queue | BullMQ on Redis. Single-instance. Production Mode (Kafka/Redpanda) deferred to Phase 2.                            |
| Core Writer            | JSON claim model. Materialized effective properties. Deterministic identity only (primary key + linking key).      |
| Neo4j                  | Core ontology: LogicalService, Repository, Deployment, RuntimeService, Team, Person, Namespace, Cluster, Pipeline. |
| Identity resolution    | Primary key match + linking key match. No fuzzy matching.                                                          |
| MCP server             | Tools: `blast_radius`, `entity_detail`, `schema_info`.                                                             |
| Web UI                 | Home view (overview + graph stats), Graph Explorer (basic).                                                        |
| Schema configuration   | YAML file. No UI editor.                                                                                           |
| Deployment             | Docker Compose.                                                                                                    |

**Walking Skeleton Milestone:**

> `docker-compose up` -> connect GitHub -> answer a blast radius question in < 15 minutes from cold start.

### Phase 1b -- Second Connector (Weeks 5-8)

| Deliverable          | Details                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| Kubernetes connector | Watch API (streaming) + hourly reconciliation.                               |
| Connector Hub UI     | List connectors, view status, trigger re-sync, DLQ inspector.                |
| Onboarding Wizard    | Basic first-run setup: connect GitHub, connect Kubernetes, run initial sync. |
| Docker Compose       | Published and documented. < 4 GB memory footprint.                           |
| MCP tools            | `find_owners`, `dependency_chain`, `graph_stats`, `search_entities`.         |
| Global search        | Cmd/Ctrl+K search bar. Exact match only (semantic deferred to Phase 2).      |
| Acceptance tests     | Reference graph fixtures + expected output assertions for all MCP tools.     |

### Phase 2 -- Breadth & Intelligence (Weeks 9-16)

| Deliverable           | Details                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Vector DB             | Weaviate deployment. Embedding Generator service.                                                         |
| Connectors            | Datadog, Jira, Backstage, Identity Provider.                                                              |
| Event Bus             | Kafka/Redpanda (Production Mode). Replaces BullMQ.                                                        |
| Schema Editor UI      | Form-based editing. Resolution strategy config. Read-only visual preview (Cytoscape.js).                  |
| Web UI views          | Entity Detail, Claim Explorer, Reconciliation UI, Query Playground, Team Dashboard.                       |
| Webhook support       | GitHub App webhooks, Kubernetes Watch API (already in 1b), Jira webhooks.                                 |
| Identity resolution   | Fuzzy matching (configurable threshold) + Reconciliation UI for manual review.                            |
| LLM-assisted identity | LLM reviews fuzzy match candidates below threshold. Human approval required.                              |
| MCP tools             | `recent_changes`, `health_check`, `list_violations`, `change_impact`, `team_topology`, `semantic_search`. |
| Deployment            | Helm chart for Kubernetes.                                                                                |

### Phase 3 -- Enterprise (Weeks 17-24)

| Deliverable            | Details                                                      |
| ---------------------- | ------------------------------------------------------------ |
| SSO/SAML               | Enterprise authentication via SAML/OIDC.                     |
| RBAC                   | Full role-based access control with graph-level ACLs.        |
| Audit Log UI           | Who changed what, when, diff view, MCP query log.            |
| AI Agent Activity view | MCP tool usage analytics dashboard.                          |
| Premium connectors     | PagerDuty, Terraform Cloud, AWS Cost Explorer.               |
| Multi-tenant mode      | Org-level isolation for managed SaaS.                        |
| Event Bus              | Cloud queue support (SQS + DynamoDB Event Log, GCP Pub/Sub). |
| Managed SaaS           | Cloud-hosted offering with managed Kafka + Neo4j Aura.       |
| GitHub PR blast radius | GitHub Check / PR comment with auto-generated blast radius.  |
| Slack bot              | On-demand graph queries via Slack.                           |

### Future Considerations

- **Graph-powered AI workflows** -- Automated incident runbooks that traverse the graph to build context.
- **Drift detection** -- Compare declared state (IaC, Backstage) vs actual state (Kubernetes, cloud).
- **Cost attribution** -- Connect cloud cost data to LogicalService ownership for per-team cost visibility.
- **Change risk scoring** -- ML model trained on graph topology + incident history to score PRs by risk.
- **Multi-graph federation** -- Connect multiple ShipIt-AI instances across orgs/BUs.
- **GitHub Copilot Extension** -- Native integration as a Copilot Extension for in-IDE graph queries.

---

## 24. Success Metrics

### 24.1 Revised 6-Month Targets

| Metric              | Target                                      | Measurement                                                    |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Graph completeness  | > 70% of known LogicalServices              | Graph entity count vs Backstage + Kubernetes discovery         |
| Data freshness      | > 95% of nodes within SLA                   | Per-connector staleness window compliance                      |
| MCP tool latency    | See per-tool targets (Section 14.2)         | MCP response time metrics (P50, P95, P99)                      |
| AI answer accuracy  | > 90% correct blast radius                  | 20-30 reference questions with ground truth, validated monthly |
| Ingestion lag       | P95 < 60 seconds                            | Event Bus consumer lag metric                                  |
| Community adoption  | 500+ GitHub stars, 3-5 community connectors | GitHub metrics                                                 |
| Enterprise pipeline | 1-2 paid pilots + 3 design partners         | Sales pipeline                                                 |

### 24.2 Leading Indicators

These metrics provide early signal on adoption and value delivery:

| Indicator                   | Measurement                                                                   | Why It Matters                            |
| --------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| Docker Compose installs     | Opt-in telemetry (anonymous install ping)                                     | Installation momentum                     |
| MCP calls/week/installation | MCP server metrics (aggregated)                                               | Agent adoption and active usage           |
| Graph node growth rate      | Week-over-week node count                                                     | Graph is growing = connectors are working |
| Weekly active graph queries | Distinct query sessions per week                                              | Human users are finding value             |
| Time-to-first-insight       | Time from `docker-compose up` to first MCP tool call with a meaningful result | Onboarding friction                       |
| Reconciliation queue depth  | Pending merge candidates over time                                            | Graph accuracy maintenance health         |

### 24.3 AI Answer Accuracy Validation

The > 90% blast radius accuracy target is validated via a **reference question set**:

1. **Curate 20-30 reference questions** spanning blast radius, ownership, dependency chain, and topology queries.
2. **Establish ground truth** by manually tracing the expected answer in the graph for each question.
3. **Monthly validation** -- Run each question through the MCP tools and compare against ground truth.
4. **Scoring** -- A response is "correct" if it identifies all Tier-1 affected services and does not include false positives that would materially change the recommended action.
5. **Threshold action** -- If accuracy drops below 85%, investigate: Cypher query correctness, graph data quality, or tool parameter handling.

---

## 25. Open Questions & Decisions

### 25.1 Closed Decisions

| Question              | Decision                                        | ADR Reference |
| --------------------- | ----------------------------------------------- | ------------- |
| API Server language   | TypeScript (Node.js)                            | ADR-001       |
| Schema storage        | Neo4j meta-nodes (schema-as-graph)              | ADR-009       |
| Vector DB             | Weaviate (deferred to Phase 2)                  | ADR-005       |
| PropertyClaim storage | JSON on entity nodes (not separate claim nodes) | ADR-002       |

### 25.2 Open Questions

| Question                | Options                                             | Deadline                                  |
| ----------------------- | --------------------------------------------------- | ----------------------------------------- |
| Embedding model         | OpenAI text-embedding-3 vs local (all-MiniLM-L6-v2) | Phase 2 start (Week 9)                    |
| Pricing model           | Per-connector vs per-seat vs hybrid                 | Week 16                                   |
| Fuzzy match threshold   | 0.80 vs 0.85 vs 0.90                                | Phase 2, empirical testing with real data |
| Event Log store for SQS | DynamoDB vs S3                                      | Phase 3 start (Week 17)                   |

### 25.3 Decision-Making Process

- **Author** (Mohamed El-Malah) is the final decision-maker for all architectural decisions.
- **ADRs** (Architecture Decision Records) document the rationale, alternatives considered, and trade-offs for each decision. Stored in `/designDocs/ADRs/`.
- **Community feedback** is solicited via GitHub Discussions for open questions. Community input informs but does not override architectural decisions.

---

## 26. Risk Register

### 26.1 Technical Risks

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                                                                                 |
| --------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neo4j performance at scale (> 100K nodes)           | Medium     | High   | Benchmark with synthetic data at 10x target. Define circuit breakers for queries exceeding 5s. Degradation plan in Section 14.5.                                           |
| Entity reconciliation false merges                  | Medium     | High   | Conservative default threshold (0.85). All merges reversible via split operation. Tier-1 entities require manual confirmation regardless of confidence score.              |
| MCP Cypher generation produces incorrect traversals | Medium     | Medium | Acceptance test suite with reference graph fixtures (Section 9.5). Every tool has regression tests. CI blocks merge on test failure.                                       |
| Core Writer exactly-once semantics failure          | Low        | High   | Transactional idempotency log in Neo4j. Every write uses `{connector_id}:{entity_primary_key}:{event_version}` idempotency key. Duplicate events are detected and skipped. |
| JSON claims model limits future query patterns      | Low        | Medium | JSON model validated for expected query patterns (Claim Explorer, resolution). Migration path to separate nodes documented if needed.                                      |

### 26.2 Adoption Risks

| Risk                                      | Likelihood | Impact | Mitigation                                                                                                                                                                   |
| ----------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup complexity deters evaluation        | High       | High   | Lite Mode (single Docker Compose, < 4 GB RAM). Walking Skeleton milestone: < 15 min time-to-first-value. Onboarding Wizard guides first-run setup.                           |
| No value until 3+ connectors configured   | High       | High   | GitHub-only experience must be compelling on its own: repository graph, CODEOWNERS ownership, GitHub Actions pipeline visualization. Pre-built demo datasets for evaluation. |
| MCP protocol adoption stalls              | Medium     | High   | MCP tools are the primary interface, but REST and GraphQL APIs are also supported for non-MCP agents and direct integration.                                                 |
| Graph accuracy erodes without stewardship | Medium     | High   | Automated neglect handling (Section 20.3). Graph Health Score as a prominent dashboard metric. Escalating alerts for unreviewed reconciliation candidates.                   |

### 26.3 Existential Risks

1. **Platform vendors absorb the feature.** GitHub Copilot ships an Infrastructure Graph; Datadog adds an AI-queryable service catalog; Backstage adds deep graph traversal.
   - _Mitigation:_ Move fast, build community, differentiate on the provenance model (multi-source claims with resolution strategies are architecturally unique). No single vendor can unify data across all tools.

2. **Graph is never accurate enough.** 15% false merges destroy trust in week 1. Users stop querying because answers are unreliable.
   - _Mitigation:_ Conservative defaults. Phase 1 uses deterministic-only matching (no fuzzy). Prominent data quality signals (Graph Health Score, staleness badges, conflict indicators). "Report Inaccuracy" button on every entity.

3. **Complexity prevents adoption.** 7 services in Docker Compose vs SaaS competitors with 30-minute signup.
   - _Mitigation:_ Lite Mode with minimal services. Radical Phase 1 scope reduction (BullMQ instead of Kafka, no Vector DB until Phase 2). < 15 min time-to-value target as a hard requirement. Kill criteria enforce this.

### 26.4 Kill Criteria

If after Phase 1b (Week 8), any of the following conditions are true, the project pivots to a **Backstage plugin approach** (graph engine + MCP server as a Backstage plugin, eliminating the standalone dashboard and connector infrastructure):

| Criterion             | Threshold                                                                    |
| --------------------- | ---------------------------------------------------------------------------- |
| Time-to-first-insight | Exceeds 30 minutes from `docker-compose up` to a correct blast radius answer |
| Blast radius accuracy | < 70% correct on 20 reference queries                                        |
| Memory footprint      | Docker Compose deployment requires > 8 GB RAM                                |

Kill criteria are evaluated at the Week 8 milestone review. The evaluation is documented as an ADR regardless of outcome.

---

## Appendix

### A.1 Example MCP Interaction

**User to Claude:** "If I push a breaking change to the config-service repo, what could break?"

**Claude invokes MCP tool:**

```
blast_radius(node='shipit://repository/default/config-service', depth=4)
```

**MCP Response:**

```json
{
  "_meta": {
    "tool": "blast_radius",
    "execution_time_ms": 340,
    "data_freshness": {
      "oldest_node_sync": "2026-02-28T02:15:00Z",
      "freshness_status": "healthy"
    },
    "truncated": false,
    "next_cursor": null,
    "result_count": 6,
    "total_available": 6,
    "warnings": [],
    "suggested_follow_up": ["find_owners", "entity_detail"]
  },
  "result": {
    "affected_nodes": [
      {
        "id": "shipit://logical-service/default/config-service",
        "label": "LogicalService",
        "name": "config-service",
        "tier_effective": 2,
        "owner_effective": "platform-team"
      },
      {
        "id": "shipit://deployment/production/config-service-prod",
        "label": "Deployment",
        "name": "config-service-prod",
        "environment": "production"
      },
      {
        "id": "shipit://runtime-service/default/config-service",
        "label": "RuntimeService",
        "name": "config-service"
      },
      {
        "id": "shipit://logical-service/default/payments-api",
        "label": "LogicalService",
        "name": "payments-api",
        "tier_effective": 1,
        "owner_effective": "payments-team"
      },
      {
        "id": "shipit://logical-service/default/ledger-service",
        "label": "LogicalService",
        "name": "ledger-service",
        "tier_effective": 1,
        "owner_effective": "payments-team"
      },
      {
        "id": "shipit://logical-service/default/card-issuance",
        "label": "LogicalService",
        "name": "card-issuance",
        "tier_effective": 2,
        "owner_effective": "cards-team"
      }
    ],
    "paths": [
      {
        "from": "shipit://repository/default/config-service",
        "to": "shipit://logical-service/default/config-service",
        "relationship": "IMPLEMENTED_BY",
        "depth": 1
      },
      {
        "from": "shipit://logical-service/default/config-service",
        "to": "shipit://deployment/production/config-service-prod",
        "relationship": "DEPLOYED_AS",
        "depth": 2
      },
      {
        "from": "shipit://deployment/production/config-service-prod",
        "to": "shipit://runtime-service/default/config-service",
        "relationship": "EMITS_TELEMETRY_AS",
        "depth": 3
      },
      {
        "from": "shipit://runtime-service/default/config-service",
        "to": "shipit://logical-service/default/payments-api",
        "relationship": "CALLS (inverse)",
        "depth": 4
      },
      {
        "from": "shipit://runtime-service/default/config-service",
        "to": "shipit://logical-service/default/ledger-service",
        "relationship": "CALLS (inverse)",
        "depth": 4
      },
      {
        "from": "shipit://runtime-service/default/config-service",
        "to": "shipit://logical-service/default/card-issuance",
        "relationship": "CALLS (inverse)",
        "depth": 4
      }
    ],
    "summary": {
      "total_services": 6,
      "total_teams": 3,
      "tier1_count": 2
    }
  }
}
```

**Claude responds:** "A breaking change to config-service would directly impact 3 downstream LogicalServices (payments-api, ledger-service, card-issuance) and transitively affect merchant-portal and transaction-processor. Two of these (payments-api, ledger-service) are Tier-1 PCI-scoped services. I recommend coordinating with the Payments team and Platform team before merging. Want me to look up who's on-call?"

### A.2 Example Cypher Queries

**Find all LogicalServices with no monitor:**

```cypher
MATCH (ls:LogicalService)
WHERE NOT (ls)<-[:MONITORS]-(:Monitor)
RETURN ls.name, ls.tier_effective
```

**Blast radius from a repo (3 hops via LogicalService -> Deployment -> RuntimeService):**

```cypher
MATCH (r:Repository {name: 'config-service'})
      <-[:IMPLEMENTED_BY]-(ls:LogicalService)
      -[:DEPLOYED_AS]->(d:Deployment)
      -[:EMITS_TELEMETRY_AS]->(rs:RuntimeService)
      <-[:CALLS]-(caller:RuntimeService)
RETURN ls.name, d.environment, rs.name, caller.name
```

**LogicalServices owned by a team with degraded SLOs:**

```cypher
MATCH (t:Team {name: 'payments'})
      -[:OWNS]->(ls:LogicalService)
      <-[:MONITORS]-(m:Monitor)
WHERE m.status = 'ALERT'
RETURN ls.name, m.name, m.status
```

**Inspect property claims for a LogicalService (JSON claims model):**

```cypher
MATCH (ls:LogicalService {name: 'payments-api'})
WITH ls, ls._claims AS claims
UNWIND claims AS claim
RETURN claim.property_key, claim.value, claim.source,
       claim.confidence, claim.ingested_at
ORDER BY claim.property_key, claim.confidence DESC
```

### A.3 Connector SDK Interface (TypeScript)

```typescript
interface ShipItConnector {
  name: string;
  version: string;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  discover(): Promise<DiscoveryResult>;
  fetch(entityType: string, cursor?: string): Promise<FetchResult>;
  normalize(raw: RawEntity[]): CanonicalEntity[];
  sync(mode: 'full' | 'incremental'): Promise<SyncResult>;
  handleWebhook?(event: WebhookEvent): Promise<void>;
}
// Note: publish() removed in v0.3. The SDK auto-publishes normalize() output
// to the Event Bus. Connector authors only implement normalize().
```

### A.4 MCP Response Envelope Example

All MCP tool responses are wrapped in a `_meta` envelope that provides execution context, freshness information, and navigation hints for AI agents.

```json
{
  "_meta": {
    "tool": "blast_radius",
    "execution_time_ms": 340,
    "data_freshness": {
      "oldest_node_sync": "2026-02-28T02:15:00Z",
      "freshness_status": "healthy"
    },
    "truncated": false,
    "next_cursor": null,
    "result_count": 6,
    "total_available": 6,
    "warnings": [],
    "suggested_follow_up": ["find_owners", "entity_detail"]
  },
  "result": {
    "affected_nodes": ["..."],
    "paths": ["..."],
    "summary": { "total_services": 6, "total_teams": 3, "tier1_count": 2 }
  }
}
```

**`_meta` Fields:**

| Field                 | Type           | Description                                                                              |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `tool`                | string         | Tool name that generated this response                                                   |
| `execution_time_ms`   | number         | Server-side execution time in milliseconds                                               |
| `data_freshness`      | object         | Oldest node sync timestamp and overall freshness status (`healthy`, `stale`, `degraded`) |
| `truncated`           | boolean        | Whether the result was truncated due to size limits                                      |
| `next_cursor`         | string or null | Cursor for paginated results; null if all results returned                               |
| `result_count`        | number         | Number of items in this response                                                         |
| `total_available`     | number         | Total items available (may be > result_count if truncated)                               |
| `warnings`            | string[]       | Non-fatal warnings (e.g., "3 nodes in result are stale")                                 |
| `suggested_follow_up` | string[]       | Tool names that would provide useful follow-up information                               |

### A.5 MCP Error Response Example

When a tool call fails, the response includes structured error information with actionable suggestions.

```json
{
  "error": {
    "code": "NODE_NOT_FOUND",
    "message": "No entity found with canonical ID 'shipit://logical-service/default/payment-api'",
    "suggestions": [
      "Did you mean 'shipit://logical-service/default/payments-api'?",
      "Try search_entities with label='LogicalService' and name contains 'payment'"
    ]
  }
}
```

**Error Codes:**

| Code                | HTTP Status | Description                                                  |
| ------------------- | ----------- | ------------------------------------------------------------ |
| `NODE_NOT_FOUND`    | 404         | The specified canonical ID does not exist in the graph       |
| `INVALID_PARAMETER` | 400         | A required parameter is missing or has an invalid value      |
| `QUERY_TIMEOUT`     | 408         | The underlying Cypher query exceeded the timeout threshold   |
| `PERMISSION_DENIED` | 403         | The API key does not have permission for this tool or entity |
| `RATE_LIMITED`      | 429         | The API key has exceeded its rate limit                      |
| `INTERNAL_ERROR`    | 500         | An unexpected server error occurred                          |

All error responses include `suggestions` where possible to help AI agents self-correct.

### A.6 CanonicalNode with JSON Claims

The `CanonicalNode` interface defines the shape of entity data flowing through the ingestion pipeline and stored in Neo4j.

```typescript
interface CanonicalNode {
  id: string; // shipit://{label}/{namespace}/{name}
  label: string; // Node label (e.g., 'LogicalService')
  properties: Record<string, any>; // Entity properties
  _claims: PropertyClaim[]; // JSON array stored on entity node
  _source_system: string; // Connector type (e.g., 'github', 'kubernetes')
  _source_org: string; // Source org (e.g., 'github/acme-corp')
  _source_id: string; // Linking key from source system
  _last_synced: string; // ISO 8601 timestamp
  _event_version: number | string; // Monotonic integer or ISO 8601 only
}

interface PropertyClaim {
  property_key: string; // Property name (e.g., 'tier', 'owner')
  value: any; // Claimed value
  source: string; // Connector or actor (e.g., 'backstage', 'manual:user@co.com')
  source_id: string; // Linking key of the source entity
  ingested_at: string; // ISO 8601 timestamp
  confidence: number; // 0.0 - 1.0
  evidence: string | null; // Human-readable justification
}
```

**v0.3 Changes from v0.2:**

- `claims` renamed to `_claims` (underscore prefix indicates internal/metadata field).
- `_claims` stored as a JSON array on the entity node, not as separate `PropertyClaim` graph nodes with `HAS_CLAIM` relationships. See Section 14.3 for write amplification analysis.
- `_event_version` added with strict type constraint: monotonic integer or ISO 8601 timestamp only. Arbitrary strings are not permitted.
- `publish()` removed from the Connector SDK; auto-publishing is handled by the framework.

---

_End of Document -- ShipIt-AI Design Document v0.3 (Part 2, Sections 10-26 + Appendix)_
