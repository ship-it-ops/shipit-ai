'use client';

import { StatCard } from '@ship-it-ui/ui';
import { type GlyphName, IconGlyph } from '@ship-it-ui/icons';
import { useGraphStats } from '@/lib/hooks/use-graph-stats';

interface StatRow {
  label: string;
  value: number;
  glyph: GlyphName;
}

export function StatsCards() {
  const { data: stats } = useGraphStats();
  const byLabel = stats?.nodesByLabel ?? {};

  const rows: StatRow[] = [
    {
      label: 'Services',
      value: (byLabel.LogicalService ?? 0) + (byLabel.RuntimeService ?? 0),
      glyph: 'service',
    },
    { label: 'Repositories', value: byLabel.Repository ?? 0, glyph: 'document' },
    { label: 'Deployments', value: byLabel.Deployment ?? 0, glyph: 'bolt' },
    { label: 'Teams', value: byLabel.Team ?? 0, glyph: 'person' },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {rows.map((row) => (
        <StatCard
          key={row.label}
          label={row.label}
          value={row.value.toLocaleString()}
          icon={<IconGlyph name={row.glyph} />}
        />
      ))}
    </div>
  );
}
