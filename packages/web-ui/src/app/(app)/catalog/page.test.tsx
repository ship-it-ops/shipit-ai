import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CatalogPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/catalog',
}));

const NODES = [
  { data: { id: 'svc:checkout', name: 'checkout', type: 'LogicalService' } },
  { data: { id: 'repo:web', name: 'web', type: 'Repository' } },
  { data: { id: 'pipe:deploy', name: 'deploy-pipeline', type: 'Pipeline' } },
];

vi.mock('@/lib/hooks/use-graph-data', () => ({
  useCatalogEntities: () => ({ data: { nodes: NODES, edges: [] }, isLoading: false, error: null }),
  useConnectorsList: () => ({ data: [] }),
}));

function renderCatalog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CatalogPage />
    </QueryClientProvider>,
  );
}

describe('CatalogPage — default Pipeline exclusion', () => {
  it('hides Pipeline entities by default but shows other types', () => {
    renderCatalog();
    expect(screen.getByText('checkout')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.queryByText('deploy-pipeline')).not.toBeInTheDocument();
  });

  it('surfaces a hint that pipelines are hidden, with the count', () => {
    renderCatalog();
    expect(screen.getByText(/hidden · 1/)).toBeInTheDocument();
  });

  it('renders Pipeline in the tri-state Type control in the exclude (hidden) state', () => {
    renderCatalog();
    // The excluded type's button carries the "clear" hint — unique to the
    // exclude state, so this confirms Pipeline is rendered as negated.
    expect(screen.getByTitle(/hidden · click to clear/i)).toBeInTheDocument();
  });

  it('clicking the excluded Pipeline type reveals its entities and clears the hint', async () => {
    const user = userEvent.setup();
    renderCatalog();
    expect(screen.queryByText('deploy-pipeline')).not.toBeInTheDocument();

    await user.click(screen.getByTitle(/hidden · click to clear/i));

    expect(screen.getByText('deploy-pipeline')).toBeInTheDocument();
    expect(screen.queryByText(/hidden · 1/)).not.toBeInTheDocument();
  });
});
