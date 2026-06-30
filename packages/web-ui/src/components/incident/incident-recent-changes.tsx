'use client';

import { Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { EntityList, EntityListRowDiv, StalenessChip, type EntityType } from '@ship-it-ui/shipit';
import type { RecentChangeEntry } from '@/lib/incident/derivations';

interface Props {
  entries: RecentChangeEntry[];
}

/** Verb shown when we have a *real* event time, by change type. */
const CHANGE_VERB: Record<RecentChangeEntry['type'], string> = {
  Deployment: 'Deployed',
  Pipeline: 'Ran',
  BuildArtifact: 'Built',
};

/** Compact + full renderings of an ISO timestamp, or null if unparseable. */
function formatAbsolute(iso: string): { short: string; full: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return {
    short: d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    full: d.toLocaleString(),
  };
}

/** Seconds elapsed since an ISO timestamp, clamped at 0; undefined if unparseable. */
function ageSecondsFrom(iso: string): number | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

/**
 * "What changed?" panel — the FireHydrant Change Events analogue.
 *
 * Timeline honesty: each row shows an absolute timestamp so the IC can build
 * a real timeline, but we never dress up sync time as deploy time. When the
 * connector reports a true event time (`changedAt` — e.g. a pipeline's last
 * run), we show it with the matching verb ("Ran", "Deployed", "Built"). When
 * it doesn't, we fall back to `_last_synced` and keep the "Synced" label so
 * the IC knows it's "when we last saw it", not "when it shipped". Phase 1.5
 * wires a real CD connector so more rows carry first-class event times.
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

          // Prefer a real event time; fall back to the sync timestamp.
          const isRealTime = Boolean(entry.changedAt);
          const whenIso = entry.changedAt ?? entry.lastSynced;
          const abs = whenIso ? formatAbsolute(whenIso) : null;
          const prefix = isRealTime ? CHANGE_VERB[entry.type] : 'Synced';
          const ageSeconds = isRealTime
            ? whenIso
              ? ageSecondsFrom(whenIso)
              : undefined
            : entry.lastSyncedAgeSeconds;
          const tooltip = abs
            ? isRealTime
              ? `${prefix} · ${abs.full}`
              : `Last synced ${abs.full} — change time not reported by this connector`
            : undefined;

          return (
            <EntityListRowDiv
              key={entry.id}
              type={entry.type as EntityType}
              name={entry.name}
              meta={metaText}
              relation={
                abs ? (
                  <span className="flex items-center gap-2">
                    <time
                      dateTime={whenIso}
                      title={abs.full}
                      className="text-text-muted font-mono text-[11px] tabular-nums"
                    >
                      {abs.short}
                    </time>
                    {ageSeconds !== undefined && ageSeconds >= 0 ? (
                      <StalenessChip ageSeconds={ageSeconds} prefix={prefix} tooltip={tooltip} />
                    ) : null}
                  </span>
                ) : ageSeconds !== undefined && ageSeconds >= 0 ? (
                  <StalenessChip ageSeconds={ageSeconds} prefix={prefix} />
                ) : undefined
              }
            />
          );
        })}
      </EntityList>
    </Card>
  );
}
