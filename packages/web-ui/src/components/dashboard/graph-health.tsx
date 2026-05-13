'use client';

import { Card, HealthScore, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useGraphStats } from '@/lib/hooks/use-graph-stats';

export function GraphHealth() {
  const { data: stats } = useGraphStats();
  const healthScore = stats?.healthScore ?? 0;
  const staleness = stats?.staleness ?? 0;

  return (
    <Card title="Graph Health">
      <div className="flex items-center gap-6">
        <HealthScore
          value={healthScore}
          size={88}
          label="Overall"
          breakdown={[
            { label: 'Nodes', value: stats?.nodeCount ?? 0 },
            { label: 'Edges', value: stats?.edgeCount ?? 0 },
            { label: 'Staleness', value: staleness, tone: staleness > 25 ? 'warn' : 'ok' },
          ]}
        />
        <dl className="flex-1 space-y-2 text-[13px]">
          <Row glyph="schema" label="Nodes" value={(stats?.nodeCount ?? 0).toLocaleString()} />
          <Row glyph="graph" label="Edges" value={(stats?.edgeCount ?? 0).toLocaleString()} />
          <Row glyph="refresh" label="Staleness" value={`${staleness}%`} />
          <Row
            glyph="live"
            label="Last Sync"
            value={stats?.lastSync ? formatRelative(stats.lastSync) : 'Never'}
          />
        </dl>
      </div>
    </Card>
  );
}

function Row({ glyph, label, value }: { glyph: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-text-muted inline-flex items-center gap-2">
        <IconGlyph name={glyph} size={12} />
        {label}
      </dt>
      <dd className="text-text font-mono tabular-nums">{value}</dd>
    </div>
  );
}
