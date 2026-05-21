---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [meta, agent-context]
importance: core
---

# docs/agent/ scaffolded during MCP Access Stage 1

## Context

The repo had no shared agent-state folder. Mid-decision on the MCP Access surface
(Stage 1 just shipped, Stage 2 designed, a separate plugin repo discussed)
exposed the need for a place where future agents can pick up cross-session
context without re-reading the conversation transcript.

## Decision

Initialize `docs/agent/` per the ship-agent-context skill. Seed the first three
durable notes (this one, the tool-metadata decision, the web-ui import scar)
plus the Stage 2 plan so the structure proves itself out immediately rather
than sitting empty.

## Alternatives Considered

- **Stash plan content in `~/.claude/plans/` only**: rejected — that file is
  outside the repo, not shared with collaborators, and gets stale fast.
- **Document everything in CLAUDE.md / AGENTS.md**: rejected — those are for
  static rules. The folder holds dynamic state (in-flight plans, scars).

## Consequences

Every agent that enters the repo is expected to read `MANIFEST.md` and
`docs/agent/status/` before working. Adds a small ritual at session start.
Pays for itself the first time it prevents a re-derivation or a stomp.

## Revisit Triggers

- If `docs/agent/` accumulates duplicate or near-duplicate notes, prune.
- If the index outgrows ~100 entries, split MANIFEST per section.
