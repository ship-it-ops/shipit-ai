'use client';

import { Badge, Card, type BadgeProps } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';

export type PlaceholderPhase = 'phase-2' | 'phase-3' | 'enterprise';

const phaseMeta: Record<
  PlaceholderPhase,
  { label: string; variant: NonNullable<BadgeProps['variant']> }
> = {
  'phase-2': { label: 'Phase 2', variant: 'accent' },
  'phase-3': { label: 'Phase 3', variant: 'purple' },
  enterprise: { label: 'Enterprise', variant: 'warn' },
};

export interface PlaceholderPageProps {
  title: string;
  description: string;
  glyph: string;
  phase: PlaceholderPhase;
  features?: ReadonlyArray<string>;
}

export function PlaceholderPage({
  title,
  description,
  glyph,
  phase,
  features,
}: PlaceholderPageProps) {
  const meta = phaseMeta[phase];
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="bg-panel-2 text-text-muted rounded-base grid h-12 w-12 place-items-center text-[22px]"
          >
            <IconGlyph name={glyph} size={22} />
          </span>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </div>
        <div>
          <h1 className="text-text text-[22px] font-semibold tracking-tight">{title}</h1>
          <p className="text-text-muted mt-1 text-[13px]">{description}</p>
        </div>
      </header>

      {features && features.length > 0 && (
        <Card title="What this will do">
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <span aria-hidden className="text-text-dim mt-[2px] font-mono">
                  ·
                </span>
                <span className="text-text-muted">{f}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="border-border bg-panel-2 text-text-muted rounded-base flex items-center gap-2 border border-dashed px-4 py-3 text-[12px]">
        <IconGlyph name="warn" size={12} />
        <span>
          This screen is a placeholder. The underlying capability is on the roadmap (see the design
          doc &sect;10).
        </span>
      </div>
    </div>
  );
}
