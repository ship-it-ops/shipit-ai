'use client';

import { useRouter } from 'next/navigation';
import { Badge, Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { EntityListRowButton, type EntityType } from '@ship-it-ui/shipit';
import type { DependencyEntry } from '@/lib/incident/derivations';

interface Props {
  upstream: DependencyEntry[];
  downstream: DependencyEntry[];
}

/**
 * Direct dependency view (depth-1). Splits "this service depends on X"
 * (outbound DEPENDS_ON / CALLS) from "X depends on this service" (inbound).
 *
 * Each row routes to that service's own incident-mode page, so the IC can
 * pivot up- or downstream from a single click — fan-out / fan-in
 * traversal is one of the operational behaviors the persona research
 * called out as "actually useful at 2 AM."
 */
export function IncidentDependencies({ upstream, downstream }: Props) {
  const router = useRouter();
  const open = (id: string) => router.push(`/incidents/${encodeURIComponent(id)}`);

  if (upstream.length === 0 && downstream.length === 0) {
    return (
      <Card title="Direct dependencies">
        <EmptyState
          icon={<IconGlyph name="graph" size={20} />}
          title="No declared dependencies"
          description="No DEPENDS_ON or CALLS edges into or out of this service in the catalog."
        />
      </Card>
    );
  }

  return (
    <Card title="Direct dependencies">
      <div className="grid gap-5 md:grid-cols-2">
        <DependencyList
          heading="Depends on"
          entries={upstream}
          onOpen={open}
          emptyText="No outbound dependencies declared."
        />
        <DependencyList
          heading="Used by"
          entries={downstream}
          onOpen={open}
          emptyText="No inbound dependencies declared."
        />
      </div>
    </Card>
  );
}

function DependencyList({
  heading,
  entries,
  onOpen,
  emptyText,
}: {
  heading: string;
  entries: DependencyEntry[];
  onOpen: (id: string) => void;
  emptyText: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">{heading}</h3>
      {entries.length === 0 ? (
        <p className="text-text-muted text-[12px]">{emptyText}</p>
      ) : (
        <div className="flex flex-col">
          {entries.map((e) => {
            const tierVariant = e.tier === 1 ? 'err' : e.tier === 2 ? 'warn' : 'neutral';
            const metaText = e.owner ? `${e.relation} · ${e.owner}` : e.relation;
            return (
              <EntityListRowButton
                key={`${e.id}-${e.relation}`}
                type={e.type as EntityType}
                name={e.name}
                meta={metaText}
                relation={
                  e.tier !== undefined ? (
                    <Badge variant={tierVariant} className="font-mono text-[10px]">
                      T{e.tier}
                    </Badge>
                  ) : undefined
                }
                onClick={() => onOpen(e.id)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
