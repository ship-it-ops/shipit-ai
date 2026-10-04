// The highest migration prefix this build of the code was written against.
// api-server (and later the runner) compare it with max(version) in
// schema_migrations at boot and switch agent features off, without crashing,
// when the database is behind. Bump it in the same change that adds a file to
// db/migrations/.
export const EXPECTED_SCHEMA_VERSION = '0003';
