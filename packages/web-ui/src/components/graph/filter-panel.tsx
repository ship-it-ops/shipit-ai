'use client';

import { Button, Card, Checkbox, Tag } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useGraphStore, type GraphFilters } from '@/stores/graph-store';

const nodeLabels = [
  'LogicalService',
  'Repository',
  'Deployment',
  'RuntimeService',
  'Team',
  'Person',
  'Pipeline',
  'Monitor',
];

const environments = ['production', 'staging', 'dev'];
const tiers = ['1', '2', '3'];
const owners = ['payments-team', 'platform-team', 'identity-team', 'sre-team', 'comms-team'];

interface FilterGroupProps {
  title: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

function FilterGroup({ title, options, selected, onChange }: FilterGroupProps) {
  const toggle = (option: string) => {
    if (selected.includes(option)) onChange(selected.filter((s) => s !== option));
    else onChange([...selected, option]);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-dim font-mono text-[9px] tracking-[1.4px] uppercase">{title}</div>
      <div className="flex flex-col gap-[6px]">
        {options.map((option) => (
          <Checkbox
            key={option}
            checked={selected.includes(option)}
            onCheckedChange={() => toggle(option)}
            label={option}
          />
        ))}
      </div>
    </div>
  );
}

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
}

export function FilterPanel({ open, onClose }: FilterPanelProps) {
  const { filters, setFilters, resetFilters } = useGraphStore();
  if (!open) return null;

  const activeChips: { key: keyof GraphFilters; value: string }[] = [
    ...filters.nodeLabels.map((value) => ({ key: 'nodeLabels' as const, value })),
    ...filters.environments.map((value) => ({ key: 'environments' as const, value })),
    ...filters.tiers.map((value) => ({ key: 'tiers' as const, value: `T${value}` })),
    ...filters.owners.map((value) => ({ key: 'owners' as const, value })),
  ];

  const removeChip = (key: keyof GraphFilters, value: string) => {
    const cleaned = value.startsWith('T') ? value.slice(1) : value;
    setFilters({ [key]: filters[key].filter((v) => v !== cleaned) } as Partial<GraphFilters>);
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

      <div className="flex flex-col gap-5 p-4">
        {activeChips.length > 0 && (
          <Card variant="ghost" className="p-0">
            <div className="flex flex-wrap gap-1">
              {activeChips.map((c) => (
                <Tag key={`${c.key}:${c.value}`} onRemove={() => removeChip(c.key, c.value)}>
                  {c.value}
                </Tag>
              ))}
            </div>
            <Button variant="link" size="sm" onClick={resetFilters} className="mt-2 px-0">
              Clear all
            </Button>
          </Card>
        )}

        <FilterGroup
          title="Node Labels"
          options={nodeLabels}
          selected={filters.nodeLabels}
          onChange={(nodeLabels) => setFilters({ nodeLabels })}
        />
        <FilterGroup
          title="Environment"
          options={environments}
          selected={filters.environments}
          onChange={(environments) => setFilters({ environments })}
        />
        <FilterGroup
          title="Tier"
          options={tiers}
          selected={filters.tiers}
          onChange={(tiers) => setFilters({ tiers })}
        />
        <FilterGroup
          title="Owner"
          options={owners}
          selected={filters.owners}
          onChange={(owners) => setFilters({ owners })}
        />
      </div>
    </aside>
  );
}
