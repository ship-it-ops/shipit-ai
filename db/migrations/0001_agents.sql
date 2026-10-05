-- 0001_agents.sql: agent definitions and their published versions.
--
-- Applied by the migration step (infra at deploy; `pnpm db:migrate` locally and
-- in CI), never by the app at boot. Forward-only: an applied file is never
-- edited; changes arrive as a new numbered file.

CREATE TABLE agents (
  id                uuid PRIMARY KEY,
  slug              text NOT NULL,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  owner_team_id     text,
  enabled           boolean NOT NULL DEFAULT true,
  builtin           boolean NOT NULL DEFAULT false,
  draft_definition  jsonb NOT NULL,
  published_version integer,
  revision          integer NOT NULL DEFAULT 1,
  created_by        text NOT NULL,
  updated_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT agents_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT agents_revision_positive CHECK (revision >= 1)
);

-- A slug is unique among live agents; archiving an agent frees its slug.
CREATE UNIQUE INDEX agents_slug_live_key ON agents (slug) WHERE archived_at IS NULL;
CREATE INDEX agents_updated_at_idx ON agents (updated_at DESC);

CREATE TABLE agent_versions (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  definition jsonb NOT NULL,
  note       text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version),
  CONSTRAINT agent_versions_version_positive CHECK (version >= 1)
);
