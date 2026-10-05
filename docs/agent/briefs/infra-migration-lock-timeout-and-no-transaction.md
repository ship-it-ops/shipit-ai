# Infra brief — migration contract: a lock timeout, and files that run outside a transaction

**For:** `Ship-It-Ops/shipit-ai-infra`. **From:** app repo, 2026-10-04. **Follows:**
`infra-postgres-and-vertex-for-agents.md` §3, delivered in infra PR #91 as
`charts/shipit-ai/files/db-migrate.sh`. **Needed before:** the first migration that alters
or indexes a table that already holds data. Nothing in `db/migrations/` needs it today.

You are working in the infra repo. Read its `docs/agent/MANIFEST.md`, `status/` and
`instructions/` first; its standing instructions apply.

## Why

The four files that exist only create tables and indexes, so they wait for nothing. Two
things go wrong with the first file that touches a populated table:

- **A migration that waits for a lock stalls the application.** `ALTER TABLE` waits behind
  any open transaction on the table, and every later query on that table then waits behind
  the `ALTER`. The app's 10-second statement timeout turns that into errors for as long as
  the wait lasts.
- **An index cannot be built without blocking writes.** `CREATE INDEX` blocks writes to the
  table for the whole build. `CREATE INDEX CONCURRENTLY` does not, but Postgres refuses it
  inside a transaction, and `db-migrate.sh` runs every file with `--single-transaction`.

The app's own migrator (`pnpm db:migrate`, the compose `migrate` service, CI) follows both
rules below as of this change: `packages/agents/src/migrate.ts`.

## What to change in `db-migrate.sh`

1. **Lock timeout.** Run each file with a lock timeout that lasts for its transaction:

   ```sh
   psql_ --single-transaction -c "SET LOCAL lock_timeout = '5s'" -f "$dir/$f" \
         -c "INSERT INTO schema_migrations (version) VALUES ('$v')"
   ```

   A file that cannot get its lock within 5 seconds fails, the hook fails, and the deploy
   stops before app pods roll, which is what a failed file does today. Running the deploy
   again later is the remedy. A file may set its own `SET LOCAL lock_timeout` to override.

2. **Files that run outside a transaction.** A file whose **first line** is exactly

   ```sql
   -- migrate: no-transaction
   ```

   is run without `--single-transaction` and without the lock timeout (a concurrent index
   build waits for older transactions without blocking anyone; cutting that wait short
   leaves an invalid index). Its version is recorded in a second `psql` call, only after
   the file succeeded:

   ```sh
   if head -n 1 "$dir/$f" | grep -Eq '^--[[:space:]]*migrate:[[:space:]]*no-transaction[[:space:]]*$'; then
     psql_ -f "$dir/$f"
     invalid="$(psql_ -tAc "SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
                               FROM pg_index i
                               JOIN pg_class c ON c.oid = i.indexrelid
                               JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE NOT i.indisvalid AND n.nspname = current_schema()")"
     if [ -n "$invalid" ]; then
       echo "db-migrate: ERROR: the schema holds an invalid index: $invalid" >&2
       echo "db-migrate: unless a build of it is still running, drop it (DROP INDEX CONCURRENTLY <name>) and deploy again" >&2
       exit 1
     fi
     psql_ -c "INSERT INTO schema_migrations (version) VALUES ('$v')"
   else
     # as in 1.
   fi
   ```

   Such a file holds **one statement**, written with `IF NOT EXISTS`
   (`CREATE INDEX CONCURRENTLY IF NOT EXISTS …`): if the recording call fails after the
   statement succeeded, the next deploy runs the statement again, harmlessly. One
   statement because the app's migrator sends the file as a single query, which Postgres
   runs as one implicit transaction when it holds several, and `psql -f` runs them one at
   a time: with two statements the two appliers would behave differently.

3. **The invalid-index check above is part of the contract.** A concurrent index build
   that fails half-way (a duplicate row under a unique index, a deadlock, a cancelled
   deploy) leaves an `INVALID` index. `IF NOT EXISTS` skips it on the next run, and
   without the check the file would be recorded as applied over an index Postgres never
   uses and, for a unique one, never enforces. With it the deploy fails and names the
   index, with its schema and quoted where it has to be. Runbook:
   `DROP INDEX CONCURRENTLY <name>;`, then deploy again.

   Any invalid index in the schema fails a marked file, not only one the file names:
   telling them apart would mean reading SQL, and a wrong guess is the silent failure the
   check is there to prevent. So an invalid index left by something else (a
   `REINDEX CONCURRENTLY` that failed) has to be dropped before a marked file can be
   recorded, and one whose build is still running has to finish first. The app's migrator
   (`packages/agents/src/migrate.ts`) does the same.

## For the record

- `0002_knowledge.sql` and `0003_runs.sql` were edited in place in the same app change
  (two redundant indexes and six with no reader removed, one added, and the pgvector guard
  now requires 0.7.0 or later). That was possible because no environment had applied them:
  the last deploy to portal-demo (2026-10-01) predates the migration hook. From the first
  deploy that applies them on, "an applied file is never edited" holds without exception.
- A database that did apply the earlier text of those files (a developer's local one) keeps
  the old indexes until it is reset. Nothing breaks; `pnpm stop:clean` and `pnpm
start:infra` rebuild it.

## Done when

1. `db-migrate.sh` applies the lock timeout to transactional files and handles the marker.
2. `scripts/test-db.sh` covers: a file blocked by an open transaction fails within the
   timeout and is not recorded; a marked file with `CREATE INDEX CONCURRENTLY` applies and
   is recorded; a marked file retried over an invalid index fails and is not recorded.
3. The runbook has the invalid-index step.
