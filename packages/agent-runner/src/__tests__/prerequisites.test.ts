import { describe, it, expect, vi } from 'vitest';
import type { Db } from '@shipit-ai/agents';
import { schemaVersion, waitForSchema } from '../process/prerequisites.js';

// A Db whose schema_migrations answers come from a list, one per query.
function dbAnswering(...answers: Array<string | null | Error>): Db {
  const query = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return { rows: [{ version: next }], rowCount: 1 };
  });
  return { query } as unknown as Db;
}

const undefinedTable = Object.assign(new Error('relation "schema_migrations" does not exist'), {
  code: '42P01',
});

describe('schemaVersion', () => {
  it('reads the highest applied migration', async () => {
    expect(await schemaVersion(dbAnswering('0002'))).toBe('0002');
  });

  it('is null when nothing was ever migrated', async () => {
    expect(await schemaVersion(dbAnswering(undefinedTable))).toBeNull();
  });

  it('lets any other database error through', async () => {
    await expect(schemaVersion(dbAnswering(new Error('connection refused')))).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('waitForSchema', () => {
  it('returns at once when the schema is current or newer', async () => {
    const sleep = vi.fn(async () => {});
    await waitForSchema(dbAnswering('0003'), '0002', { sleep, log: () => {} });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits, saying why, until the migration step catches up; it never throws', async () => {
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    await waitForSchema(
      dbAnswering(new Error('connection refused'), undefinedTable, '0001', '0002'),
      '0002',
      { sleep, log },
    );
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([m]) => m)).toEqual([
      expect.stringContaining('connection refused'),
      expect.stringContaining('not migrated'),
      expect.stringContaining('0001'),
    ]);
  });
});
