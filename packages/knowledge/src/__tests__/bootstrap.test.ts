import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@shipit-ai/agents';
import { ensureVectorExtension, hasVectorExtension } from '../bootstrap.js';

function fakeDb(extensionPresent: boolean): { db: SqlClient; statements: string[] } {
  const statements: string[] = [];
  const db: SqlClient = {
    async query<R extends object>(text: string) {
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('pg_extension')) {
        return {
          rows: (extensionPresent ? [{ extversion: '0.8.7' }] : []) as R[],
          rowCount: 0,
        };
      }
      return { rows: [] as R[], rowCount: 0 };
    },
  };
  return { db, statements };
}

describe('vector extension bootstrap', () => {
  it('reports the extension present or absent from pg_extension', async () => {
    expect(await hasVectorExtension(fakeDb(true).db)).toBe(true);
    expect(await hasVectorExtension(fakeDb(false).db)).toBe(false);
  });

  it('creates the extension only when it is absent', async () => {
    const absent = fakeDb(false);
    expect(await ensureVectorExtension(absent.db)).toBe('created');
    expect(absent.statements).toContain('CREATE EXTENSION IF NOT EXISTS vector');

    const present = fakeDb(true);
    expect(await ensureVectorExtension(present.db)).toBe('present');
    expect(present.statements.some((s) => s.startsWith('CREATE EXTENSION'))).toBe(false);
  });
});
