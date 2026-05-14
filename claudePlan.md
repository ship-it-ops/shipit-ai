Plan is written. Quick summary of what it contains before I exit plan mode:   
                                                      
  - Scope locked to the 5 Phase 2 UI views + real minimal backend. Vector DB,   
  Kafka, new connectors, semantic search, and new MCP tools are explicitly      
  deferred.                                                                     
  - Build order anchored on your choice — Query Playground first (because the   
  safe read-only Cypher endpoint becomes a reusable pattern), then Claim        
  Explorer → Schema Editor → Team Dashboard → Reconciliation UI (heaviest,      
  last).                                                                        
  - Fuzzy matching uses Jaro-Winkler + trigram, not vector embeddings, since the
   Vector DB is deferred. Per design doc §5.3 feature weights.                  
  - All new API responses get shared TypeScript types in
  packages/shared/src/types/ so API and web-ui stay in sync.                    
  - Seed-demo extended to include teams, near-duplicate entities, and
  conflicting claims so each view has something to render.                      
                                          
────────────────────────────────────────────────────────────────────────────────
 Ready to code?                                       
                                     
 Here is Claude's plan:                                                         
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Phase 2 Implementation Plan — 5 UI Views + Real Backend                        
                                          
 Context                             

 ShipIt-AI has shipped Phase 1 (Walking Skeleton + GitHub connector). The web
 UI currently shows working Home, Graph Explorer, Catalog, Entity Detail,
 Incident Mode, Ask, and Connector Hub. Five sidebar items are stub
 PlaceholderPage screens tagged phase-2:

 - /explore/query — Query Playground
 - /operations/claims — Claim Explorer
 - /configure/schema — Schema Editor
 - /catalog/teams — Team Dashboard
 - /operations/reconciliation — Reconciliation UI

 Design doc §23 also lists Phase 2 infra work (Vector DB, Kafka,
 Datadog/Jira/Backstage connectors, 6 new MCP tools, Helm). Per user decision,
 this plan scopes only the 5 UI views + the minimum real backend to make them
 functional against the existing Neo4j graph. Vector DB, Kafka, new connectors,
  semantic search, and new MCP tools are explicitly deferred to a later
 mini-phase.

 The user picked Query Playground first as the order anchor — it has the
 cleanest dependency surface (read-only Cypher against Neo4jService.runQuery)
 and a useful pattern (safe-exec wrapper) that other views can reuse.

 ---
 Scope

 In-scope

 View: Query Playground
 UI work: Cypher editor + result grid + saved queries (localStorage)
 Backend work: POST /api/query safe read-only Cypher exec (write-blocked,
   row-limited, timeout)
 ────────────────────────────────────────
 View: Claim Explorer
 UI work: Per-property claim list, "why this value won," filters; manual
   override deferred to Enterprise per design doc §15
 Backend work: GET /api/claims/:entityId, GET /api/conflicts reading _claims
   JSON off nodes
 ────────────────────────────────────────
 View: Schema Editor
 UI work: Form-based node-type list, property + resolution-strategy editor,
   validation banner, version history (last 10)
 Backend work: Reuse existing GET/PUT /api/schema; add GET /api/schema/history
 +
   write a versioned snapshot on each PUT
 ────────────────────────────────────────
 View: Team Dashboard
 UI work: Per-team summary: services owned, repos, deployments, recent
 activity,
   "View Team Graph" link
 Backend work: GET /api/teams, GET /api/teams/:id reading Team nodes +
   OWNS/ON_CALL_FOR edges
 ────────────────────────────────────────
 View: Reconciliation UI
 UI work: Pending-candidate worklist, side-by-side comparison,
   confirm/reject/mark-distinct, recent merges, split-button
 Backend work: GET /api/reconciliation/candidates, POST
   /api/reconciliation/:id/confirm|reject|split; new ReconciliationService
 using
    string-similarity (Jaro-Winkler + trigram) since the Vector DB is deferred

 Out-of-scope (intentionally deferred)

 - Vector DB / embeddings / semantic search (deferred until vector infra lands)
 - Datadog, Jira, Backstage, Identity Provider connectors
 - Kafka / Redpanda Event Bus
 - 6 new MCP tools (recent_changes, health_check, list_violations,
 change_impact, team_topology, semantic_search)
 - LLM-assisted identity review
 - Helm chart deployment
 - Webhook support for any connector
 - The phase-3 and enterprise-tagged placeholders (Audit Log, Access Control,
 Agent Activity)

 ---
 Build sequence

 Step 1 — Query Playground (foundation pattern: safe read-only Cypher)

 Backend — packages/api-server/src/:
 - New routes/query.ts exposing POST /api/query { cypher: string, params?:
 Record<string, unknown> } that:
   - Rejects any statement containing write tokens (CREATE, MERGE, DELETE, SET,
  REMOVE, DROP, CALL apoc.periodic, CALL { ... } IN TRANSACTIONS) via a
 token-aware check on the parsed statement, not just substring.
   - Wraps execution in a Neo4j session with defaultAccessMode: READ and a
 server-side timeout (default 5s, configurable via env QUERY_TIMEOUT_MS).
   - Caps result rows at 1000; returns { columns, rows, executionTimeMs,
 truncated }.
 - Wire into packages/api-server/src/server.ts (mounted under /api/query).

 UI — packages/web-ui/src/:
 - Replace app/explore/query/page.tsx with a real client component.
 - New components/query/query-editor.tsx — textarea-based Cypher editor (skip
 Monaco for now; use <textarea> + monospace font and a "Format" button via Tab
 indent). Mark autocomplete as a TODO comment for a follow-up; not blocking.
 - New components/query/result-grid.tsx — render { columns, rows } using the
 existing DS table from @ship-it-ui/ui.
 - New components/query/saved-queries.tsx — localStorage-backed list (key
 shipit:saved-queries), save/load/delete, with 3-4 starter examples ("Tier-1
 services," "Stale deployments," "Services without on-call").
 - New lib/hooks/use-cypher-query.ts — POSTs to /api/query, returns { data,
 isLoading, error }.

 Verification: open /explore/query, paste MATCH (n) RETURN labels(n) AS label,
 count(*) AS count, hit Run, see result grid. Try CREATE (n:Test) — expect
 rejected response. Save a query, reload page, see it persist.

 Step 2 — Claim Explorer

 Backend — packages/api-server/src/:
 - New services/claim-service.ts:
   - getClaimsForEntity(entityId): Promise<EffectivePropertySummary[]> — runs
 MATCH (n {id: $entityId}) RETURN n, parses the _claims JSON property, groups
 by property_key, resolves the winning claim using the entity-type's resolution
  strategy from SchemaService.getSchema().
   - listConflicts({ label?, tier?, limit }): Promise<ConflictRow[]> — scans
 nodes where the parsed _claims has ≥2 distinct values for at least one
 property, returns { entityId, propertyKey, claimCount, conflictingSources[],
 tier }.
 - New routes/claims.ts:
   - GET /api/claims/:entityId → getClaimsForEntity
   - GET /api/conflicts?label=&tier=&limit= → listConflicts
 - Reuses PropertyClaim and EffectiveProperty types from
 packages/shared/src/types/claims.ts.

 UI — packages/web-ui/src/:
 - Replace app/operations/claims/page.tsx. Two modes:
   - List mode (default): conflict-only view (Claim Conflict Dashboard from
 design doc §7.7), filterable by label/tier. Each row deep-links to detail
 mode.
   - Detail mode (?entity={id}&property={key}): claim list with source icon,
 confidence badge, timestamp, evidence; "Winning" badge on the resolved claim;
 collapsible "Why this won" explainer reading the resolution strategy from
 schema.
 - New components/claims/claim-list.tsx, components/claims/conflict-table.tsx.
 - Wire the existing "View Claims" / "Inspect Claims" links in
 app/catalog/[id]/page.tsx (currently routes are stubbed) to
 /operations/claims?entity={id}&property={key}.

 Verification: seed a node with conflicting tier claims (extend
 scripts/seed-demo.ts), open /operations/claims, see the entity listed; click
 through, see both claims with the winner annotated.

 Step 3 — Schema Editor

 Backend — packages/api-server/src/:
 - Extend services/schema-service.ts:
   - Persist a versioned snapshot (timestamp + actor + YAML) to
 config/schema-history/ on every successful updateSchema(). Keep last 10.
   - Add getHistory(): SchemaSnapshot[] and rollbackTo(version):
 Promise<SchemaConfig>.
 - Extend routes/schema.ts:
   - GET /api/schema/history
   - POST /api/schema/rollback { version: string }
   - POST /api/schema/diff { yaml: string } — returns added/removed/changed
 types vs current.

 UI — packages/web-ui/src/:
 - Replace app/configure/schema/page.tsx. Three-pane layout:
   - Left: node-type list (scrollable). Selecting expands properties.
   - Center: form editor for the selected type — property table (name, type,
 required, default), resolution strategy dropdown per property with inline
 explanation strings from design doc §10.5.
   - Right: live validation panel + a non-interactive Cytoscape meta-graph
 (reuse components/graph/graph-canvas.tsx with interactive={false}).
 - Footer actions: Save (PUTs full YAML; shows diff modal first), Validate,
 View History, Rollback.
 - New components: components/schema/node-type-list.tsx,
 components/schema/property-editor.tsx, components/schema/schema-diff.tsx,
 components/schema/history-drawer.tsx.

 Verification: open /configure/schema, change a property's resolution strategy,
  save, see history entry; rollback to previous version and confirm value
 reverts.

 Step 4 — Team Dashboard

 Backend — packages/api-server/src/:
 - New services/team-service.ts:
   - listTeams(): Promise<TeamSummary[]> — MATCH (t:Team) OPTIONAL MATCH
 (t)-[:OWNS]->(s) RETURN t, count(s) AS ownedCount
   - getTeam(id): Promise<TeamDetail> — services, repos, deployments owned,
 on-call rotation, last 25 events from sync history
 - New routes/teams.ts:
   - GET /api/teams
   - GET /api/teams/:id

 UI — packages/web-ui/src/:
 - Replace app/catalog/teams/page.tsx with a team-list grid (Card per team).
 - New app/catalog/teams/[id]/page.tsx — team detail page with inventory tables
  + activity feed.
 - "View Team Graph" link routes to /explore?focus={team-canonical-id}
 (existing graph already accepts a focus param).
 - New components/teams/team-summary-card.tsx,
 components/teams/team-inventory.tsx.

 Verification: ensure seed-demo.ts creates a few Team nodes with OWNS edges;
 open /catalog/teams, see grid; click in, see services and deployments listed.

 Step 5 — Reconciliation UI

 Backend — packages/api-server/src/:
 - New services/reconciliation-service.ts:
   - Periodic scan job (cron via node-cron, every 15 min, configurable): for
 each label, compute pairwise Jaro-Winkler on name with namespace/tags as
 boosting features per the design doc §5.3 weights (name=0.5, namespace=0.2,
 tags=0.2, labels=0.1). Below 0.95 and above threshold (default 0.85,
 env-configurable) → write a ReconciliationCandidate node connecting the two
 entities with a confidence score.
   - listCandidates({ status='pending', limit }) and getCandidate(id) (with
 both entities + their claims for side-by-side display).
   - confirmMerge(id, actor) — writes a MergeEvent, reassigns the loser's
 claims onto the winner, soft-deletes the loser (_deleted=true,
 _merged_into=<winner-id>). Reuses the existing MergeEvent type from
 packages/shared/src/types/identity.ts.
   - rejectCandidate(id, actor) / markDistinct(id, actor) — close the candidate
  without merging; markDistinct records a DISTINCT_FROM relationship to prevent
  re-flagging.
   - splitMerge(mergeEventId, actor) — reverse a prior merge using stored
 MergeEvent data.
 - New routes/reconciliation.ts:
   - GET /api/reconciliation/candidates?status=&limit=
   - GET /api/reconciliation/candidates/:id
   - POST /api/reconciliation/candidates/:id/confirm|reject|distinct
   - GET /api/reconciliation/merges?limit=
   - POST /api/reconciliation/merges/:id/split

 UI — packages/web-ui/src/:
 - Replace app/operations/reconciliation/page.tsx. Two tabs:
   - Pending — candidate list with confidence bar, source labels, "Open"
 button.
   - Recent merges — last 50 merges with Split action.
 - New components/reconciliation/candidate-row.tsx,
 components/reconciliation/compare-drawer.tsx (side-by-side claim comparison,
 action buttons), components/reconciliation/merges-table.tsx.
 - Sidebar badge: surface pending count from GET
 /api/reconciliation/candidates?status=pending&limit=1 (just need the total).
 Extend the sidebar NavLink type to support a numeric badge alongside the
 existing P2 phase badge.

 Verification: seed two near-duplicate services (e.g., payments-svc and
 payments-service) in different connector namespaces; trigger the scan; open
 /operations/reconciliation, see the candidate; confirm; verify the loser is
 soft-deleted and a MergeEvent exists in the graph; split it; verify both nodes
  return.

 ---
 Cross-cutting concerns

 - API client: extend packages/web-ui/src/lib/api-client.ts (or whatever the
 existing file is named — verify pattern in lib/hooks/use-graph-data.ts) with
 helpers for each new endpoint. Reuse existing fetch wrapper; do not introduce
 a new HTTP library.
 - Types: every new API response gets a TypeScript interface in
 packages/shared/src/types/ so both API and web-ui import the same shape. Add
 new files: claims-api.ts, query-api.ts, team-api.ts, reconciliation-api.ts,
 schema-api.ts.
 - Seed data: extend scripts/seed-demo.ts to include (a) Team nodes with OWNS
 edges, (b) at least two near-duplicate entities for reconciliation, (c) at
 least one node with conflicting _claims JSON for the Claim Explorer.
 - Auth/perms: out of scope. All routes remain unauthenticated for local dev.
 Document this as an Enterprise/Phase 3 follow-up in the route file headers.
 - Tests: add Vitest unit tests for claim-service, reconciliation-service
 (Jaro-Winkler scoring edge cases — empty strings, identical strings, exact
 match should not surface as a candidate), and the safe-Cypher token check (try
  every banned keyword + adversarial whitespace/comments).
 - No CLAUDE.md / no new docs beyond inline route-header comments.

 Critical files (touched or created)

 Existing files modified:
 - packages/api-server/src/server.ts — register 4 new route plugins
 - packages/api-server/src/services/schema-service.ts — history + rollback
 - packages/api-server/src/routes/schema.ts — history/diff/rollback endpoints
 - packages/web-ui/src/components/layout/sidebar.tsx — numeric badge support
 for reconciliation pending count
 - packages/web-ui/src/app/catalog/[id]/page.tsx — wire "Inspect Claims" link
 - packages/shared/src/types/index.ts — re-export new API types
 - scripts/seed-demo.ts — teams, duplicates, conflicting claims

 New files (backend):
 - packages/api-server/src/routes/query.ts
 - packages/api-server/src/routes/claims.ts
 - packages/api-server/src/routes/teams.ts
 - packages/api-server/src/routes/reconciliation.ts
 25 events from sync history
 - New routes/teams.ts:
   - GET /api/teams
   - GET /api/teams/:id

 UI — packages/web-ui/src/:
 - Replace app/catalog/teams/page.tsx with a
 team-list grid (Card per team).
 - New app/catalog/teams/[id]/page.tsx — team
 detail page with inventory tables + activity feed.
 - "View Team Graph" link routes to
 /explore?focus={team-canonical-id} (existing graph
  already accepts a focus param).
 - New components/teams/team-summary-card.tsx,
 components/teams/team-inventory.tsx.

 Verification: ensure seed-demo.ts creates a few
 Team nodes with OWNS edges; open /catalog/teams,
 see grid; click in, see services and deployments
 listed.

 Step 5 — Reconciliation UI

 Backend — packages/api-server/src/:
 - New services/reconciliation-service.ts:
   - Periodic scan job (cron via node-cron, every
 15 min, configurable): for each label, compute
 pairwise Jaro-Winkler on name with namespace/tags
 as boosting features per the design doc §5.3
 weights (name=0.5, namespace=0.2, tags=0.2,
 labels=0.1). Below 0.95 and above threshold
 (default 0.85, env-configurable) → write a
 ReconciliationCandidate node connecting the two
 entities with a confidence score.
   - listCandidates({ status='pending', limit })
 and getCandidate(id) (with both entities + their
 claims for side-by-side display).
   - confirmMerge(id, actor) — writes a MergeEvent,
  reassigns the loser's claims onto the winner,
 soft-deletes the loser (_deleted=true,
 _merged_into=<winner-id>). Reuses the existing
 MergeEvent type from
 packages/shared/src/types/identity.ts.
   - rejectCandidate(id, actor) / markDistinct(id,
 actor) — close the candidate without merging;
 markDistinct records a DISTINCT_FROM relationship
 to prevent re-flagging.
   - splitMerge(mergeEventId, actor) — reverse a
 prior merge using stored MergeEvent data.
 - New routes/reconciliation.ts:
   - GET
 /api/reconciliation/candidates?status=&limit=
   - GET /api/reconciliation/candidates/:id
   - POST /api/reconciliation/candidates/:id/confir
 m|reject|distinct
   - GET /api/reconciliation/merges?limit=
   - POST /api/reconciliation/merges/:id/split

 UI — packages/web-ui/src/:
 - Replace app/operations/reconciliation/page.tsx.
 Two tabs:
   - Pending — candidate list with confidence bar,
 source labels, "Open" button.
   - Recent merges — last 50 merges with Split
 action.
 - New components/reconciliation/candidate-row.tsx,
  components/reconciliation/compare-drawer.tsx
 (side-by-side claim comparison, action buttons),
 components/reconciliation/merges-table.tsx.
 - Sidebar badge: surface pending count from GET
 /api/reconciliation/candidates?status=pending&limi
 t=1 (just need the total). Extend the sidebar
 NavLink type to support a numeric badge alongside
 the existing P2 phase badge.

 Verification: seed two near-duplicate services
 (e.g., payments-svc and payments-service) in
 different connector namespaces; trigger the scan;
 open /operations/reconciliation, see the
 candidate; confirm; verify the loser is
 soft-deleted and a MergeEvent exists in the graph;
  split it; verify both nodes return.

 ---
 Cross-cutting concerns

 - API client: extend
 packages/web-ui/src/lib/api-client.ts (or whatever
  the existing file is named — verify pattern in
 lib/hooks/use-graph-data.ts) with helpers for each
  new endpoint. Reuse existing fetch wrapper; do
 not introduce a new HTTP library.
 - Types: every new API response gets a TypeScript
 interface in packages/shared/src/types/ so both
 API and web-ui import the same shape. Add new
 files: claims-api.ts, query-api.ts, team-api.ts,
 reconciliation-api.ts, schema-api.ts.
 - Seed data: extend scripts/seed-demo.ts to
 include (a) Team nodes with OWNS edges, (b) at
 least two near-duplicate entities for
 reconciliation, (c) at least one node with
 conflicting _claims JSON for the Claim Explorer.
 - Auth/perms: out of scope. All routes remain
 unauthenticated for local dev. Document this as an
  Enterprise/Phase 3 follow-up in the route file
 headers.
 - Tests: add Vitest unit tests for claim-service,
 reconciliation-service (Jaro-Winkler scoring edge
 cases — empty strings, identical strings, exact
 match should not surface as a candidate), and the
 safe-Cypher token check (try every banned keyword
 + adversarial whitespace/comments).
 - No CLAUDE.md / no new docs beyond inline
 route-header comments.

 Critical files (touched or created)

 Existing files modified:
 - packages/api-server/src/server.ts — register 4
 new route plugins
 -
 packages/api-server/src/services/schema-service.ts
  — history + rollback
 - packages/api-server/src/routes/schema.ts —
 history/diff/rollback endpoints
 -
 packages/web-ui/src/components/layout/sidebar.tsx
 — numeric badge support for reconciliation pending
  count
 - packages/web-ui/src/app/catalog/[id]/page.tsx —
 wire "Inspect Claims" link
 - packages/shared/src/types/index.ts — re-export
 new API types
 - scripts/seed-demo.ts — teams, duplicates,
 conflicting claims
     (try every banned keyword + adversarial whitespace/comments). 
     - No CLAUDE.md / no new docs beyond inline route-header comments.    
                                                                             
     Critical files (touched or created)                                    
                                 
     Existing files modified:                                                
     - packages/api-server/src/server.ts — register 4 new route plugins
     - packages/api-server/src/services/schema-service.ts — history + rollback
     - packages/api-server/src/routes/schema.ts — history/diff/rollback
     endpoints       
     - packages/web-ui/src/components/layout/sidebar.tsx — numeric badge support
      for reconciliation pending count     
     - packages/web-ui/src/app/catalog/[id]/page.tsx — wire "Inspect Claims"
     link                                          
     - packages/shared/src/types/index.ts — re-export new API types
      existing file is named — verify pattern in lib/hooks/use-graph-data.ts)
     with helpers for each new endpoint. Reuse existing fetch wrapper; do not
     introduce a new HTTP library.
     - Types: every new API response gets a TypeScript interface in
     packages/shared/src/types/ so both API and web-ui import the same shape.
     Add new files: claims-api.ts, query-api.ts, team-api.ts,
     reconciliation-api.ts, schema-api.ts.
     - Seed data: extend scripts/seed-demo.ts to include (a) Team nodes with
     OWNS edges, (b) at least two near-duplicate entities for reconciliation,
     (c) at least one node with conflicting _claims JSON for the Claim Explorer.
     - Auth/perms: out of scope. All routes remain unauthenticated for local
     dev. Document this as an Enterprise/Phase 3 follow-up in the route file
     headers.
     - Tests: add Vitest unit tests for claim-service, reconciliation-service
     (Jaro-Winkler scoring edge cases — empty strings, identical strings, exact
     match should not surface as a candidate), and the safe-Cypher token check
     (try every banned keyword + adversarial whitespace/comments).
     - No CLAUDE.md / no new docs beyond inline route-header comments.

     Critical files (touched or created)

     Existing files modified:
     - packages/api-server/src/server.ts — register 4 new route plugins
     - packages/api-server/src/services/schema-service.ts — history + rollback
     - packages/api-server/src/routes/schema.ts — history/diff/rollback
     endpoints
     - packages/web-ui/src/components/layout/sidebar.tsx — numeric badge support
      for reconciliation pending count
     - packages/web-ui/src/app/catalog/[id]/page.tsx — wire "Inspect Claims"
     link
     - packages/shared/src/types/index.ts — re-export new API types
     - scripts/seed-demo.ts — teams, duplicates, conflicting claims

     New files (backend):
     - packages/api-server/src/routes/query.ts
     - packages/api-server/src/routes/claims.ts
     - packages/api-server/src/routes/teams.ts
     - packages/api-server/src/routes/reconciliation.ts
     - packages/api-server/src/services/claim-service.ts
     - packages/api-server/src/services/team-service.ts
     - packages/api-server/src/services/reconciliation-service.ts
     - packages/shared/src/types/claims-api.ts, query-api.ts, team-api.ts,
     reconciliation-api.ts, schema-api.ts

     New files (web-ui) — pages + components listed under each step above.

     Verification (end-to-end)

     1. pnpm install && pnpm run start:all — Neo4j + Redis up, all packages
     running.
     2. pnpm tsx scripts/seed-demo.ts — graph populated with teams, duplicates,
     conflicting claims.
     3. Manual walkthrough per step's verification block above (Query Playground
      → Claim Explorer → Schema Editor → Team Dashboard → Reconciliation).
     4. pnpm -w test — Vitest passes for new services + safe-Cypher token check.
     5. pnpm -w typecheck — clean across all packages.
     6. Visual smoke test: every Phase 2 sidebar entry now loads a real view (no
      PlaceholderPage). The remaining P3 and EE sidebar entries are untouched.
