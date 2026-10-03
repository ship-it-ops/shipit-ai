import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MigrationPlanError,
  listMigrationFiles,
  parseMigrationFilename,
  planMigrations,
} from '../migrate.js';
import { EXPECTED_SCHEMA_VERSION } from '../schema-version.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

describe('parseMigrationFilename', () => {
  it('accepts NNNN_description.sql', () => {
    expect(parseMigrationFilename('0001_agents.sql')).toEqual({
      version: '0001',
      description: 'agents',
    });
    expect(parseMigrationFilename('0012_run_steps_v2.sql')).toEqual({
      version: '0012',
      description: 'run_steps_v2',
    });
  });

  it.each(['1_agents.sql', '00001_agents.sql', '0001-agents.sql', '0001_Agents.sql', '0001_.sql'])(
    'rejects %s',
    (name) => {
      expect(parseMigrationFilename(name)).toBeNull();
    },
  );
});

describe('planMigrations', () => {
  it('returns unapplied files in version order, whatever order they were listed in', () => {
    const plan = planMigrations(['0003_c.sql', '0001_a.sql', '0002_b.sql'], ['0001']);
    expect(plan.pending).toEqual(['0002_b.sql', '0003_c.sql']);
    expect(plan.unknownApplied).toEqual([]);
  });

  it('plans nothing when everything is applied', () => {
    expect(planMigrations(['0001_a.sql'], ['0001']).pending).toEqual([]);
  });

  it('ignores files that are not .sql', () => {
    expect(planMigrations(['README.md', '.gitkeep', '0001_a.sql'], []).pending).toEqual([
      '0001_a.sql',
    ]);
  });

  it('refuses a .sql file with a malformed name rather than skipping it', () => {
    expect(() => planMigrations(['0001_a.sql', '2_oops.sql'], [])).toThrow(MigrationPlanError);
  });

  it('refuses two files with the same version', () => {
    expect(() => planMigrations(['0001_a.sql', '0001_b.sql'], [])).toThrow(/share version 0001/);
  });

  it('refuses a pending file older than the newest applied version', () => {
    expect(() =>
      planMigrations(['0001_a.sql', '0002_b.sql', '0003_c.sql'], ['0001', '0003']),
    ).toThrow(/forward-only/);
  });

  it('reports applied versions that have no file, without failing', () => {
    const plan = planMigrations(['0001_a.sql'], ['0001', '0002']);
    expect(plan.pending).toEqual([]);
    expect(plan.unknownApplied).toEqual(['0002']);
  });
});

describe('listMigrationFiles', () => {
  it('returns an empty list for a directory that does not exist', async () => {
    await expect(listMigrationFiles(resolve(here, 'no-such-dir'))).resolves.toEqual([]);
  });
});

describe('db/migrations', () => {
  it('is a valid, gap-free sequence', () => {
    const plan = planMigrations(readdirSync(MIGRATIONS_DIR), []);
    const versions = plan.pending.map((f) => parseMigrationFilename(f)!.version);
    expect(versions).toEqual(versions.map((_, i) => String(i + 1).padStart(4, '0')));
  });

  it('ends at EXPECTED_SCHEMA_VERSION, so the code and the schema move together', () => {
    const plan = planMigrations(readdirSync(MIGRATIONS_DIR), []);
    const last = parseMigrationFilename(plan.pending.at(-1)!)!.version;
    expect(last).toBe(EXPECTED_SCHEMA_VERSION);
  });
});
