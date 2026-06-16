---
type: investigation
status: fixed
created: 2026-06-15
updated: 2026-06-16
author: claude-opus-4-8
tags: [team-dashboard, blast-radius, codeowner, ownership, cypher, github-connector]
importance: core
---

# Team Dashboard shows "0 owns" and team blast radius is empty (GitHub-synced demo)

## Symptoms

On the deployed demo (portal-demo.shipitops.com, populated by a real GitHub org
sync — teams Data & ML, Frontend Web, Orders & Fulfillment, Payments, Platform
Engineering, NOT the `seed-demo.ts` teams):

- Team Dashboard (`/catalog/teams`) shows `0 owns` for every team, even though
  teams are CODEOWNERS of repos. `members` shows 1, `on-call` 0.
- Blast radius for a team shows none of the repos the team owns.

## Root Cause

GitHub-sourced ownership lives on **`CODEOWNER_OF`** edges, but both surfaces
only consider **`OWNS`**.

The GitHub connector emits:

- `MEMBER_OF` (Person→Team) → so `members` count works.
- `CODEOWNER_OF` (Team/Person → Repository) for ownership
  (`packages/connectors/github/src/normalizers/codeowner.ts`: edge `from`=team
  canonical id, `to`=repo id, direction `(team)-[:CODEOWNER_OF]->(repo)`).
- It does **not** emit `OWNS`. `OWNS` (Team→LogicalService) only comes from
  Backstage / `seed-demo.ts`.

1. **Team Dashboard "owns" = 0** —
   `packages/api-server/src/services/team-service.ts`:
   - `listTeams()` line 39: `OPTIONAL MATCH (t)-[:OWNS]->(owned)` — counts only OWNS.
   - `getTeam()` line 75: `MATCH (t:Team {id:$id})-[:OWNS]->(n)` — same.
     The file header comment even hard-codes the assumption `(:Team)-[:OWNS]->(:Repository)`.
     GitHub teams own repos via `CODEOWNER_OF`, so `ownedCount` is 0.

2. **Team blast radius empty** —
   `packages/mcp-server/src/cypher/generator.ts` line 8:
   `DOWNSTREAM_EDGE_PATTERN = 'IMPLEMENTED_BY|DEPLOYED_AS|EMITS_TELEMETRY_AS|CALLS|DEPENDS_ON|BUILT_BY|TRIGGERS'`.
   Neither `OWNS` nor `CODEOWNER_OF` is in the pattern, so from a Team node there
   is no edge type to traverse to the repos it owns → empty result.

Note: `generateFindOwnersCypher` (same file, lines 81-82) DOES query both
`OWNS` and `CODEOWNER_OF`, proving the convention — the two broken surfaces just
predate / missed it. Not a canonical-ID format mismatch (`members` works, so the
Team node id matches its incoming edges fine).

## Fix (shipped to working tree 2026-06-16, downstream-only ownership)

The web-UI blast radius is **not** the mcp-server generator — it's
`packages/api-server/src/services/neo4j-service.ts` `getBlastRadius()` (APOC
`apoc.path.subgraphAll`). Both were fixed:

- `team-service.ts`: both ownership matches → `-[:OWNS|CODEOWNER_OF]->`;
  `getTeam` owned query gained `RETURN DISTINCT` (a node owned via both rel
  types would otherwise list twice). `count(DISTINCT owned)` already dedupes the
  list-page count.
- `neo4j-service.ts` `getBlastRadius`: `relationshipFilter` changed from
  `'<DEPENDS_ON|<CALLS|<MONITORS'` to
  `'<DEPENDS_ON|<CALLS|<MONITORS|OWNS>|CODEOWNER_OF>'`. Ownership is **outbound
  only** (`OWNS>`), so a team reaches what it owns but a service's blast radius
  does not surface its owning team.
- `mcp-server/src/cypher/generator.ts`: split into `DEPENDENCY_EDGE_PATTERN` +
  `OWNERSHIP_EDGE_PATTERN`; DOWNSTREAM adds ownership, UPSTREAM and BOTH stay
  dependency-only (BOTH is undirected, so ownership there would surface owners).
- Tests: `api-server/.../team-service.test.ts`,
  `api-server/.../blast-radius-ownership.test.ts`,
  plus two cases in `mcp-server/.../cypher-generator.test.ts`. 380 pkg tests
  green, both packages typecheck.
- `on-call` on the dashboard is separately 0 because no on-call connector emits
  `ON_CALL_FOR` in this demo — out of scope, NOT fixed.

Not yet committed/pushed/deployed (awaiting user approval). The deployed demo
still shows the bug until a rebuild+deploy.

## Prevention

When a read surface asks "what does a team own?", it must consider every rel type
marked `semantics: 'ownership'` in the schema (currently `OWNS` + `CODEOWNER_OF`),
not just `OWNS`. See [ownership-edge-semantics](../patterns/ownership-edge-semantics.md).

## Related

- [ownership-edge-semantics](../patterns/ownership-edge-semantics.md)
- [canonical-id-org-namespacing](../decisions/canonical-id-org-namespacing.md)
