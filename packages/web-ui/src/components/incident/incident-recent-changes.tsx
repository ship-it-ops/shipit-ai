'use client';

import { Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import type { RecentChangeEntry } from '@/lib/incident/derivations';
import { StalenessChip } from './staleness-chip';

interface Props {
  entries: RecentChangeEntry[];
}

/**
 * "What changed?" panel — the FireHydrant Change Events analogue.
 *
 * Honesty constraint: we sort by `_last_synced` (when the connector saw the
 * deployment), not by deployment timestamp. We label timestamps as "synced"
 * not "deployed" so the IC isn't misled. Phase 1.5 wires a real CD
 * connector with first-class timestamps; until then this is the best
 * proxy the catalog has.
 */
export function IncidentRecentChanges({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <Card title="Recent changes">
        <EmptyState
          icon={<IconGlyph name="bolt" size={20} />}
          title="No recent changes"
          description="No deployments, pipelines, or build artifacts visible in the depth-1 neighborhood."
        />
      </Card>
    );
  }

  return (
    <Card title={`Recent changes · ${entries.length}`}>
      <ul className="m-0 flex flex-col p-0">
        {entries.map((entry, i) => {
          const meta = getEntityTypeMeta(entry.type);
          return (
            <li
              key={entry.id}
              className={
                'flex items-center gap-3 py-2 text-[12px] ' +
                (i > 0 ? 'border-border border-t' : '')
              }
            >
              <span
                aria-hidden
                className={`grid h-6 w-6 place-items-center rounded-xs text-[12px] ${meta.toneBg} ${meta.toneClass}`}
              >
                {meta.glyph}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-text truncate font-medium">{entry.name}</span>
                <span className="text-text-dim font-mono text-[10px]">
                  {entry.type}
                  {entry.environment ? ` · ${entry.environment}` : ''}
                  {entry.status ? ` · ${entry.status}` : ''}
                </span>
              </div>
              <StalenessChip ageSeconds={entry.lastSyncedAgeSeconds} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
