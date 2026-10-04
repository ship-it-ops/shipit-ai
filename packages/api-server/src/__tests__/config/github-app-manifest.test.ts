import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, '../../../config/github-app-manifest.json'), 'utf8'),
) as { default_permissions: Record<string, string>; default_events: string[] };

describe('GitHub App manifest', () => {
  it('asks to read issues, for the knowledge facet', () => {
    expect(manifest.default_permissions.issues).toBe('read');
    expect(manifest.default_events).toEqual(expect.arrayContaining(['issues', 'issue_comment']));
  });

  it('asks for nothing it can write', () => {
    for (const [name, level] of Object.entries(manifest.default_permissions)) {
      expect(level, name).toBe('read');
    }
  });
});
