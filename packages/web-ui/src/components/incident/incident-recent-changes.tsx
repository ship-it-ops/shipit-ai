'use client';

import { Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { EntityList, EntityListRowDiv, StalenessChip, type EntityType } from '@ship-it-ui/shipit';
import type { RecentChangeEntry } from '@/lib/incident/derivations';

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
      <EntityList framed={false}>
        {entries.map((entry) => {
          const metaText = [entry.type, entry.environment, entry.status]
            .filter(Boolean)
            .join(' · ');
          return (
            <EntityListRowDiv
              key={entry.id}
              type={entry.type as EntityType}
              name={entry.name}
              meta={metaText}
              relation={
                entry.lastSyncedAgeSeconds !== undefined && entry.lastSyncedAgeSeconds >= 0 ? (
                  <StalenessChip ageSeconds={entry.lastSyncedAgeSeconds} prefix="Synced" />
                ) : undefined
              }
            />
          );
        })}
      </EntityList>
    </Card>
  );
}
