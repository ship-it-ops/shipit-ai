import { describe, it, expect } from 'vitest';
import {
  TOKEN_PREFIX,
  splitToken,
  hashSecret,
  constantTimeEqual,
  formatToken,
} from '../auth/token-crypto.js';

describe('token-crypto', () => {
  it('formatToken/splitToken round-trip', () => {
    const t = formatToken('idpart', 'secretpart');
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(splitToken(t)).toEqual({ id: 'idpart', secret: 'secretpart' });
  });

  it('splitToken rejects malformed input', () => {
    expect(splitToken('nope')).toBeNull(); // wrong prefix
    expect(splitToken(`${TOKEN_PREFIX}noseparator`)).toBeNull(); // no '.'
    expect(splitToken(`${TOKEN_PREFIX}.secret`)).toBeNull(); // empty id
    expect(splitToken(`${TOKEN_PREFIX}id.`)).toBeNull(); // empty secret
  });

  it('hashSecret is deterministic and salt-dependent', () => {
    expect(hashSecret('s', 'salt')).toBe(hashSecret('s', 'salt'));
    expect(hashSecret('s', 'salt')).not.toBe(hashSecret('s', 'other-salt'));
    expect(hashSecret('s', 'salt')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('constantTimeEqual compares equal-length hex and rejects mismatches', () => {
    const h = hashSecret('s', 'salt');
    expect(constantTimeEqual(h, h)).toBe(true);
    expect(constantTimeEqual(h, hashSecret('t', 'salt'))).toBe(false);
    expect(constantTimeEqual(h, '')).toBe(false); // length mismatch
  });
});
