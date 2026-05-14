'use client';

import { useRouter } from 'next/navigation';
import { Badge, Card, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
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
          arrow="→"
          entries={upstream}
          onOpen={open}
          emptyText="No outbound dependencies declared."
        />
        <DependencyList
          heading="Used by"
          arrow="←"
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
  arrow,
  entries,
  onOpen,
  emptyText,
}: {
  heading: string;
  arrow: string;
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
        <ul className="m-0 flex flex-col gap-1 p-0">
          {entries.map((e) => {
            const meta = getEntityTypeMeta(e.type);
            const tierVariant =
              e.tier === 1 ? 'err' : e.tier === 2 ? 'warn' : 'neutral';
            return (
              <li key={`${e.id}-${e.relation}`}>
                <button
                  type="button"
                  onClick={() => onOpen(e.id)}
                  className="hover:bg-panel-2 flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-[12px]"
                >
                  <span aria-hidden className="text-text-dim w-3 font-mono text-[10px]">
                    {arrow}
                  </span>
                  <span
                    aria-hidden
                    className={`grid h-5 w-5 place-items-center rounded-xs text-[11px] ${meta.toneBg} ${meta.toneClass}`}
                  >
                    {meta.glyph}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-text truncate">{e.name}</span>
                    <span className="text-text-dim truncate font-mono text-[10px]">
                      {e.relation}
                      {e.owner ? ` · ${e.owner}` : ''}
                    </span>
                  </span>
                  {e.tier !== undefined && (
                    <Badge variant={tierVariant} className="shrink-0 font-mono text-[10px]">
                      T{e.tier}
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
