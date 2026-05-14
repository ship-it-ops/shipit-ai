import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './sidebar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/explore',
}));

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
});
