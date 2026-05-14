'use client';

import { Badge, Button, Drawer, EmptyState, formatRelative, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useQuery } from '@tanstack/react-query';
import { fetchSchemaHistory, type SchemaSnapshot } from '@/lib/api';

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  onRollback: (version: string) => void;
  rollingBack: string | null;
}

// Stored as ISO timestamps with ':' and '.' replaced by '-' for filesystem
// safety. Restore them before formatting.
function parseVersion(v: string): Date | null {
  const restored = v.replace(/-/g, (m, i) => {
    // Restore the time-component dashes back to colons, and the millisecond
    // dash back to a dot. The date-component dashes (positions 4, 7) stay.
    if (i === 4 || i === 7) return '-';
    if (i === 19) return '.';
    return ':';
  });
  const d = new Date(restored);
  return isNaN(d.getTime()) ? null : d;
}

export function HistoryDrawer({ open, onClose, onRollback, rollingBack }: HistoryDrawerProps) {
  const { data, isLoading } = useQuery<SchemaSnapshot[]>({
    queryKey: ['schema-history'],
    queryFn: fetchSchemaHistory,
    enabled: open,
  });

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} side="right" title="Schema history">
      <div className="flex flex-col gap-3 p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={<IconGlyph name="file" size={22} />}
            title="No prior versions"
            description="The schema has not been edited yet. Snapshots are written automatically on every save."
          />
        ) : (
          <ul className="flex list-none flex-col gap-2 p-0">
            {data.map((s) => {
              const when = parseVersion(s.version);
              return (
                <li
                  key={s.version}
                  className="border-border bg-panel flex items-center justify-between gap-3 rounded-xs border p-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-text text-[12px]">
                      {when ? formatRelative(when) : s.version}
                    </span>
                    <span className="text-text-dim font-mono text-[10px]">{s.version}</span>
                    <div className="flex items-center gap-2">
                      <Badge size="sm" variant="neutral">
                        {s.actor}
                      </Badge>
                      <span className="text-text-dim text-[10px]">{s.size} bytes</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRollback(s.version)}
                    disabled={rollingBack !== null}
                  >
                    {rollingBack === s.version ? <Spinner size="sm" /> : 'Rollback'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
