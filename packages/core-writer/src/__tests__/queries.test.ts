/**
 * Unit tests for the Cypher sanitizers in neo4j/queries.ts (cheap follow-up
 * flagged by the integration-test roadmap deep-dive). sanitizeLabel had ZERO
 * coverage despite its output being interpolated DIRECTLY into Cypher
 * (`MERGE (n:${sanitizeLabel(node.label)} ...)`) — i.e. it is the injection
 * boundary for labels/relationship types (property values go through bound
 * params, labels can't). These tests pin the whitelist behavior.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeLabel, sanitizeProperties } from '../neo4j/queries.js';

describe('sanitizeLabel', () => {
  it('passes through a plain alphanumeric/underscore label unchanged', () => {
    expect(sanitizeLabel('Repository')).toBe('Repository');
    expect(sanitizeLabel('CODEOWNER_OF')).toBe('CODEOWNER_OF');
    expect(sanitizeLabel('_LinkingKey')).toBe('_LinkingKey');
    expect(sanitizeLabel('Team123')).toBe('Team123');
  });

  it('replaces every Cypher-significant character with an underscore', () => {
    // Backtick, brace, paren, colon, space — the chars an attacker would use to
    // break out of `MERGE (n:LABEL ...)` — must all be neutralized.
    expect(sanitizeLabel('Foo`)-[:OWNS]->(x')).toBe('Foo_____OWNS____x');
    expect(sanitizeLabel('a b')).toBe('a_b');
    expect(sanitizeLabel('a:b')).toBe('a_b');
    expect(sanitizeLabel('a{b}')).toBe('a_b_');
  });

  it('neutralizes a Cypher-injection attempt so no metacharacter survives', () => {
    const malicious = 'X`) DETACH DELETE n //';
    const out = sanitizeLabel(malicious);
    // Nothing outside the [A-Za-z0-9_] whitelist remains.
    expect(out).toMatch(/^[A-Za-z0-9_]+$/);
    expect(out).not.toContain('`');
    expect(out).not.toContain(')');
    expect(out).not.toContain(' ');
  });

  it('maps an entirely non-whitelisted label to all underscores (never empty)', () => {
    expect(sanitizeLabel('!@#')).toBe('___');
    expect(sanitizeLabel('')).toBe('');
  });

  it('replaces unicode/emoji outside the ASCII whitelist', () => {
    expect(sanitizeLabel('café')).toBe('caf_');
    expect(sanitizeLabel('Tëam')).toBe('T_am');
  });
});

describe('sanitizeProperties', () => {
  it('passes primitives through untouched', () => {
    expect(sanitizeProperties({ name: 'svc', count: 3, active: true })).toEqual({
      name: 'svc',
      count: 3,
      active: true,
    });
  });

  it('JSON-stringifies object and array values', () => {
    expect(sanitizeProperties({ tags: ['a', 'b'], meta: { k: 1 } })).toEqual({
      tags: '["a","b"]',
      meta: '{"k":1}',
    });
  });

  it('coerces null and undefined to null', () => {
    expect(sanitizeProperties({ a: null, b: undefined })).toEqual({ a: null, b: null });
  });

  it('drops _-prefixed internal keys', () => {
    expect(sanitizeProperties({ keep: 1, _claims: 'x', _source_org: 'acme' })).toEqual({ keep: 1 });
  });

  it('returns an empty object for empty input', () => {
    expect(sanitizeProperties({})).toEqual({});
  });
});
