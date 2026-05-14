'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { splitMerge, type MergeEventSummary } from '@/lib/api';

export interface MergesTableProps {
  merges: MergeEventSummary[];
}

export function MergesTable({ merges }: MergesTableProps) {
  const queryClient = useQueryClient();
  const split = useMutation({
    mutationFn: splitMerge,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['merges'] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
  });

  if (merges.length === 0) {
    return (
      <EmptyState
        icon={<IconGlyph name="graph" size={22} />}
        title="No merges yet"
        description="Confirm a candidate from the Pending tab to record the first merge."
      />
    );
  }

  return (
    <div className="border-border bg-panel rounded-base overflow-hidden border">
      <table className="text-text w-full text-[12px]">
        <thead className="bg-panel-2 text-text-muted text-left">
          <tr>
            <th className="border-border border-b px-3 py-2 font-medium">Merged into</th>
            <th className="border-border border-b px-3 py-2 font-medium">From</th>
            <th className="border-border border-b px-3 py-2 font-medium">Actor</th>
            <th className="border-border border-b px-3 py-2 font-medium">When</th>
            <th className="border-border border-b px-3 py-2 font-medium">Method</th>
            <th className="border-border border-b px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {merges.map((m) => (
            <tr key={m.id} className="border-border border-b last:border-b-0">
              <td className="px-3 py-2 font-medium">{m.targetName}</td>
              <td className="text-text-muted px-3 py-2 font-mono text-[11px]">{m.sourceName}</td>
              <td className="px-3 py-2">{m.actor}</td>
              <td className="text-text-muted px-3 py-2">
                {m.timestamp ? formatRelative(m.timestamp.replace(/(\.\d+)0+Z$/, '$1Z')) : '—'}
              </td>
              <td className="px-3 py-2">
                <Badge size="sm" variant="neutral">
                  {m.method} · {(m.confidence * 100).toFixed(0)}%
                </Badge>
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => split.mutate(m.id)}
                  disabled={split.isPending}
                >
                  Split
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
