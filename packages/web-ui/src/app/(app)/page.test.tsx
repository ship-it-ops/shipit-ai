import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HomePage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/lib/hooks/use-graph-stats', () => ({
  useGraphStats: () => ({
    data: {
      nodeCount: 1234,
      edgeCount: 5678,
      staleness: 12,
      lastSync: new Date(Date.now() - 60_000).toISOString(),
      healthScore: 92,
      nodesByLabel: {
        LogicalService: 10,
        RuntimeService: 5,
        Repository: 8,
        Deployment: 12,
        Team: 3,
      },
    },
  }),
}));

vi.mock('@/lib/hooks/use-connectors', () => ({
  useConnectors: () => ({ data: [{ id: '1', status: 'healthy' }] }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...orig,
    fetchActivity: vi.fn().mockResolvedValue([]),
  };
});

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HomePage />
    </QueryClientProvider>,
  );
}

describe('HomePage', () => {
  it('renders the overview heading', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1, name: /overview/i })).toBeInTheDocument();
  });

  it('renders the four StatCards with their labels', () => {
    renderHome();
    expect(screen.getByText(/services/i)).toBeInTheDocument();
    expect(screen.getByText(/repositories/i)).toBeInTheDocument();
    expect(screen.getByText(/deployments/i)).toBeInTheDocument();
    expect(screen.getByText(/^teams$/i)).toBeInTheDocument();
  });

  it('renders graph health, quick actions, activity feed, and getting started cards', () => {
    renderHome();
    expect(screen.getByText(/graph health/i)).toBeInTheDocument();
    expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    expect(screen.getByText(/recent activity/i)).toBeInTheDocument();
    expect(screen.getByText(/getting started/i)).toBeInTheDocument();
  });
});
