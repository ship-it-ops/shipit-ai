'use client';

import { useMemo } from 'react';
import { FilterPanel as DSFilterPanel, type FilterPanelValue } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import type { GraphData } from '@/lib/api';
import { useGraphStore, type GraphFilters } from '@/stores/graph-store';

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
  /** Graph data drives the available filter options. */
  data?: GraphData;
}

function uniqueSorted(values: ReadonlyArray<string>): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

export function FilterPanel({ open, onClose, data }: FilterPanelProps) {
  const { filters, setFilters, resetFilters } = useGraphStore();

  const { facets, counts } = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const labels: string[] = [];
    const environments: string[] = [];
    const tiers: string[] = [];
    const owners: string[] = [];
    const c: Record<string, Record<string, number>> = {
      nodeLabels: {},
      environments: {},
      tiers: {},
      owners: {},
    };

    for (const node of nodes) {
      const d = node.data;
      const label = typeof d.type === 'string' ? d.type : '';
      const env = typeof d.environment === 'string' ? d.environment : '';
      const tier = d.tier !== undefined && d.tier !== null ? String(d.tier) : '';
      // Owners come from two sources. Seeded LogicalServices carry a flat
      // `owner` string. GitHub-connected data encodes ownership as
      // `CODEOWNER_OF` edges from Team/Person nodes — so for the user-facing
      // facet we also surface those nodes' names. Without this the Owner
      // filter is empty on any graph populated from real GitHub data.
      const ownerProp = typeof d.owner === 'string' ? d.owner : '';
      const nodeName = typeof d.name === 'string' ? d.name : '';
      if (label) {
        labels.push(label);
        c.nodeLabels[label] = (c.nodeLabels[label] ?? 0) + 1;
      }
      if (env) {
        environments.push(env);
        c.environments[env] = (c.environments[env] ?? 0) + 1;
      }
      if (tier) {
        tiers.push(tier);
        c.tiers[tier] = (c.tiers[tier] ?? 0) + 1;
      }
      if (ownerProp) {
        owners.push(ownerProp);
        c.owners[ownerProp] = (c.owners[ownerProp] ?? 0) + 1;
      }
      if ((label === 'Team' || label === 'Person') && nodeName) {
        owners.push(nodeName);
        c.owners[nodeName] = (c.owners[nodeName] ?? 0) + 1;
      }
    }

    return {
      facets: [
        {
          id: 'nodeLabels',
          label: 'Node labels',
          options: uniqueSorted(labels).map((v) => {
            const meta = getEntityTypeMeta(v);
            return { value: v, label: meta?.label ?? v };
          }),
        },
        {
          id: 'environments',
          label: 'Environment',
          options: uniqueSorted(environments).map((v) => ({ value: v, label: v })),
        },
        {
          id: 'tiers',
          label: 'Tier',
          options: uniqueSorted(tiers).map((v) => ({ value: v, label: `T${v}` })),
        },
        {
          id: 'owners',
          label: 'Owner',
          options: uniqueSorted(owners).map((v) => ({ value: v, label: v })),
        },
      ] as const,
      counts: c,
    };
  }, [data]);

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
          counts={counts}
          onValueChange={handleChange}
          onReset={resetFilters}
          title="Refine"
          className="w-full"
        />
      </div>
    </aside>
  );
}
