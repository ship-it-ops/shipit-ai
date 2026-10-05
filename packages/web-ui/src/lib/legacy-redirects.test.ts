import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_REDIRECTS } from '../../legacy-redirects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../app/(app)');
const pageFor = (route: string) => resolve(appDir, route.replace(/^\//, ''), 'page.tsx');

describe('legacy redirects', () => {
  it('covers every route that moved under /ai', () => {
    const map = Object.fromEntries(LEGACY_REDIRECTS.map((r) => [r.source, r.destination]));
    expect(map['/ask']).toBe('/ai/ask');
    expect(map['/configure/mcp']).toBe('/ai/mcp');
    expect(map['/admin/agent-activity']).toBe('/ai/activity');
  });

  it('sends a bare /ai somewhere real, without making it permanent', () => {
    const bare = LEGACY_REDIRECTS.find((r) => r.source === '/ai');
    expect(bare).toEqual({ source: '/ai', destination: '/ai/ask', permanent: false });
  });

  it('points every destination at a page that exists', () => {
    for (const r of LEGACY_REDIRECTS) {
      expect(existsSync(pageFor(r.destination)), `${r.destination} has no page.tsx`).toBe(true);
    }
  });

  it('leaves no page behind at a moved source', () => {
    for (const r of LEGACY_REDIRECTS.filter((x) => x.permanent)) {
      expect(existsSync(pageFor(r.source)), `${r.source} still has a page.tsx`).toBe(false);
    }
  });

  it('never chains: no destination is itself a source', () => {
    const sources = new Set(LEGACY_REDIRECTS.map((r) => r.source));
    for (const r of LEGACY_REDIRECTS) {
      expect(sources.has(r.destination), `${r.destination} redirects again`).toBe(false);
    }
  });
});
