'use client';

import { useRouter } from 'next/navigation';
import { Badge, Card } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { TeamSummary } from '@/lib/api';

export interface TeamSummaryCardProps {
  team: TeamSummary;
}

export function TeamSummaryCard({ team }: TeamSummaryCardProps) {
  const router = useRouter();
  return (
    <Card
      interactive
      onClick={() => router.push(`/catalog/teams/${encodeURIComponent(team.id)}`)}
      className="cursor-pointer"
    >
      <div className="flex flex-col gap-3">
        <header className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-text text-[14px] font-semibold tracking-tight">{team.name}</span>
            <span className="text-text-dim font-mono text-[10px]">{team.slug}</span>
          </div>
          <Badge size="sm" variant="purple" icon={<IconGlyph name="person" size={10} />}>
            team
          </Badge>
        </header>
        {team.description && (
          <p className="text-text-muted line-clamp-2 text-[12px]">{team.description}</p>
        )}
        <dl className="text-text-muted m-0 grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="owns" value={team.ownedCount} />
          <Stat label="members" value={team.memberCount} />
          <Stat label="on-call" value={team.onCallCount} />
        </dl>
        {team.email && (
          <a
            href={`mailto:${team.email}`}
            onClick={(e) => e.stopPropagation()}
            className="text-text-dim hover:text-accent inline-flex items-center gap-1 text-[11px]"
          >
            <IconGlyph name="mention" size={10} /> {team.email}
          </a>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border bg-panel-2 flex flex-col items-start rounded-xs border px-2 py-1">
      <span className="text-text font-mono text-[14px] tabular-nums">{value}</span>
      <span className="text-text-dim text-[10px]">{label}</span>
    </div>
  );
}
