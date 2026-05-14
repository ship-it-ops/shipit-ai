'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Drawer, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  confirmMerge,
  fetchCandidate,
  markCandidateDistinct,
  rejectCandidate,
  type CandidateDetail,
} from '@/lib/api';

export interface CompareDrawerProps {
  candidateId: string | null;
  onClose: () => void;
}

// Hide the noisy internal `_*` properties; they're useful for debugging but
// distract from the comparison task.
const HIDE_PREFIXES = ['_'];
const HIDE_KEYS = new Set(['id']);

function visibleProps(p: Record<string, unknown>) {
  return Object.entries(p)
    .filter(([k]) => !HIDE_KEYS.has(k) && !HIDE_PREFIXES.some((prefix) => k.startsWith(prefix)))
    .sort(([a], [b]) => a.localeCompare(b));
}

export function CompareDrawer({ candidateId, onClose }: CompareDrawerProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<CandidateDetail>({
    queryKey: ['candidate', candidateId],
    queryFn: () => fetchCandidate(candidateId!),
    enabled: !!candidateId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['candidates'] });
    queryClient.invalidateQueries({ queryKey: ['merges'] });
    queryClient.invalidateQueries({ queryKey: ['reconciliation-stats'] });
  };

  const confirm = useMutation({
    mutationFn: () => confirmMerge(candidateId!),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const reject = useMutation({
    mutationFn: () => rejectCandidate(candidateId!),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const distinct = useMutation({
    mutationFn: () => markCandidateDistinct(candidateId!),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const sharedKeys = useMemo(() => {
    if (!data) return new Set<string>();
    const a = new Set(Object.keys(data.leftProperties));
    const b = new Set(Object.keys(data.rightProperties));
    return new Set([...a].filter((k) => b.has(k)));
  }, [data]);

  return (
    <Drawer
      open={!!candidateId}
      onOpenChange={(o) => !o && onClose()}
      side="right"
      title="Review match"
    >
      <div className="flex flex-col gap-4 p-4">
        {isLoading || !data ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between">
              <Badge size="sm" variant="accent">
                {(data.confidence * 100).toFixed(1)}% match
              </Badge>
              <Badge size="sm" variant="neutral">{data.label}</Badge>
            </header>

            <section className="flex flex-col gap-2">
              <h3 className="text-text-muted text-[11px] uppercase">Score breakdown</h3>
              <ul className="m-0 grid grid-cols-2 gap-2 p-0 text-[12px]">
                <Score label="name" value={data.scoreBreakdown.name} />
                <Score label="namespace" value={data.scoreBreakdown.namespace} />
                <Score label="tags" value={data.scoreBreakdown.tags} />
                <Score label="labels" value={data.scoreBreakdown.labels} />
              </ul>
            </section>

            <section className="grid grid-cols-2 gap-3">
              <SideColumn
                title={data.leftName}
                id={data.leftId}
                source={data.leftSource}
                properties={data.leftProperties}
                sharedKeys={sharedKeys}
                otherProps={data.rightProperties}
              />
              <SideColumn
                title={data.rightName}
                id={data.rightId}
                source={data.rightSource}
                properties={data.rightProperties}
                sharedKeys={sharedKeys}
                otherProps={data.leftProperties}
              />
            </section>

            {data.status === 'pending' ? (
              <footer className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => distinct.mutate()}
                  disabled={distinct.isPending || confirm.isPending || reject.isPending}
                  title="Mark as distinct so the scan never re-proposes this pair"
                >
                  Mark distinct
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reject.mutate()}
                  disabled={reject.isPending || confirm.isPending || distinct.isPending}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  onClick={() => confirm.mutate()}
                  disabled={confirm.isPending || reject.isPending || distinct.isPending}
                  icon={confirm.isPending ? <Spinner size="sm" /> : <IconGlyph name="check" size={12} />}
                >
                  Confirm merge
                </Button>
              </footer>
            ) : (
              <EmptyState
                icon={<IconGlyph name="check" size={20} />}
                title={`Already ${data.status}`}
                description={`Reviewed by ${data.reviewedBy ?? 'unknown'}.`}
              />
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <li className="border-border bg-panel-2 flex items-center justify-between rounded-xs border px-2 py-1">
      <span className="text-text-muted font-mono text-[11px]">{label}</span>
      <span className="text-text font-mono text-[12px]">{(value * 100).toFixed(0)}%</span>
    </li>
  );
}

function SideColumn({
  title,
  id,
  source,
  properties,
  sharedKeys,
  otherProps,
}: {
  title: string;
  id: string;
  source: string | null;
  properties: Record<string, unknown>;
  sharedKeys: Set<string>;
  otherProps: Record<string, unknown>;
}) {
  const props = visibleProps(properties);
  return (
    <div className="border-border bg-panel rounded-base flex flex-col gap-2 border p-3">
      <header className="flex flex-col gap-1">
        <span className="text-text text-[13px] font-medium">{title}</span>
        <span className="text-text-dim font-mono text-[10px]">{id}</span>
        {source && (
          <Badge size="sm" variant="accent">
            {source}
          </Badge>
        )}
      </header>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[11px]">
        {props.map(([k, v]) => {
          const sameOnOther =
            sharedKeys.has(k) && JSON.stringify(otherProps[k]) === JSON.stringify(v);
          return (
            <li
              key={k}
              className={
                'flex justify-between gap-2 rounded-xs px-2 py-1 ' +
                (sameOnOther ? 'bg-panel-2' : 'bg-[color:var(--color-warn)]/10')
              }
            >
              <span className="text-text-muted font-mono">{k}</span>
              <span className="text-text truncate font-mono">{JSON.stringify(v)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
