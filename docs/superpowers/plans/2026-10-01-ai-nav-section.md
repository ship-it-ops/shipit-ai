# AI Nav Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The left nav has an **AI** group holding Ask, Agents, Workflows, Activity, Tools and MCP Access under `/ai/*`, and every old URL still works.

**Architecture:** Three existing pages move with `git mv` into `src/app/(app)/ai/`, three new entries get placeholder pages, and a small redirect map (one `.mjs` file shared by `next.config.mjs` and a test) keeps old URLs alive. The sidebar and breadcrumb tables are then pointed at the new routes. No backend change.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, `@ship-it-ui/ui` + `@ship-it-ui/icons`, Vitest 4 + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md` (§Web UI → Nav; Milestone 0)

## Global Constraints

- **Package:** all code is in `packages/web-ui`. Run commands from the repo root.
- **Test command:** `pnpm --filter @shipit-ai/web-ui test`. A single file: `pnpm --filter @shipit-ai/web-ui exec vitest run src/path/to/file.test.tsx`.
- **Verify before each commit:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` must pass. `pnpm format:check` is a CI gate; run `npx prettier --write <files>` on anything you touch.
- **Never commit `packages/web-ui/next-env.d.ts`.** `pnpm build` rewrites it; `git checkout -- packages/web-ui/next-env.d.ts` before committing.
- **Commits need the owner's go-ahead.** Each "Commit" step marks where a commit belongs. Ask before running `git commit`, and separately before any `git push`. No `Co-Authored-By` or other AI-attribution trailer.
- **Move pages with `git mv`**, so history follows the files.
- **Routes (exact):** `/ai/ask`, `/ai/agents`, `/ai/workflows`, `/ai/activity`, `/ai/tools`, `/ai/mcp`.
- **Nav order (exact):** Home, Explore, AI, Catalog, Configure, Operations, Admin. Inside AI: Ask, Agents, Workflows, Activity, Tools, MCP Access.
- **Glyphs (exact, all exist in `@ship-it-ui/icons`):** Ask `ask`, Agents `bot`, Workflows `workflow`, Activity `activity`, Tools `package`, MCP Access `server`.
- **Banner tones in this design system are `accent | err | ok | warn`.** There is no `danger` or `neutral`.
- **The API paths do not move.** `/mcp` and `/api/mcp/info` are untouched.

## Review Focus

Conditions the spec implies that a person will hit, each pinned by a test or a named manual check below:

1. **An old bookmark with a query string** (`/configure/mcp?client=cursor`) must land on the new page with the query intact. → Task 1, Step 9 (curl check).
2. **Typing `/ai` on its own** must not 404. → Task 1, redirect map + test.
3. **A member, not only an admin, sees the AI group.** → Task 2, sidebar test.
4. **Collapsed sidebar: two entries in one group must not share an icon.** Ask and MCP Access both used the "sparkles" icon while they sat in different groups. → Task 2, glyph-uniqueness test; MCP Access moves to `server`.
5. **A nested AI path highlights its nav entry** (`/ai/agents/abc` → Agents), since later milestones add such pages. → Task 2, active-link test.

---

## Task 1: Move the routes, add placeholders, keep old URLs alive

**Files:**

- Move: `packages/web-ui/src/app/(app)/ask/` → `packages/web-ui/src/app/(app)/ai/ask/`
- Move: `packages/web-ui/src/app/(app)/configure/mcp/` → `packages/web-ui/src/app/(app)/ai/mcp/`
- Move: `packages/web-ui/src/app/(app)/admin/agent-activity/` → `packages/web-ui/src/app/(app)/ai/activity/`
- Modify: `packages/web-ui/src/app/(app)/ai/activity/page.tsx`
- Create: `packages/web-ui/src/app/(app)/ai/agents/page.tsx`
- Create: `packages/web-ui/src/app/(app)/ai/workflows/page.tsx`
- Create: `packages/web-ui/src/app/(app)/ai/tools/page.tsx`
- Modify: `packages/web-ui/src/components/layout/placeholder-page.tsx`
- Create: `packages/web-ui/legacy-redirects.mjs`
- Modify: `packages/web-ui/next.config.mjs`
- Test: `packages/web-ui/src/components/layout/placeholder-page.test.tsx` (create)
- Test: `packages/web-ui/src/lib/legacy-redirects.test.ts` (create)

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `LEGACY_REDIRECTS: ReadonlyArray<{ source: string; destination: string; permanent: boolean }>` exported from `packages/web-ui/legacy-redirects.mjs`.
  - `PlaceholderPageProps.note?: string` — replaces the footer sentence when set.
  - Page files at `src/app/(app)/ai/{ask,agents,workflows,activity,tools,mcp}/page.tsx`.

- [ ] **Step 1: Write the failing redirect-map test**

Create `packages/web-ui/src/lib/legacy-redirects.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/lib/legacy-redirects.test.ts`
Expected: FAIL — cannot resolve `../../legacy-redirects.mjs`.

- [ ] **Step 3: Create the redirect map**

Create `packages/web-ui/legacy-redirects.mjs`:

```js
// Routes that moved when the AI nav group was introduced (2026-10). Kept as
// data in its own module so next.config.mjs and the unit test read one list.
// Next applies redirects before middleware, so an unauthenticated visit to an
// old URL becomes /login?redirect_to=<new path>, and query strings carry over.

/** @type {ReadonlyArray<{ source: string; destination: string; permanent: boolean }>} */
export const LEGACY_REDIRECTS = [
  { source: '/ask', destination: '/ai/ask', permanent: true },
  { source: '/configure/mcp', destination: '/ai/mcp', permanent: true },
  { source: '/admin/agent-activity', destination: '/ai/activity', permanent: true },
  // No /ai index page yet. Temporary on purpose: an overview page may claim /ai later.
  { source: '/ai', destination: '/ai/ask', permanent: false },
];
```

- [ ] **Step 4: Move the three pages**

```bash
cd packages/web-ui
mkdir -p "src/app/(app)/ai"
git mv "src/app/(app)/ask" "src/app/(app)/ai/ask"
git mv "src/app/(app)/configure/mcp" "src/app/(app)/ai/mcp"
git mv "src/app/(app)/admin/agent-activity" "src/app/(app)/ai/activity"
cd ../..
```

None of the moved files uses a `../` import (they import `@/…`, packages, or `./` siblings), so no import needs editing.

- [ ] **Step 5: Write the failing placeholder test**

Create `packages/web-ui/src/components/layout/placeholder-page.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceholderPage } from './placeholder-page';

describe('PlaceholderPage', () => {
  it('shows the default roadmap note when none is given', () => {
    render(<PlaceholderPage title="Audit Log" description="d" glyph="file" />);
    expect(
      screen.getByText(/This screen is a placeholder\. The underlying capability/i),
    ).toBeInTheDocument();
  });

  it('shows a custom note instead of the default one', () => {
    render(
      <PlaceholderPage title="Agents" description="d" glyph="bot" note="Agents are being built." />,
    );
    expect(screen.getByText('Agents are being built.')).toBeInTheDocument();
    expect(screen.queryByText(/The underlying capability/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/layout/placeholder-page.test.tsx`
Expected: the first test passes, the second FAILS (`note` is not a prop; the default text is still rendered).

- [ ] **Step 7: Add the `note` prop**

In `packages/web-ui/src/components/layout/placeholder-page.tsx`, change the props interface and the footer:

```tsx
export interface PlaceholderPageProps {
  title: string;
  description: string;
  glyph: GlyphName;
  features?: ReadonlyArray<string>;
  /** Replaces the default footer sentence. Use when the roadmap pointer is wrong for this page. */
  note?: string;
}

export function PlaceholderPage({
  title,
  description,
  glyph,
  features,
  note,
}: PlaceholderPageProps) {
```

and replace the footer `<span>` content:

```tsx
<span>
  {note ?? (
    <>
      This screen is a placeholder. The underlying capability is on the roadmap (see the design doc
      &sect;10).
    </>
  )}
</span>
```

- [ ] **Step 8: Write the three new pages and update Activity**

Create `packages/web-ui/src/app/(app)/ai/agents/page.tsx`:

```tsx
'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Agents are being built now; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function AgentsPage() {
  return (
    <PlaceholderPage
      title="Agents"
      description="Define AI agents: what they are for, which model they use, which tools they may call, and what starts them."
      glyph="bot"
      features={[
        'Name an agent, write its instructions, and pick a model.',
        'Grant tools per service with read, write and delete access set to off, allow or ask first.',
        'Test an agent in a side panel before publishing it.',
        'Start agents on a schedule, from a webhook, on a graph or GitHub event, or after another agent.',
      ]}
      note={NOTE}
    />
  );
}
```

Create `packages/web-ui/src/app/(app)/ai/workflows/page.tsx`:

```tsx
'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Workflows arrive after agents; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function WorkflowsPage() {
  return (
    <PlaceholderPage
      title="Workflows"
      description="Wire several agents together on a canvas, with branches, parallel steps, approval gates and bounded loops."
      glyph="workflow"
      features={[
        'Drag agents onto a canvas and connect them.',
        'Branch on an agent’s result, run steps in parallel, and join them again.',
        'Hold a step until a person approves it.',
        'Watch a run move through the canvas node by node.',
      ]}
      note={NOTE}
    />
  );
}
```

Create `packages/web-ui/src/app/(app)/ai/tools/page.tsx`:

```tsx
'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Tools arrive with agents; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function ToolsPage() {
  return (
    <PlaceholderPage
      title="Tools"
      description="Everything an agent can call, grouped by service, with whether each tool reads, writes or deletes."
      glyph="package"
      features={[
        'The built-in graph tools, the same ones external MCP clients use.',
        'Connections to external MCP servers, with each tool classified before agents may use it.',
        'The GitHub actions App that lets agents commit to a branch and open a pull request.',
      ]}
      note={NOTE}
    />
  );
}
```

Replace the whole of `packages/web-ui/src/app/(app)/ai/activity/page.tsx`:

```tsx
'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Activity arrives with agents; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function ActivityPage() {
  return (
    <PlaceholderPage
      title="Activity"
      description="Runs of your agents and workflows, the tool calls they made, and approvals waiting on a person."
      glyph="activity"
      features={[
        'Run list with agent, trigger, status, tokens and duration.',
        'A full transcript per run: every model turn and tool call, with its service, effect and decision.',
        'An approvals inbox for write and delete actions held for a person.',
        'Later: calls made by external MCP clients, alongside our own agents.',
      ]}
      note={NOTE}
    />
  );
}
```

- [ ] **Step 9: Wire the redirects into Next and check them by hand**

In `packages/web-ui/next.config.mjs`, add the import under the existing imports:

```js
import { LEGACY_REDIRECTS } from './legacy-redirects.mjs';
```

and add `redirects` to `nextConfig`:

```js
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: [
    '@ship-it-ui/ui',
    '@ship-it-ui/tokens',
    '@ship-it-ui/icons',
    '@ship-it-ui/shipit',
  ],
  env: envBlock,
  async redirects() {
    return [...LEGACY_REDIRECTS];
  },
};
```

Then check the real behaviour, including the query string (Review Focus 1 and 2):

```bash
pnpm start:frontend   # in a second terminal; wait for "Ready"
curl -sI 'http://localhost:3000/configure/mcp?client=cursor' | grep -iE '^(HTTP|location)'
curl -sI 'http://localhost:3000/ask' | grep -iE '^(HTTP|location)'
curl -sI 'http://localhost:3000/ai' | grep -iE '^(HTTP|location)'
```

Expected:

```
HTTP/1.1 308 Permanent Redirect
location: /ai/mcp?client=cursor
HTTP/1.1 308 Permanent Redirect
location: /ai/ask
HTTP/1.1 307 Temporary Redirect
location: /ai/ask
```

Stop the dev server. If you restarted it after running `pnpm install`, that is expected; a stale `next dev` serves an old bundle (scar `pnpm-install-under-live-next-dev-serves-stale-bundle`).

- [ ] **Step 10: Run the tests to verify they pass**

Run:

```bash
pnpm --filter @shipit-ai/web-ui exec vitest run src/lib/legacy-redirects.test.ts src/components/layout/placeholder-page.test.tsx "src/app/(app)/ai/ask/ask.test.tsx"
```

Expected: PASS, 3 files. The Ask test passes unchanged from its new folder.

- [ ] **Step 11: Verify and commit**

```bash
npx prettier --write packages/web-ui/legacy-redirects.mjs packages/web-ui/next.config.mjs "packages/web-ui/src/app/(app)/ai" packages/web-ui/src/components/layout/placeholder-page.tsx packages/web-ui/src/components/layout/placeholder-page.test.tsx packages/web-ui/src/lib/legacy-redirects.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/web-ui
git commit -m "web-ui: move Ask, MCP Access and Activity under /ai with redirects and placeholders"
```

`pnpm test` will report the existing sidebar and header still pointing at the old paths as passing; they are fixed in Task 2. Between this commit and the next, the sidebar's three old links work only through the redirects.

---

## Task 2: Point the navigation at the new routes

**Files:**

- Modify: `packages/web-ui/src/components/layout/sidebar.tsx:28-76`
- Modify: `packages/web-ui/src/components/layout/header.tsx:20-46`
- Modify: `packages/web-ui/src/components/dashboard/quick-actions.tsx:35`
- Modify: `packages/web-ui/src/components/settings/api-keys-tab.tsx:75`
- Test: `packages/web-ui/src/components/layout/sidebar.test.tsx` (modify)
- Test: `packages/web-ui/src/components/layout/header.test.tsx` (create)

**Interfaces:**

- Consumes: the page routes from Task 1.
- Produces:
  - `NAV_GROUPS: ReadonlyArray<NavGroup>` exported from `sidebar.tsx` (was the private `navGroups`).
  - `trailFor(pathname: string): Trail` exported from `header.tsx` (was private).

- [ ] **Step 1: Write the failing sidebar tests**

In `packages/web-ui/src/components/layout/sidebar.test.tsx`, replace the `next/navigation` mock and the import line so the pathname is controllable, and import `NAV_GROUPS`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar, NAV_GROUPS } from './sidebar';

// Controllable pathname so active-link behaviour can be exercised per test.
const { mockPath } = vi.hoisted(() => ({ mockPath: { value: '/explore' } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => mockPath.value,
}));
```

Reset the pathname in the existing `beforeEach`:

```tsx
beforeEach(() => {
  mockUser.role = 'admin';
  mockPath.value = '/explore';
});
```

Add these tests inside the existing `describe('Sidebar', …)` block:

```tsx
it('groups the AI pages under /ai, in order', () => {
  renderWithQueryClient(<Sidebar />);
  const expected: Array<[RegExp, string]> = [
    [/ask/i, '/ai/ask'],
    [/agents/i, '/ai/agents'],
    [/workflows/i, '/ai/workflows'],
    [/activity/i, '/ai/activity'],
    [/tools/i, '/ai/tools'],
    [/mcp access/i, '/ai/mcp'],
  ];
  for (const [name, href] of expected) {
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
  }
  const ai = NAV_GROUPS.find((g) => g.label === 'AI');
  expect(ai?.items.map((i) => i.href)).toEqual(expected.map(([, href]) => href));
});

it('places AI between Explore and Catalog', () => {
  expect(NAV_GROUPS.map((g) => g.label)).toEqual([
    undefined,
    'Explore',
    'AI',
    'Catalog',
    'Configure',
    'Operations',
    'Admin',
  ]);
});

it('no longer links to the pre-move routes', () => {
  renderWithQueryClient(<Sidebar />);
  const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
  expect(hrefs).not.toContain('/ask');
  expect(hrefs).not.toContain('/configure/mcp');
  expect(hrefs).not.toContain('/admin/agent-activity');
});

it('shows the AI group to members, not only admins', () => {
  mockUser.role = 'member';
  renderWithQueryClient(<Sidebar />);
  expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /mcp access/i })).toBeInTheDocument();
});

it('highlights the AI entry for a nested AI path', () => {
  mockPath.value = '/ai/agents/abc123';
  renderWithQueryClient(<Sidebar />);
  expect(screen.getByRole('link', { name: /agents/i }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: /ask/i }).getAttribute('aria-current')).toBeNull();
});

it('gives every entry in a group its own icon, so a collapsed group is readable', () => {
  for (const group of NAV_GROUPS) {
    const glyphs = group.items.map((i) => i.glyph);
    expect(new Set(glyphs).size, `duplicate glyph in group ${group.label ?? 'top'}`).toBe(
      glyphs.length,
    );
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/layout/sidebar.test.tsx`
Expected: FAIL — `NAV_GROUPS` is not exported from `./sidebar`.

- [ ] **Step 3: Rewrite the nav groups**

In `packages/web-ui/src/components/layout/sidebar.tsx`, replace the `const navGroups: NavGroup[] = [ … ];` block (lines 28–76) with:

```tsx
export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    items: [{ label: 'Home', href: '/', glyph: 'home' }],
  },
  {
    label: 'Explore',
    items: [
      { label: 'Graph Explorer', href: '/explore', glyph: 'graph' },
      { label: 'Query Playground', href: '/explore/query', glyph: 'cmd' },
    ],
  },
  {
    // Everything AI lives here: our own agents (Ask, Agents, Workflows,
    // Activity, Tools) and the surface for other people's (MCP Access).
    // 'Soon' marks entries whose page is still a placeholder.
    label: 'AI',
    items: [
      { label: 'Ask', href: '/ai/ask', glyph: 'ask' },
      { label: 'Agents', href: '/ai/agents', glyph: 'bot', badge: 'Soon' },
      { label: 'Workflows', href: '/ai/workflows', glyph: 'workflow', badge: 'Soon' },
      { label: 'Activity', href: '/ai/activity', glyph: 'activity', badge: 'Soon' },
      { label: 'Tools', href: '/ai/tools', glyph: 'package', badge: 'Soon' },
      // 'server', not 'sparkle': 'ask' and 'sparkle' are the same icon, and a
      // collapsed group must show distinct icons.
      { label: 'MCP Access', href: '/ai/mcp', glyph: 'server' },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { label: 'Entities', href: '/catalog', glyph: 'document' },
      { label: 'Team Dashboard', href: '/catalog/teams', glyph: 'person' },
    ],
  },
  {
    label: 'Configure',
    items: [
      { label: 'Connector Hub', href: '/connectors', glyph: 'bolt' },
      { label: 'Schema Editor', href: '/configure/schema', glyph: 'schema' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Incident Mode', href: '/incidents', glyph: 'incident' },
      { label: 'Claim Explorer', href: '/operations/claims', glyph: 'check' },
      {
        label: 'Reconciliation',
        href: '/operations/reconciliation',
        glyph: 'graph',
      },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Audit Log', href: '/admin/audit', glyph: 'file' },
      { label: 'Access Control', href: '/admin/access', glyph: 'shield' },
      { label: 'Settings', href: '/admin/settings', glyph: 'settings', adminOnly: true },
    ],
  },
];
```

Then update the two things that referred to the old name. In `Sidebar()`:

```tsx
const decoratedGroups = NAV_GROUPS.map((g) => ({
```

(the rest of that expression is unchanged).

One existing group already repeated an icon before this change, which the new uniqueness test catches: Admin had `settings` on both Access Control and Settings. The block above fixes it by giving Access Control `shield` (verified present in `@ship-it-ui/icons`, as are `bot`, `workflow`, `activity`, `package` and `server`). Operations uses `graph` for Reconciliation while Explore uses it for Graph Explorer; those are different groups, so the test allows it.

- [ ] **Step 4: Run the sidebar tests to verify they pass**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/layout/sidebar.test.tsx`
Expected: PASS, 11 tests (5 existing + 6 new).

- [ ] **Step 5: Write the failing breadcrumb test**

Create `packages/web-ui/src/components/layout/header.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/components/layout/user-menu', () => ({ UserMenu: () => null }));

import { trailFor } from './header';

describe('trailFor', () => {
  it('names every AI page under an AI section', () => {
    const pages: Record<string, string> = {
      '/ai/ask': 'Ask',
      '/ai/agents': 'Agents',
      '/ai/workflows': 'Workflows',
      '/ai/activity': 'Activity',
      '/ai/tools': 'Tools',
      '/ai/mcp': 'MCP Access',
    };
    for (const [path, page] of Object.entries(pages)) {
      expect(trailFor(path)).toEqual({ section: { label: 'AI' }, page });
    }
  });

  it('has no trail left for the pre-move routes', () => {
    expect(trailFor('/ask')).toEqual({ page: 'Ask' });
    expect(trailFor('/admin/agent-activity')).toEqual({ page: 'Admin' });
  });

  it('still falls back to the capitalised first segment for unknown paths', () => {
    expect(trailFor('/catalog/abc')).toEqual({ page: 'Catalog' });
    expect(trailFor('/')).toEqual({ page: 'Home' });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/layout/header.test.tsx`
Expected: FAIL — `trailFor` is not exported from `./header`.

- [ ] **Step 7: Update the breadcrumb table and the two in-app links**

In `packages/web-ui/src/components/layout/header.tsx`, remove these two lines from `TRAILS`:

```ts
  '/ask': { section: { label: 'Explore' }, page: 'Ask' },
```

```ts
  '/admin/agent-activity': { section: { label: 'Admin' }, page: 'Agent Activity' },
```

add these six after the `/explore/query` line:

```ts
  '/ai/ask': { section: { label: 'AI' }, page: 'Ask' },
  '/ai/agents': { section: { label: 'AI' }, page: 'Agents' },
  '/ai/workflows': { section: { label: 'AI' }, page: 'Workflows' },
  '/ai/activity': { section: { label: 'AI' }, page: 'Activity' },
  '/ai/tools': { section: { label: 'AI' }, page: 'Tools' },
  '/ai/mcp': { section: { label: 'AI' }, page: 'MCP Access' },
```

and export the lookup:

```ts
export function trailFor(pathname: string): Trail {
```

In `packages/web-ui/src/components/dashboard/quick-actions.tsx`, change line 35:

```tsx
          onClick={() => router.push('/ai/ask')}
```

In `packages/web-ui/src/components/settings/api-keys-tab.tsx`, change line 75:

```tsx
<a href="/ai/mcp">Open MCP Access</a>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/layout`
Expected: PASS — `sidebar.test.tsx`, `header.test.tsx`, `placeholder-page.test.tsx`, `theme-toggle.test.tsx`.

Then confirm no in-app reference to an old path remains:

```bash
grep -rnE "'/ask'|\"/ask\"|/configure/mcp|/admin/agent-activity" packages/web-ui/src packages/web-ui/next.config.mjs
```

Expected: only the three `it('…')` assertions in `sidebar.test.tsx`, `header.test.tsx` and `legacy-redirects.test.ts` that name the old paths on purpose. `legacy-redirects.mjs` is the one non-test file allowed to contain them.

- [ ] **Step 9: Verify and commit**

```bash
npx prettier --write packages/web-ui/src/components/layout packages/web-ui/src/components/dashboard/quick-actions.tsx packages/web-ui/src/components/settings/api-keys-tab.tsx
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git checkout -- packages/web-ui/next-env.d.ts
git add packages/web-ui
git commit -m "web-ui: AI nav group, breadcrumbs and in-app links for the /ai routes"
```

---

## Task 3: Docs and comments that name the old paths

**Files:**

- Modify: `docs/mcp-tools.md:3`
- Modify: `docs/architecture.md:233`, `docs/architecture.md:248`
- Modify: `packages/api-server/src/routes/mcp.ts:5`
- Modify: `packages/api-server/src/server.ts:428`
- Modify: `packages/api-server/src/middleware/require-auth.ts:47`
- Modify: `packages/mcp-server/src/tools/metadata.ts:3`
- Modify: `docs/agent/plans/ai-agents-and-workflows.md` (Status section)

**Interfaces:**

- Consumes: the routes from Tasks 1–2.
- Produces: nothing other tasks use.

- [ ] **Step 1: Update the user-facing docs**

`docs/mcp-tools.md`, line 3 — the nav group and the path both change. The line becomes:

```markdown
> **In the app:** AI → MCP Access (`/ai/mcp`) surfaces the connection snippets and tool catalog in a copy-paste friendly form. This doc is the canonical reference for parameters and response shapes.
```

`docs/architecture.md`, line 233 becomes:

```markdown
- `/api/mcp` — MCP server metadata for the in-app `/ai/mcp` page
```

`docs/architecture.md`, line 248 — replace `` `/configure/mcp` page `` with `` `/ai/mcp` page ``; the rest of the sentence is unchanged.

- [ ] **Step 2: Update the four code comments**

These are comments only; no behaviour changes.

`packages/api-server/src/routes/mcp.ts:5`:

```ts
// Runtime metadata about the MCP server, fetched by /ai/mcp.
```

`packages/api-server/src/server.ts:428`:

```ts
// /ai/mcp page; also useful for future CLI/plugin discovery.
```

`packages/api-server/src/middleware/require-auth.ts:47` — replace `/configure/mcp` with `/ai/mcp` in that comment line.

`packages/mcp-server/src/tools/metadata.ts:3` — replace `/configure/mcp` with `/ai/mcp` in that comment line.

- [ ] **Step 3: Confirm nothing outside history still points at the old paths**

```bash
grep -rnE "/configure/mcp|/admin/agent-activity" --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.md" . \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.git \
  | grep -v "^./docs/agent/" | grep -v "^./docs/superpowers/" | grep -v "^./ClaudePlans/"
```

Expected: only `packages/web-ui/legacy-redirects.mjs` and the three test files from Tasks 1–2. Notes under `docs/agent/`, `docs/superpowers/` and `ClaudePlans/` describe the past and are left as written; the redirects keep their links working.

- [ ] **Step 4: Record the milestone in the plan note**

In `docs/agent/plans/ai-agents-and-workflows.md`, append to the Status section:

```markdown
**Milestone 0 (AI nav) implemented** per `docs/superpowers/plans/2026-10-01-ai-nav-section.md`:
routes moved under `/ai`, redirects in `packages/web-ui/legacy-redirects.mjs`, three
placeholder pages (Agents, Workflows, Tools) until their milestones land.
```

- [ ] **Step 5: Verify and commit**

```bash
npx prettier --write docs/mcp-tools.md docs/architecture.md docs/agent/plans/ai-agents-and-workflows.md packages/api-server/src/routes/mcp.ts packages/api-server/src/server.ts packages/api-server/src/middleware/require-auth.ts packages/mcp-server/src/tools/metadata.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
git add docs packages/api-server packages/mcp-server
git commit -m "docs: point MCP Access references at /ai/mcp"
```

---

## Self-review notes

- **Spec coverage (§Web UI → Nav, Milestone 0):** group and order (Task 2), six routes (Task 1), redirects from `/ask`, `/configure/mcp`, `/admin/agent-activity` (Task 1), `header.tsx` `TRAILS`, quick action, API Keys link (Task 2), `docs/mcp-tools.md` and `docs/architecture.md` (Task 3). The Activity badge for pending approvals and the real pages belong to later milestones.
- **One deviation from the spec's nav table:** MCP Access uses the `server` icon instead of keeping `sparkle`, because `ask` and `sparkle` are the same icon and the two entries now share a group (Review Focus 4).
- **One addition:** a temporary `/ai` → `/ai/ask` redirect, so the bare section path is not a 404 (Review Focus 2).
- **Not in scope:** breadcrumbs for nested AI pages (`/ai/agents/<id>`). No such page exists until the next plan, which adds prefix matching to `trailFor` along with the page.
