'use client';

import { Badge } from '@ship-it-ui/ui';
import type { SchemaDiff } from '@/lib/api';

export interface SchemaDiffViewProps {
  diff: SchemaDiff;
}

export function SchemaDiffView({ diff }: SchemaDiffViewProps) {
  const empty =
    diff.added.node_types.length === 0 &&
    diff.added.relationship_types.length === 0 &&
    diff.removed.node_types.length === 0 &&
    diff.removed.relationship_types.length === 0 &&
    diff.changed.length === 0;

  if (empty) {
    return (
      <p className="text-text-muted text-[12px]">
        No changes vs the currently saved schema.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      {(diff.added.node_types.length > 0 || diff.added.relationship_types.length > 0) && (
        <Section title="Added" tone="ok">
          {diff.added.node_types.map((n) => (
            <Pill key={`an:${n}`} variant="ok">
              + {n} <small>(node type)</small>
            </Pill>
          ))}
          {diff.added.relationship_types.map((n) => (
            <Pill key={`ar:${n}`} variant="ok">
              + {n} <small>(rel)</small>
            </Pill>
          ))}
        </Section>
      )}
      {(diff.removed.node_types.length > 0 || diff.removed.relationship_types.length > 0) && (
        <Section title="Removed" tone="err">
          {diff.removed.node_types.map((n) => (
            <Pill key={`rn:${n}`} variant="err">
              − {n} <small>(node type)</small>
            </Pill>
          ))}
          {diff.removed.relationship_types.map((n) => (
            <Pill key={`rr:${n}`} variant="err">
              − {n} <small>(rel)</small>
            </Pill>
          ))}
        </Section>
      )}
      {diff.changed.length > 0 && (
        <Section title="Changed" tone="warn">
          {diff.changed.map((c) => (
            <div
              key={`${c.kind}:${c.name}`}
              className="border-border bg-panel rounded-xs flex flex-col gap-1 border p-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-text font-medium">{c.name}</span>
                <Badge size="sm" variant="neutral">{c.kind}</Badge>
              </div>
              {c.added_properties.length > 0 && (
                <div className="text-text-muted text-[11px]">
                  + props: <span className="font-mono">{c.added_properties.join(', ')}</span>
                </div>
              )}
              {c.removed_properties.length > 0 && (
                <div className="text-text-muted text-[11px]">
                  − props: <span className="font-mono">{c.removed_properties.join(', ')}</span>
                </div>
              )}
              {c.changed_properties.length > 0 && (
                <ul className="text-text-muted m-0 list-none p-0 text-[11px]">
                  {c.changed_properties.map((p, i) => (
                    <li key={i}>
                      <span className="font-mono">{p.name}.{p.field}</span>:{' '}
                      <span className="font-mono">{JSON.stringify(p.before)}</span> →{' '}
                      <span className="text-text font-mono">{JSON.stringify(p.after)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'ok' | 'warn' | 'err';
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-muted text-[11px]">
        <Badge size="sm" variant={tone}>{title}</Badge>
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Pill({ variant, children }: { variant: 'ok' | 'err'; children: React.ReactNode }) {
  return (
    <Badge size="sm" variant={variant}>
      {children}
    </Badge>
  );
}
