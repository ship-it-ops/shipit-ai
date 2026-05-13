import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterPanel } from './filter-panel';
import { useGraphStore } from '@/stores/graph-store';

describe('FilterPanel', () => {
  beforeEach(() => {
    useGraphStore.getState().resetFilters();
  });

  it('does not render when closed', () => {
    const { container } = render(<FilterPanel open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the four filter group headings when open', () => {
    render(<FilterPanel open={true} onClose={vi.fn()} />);
    expect(screen.getByText(/node labels/i)).toBeInTheDocument();
    expect(screen.getByText(/environment/i)).toBeInTheDocument();
    expect(screen.getByText(/tier/i)).toBeInTheDocument();
    expect(screen.getByText(/owner/i)).toBeInTheDocument();
  });

  it('toggling a checkbox updates the graph store filters', async () => {
    const user = userEvent.setup();
    render(<FilterPanel open={true} onClose={vi.fn()} />);

    const productionLabel = screen.getByText('production');
    await user.click(productionLabel);

    expect(useGraphStore.getState().filters.environments).toContain('production');
  });
});
