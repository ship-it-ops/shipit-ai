# Infra brief (addendum) — pgvector on Postgres 17 for the knowledge layer

**For:** `Ship-It-Ops/shipit-ai-infra`.
**From:** app repo, 2026-10-02. **Amends:**
`docs/agent/briefs/infra-postgres-and-vertex-for-agents.md` (in your inbox as
`incoming-brief-agent-platform-postgres-vertex-2026-10-01.md`). Read the two together;
where they differ, this one wins.
**Enables:** the knowledge layer (`docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`,
`docs/agent/decisions/knowledge-layer-v1-foundations.md`).

You are working in the infra repo. Read its `docs/agent/MANIFEST.md`, `status/` and
`instructions/` first; its standing instructions apply. Where this says "infra decides",
pick what fits the repo's conventions and record the choice as a decision note.

## What the app is building

Content from Slack, Confluence, Jira and GitHub will be stored in the same Postgres
instance the agent platform uses, with a vector index for semantic search. That needs the
`vector` extension (pgvector), which the first brief said was not required.

## Changes to the first brief

### 1. Postgres 17, on a pgvector image

- The first brief says "16 or newer". Make it **17**. A BM25 extension we may want later
  (`pg_textsearch`) needs 17, and Cloud SQL offers it on 17 and up only.
- Use an image that ships pgvector, pinned to a pgvector version and the Postgres major,
  for example `pgvector/pgvector:0.8.7-pg17`. Check the current tag list before pinning;
  0.8.3 fixed an HNSW vacuum index-corruption bug, so do not pin below it.

### 2. Create the extension once, as a superuser

- pgvector is **not a trusted extension**. `CREATE EXTENSION vector` needs a superuser, so
  `shipit_migrator` (a plain schema owner) cannot run it, and it must not be put in a
  migration file.
- Add a bootstrap step that runs `CREATE EXTENSION IF NOT EXISTS vector;` in database
  `shipit` as the superuser, **before the migration step** on every deploy (it is
  idempotent). An init script covers a fresh volume but not an existing one, so prefer a
  step that runs each time.
- On Cloud SQL later, the same statement must be run by a member of `cloudsqlsuperuser`.
- The app's first knowledge migration fails with a clear message when the extension is
  missing, and the app disables the knowledge feature, without crashing, when it is absent
  at boot.

### 3. More memory and disk

The first brief suggested requests around `100m / 256Mi`. A vector index wants RAM.

- Rough size per 1 million chunks (our estimate, not a measurement): about 1.6 GB of
  vectors, about 2 GB of HNSW index, about 2 GB of text, about 1 GB of full-text index.
  Roughly 6 to 7 GB per million chunks.
- The demo corpus should stay well under 200,000 chunks. A reasonable start is a memory
  request around 1Gi and a PVC of 20Gi. Infra decides; the node pool must fit it, and the
  cost ceiling the first brief flagged applies with more force.
- Index builds are much faster when the graph fits in `maintenance_work_mem`. If you
  expose Postgres settings, make that one tunable.
- **Backups:** the ingested content can be re-fetched from its sources. If the nightly
  dump grows too large, the `knowledge_chunks` table data can be excluded and rebuilt; the
  other tables should stay in the dump.

### 4. A service account for the knowledge worker

- A new long-running worker, `knowledge-worker`, will call Vertex AI for embeddings. It
  does not exist yet; its Deployment is a follow-up brief.
- Creating its identity now is welcome: a GSA, for example `shipit-knowledge-worker`, with
  `roles/aiplatform.user`, bound by Workload Identity to KSA `shipit/knowledge-worker`,
  following D7 (a new GSA per workload).
- `api-server` still needs no Vertex role.
- Embedding spend falls under the Vertex budget alert the first brief asks for. No new
  alert is needed.

## Not in this brief

- **The `knowledge-worker` Deployment and image.** A follow-up brief will ask for a
  `Deployment` with no Service (same shape as `core-writer`), `replicas: 1`, env from the
  app ConfigMap plus `DATABASE_URL`, Redis and read-only Neo4j settings, and an entry in
  `build-images.yml`.
- **Egress from `api-server`** to `slack.com`, `api.atlassian.com` and customer
  `*.atlassian.net` sites. Needed when the connectors ship; if the cluster restricts
  egress today, say so in your report.
- **No new secret containers.** Slack and Atlassian tokens are stored in the existing
  `shipit-connector-apps` blob.

## Done when

1. `SELECT extversion FROM pg_extension WHERE extname = 'vector'` returns a row in database
   `shipit`.
2. `SELECT version()` reports Postgres 17.
3. As `shipit_migrator`, `CREATE TABLE t (e halfvec(768))` succeeds, and
   `CREATE EXTENSION vector` is refused.
4. A second deploy at the same SHA runs the bootstrap step again without error.
5. A pod running as KSA `shipit/knowledge-worker` can call a Vertex embedding model.
6. The runbook says how to rebuild `knowledge_chunks` if it is excluded from backups.

## Notes

- Project `ship-it-ai-portal`, cluster `shipit-demo`, namespace `shipit`.
- Please report back: the image tag pinned, the pgvector version installed, the memory and
  PVC sizes chosen, and the GSA email.
