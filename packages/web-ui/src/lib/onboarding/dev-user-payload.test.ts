import { describe, expect, it } from 'vitest';
import { devUserYamlSnippet, validateDevUser } from './dev-user-payload';

const valid = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  role: 'Platform Admin',
  team: 'platform-team',
  joinedAt: '2026-05-19',
  capabilities: ['admin', 'graph:write'],
};

describe('validateDevUser', () => {
  it('accepts a fully-populated payload', () => {
    const result = validateDevUser(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe('ada@example.com');
  });

  it('trims whitespace from string fields', () => {
    const result = validateDevUser({ ...valid, firstName: '  Ada  ', email: ' ada@example.com ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.firstName).toBe('Ada');
      expect(result.value.email).toBe('ada@example.com');
    }
  });

  it('rejects an empty firstName', () => {
    const result = validateDevUser({ ...valid, firstName: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === 'firstName')).toBe(true);
  });

  it('rejects an email that doesnt look like an address', () => {
    const result = validateDevUser({ ...valid, email: 'not-an-email' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === 'email')).toBe(true);
  });

  it('rejects a joinedAt that isnt YYYY-MM-DD', () => {
    const result = validateDevUser({ ...valid, joinedAt: '05/19/2026' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === 'joinedAt')).toBe(true);
  });

  it('rejects capabilities that isnt an array', () => {
    const result = validateDevUser({ ...valid, capabilities: 'admin' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === 'capabilities')).toBe(true);
  });

  it('rejects empty-string entries in capabilities', () => {
    const result = validateDevUser({ ...valid, capabilities: ['admin', ''] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === 'capabilities[1]')).toBe(true);
  });

  it('rejects non-object bodies', () => {
    expect(validateDevUser(null).ok).toBe(false);
    expect(validateDevUser([]).ok).toBe(false);
    expect(validateDevUser('hi').ok).toBe(false);
  });
});

describe('devUserYamlSnippet', () => {
  it('emits the full devUser block with proper indentation', () => {
    const out = devUserYamlSnippet(valid);
    expect(out).toContain('frontend:');
    expect(out).toContain('  devUser:');
    expect(out).toContain('    firstName: Ada');
    expect(out).toContain('    lastName: Lovelace');
    expect(out).toContain('    email: ada@example.com');
    expect(out).toContain('    capabilities:');
    expect(out).toContain('      - admin');
    expect(out).toContain('      - graph:write');
  });

  it('handles an empty capabilities array', () => {
    const out = devUserYamlSnippet({ ...valid, capabilities: [] });
    expect(out).toContain('    capabilities:\n\n');
  });
});
