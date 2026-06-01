import { describe, expect, it } from 'vitest';
import { buildOldCanonicalIdRegex, buildOldIdempotencyKeyRegex } from '../neo4j/migrations.js';

// Cypher `=~` is anchored full-match. `buildOldCanonicalIdRegex` carries its
// own `^...$`; `buildOldIdempotencyKeyRegex` does not (the Cypher op anchors
// it), so the test wraps it in `^...$` to mirror Neo4j semantics.

describe('buildOldCanonicalIdRegex', () => {
  it.each([
    ['repository', 'shipit://repository/default/graph-api', true],
    ['repository', 'shipit://repository/default/shipitops/graph-api', false],
    ['team', 'shipit://team/default/platform', true],
    ['team', 'shipit://team/default/shipitops/platform', false],
    ['pipeline', 'shipit://pipeline/default/web-ci', true],
    ['pipeline', 'shipit://pipeline/default/shipitops/web-ci', false],
  ] as const)('label=%s id=%s → match=%s', (label, id, expected) => {
    const re = new RegExp(buildOldCanonicalIdRegex(label));
    expect(re.test(id)).toBe(expected);
  });
});

describe('buildOldIdempotencyKeyRegex', () => {
  // Stored keys have shape `<connector>~shipit~//<label>/default/<name>~<v>`.
  // Old-format names are single-segment; new-format includes `<org>/<name>`
  // and must not be matched (cleanup would otherwise wipe live dedup entries).
  it.each([
    ['repository', 'github-shipitops~shipit~//repository/default/graph-api~1', true],
    ['repository', 'github-shipitops~shipit~//repository/default/shipitops/graph-api~1', false],
    ['team', 'github-shipitops~shipit~//team/default/platform~1', true],
    ['team', 'github-shipitops~shipit~//team/default/shipitops/platform~1', false],
    ['pipeline', 'github-shipitops~shipit~//pipeline/default/web-ci~1', true],
    ['pipeline', 'github-shipitops~shipit~//pipeline/default/shipitops/web-ci~1', false],
    // Unrelated keys for non-scoped labels — must not be matched.
    ['repository', 'github-shipitops~shipit~//logical-service/default/graph-api~1', false],
    ['repository', 'github-shipitops~shipit~//person/default/alice~1', false],
  ] as const)('label=%s key=%s → match=%s', (label, key, expected) => {
    const re = new RegExp(`^${buildOldIdempotencyKeyRegex(label)}$`);
    expect(re.test(key)).toBe(expected);
  });
});
