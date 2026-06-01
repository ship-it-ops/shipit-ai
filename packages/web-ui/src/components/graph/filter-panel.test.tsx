import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('FilterPanel', () => {
  beforeEach(() => {
    useGraphStore.getState().resetFilters();
  });

  it('does not render when closed', () => {
    const { container } = render(<FilterPanel open={false} onClose={vi.fn()} data={sampleData} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the four filter group headings when open', () => {
    render(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />);
    expect(screen.getByText(/node labels/i)).toBeInTheDocument();
    expect(screen.getByText(/environment/i)).toBeInTheDocument();
    expect(screen.getByText(/tier/i)).toBeInTheDocument();
    expect(screen.getByText(/owner/i)).toBeInTheDocument();
  });

  it('derives owner options from the graph data, not from a hardcoded list', () => {
    render(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />);
    expect(screen.getByText('payments')).toBeInTheDocument();
    expect(screen.getByText('finance')).toBeInTheDocument();
    // Old hardcoded values must no longer leak through.
    expect(screen.queryByText('payments-team')).not.toBeInTheDocument();
    expect(screen.queryByText('platform-team')).not.toBeInTheDocument();
  });

  it('toggling a checkbox updates the graph store filters', async () => {
    const user = userEvent.setup();
    render(<FilterPanel open={true} onClose={vi.fn()} data={sampleData} />);

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
    render(<FilterPanel open={true} onClose={vi.fn()} data={githubLikeData} />);
    expect(screen.getByText('platform-team')).toBeInTheDocument();
    expect(screen.getByText('mohamed')).toBeInTheDocument();
  });
});
