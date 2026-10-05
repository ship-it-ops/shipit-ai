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

// Controllable identity so we can exercise the admin-only Settings nav item.
const { mockUser } = vi.hoisted(() => ({ mockUser: { role: 'admin' } }));
vi.mock('@/lib/current-user', () => ({ useCurrentUser: () => mockUser }));

// The Sidebar polls `/api/reconciliation/stats` to surface the pending-merge
// count as a badge. Stub the fetch so tests don't hit the network and don't
// need an API server running.
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ pending: 0, recentMerges: 0, lastScanAt: null }),
  }),
);

function renderWithQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('Sidebar', () => {
  beforeEach(() => {
    mockUser.role = 'admin';
    mockPath.value = '/explore';
  });

  it('renders all top-level nav items', () => {
    renderWithQueryClient(<Sidebar />);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /graph explorer/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ask/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /connector hub/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /incident mode/i })).toBeInTheDocument();
  });

  it('marks the current pathname as the active link', () => {
    renderWithQueryClient(<Sidebar />);
    const explore = screen.getByRole('link', { name: /graph explorer/i });
    expect(explore.getAttribute('aria-current')).toBe('page');
  });

  it('renders the brand mark', () => {
    renderWithQueryClient(<Sidebar />);
    expect(screen.getByText('ShipIt-AI')).toBeInTheDocument();
  });

  it('shows the admin Settings nav item for admins', () => {
    renderWithQueryClient(<Sidebar />);
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('hides the admin Settings nav item for non-admins', () => {
    mockUser.role = 'member';
    renderWithQueryClient(<Sidebar />);
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });

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
});
