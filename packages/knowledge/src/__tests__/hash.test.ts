import { describe, it, expect } from 'vitest';
import { contentHashOf, sha256Hex } from '../hash.js';

describe('hashing', () => {
  it('is stable for the same input', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).toHaveLength(64);
  });

  it('changes when a segment changes and ignores author display names', () => {
    const a = contentHashOf('T', [{ key: 'k', text: 'x', authorName: 'Ada' }]);
    const b = contentHashOf('T', [{ key: 'k', text: 'x', authorName: 'A. Lovelace' }]);
    const c = contentHashOf('T', [{ key: 'k', text: 'y', authorName: 'Ada' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
