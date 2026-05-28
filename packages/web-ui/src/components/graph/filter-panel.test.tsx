import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { FilterPanel } from './filter-panel';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

const sampleData: GraphData = {
  nodes: [
    {
      data: {
        id: 'svc:checkout',
        label: 'Checkout',
        name: 'Checkout',
        type: 'LogicalService',
        environment: 'production',
        tier: 1,
        owner: 'payments',
      },
    },
    {
      data: {
        id: 'svc:billing',
        label: 'Billing',
        name: 'Billing',
        type: 'LogicalService',
        environment: 'staging',
        tier: 2,
        owner: 'finance',
      },
    },
    {
      data: {
        id: 'repo:checkout',
        label: 'checkout-repo',
        name: 'checkout-repo',
        type: 'Repository',
        owner: 'payments',
      },
    },
  ],
  edges: [],
};

function withQueryClient(ui: ReactNode) {
  // No-retry client keeps tests deterministic when the inner React Query
  // hooks try (and fail) to fetch /api/graph/sources + /api/connectors.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe('FilterPanel', () => {
  beforeEach(() => {
    useGraphStore.getState().resetFilters();
  });

  it('does not render when closed', () => {
    const { container } = render(
      withQueryClient(<FilterPanel open={false} onClose={vi.fn()} data={sampleData} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the filter group headings when open', () => {
    render(withQueryClient(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />));
    expect(screen.getByText(/node labels/i)).toBeInTheDocument();
    expect(screen.getByText(/environment/i)).toBeInTheDocument();
    expect(screen.getByText(/tier/i)).toBeInTheDocument();
    expect(screen.getByText(/owner/i)).toBeInTheDocument();
  });

  it('derives owner options from the graph data, not from a hardcoded list', () => {
    render(withQueryClient(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />));
    expect(screen.getByText('payments')).toBeInTheDocument();
    expect(screen.getByText('finance')).toBeInTheDocument();
    // Old hardcoded values must no longer leak through.
    expect(screen.queryByText('payments-team')).not.toBeInTheDocument();
    expect(screen.queryByText('platform-team')).not.toBeInTheDocument();
  });

  it('exposes a Source facet (populated from /api/graph/sources)', () => {
    render(withQueryClient(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />));
    // Heading renders even when /api/graph/sources hasn't returned yet; the
    // option list is filled in once the query resolves.
    expect(screen.getByText(/^source$/i)).toBeInTheDocument();
  });

  it('toggling a checkbox updates the graph store filters', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />));

    const productionLabel = screen.getByText('production');
    await user.click(productionLabel);

    expect(useGraphStore.getState().filters.environments).toContain('production');
  });

  // Mirrors the GitHub-connector reality: Repository nodes don't carry an
  // `owner` string. Ownership lives in CODEOWNER_OF edges from Team / Person
  // nodes. The Owner facet must surface those node names so the filter isn't
  // empty on a GitHub-only graph.
  it('derives owner options from Team and Person nodes (no `d.owner` needed)', () => {
    const githubLikeData: GraphData = {
      nodes: [
        {
          data: {
            id: 'Team::default::shipitops/platform',
            label: 'platform-team',
            name: 'platform-team',
            type: 'Team',
          },
        },
        {
          data: {
            id: 'Person::default::mohamed',
            label: 'mohamed',
            name: 'mohamed',
            type: 'Person',
          },
        },
        {
          data: {
            id: 'Repository::default::shipitops/web',
            label: 'web',
            name: 'web',
            type: 'Repository',
          },
        },
      ],
      edges: [
        {
          data: {
            id: 'e1',
            source: 'Team::default::shipitops/platform',
            target: 'Repository::default::shipitops/web',
            type: 'CODEOWNER_OF',
          },
        },
      ],
    };
    render(withQueryClient(<FilterPanel open={true} onClose={vi.fn()} data={githubLikeData} />));
    expect(screen.getByText('platform-team')).toBeInTheDocument();
    expect(screen.getByText('mohamed')).toBeInTheDocument();
  });
});
