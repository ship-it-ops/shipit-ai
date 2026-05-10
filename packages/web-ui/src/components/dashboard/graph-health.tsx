'use client';

import { Card, RadialProgress, type RadialTone } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useGraphStats } from '@/lib/hooks/use-graph-stats';

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function toneFor(score: number): RadialTone {
  if (score >= 90) return 'ok';
  if (score >= 70) return 'warn';
  return 'err';
}

export function GraphHealth() {
  const { data: stats } = useGraphStats();
  const healthScore = stats?.healthScore ?? 0;

  return (
    <Card title="Graph Health">
      <div className="flex items-center gap-6">
        <RadialProgress value={healthScore} size={88} thickness={6} tone={toneFor(healthScore)}>
          <span className="font-mono text-[18px] font-medium tabular-nums">{healthScore}%</span>
        </RadialProgress>
        <dl className="flex-1 space-y-2 text-[13px]">
          <Row glyph="schema" label="Nodes" value={(stats?.nodeCount ?? 0).toLocaleString()} />
          <Row glyph="graph" label="Edges" value={(stats?.edgeCount ?? 0).toLocaleString()} />
          <Row glyph="refresh" label="Staleness" value={`${stats?.staleness ?? 0}%`} />
          <Row
            glyph="live"
            label="Last Sync"
            value={stats?.lastSync ? formatRelativeTime(stats.lastSync) : 'Never'}
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
