-- Fresh local volumes get pgvector at first boot. Existing volumes are covered
-- by `pnpm db:bootstrap`, which scripts/infra.sh runs before migrations.
CREATE EXTENSION IF NOT EXISTS vector;
