import { describe, expect, it } from 'vitest';
import {
  buildOldCanonicalIdRegex,
  buildOldIdempotencyKeyRegex,
  buildMixedCasePersonIdRegex,
  buildMixedCasePersonIdempotencyKeyRegex,
} from '../neo4j/migrations.js';

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

describe('buildMixedCasePersonIdRegex', () => {
  // Matches stale pre-fix Person ids whose login segment carries uppercase.
  it.each([
    ['shipit://person/default/Mohamed-E', true],
    ['shipit://person/default/GH-User', true],
    ['shipit://person/default/mohamed-e', false],
    ['shipit://person/default/alice', false],
    // Wrong label — guarded by the STARTS WITH prefix anyway, but the regex
    // must not match on its own either.
    ['shipit://repository/default/Graph-API', false],
  ] as const)('id=%s → match=%s', (id, expected) => {
    const re = new RegExp(buildMixedCasePersonIdRegex());
    expect(re.test(id)).toBe(expected);
  });
});

describe('buildMixedCasePersonIdempotencyKeyRegex', () => {
  // Stored key shape `<connector>~shipit~//person/default/<name>~<v>`.
  it.each([
    ['github-shipitops~shipit~//person/default/Mohamed-E~1', true],
    ['github-shipitops~shipit~//person/default/mohamed-e~1', false],
    ['github-shipitops~shipit~//person/default/alice~1', false],
    // Uppercase elsewhere (a non-person label) must not match.
    ['github-shipitops~shipit~//repository/default/Graph-API~1', false],
  ] as const)('key=%s → match=%s', (key, expected) => {
    const re = new RegExp(`^${buildMixedCasePersonIdempotencyKeyRegex()}$`);
    expect(re.test(key)).toBe(expected);
  });
});
