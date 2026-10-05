import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_VERSION, KNOWLEDGE_MIGRATIONS } from '../schema-version.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

describe('knowledge migrations', () => {
  it('names versions that exist as files', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    for (const version of KNOWLEDGE_MIGRATIONS) {
      expect(files.some((f) => f.startsWith(`${version}_`))).toBe(true);
    }
  });

  it('guards on the vector extension before touching any type', () => {
    const file = readdirSync(MIGRATIONS_DIR).find((f) =>
      f.startsWith(`${KNOWLEDGE_MIGRATIONS[0]}_`),
    )!;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const guardAt = sql.indexOf("pg_extension WHERE extname = 'vector'");
    const halfvecAt = sql.indexOf('halfvec(768)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(halfvecAt).toBeGreaterThan(guardAt);
  });

  it('starts the index version at 1', () => {
    expect(INDEX_VERSION).toBe(1);
  });
});
