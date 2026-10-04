// Migration versions this build of the knowledge layer needs PRESENT in
// schema_migrations. Presence, not "max >= X": two workstreams share one
// migration sequence, so the highest applied number proves nothing about ours.
// Add a version here in the same change that adds its file to db/migrations/.
export const KNOWLEDGE_MIGRATIONS: readonly string[] = ['0002'];

// Bumped when the chunker changes shape. Documents indexed under an older
// version are re-indexed by an admin action (never automatically at boot).
export const INDEX_VERSION = 1;
