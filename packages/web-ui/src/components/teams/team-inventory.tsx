'use client';

import { useRouter } from 'next/navigation';
import { Badge, Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { TeamOwnedEntity } from '@/lib/api';

export interface TeamInventoryProps {
  title: string;
  entities: TeamOwnedEntity[];
  glyph: string;
}

function tierVariant(tier: number | null) {
  if (tier === 1) return 'err' as const;
  if (tier === 2) return 'warn' as const;
  if (tier === 3) return 'neutral' as const;
  return 'neutral' as const;
}

export function TeamInventory({ title, entities, glyph }: TeamInventoryProps) {
  const router = useRouter();

  return (
    <Card title={`${title} (${entities.length})`}>
      {entities.length === 0 ? (
        <EmptyState
          icon={<IconGlyph name={glyph} size={18} />}
          title="None"
          description={`This team doesn't own any ${title.toLowerCase()} yet.`}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entities.map((e) => (
            <li
              key={e.id}
              onClick={() => router.push(`/catalog/${encodeURIComponent(e.id)}`)}
              className="border-border bg-panel hover:bg-panel-2 flex cursor-pointer items-center gap-2 rounded-xs border px-2 py-1.5 text-[12px]"
            >
              <IconGlyph name={glyph} size={12} />
              <span className="text-text flex-1 truncate font-medium">{e.name}</span>
              {e.environment && (
                <Badge size="sm" variant="neutral">
                  {e.environment}
                </Badge>
              )}
              {e.tier !== null && (
                <Badge size="sm" variant={tierVariant(e.tier)}>
                  T{e.tier}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
