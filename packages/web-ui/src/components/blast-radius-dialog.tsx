'use client';

import { useMemo } from 'react';
import { Badge, Button, Dialog, EmptyState, Spinner } from '@ship-it-ui/ui';
import { DynamicIconGlyph, IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import type { GraphData } from '@/lib/api';

interface BlastRadiusDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Canonical id of the entity the user is asking about. */
  startId: string;
  /** Display name of that entity. */
  startName: string;
  /**
   * Result of `useBlastRadius` — `data` includes the start entity, so the
   * dialog filters it out before grouping.
   */
  data: GraphData | undefined;
  isLoading: boolean;
  error: Error | null;
  /** Clicking an affected entity navigates to its detail page. */
  onOpenEntity: (id: string) => void;
}

/**
 * Shared "blast radius" dialog used from both the catalog entity-detail page
 * and the graph explorer's node detail panel. Source of truth for what
 * "blast radius" means in the UI: results come from the directed
 * `/api/graph/blast-radius` endpoint (inbound `DEPENDS_ON | CALLS | MONITORS`),
 * not the undirected neighborhood — so a leaf entity like a Person correctly
 * reports "no downstream impact".
 */
export function BlastRadiusDialog({
  open,
  onOpenChange,
  startId,
  startName,
  data,
  isLoading,
  error,
  onOpenEntity,
}: BlastRadiusDialogProps) {
  const affected = useMemo(
    () => (data?.nodes ?? []).filter((n) => n.data.id !== startId),
    [data, startId],
  );

  const byType = useMemo(() => {
    const groups = new Map<string, typeof affected>();
    for (const n of affected) {
      const t = String(n.data.type ?? 'Unknown');
      const bucket = groups.get(t) ?? [];
      bucket.push(n);
      groups.set(t, bucket);
    }
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => String(a.data.name ?? '').localeCompare(String(b.data.name ?? '')));
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [affected]);

  const tier1Count = affected.filter((n) => Number(n.data.tier) === 1).length;

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div className="flex h-32 items-center justify-center">
        <Spinner />
      </div>
    );
  } else if (error) {
    body = (
      <div className="text-err text-[13px]">
        Couldn&apos;t load blast radius. The API may be unavailable, or APOC isn&apos;t installed on
        this Neo4j instance.
      </div>
    );
  } else if (affected.length === 0) {
    body = (
      <EmptyState
        icon={<IconGlyph name="check" size={22} />}
        title="No downstream impact"
        description="Nothing in the graph transitively depends on this entity via DEPENDS_ON, CALLS, or MONITORS edges."
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        <div className="text-text-muted flex flex-wrap items-center gap-3 text-[12px]">
          <span>
            <span className="text-text font-mono">{affected.length}</span> affected entit
            {affected.length === 1 ? 'y' : 'ies'}
          </span>
          {tier1Count > 0 && (
            <Badge variant="err" className="font-mono text-[10px]">
              {tier1Count} T1
            </Badge>
          )}
        </div>

        {byType.map(([type, nodes]) => {
          const meta = getEntityTypeMeta(type);
          return (
            <section key={type} className="flex flex-col gap-2">
              <h3 className="text-text-dim flex items-center gap-2 font-mono text-[10px] tracking-[1.4px] uppercase">
                <DynamicIconGlyph aria-hidden name={meta.iconName} size={11} />
                {meta.label}
                <span className="text-text-dim font-mono">· {nodes.length}</span>
              </h3>
              <ul className="flex flex-col gap-1">
                {nodes.map((n) => {
                  const tier = n.data.tier !== undefined ? Number(n.data.tier) : undefined;
                  const owner = n.data.owner ? String(n.data.owner) : undefined;
                  return (
                    <li key={n.data.id}>
                      <button
                        type="button"
                        onClick={() => onOpenEntity(n.data.id)}
                        className="hover:bg-panel-2 focus-visible:ring-accent-dim flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left text-[12px] outline-none focus-visible:ring-[3px]"
                      >
                        <span
                          aria-hidden
                          className={
                            'grid h-6 w-6 place-items-center rounded-xs ' +
                            meta.toneBg +
                            ' ' +
                            meta.toneClass
                          }
                        >
                          <DynamicIconGlyph name={meta.iconName} size={13} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-text truncate font-medium">
                            {String(n.data.name ?? n.data.id)}
                          </span>
                          <span className="text-text-dim truncate font-mono text-[10px]">
                            {owner ?? '—'}
                          </span>
                        </span>
                        {tier !== undefined && (
                          <Badge
                            variant={tier === 1 ? 'err' : tier === 2 ? 'warn' : 'neutral'}
                            className="font-mono text-[10px]"
                          >
                            T{tier}
                          </Badge>
                        )}
                        <IconGlyph name="caretRight" size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Blast radius — ${startName}`}
      description="Entities transitively affected (up to 3 hops) along inbound DEPENDS_ON, CALLS, and MONITORS edges."
      width={620}
      footer={
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      {body}
    </Dialog>
  );
}
