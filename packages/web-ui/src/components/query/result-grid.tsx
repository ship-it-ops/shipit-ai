'use client';

import { Badge, EmptyState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { CypherQueryResult } from '@/lib/api';

export interface ResultGridProps {
  result: CypherQueryResult | null;
  error: string | null;
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Nodes and relationships are serialized as `{ _kind, labels|type, properties }`.
  if (typeof value === 'object' && value !== null && '_kind' in value) {
    const v = value as { _kind: string; labels?: string[]; type?: string };
    if (v._kind === 'node') return `(:${(v.labels ?? []).join(':')})`;
    if (v._kind === 'relationship') return `[:${v.type ?? '?'}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ResultGrid({ result, error }: ResultGridProps) {
  if (error) {
    return (
      <EmptyState
        tone="err"
        icon={<IconGlyph name="warn" size={22} />}
        title="Query failed"
        description={error}
      />
    );
  }
  if (!result) {
    return (
      <EmptyState
        icon={<IconGlyph name="cmd" size={22} />}
        title="No results yet"
        description="Write a Cypher query above and press ⌘/Ctrl + ⏎ to run it."
      />
    );
  }
  if (result.rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <ResultMeta result={result} />
        <EmptyState
          icon={<IconGlyph name="search" size={22} />}
          title="No rows returned"
          description="The query ran successfully but matched nothing."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ResultMeta result={result} />
      <div className="border-border bg-panel rounded-base max-h-[480px] overflow-auto border">
        <table className="text-text w-full border-collapse text-[12px]">
          <thead className="bg-panel-2 text-text-muted sticky top-0 z-10 text-left">
            <tr>
              {result.columns.map((col) => (
                <th
                  key={col}
                  className="border-border border-b px-3 py-2 font-mono text-[11px] font-medium tracking-tight"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className="border-border hover:bg-panel-2/60 border-b last:border-b-0">
                {result.columns.map((col) => (
                  <td
                    key={col}
                    className="px-3 py-1.5 align-top font-mono text-[12px] whitespace-pre-wrap"
                  >
                    {renderCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultMeta({ result }: { result: CypherQueryResult }) {
  return (
    <div className="text-text-muted flex items-center gap-3 text-[11px]">
      <span>
        {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'} ·{' '}
        {result.executionTimeMs}ms
      </span>
      {result.truncated && (
        <Badge variant="warn" size="sm">
          truncated at {result.rowLimit}
        </Badge>
      )}
    </div>
  );
}
