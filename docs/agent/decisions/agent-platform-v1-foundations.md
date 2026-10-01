---
type: decision
status: active
created: 2026-10-01
updated: 2026-10-01
author: claude-session-2026-09-30
tags: [ai, agents, postgres, vertex, runtime, scope, cross-repo]
importance: core
---

# Agent platform v1 foundations: Postgres (infra-applied schema), own runtime, Vertex AI, all-in first release

## Context

The deep dive in [ai-agents-and-workflows](../plans/ai-agents-and-workflows.md) left four
decisions with the owner. They answered all four on 2026-10-01.

## Decision

1. **Storage: Postgres.** The infra repo creates the instance and manages the schema "for
   now". Interpreted as: migration SQL lives in this repo under `db/migrations/` (so local
   dev, CI and self-hosters share one schema; the infra repo is private), and the infra
   repo applies it at deploy, bound to the image SHA. The app does not migrate at boot.
   This supersedes the "Drizzle ORM with built-in migrations" recommendation in
   [api-server-config-persistence-strategy](api-server-config-persistence-strategy.md) for
   the migration mechanism; a query layer is still an open choice for the spec.
2. **Runtime: our own agent loop** in a new `agent-runner` process, with a tool gateway
   that enforces grants. Not Claude Managed Agents, not the Claude Agent SDK.
3. **Model provider: Vertex AI, any model it offers** (Claude, Gemini, open models). The
   rest of the infrastructure is on GCP. Auth is Workload Identity / ADC, no API keys.
4. **First release: everything.** Agents, per-service read/write/delete permissions,
   approvals, all trigger types, agent chaining and workflows ship together. The six phases
   in the plan note become ordered build milestones inside one release, not separate
   releases.

## Alternatives Considered

- **Neo4j nodes + Redis for storage**: rejected — transcripts too large for Redis, poor fit
  for Neo4j, and Postgres was already the planned next step.
- **App-run migrations (Drizzle) at boot**: rejected by the owner for now in favour of
  infra-applied schema.
- **Claude Managed Agents**: rejected as the runtime — beta, unavailable on Vertex, run data
  stored at Anthropic.
- **Anthropic SDK first, other providers later**: rejected — the owner wants any Vertex
  model from the start.
- **Read-only agents as a first release**: rejected — the owner wants the end-to-end feature
  set working before release.

## Consequences

- The model-access layer must be provider-neutral over Vertex. Verified on 2026-10-01:
  `@ai-sdk/google-vertex` (Apache-2.0, Node >= 22, ESM-only AI SDK 7) covers Gemini, Claude
  (`/anthropic`), and open models (`/maas`) with ADC auth. It is the leading candidate; the
  spec locks it. We run our own loop and execute tools in our gateway, not the SDK's loop.
- Claude on Vertex lacks server-side tools, the Files API, batches and the MCP connector.
  None are needed with an own loop.
- Partner and open models need a one-time per-project enable in Model Garden (manual step).
- Provider differences the loop must handle: Gemini's JSON-schema subset for tool
  parameters, Gemini 3 thought signatures and Claude thinking signatures replayed unchanged
  when a run is persisted and resumed, and uneven function-calling support across open
  models.
- Every question the deep dive marked "can wait" now needs an answer before the spec:
  workflow engine, where write tools come from, who may create agents, agent identity.
- The infra brief is [infra-postgres-and-vertex-for-agents](../briefs/infra-postgres-and-vertex-for-agents.md).
  A second brief for the `agent-runner` Deployment follows once the image exists.
- Rough size is unchanged at 14 to 18 weeks, now to a single release.

## Revisit Triggers

- Schema changes become frequent enough that the cross-repo apply step slows delivery →
  move migrations into the app's own deploy step.
- A self-hoster without GCP needs agents → add a second model provider behind the same
  interface.
- The all-in release slips materially → reconsider releasing the read-only milestone first.

## Related

- [ai-agents-and-workflows](../plans/ai-agents-and-workflows.md) — the plan these decisions unblock
- [api-server-config-persistence-strategy](api-server-config-persistence-strategy.md) — Postgres Phase 2, now started
- [core-writer-runs-as-its-own-process](core-writer-runs-as-its-own-process.md) — precedent for `agent-runner`
- [image-build-owned-by-infra-repo](image-build-owned-by-infra-repo.md) — why a new worker needs an infra brief
