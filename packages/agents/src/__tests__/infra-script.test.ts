import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/infra.sh starts the compose services and then applies the schema
// (`pnpm db:bootstrap`, `pnpm db:migrate`). It is run here with stand-ins for
// docker and pnpm on the PATH, to see which database it points the two at.
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../../../../scripts/infra.sh');
const COMPOSE_URL = 'postgres://shipit:shipit-dev@localhost:5432/shipit';

describe('scripts/infra.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the script and returns the DATABASE_URL each pnpm command was given. */
  function targets(env: Record<string, string>): Array<{ command: string; url: string }> {
    const bin = mkdtempSync(join(tmpdir(), 'shipit-infra-script-'));
    dirs.push(bin);
    const record = join(bin, 'pnpm-calls');
    // `compose up` succeeds, `compose ps -q` names a container, `inspect` says healthy.
    writeFileSync(
      join(bin, 'docker'),
      '#!/bin/sh\ncase "$*" in *"ps -q"*) echo container-id ;; inspect*) echo healthy ;; esac\n',
    );
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\nprintf '%s\\t%s\\n' "$*" "$DATABASE_URL" >> "${record}"\n`,
    );
    for (const name of ['docker', 'pnpm']) chmodSync(join(bin, name), 0o755);
    execFileSync('bash', [SCRIPT], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: bin, ...env },
      stdio: 'pipe',
    });
    return readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [args, url] = line.split('\t');
        return { command: args!.replace('--silent ', ''), url: url! };
      });
  }

  it('applies the schema to the compose database', () => {
    expect(targets({})).toEqual([
      { command: 'db:bootstrap', url: COMPOSE_URL },
      { command: 'db:migrate', url: COMPOSE_URL },
    ]);
  });

  // A DATABASE_URL already exported in the shell belongs to something else
  // (another project, a hosted database). The script has just started its own
  // database; that is the one it migrates.
  it('does not take the target from a DATABASE_URL that happens to be exported', () => {
    const urls = targets({ DATABASE_URL: 'postgres://db.example.com:5432/billing' });
    expect(urls.map((t) => t.url)).toEqual([COMPOSE_URL, COMPOSE_URL]);
  });

  it('follows the compose password when one is set', () => {
    const password = 'set-in-the-shell';
    const urls = targets({ POSTGRES_PASSWORD: password });
    expect(urls[0]!.url).toBe(`postgres://shipit:${password}@localhost:5432/shipit`);
  });

  it('takes a deliberate override from SHIPIT_DEV_DATABASE_URL', () => {
    const override = 'postgres://localhost:5433/scratch';
    expect(targets({ SHIPIT_DEV_DATABASE_URL: override }).map((t) => t.url)).toEqual([
      override,
      override,
    ]);
  });
});
