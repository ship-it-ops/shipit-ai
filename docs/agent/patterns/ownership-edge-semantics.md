---
type: pattern
status: active
created: 2026-05-30
updated: 2026-05-30
author: claude-opus-4-7
tags: [schema, graph, connectors, ui, extensibility]
importance: core
---

# Mark ownership-class relationships with `semantics: 'ownership'` in the schema

## When to Use

Whenever a new connector introduces a relationship type whose source node should be treated as an "owner" of the target — for the Owner filter on the graph explorer, the catalog Owner facet, and any future surface that asks "who owns this?". Examples already in the default schema: `OWNS` (Team → LogicalService), `CODEOWNER_OF` (Person/Team → Repository). Plausible future additions when their connectors land: `MAINTAINS`, `ON_CALL_FOR` (note: kept off by default — see Gotchas), `RESPONSIBLE_FOR`.

Do **not** apply this to membership, dependency, or runtime relationships — `MEMBER_OF` is membership (Person → Team), not ownership; `DEPENDS_ON` is dependency; `EMITS_TELEMETRY_AS` is runtime. Treating membership as ownership leaks Person nodes into Team-owned filters and is the regression this pattern guards against.

## Implementation

The `ShipItSchema` registry is the single source of truth. Each entry in `relationship_types` can carry an optional `semantics` field defined in `packages/shared/src/types/schema.ts`:

```ts
export type RelTypeSemantics = 'ownership';

export interface SchemaRelTypeDef {
  from: string;
  to: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  properties?: Record<string, SchemaPropertyDef>;
  description?: string;
  semantics?: RelTypeSemantics;
}
```

Connector authors mark their ownership-class rel types in two places that must stay in sync:

1. The TS defaults in `packages/shared/src/schema/defaults.ts` (used by tests, fresh installs, and as the runtime fallback).
2. The shipped YAML at `config/shipit-schema.yaml` (loaded into the server on first boot).

The web UI consumes the marked set through `getOwnershipRelTypes(schema)` exported from `@shipit-ai/shared`. The graph canvas pulls the live schema via the react-query key `['schema']` (already used by `app/configure/schema/page.tsx`) and falls back to `DEFAULT_OWNERSHIP_REL_TYPES` if the schema hasn't loaded yet, so the filter never wedges on initial paint.

```ts
// packages/web-ui/src/components/graph/graph-canvas.tsx
const ownershipRelTypes = useMemo(() => {
  if (!schemaResult?.schema) return DEFAULT_OWNERSHIP_REL_TYPES;
  return getOwnershipRelTypes(schemaResult.schema);
}, [schemaResult]);

const ownershipIndex = useMemo(
  () => buildOwnershipIndex(data, ownershipRelTypes),
  [data, ownershipRelTypes],
);
```

The pure builder `buildOwnershipIndex` in `packages/web-ui/src/components/graph/ownership-index.ts` walks edges of the marked types plus `d.owner` strings and Team/Person self-membership, producing a `Map<nodeId, Set<owner>>` that the filter useEffect reads once per data/schema change.

## Examples

Marking a relationship as ownership in `defaults.ts`:

```ts
OWNS: { from: 'Team', to: 'LogicalService', cardinality: '1:N', semantics: 'ownership' },
CODEOWNER_OF: {
  from: 'Person',
  to: 'Repository',
  cardinality: 'N:M',
  semantics: 'ownership',
},
```

Mirror in `config/shipit-schema.yaml`:

```yaml
OWNS:
  from: Team
  to: LogicalService
  cardinality: '1:N'
  semantics: ownership
```

A user-edited schema can add or remove `semantics: ownership` on any rel type and the filter reflects the change as soon as the `['schema']` query revalidates.

## Gotchas

- **Direction is load-bearing.** The source node's `name` is recorded as the owner of the target. `MEMBER_OF` runs Person → Team — marking it as ownership would record each Person's name as an owner of the Team they belong to (the bug this pattern exists to prevent). When considering a new rel type, ask: "if I pick the source node's name as an owner filter, should the target be visible?" If the answer is no, it's not ownership.
- **The two schema sources must agree.** `defaults.ts` and `config/shipit-schema.yaml` both ship and can drift. The `parseSchemaFile` test loads the YAML; the `getOwnershipRelTypes` tests load `DEFAULT_SCHEMA`. When you flip a rel type, update both, and the existing test `matches DEFAULT_OWNERSHIP_REL_TYPES for the shipped schema` will guard the parity.
- **Conservative defaults.** `ON_CALL_FOR` is intentionally NOT flagged as ownership in the shipped schema — on-call is "responder", not "owner". If a self-hosting user wants it included, they can flip it from the schema editor without a redeploy. New connectors should pick the narrowest accurate label and let users widen.
- **Validator round-trips it.** `relTypeDefSchema` in `packages/shared/src/schema/validator.ts` accepts `semantics: z.literal('ownership').optional()`. Adding a new semantic value (e.g. `'observability'`) requires bumping that literal to a `z.enum([...])` union and updating `RelTypeSemantics`.
- **Web-ui carries its own duplicate of `ShipItSchema`** in `packages/web-ui/src/lib/api.ts`. When adding a new semantics value, mirror the literal there too, or the locally-typed schema won't expose the field through the type system. This duplication is pre-existing tech debt — the long-term fix is to drop the local types in favor of `@shipit-ai/shared`, which is now a workspace dependency.

## Related

- [agent-context-initialized](../decisions/agent-context-initialized.md) — establishes the `docs/agent` system this pattern is filed under.
- [internal-node-label-underscore-prefix](./internal-node-label-underscore-prefix.md) — sister pattern; both encode schema-driven conventions that the UI relies on.
