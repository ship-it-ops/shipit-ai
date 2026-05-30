# Migration — canonical-ID org namespacing

ShipIt-AI now scopes `Repository`, `Team`, and `Pipeline` canonical IDs by
GitHub org. Pre-migration IDs looked like
`shipit://repository/default/payments-api`; post-migration they look like
`shipit://repository/default/acme-corp/payments-api`.

`Person` IDs are unchanged because GitHub logins are globally unique.

## Why

Before this change, two GitHub orgs that shared a common repo name (e.g.,
`acme-corp/infra` and `contoso/infra`) silently collapsed onto a single
`Repository` node in the graph — there was no error, just data corruption.

See `docs/agent/decisions/canonical-id-org-namespacing.md` for the full
context.

## How to migrate

The `core-writer` process runs the cleanup automatically on every startup.
It's a no-op once there are no old-format IDs left. To migrate:

1. Restart the `core-writer` process (the worker that consumes the sync
   event bus and writes to Neo4j). On boot, if it finds old-format IDs,
   you'll see a log line like:
   ```
   CoreWriter canonical-ID migration: removed nodes (repository=12, team=4, pipeline=7)
   ```
   If there's nothing to do, the line is silent.
2. Open the web UI → **Connectors** → for each GitHub connector instance,
   click **Sync now**. The next sync regenerates the deleted entities with
   the new org-scoped IDs.

## Verifying

```cypher
MATCH (n:Repository) RETURN n.id ORDER BY n.id;
```

Expected: every row matches `shipit://repository/default/<org>/<name>`. If
you connect two orgs that both have a repo named `infra`, you should see
two rows, one per org.

## What does NOT change

- `Person` canonical IDs.
- `LogicalService` and other non-GitHub-derived entity types — no connector
  emits those today.
- `_LinkingKey` shapes — they were already org-scoped (`github://<org>/<repo>`).
