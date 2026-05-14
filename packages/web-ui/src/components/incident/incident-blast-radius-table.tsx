'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { EntityListRowButton, type EntityType } from '@ship-it-ui/shipit';
import { BlastRadiusDialog } from '@/components/blast-radius-dialog';
import {
  type BlastRadiusEntry,
  blastRadiusSummary,
  rankedBlastRadius,
} from '@/lib/incident/derivations';
import type { GraphData } from '@/lib/api';

interface Props {
  serviceId: string;
  serviceName: string | undefined;
  blast: GraphData | undefined;
  loading?: boolean;
  error?: Error | null;
  truncated?: boolean;
}

const INLINE_LIMIT = 10;

/**
 * The hero panel — the question PagerDuty/Datadog can't answer because
 * they don't have the catalog graph. Renders as a ranked TABLE not a force-
 * directed graph: the persona research is unanimous that 2 AM SREs read
 * tables and ignore graphs.
 *
 * Sort order is in `derivations.rankedBlastRadius`: tier asc, then inbound-
 * degree desc, then name. The full graph view is still available behind
 * "View graph" — the existing BlastRadiusDialog reused as-is.
 */
export function IncidentBlastRadiusTable({
  serviceId,
  serviceName,
  blast,
  loading,
  error,
  truncated,
}: Props) {
  const router = useRouter();
  const [graphOpen, setGraphOpen] = useState(false);

  const ranked = useMemo(() => rankedBlastRadius(blast, serviceId), [blast, serviceId]);
  const summary = useMemo(() => blastRadiusSummary(ranked), [ranked]);
  const inline = ranked.slice(0, INLINE_LIMIT);

  const titleSuffix =
    summary.total > 0
      ? ` · ${summary.total} downstream${summary.tier1 > 0 ? ` · ${summary.tier1} T1` : ''}`
      : '';

  const summaryActions = ranked.length > INLINE_LIMIT && (
    <Button
      variant="outline"
      size="sm"
      icon={<IconGlyph name="graph" size={11} />}
      onClick={() => setGraphOpen(true)}
    >
      View all {ranked.length}
    </Button>
  );

  return (
    <>
      <Card title={`Blast radius${titleSuffix}`} actions={summaryActions ?? undefined}>
        {loading && !blast ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <div className="text-err text-[12px]">
            Couldn&apos;t load blast radius. Other panels are unaffected.
          </div>
        ) : ranked.length === 0 ? (
          <EmptyState
            tone="ok"
            icon={<IconGlyph name="check" size={20} />}
            title="No downstream impact"
            description="Nothing in the catalog transitively depends on this service via DEPENDS_ON, CALLS, or MONITORS."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {truncated && (
              <div className="border-warn bg-warn/10 text-warn rounded-base flex items-center gap-2 border px-3 py-2 text-[11px]">
                <IconGlyph name="warn" size={12} />
                Showing the most impactful 200 services — graph is too large to render in full.
              </div>
            )}
            <BlastRadiusTable
              entries={inline}
              onOpen={(id) => router.push(`/incidents/${encodeURIComponent(id)}`)}
            />
            {ranked.length > INLINE_LIMIT && (
              <button
                type="button"
                onClick={() => setGraphOpen(true)}
                className="text-text-muted hover:text-accent inline-flex items-center gap-1 self-start text-[11px]"
              >
                + {ranked.length - INLINE_LIMIT} more · view all in graph
              </button>
            )}
          </div>
        )}
      </Card>

      <BlastRadiusDialog
        open={graphOpen}
        onOpenChange={setGraphOpen}
        startId={serviceId}
        startName={serviceName ?? serviceId}
        data={blast}
        isLoading={!!loading}
        error={error ?? null}
        onOpenEntity={(id) => {
          setGraphOpen(false);
          router.push(`/incidents/${encodeURIComponent(id)}`);
        }}
      />
    </>
  );
}

function BlastRadiusTable({
  entries,
  onOpen,
}: {
  entries: BlastRadiusEntry[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {entries.map((entry) => {
        const tierVariant = entry.tier === 1 ? 'err' : entry.tier === 2 ? 'warn' : 'neutral';
        return (
          <EntityListRowButton
            key={entry.id}
            type={entry.type as EntityType}
            name={entry.name}
            relation={
              entry.tier !== undefined ? (
                <Badge variant={tierVariant} className="font-mono text-[10px]">
                  T{entry.tier}
                </Badge>
              ) : undefined
            }
            meta={entry.owner}
            onClick={() => onOpen(entry.id)}
          />
        );
      })}
    </div>
  );
}
