'use client';

import { useMemo } from 'react';
import { FilterPanel as DSFilterPanel, type FilterPanelValue } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useGraphStore, type GraphFilters } from '@/stores/graph-store';

const facets = [
  {
    id: 'nodeLabels',
    label: 'Node labels',
    options: [
      'LogicalService',
      'Repository',
      'Deployment',
      'RuntimeService',
      'Team',
      'Person',
      'Pipeline',
      'Monitor',
    ].map((value) => ({ value, label: value })),
  },
  {
    id: 'environments',
    label: 'Environment',
    options: ['production', 'staging', 'dev'].map((value) => ({ value, label: value })),
  },
  {
    id: 'tiers',
    label: 'Tier',
    options: ['1', '2', '3'].map((value) => ({ value, label: `T${value}` })),
  },
  {
    id: 'owners',
    label: 'Owner',
    options: ['payments-team', 'platform-team', 'identity-team', 'sre-team', 'comms-team'].map(
      (value) => ({ value, label: value }),
    ),
  },
] as const;

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
}

export function FilterPanel({ open, onClose }: FilterPanelProps) {
  const { filters, setFilters, resetFilters } = useGraphStore();

  const value = useMemo<FilterPanelValue>(
    () => ({
      nodeLabels: filters.nodeLabels,
      environments: filters.environments,
      tiers: filters.tiers,
      owners: filters.owners,
    }),
    [filters],
  );

  if (!open) return null;

  const handleChange = (next: FilterPanelValue) => {
    setFilters({
      nodeLabels: [...(next.nodeLabels ?? [])],
      environments: [...(next.environments ?? [])],
      tiers: [...(next.tiers ?? [])],
      owners: [...(next.owners ?? [])],
    } as Partial<GraphFilters>);
  };

  return (
    <aside className="border-border bg-panel w-72 shrink-0 overflow-y-auto border-r">
      <div className="border-border flex items-center justify-between border-b p-4">
        <span className="text-text inline-flex items-center gap-2 text-[13px] font-medium">
          <IconGlyph name="schema" size={14} />
          Filters
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          className="text-text-dim hover:text-text rounded-sm p-1 leading-none"
        >
          ×
        </button>
      </div>

      <div className="p-4">
        <DSFilterPanel
          facets={facets}
          value={value}
          onValueChange={handleChange}
          onReset={resetFilters}
          title="Refine"
          className="w-full"
        />
      </div>
    </aside>
  );
}
