# ADR-034: Agent Platform v1 Foundations — Postgres, Our Own Runner, Vertex AI, One Release

## Status

Accepted

## Date

2026-10-01

## Context

The AI section of the product (Ask, agents, workflows) needs durable runs and transcripts, a place to run agents, a model provider, and a release shape. The deep dive in `docs/agent/plans/ai-agents-and-workflows.md` left four decisions with the owner.

## Decision

1. **Storage: Postgres.** Migration SQL lives in this repository under `db/migrations/` and is applied by `pnpm db:migrate` locally and by the infrastructure repository at deploy, bound to the image. The application never migrates at boot. Postgres is optional at runtime: without `DATABASE_URL`, agent routes answer `503 AI_UNAVAILABLE`.
2. **Runtime: our own agent loop** in the `agent-runner` process (a BullMQ worker), with a tool gateway that enforces per-service grants, limits per run and per day, cancellation, multi-turn chat and recovery when a worker dies. Not a hosted agent service and not an agent SDK's loop.
3. **Models through Vertex AI, any model it offers**, with application default credentials or workload identity; no API keys. The AI SDK's Vertex provider carries Gemini; provider options such as thought signatures are stored verbatim.
4. **One release:** agents, permissions, approvals, triggers, chaining and workflows ship together; the plan's phases are build milestones inside it. Milestone 0 (the AI navigation) and Milestone 1's backend shipped in pull request #119.

## Consequences

### Positive

- The schema is shared by local development, CI and self-hosters.
- Provider-neutral model access; the graph read tools run in-process in the runner through the same handlers the MCP server registers.

### Negative

- Schema changes cross a repository boundary at deploy time.
- A self-hoster without Google Cloud has no model provider until a second one is added behind the same interface.

### Neutral

- ADR-005's deferral of a vector store and ADR-024's phase 2 both converge on this Postgres instance.

## Alternatives Considered

### Neo4j nodes and Redis for runs

- **Cons:** Transcripts are too large for Redis and a poor fit for the graph.

### A hosted managed-agent service

- **Cons:** Not available on the chosen provider; run data stored off-platform.

### A read-only first release

- **Cons:** The owner wants the end-to-end feature set before release.

## References

- `docs/agent/decisions/agent-platform-v1-foundations.md`
- `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md`, `docs/agent/investigations/vertex-model-layer-probe.md`
