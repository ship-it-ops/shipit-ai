-- 0002_knowledge.sql: the knowledge layer — containers an admin selects,
-- source principals, documents, their chunks and embeddings, and a small
-- key/value state table. Design:
-- docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md §Data model.
--
-- Applied by the migration step (infra at deploy; `pnpm db:migrate` locally and
-- in CI), never by the app at boot. Forward-only.

-- pgvector must already be installed by a superuser (`pnpm db:bootstrap`; on
-- GKE the infra bootstrap step). Fail with the reason, not with
-- "type halfvec does not exist" three statements later.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'The "vector" extension (pgvector) is not installed in this database.',
      HINT = 'A superuser must run CREATE EXTENSION vector; (locally: pnpm db:bootstrap). See docs/agent/briefs/infra-pgvector-for-knowledge.md.';
  END IF;
END
$$;

CREATE TABLE knowledge_containers (
  id                         uuid PRIMARY KEY,
  connector_id               text NOT NULL,
  external_id                text NOT NULL,
  kind                       text NOT NULL,
  name                       text NOT NULL,
  url                        text,
  visibility                 text NOT NULL DEFAULT 'unknown',
  archived                   boolean NOT NULL DEFAULT false,
  acl                        jsonb,
  selected                   boolean NOT NULL DEFAULT false,
  selected_by                text,
  selected_at                timestamptz,
  visibility_acknowledged_by text,
  mapped_entity_ids          text[] NOT NULL DEFAULT '{}',
  checkpoint                 text,
  backfill_done              boolean NOT NULL DEFAULT false,
  oldest_fetched_at          timestamptz,
  last_polled_at             timestamptz,
  last_reconciled_at         timestamptz,
  purge_requested_at         timestamptz,
  gone_at                    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_containers_kind CHECK (kind IN ('channel', 'space', 'project', 'repository')),
  CONSTRAINT knowledge_containers_visibility CHECK (visibility IN ('open', 'restricted', 'unknown')),
  CONSTRAINT knowledge_containers_connector_external_key UNIQUE (connector_id, external_id)
);
CREATE INDEX knowledge_containers_selected_idx ON knowledge_containers (connector_id) WHERE selected;

CREATE TABLE knowledge_principals (
  id           uuid PRIMARY KEY,
  connector_id text NOT NULL,
  external_id  text NOT NULL,
  kind         text NOT NULL,
  display_name text NOT NULL,
  email        text,
  login        text,
  active       boolean NOT NULL DEFAULT true,
  person_id    text,
  match_method text,
  matched_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_principals_kind CHECK (kind IN ('user', 'bot', 'group', 'external')),
  CONSTRAINT knowledge_principals_match_method CHECK (match_method IS NULL OR match_method IN ('email', 'login', 'manual')),
  CONSTRAINT knowledge_principals_connector_external_key UNIQUE (connector_id, external_id)
);
CREATE INDEX knowledge_principals_email_idx ON knowledge_principals (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX knowledge_principals_person_idx ON knowledge_principals (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE knowledge_documents (
  id                        uuid PRIMARY KEY,
  connector_id              text NOT NULL,
  container_id              uuid NOT NULL REFERENCES knowledge_containers (id) ON DELETE CASCADE,
  external_id               text NOT NULL,
  kind                      text NOT NULL,
  title                     text NOT NULL DEFAULT '',
  url                       text NOT NULL DEFAULT '',
  segments                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash              text,
  source_version            text,
  source_created_at         timestamptz,
  source_updated_at         timestamptz,
  author_principal_id       uuid REFERENCES knowledge_principals (id) ON DELETE SET NULL,
  participant_principal_ids uuid[] NOT NULL DEFAULT '{}',
  state                     text,
  attributes                jsonb NOT NULL DEFAULT '{}'::jsonb,
  restricted                boolean NOT NULL DEFAULT false,
  acl                       jsonb,
  redactions                integer NOT NULL DEFAULT 0,
  index_status              text NOT NULL DEFAULT 'pending',
  index_claimed_at          timestamptz,
  index_attempts            integer NOT NULL DEFAULT 0,
  index_error               text,
  indexed_hash              text,
  index_version             integer,
  extraction_status         text NOT NULL DEFAULT 'none',
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_documents_kind CHECK (kind IN (
    'slack_thread', 'slack_channel_day', 'confluence_page', 'jira_issue',
    'github_pull_request', 'github_issue', 'github_doc')),
  CONSTRAINT knowledge_documents_index_status CHECK (index_status IN ('pending', 'indexing', 'indexed', 'failed', 'skipped')),
  CONSTRAINT knowledge_documents_extraction_status CHECK (extraction_status IN ('none', 'pending', 'done', 'skipped')),
  CONSTRAINT knowledge_documents_state CHECK (state IS NULL OR state IN ('open', 'closed', 'merged', 'resolved', 'archived')),
  CONSTRAINT knowledge_documents_connector_external_key UNIQUE (connector_id, external_id)
);
-- The worker's claim query: everything not yet in a terminal state.
CREATE INDEX knowledge_documents_claimable_idx ON knowledge_documents (updated_at)
  WHERE index_status IN ('pending', 'indexing', 'failed');
CREATE INDEX knowledge_documents_container_updated_idx ON knowledge_documents (container_id, source_updated_at DESC);
CREATE INDEX knowledge_documents_kind_state_idx ON knowledge_documents (kind, state, source_updated_at DESC);
CREATE INDEX knowledge_documents_participants_idx ON knowledge_documents USING GIN (participant_principal_ids);

CREATE TABLE knowledge_chunks (
  id              uuid PRIMARY KEY,
  document_id     uuid NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  segment_keys    text[] NOT NULL DEFAULT '{}',
  url             text,
  occurred_at     timestamptz,
  prefix          text NOT NULL DEFAULT '',
  text            text NOT NULL,
  text_hash       text NOT NULL,
  token_estimate  integer NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', prefix || ' ' || text)) STORED,
  embedding       halfvec(768),
  embedding_model text,
  CONSTRAINT knowledge_chunks_document_seq_key UNIQUE (document_id, seq)
);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);
CREATE INDEX knowledge_chunks_text_hash_idx ON knowledge_chunks (document_id, text_hash);

CREATE TABLE knowledge_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
