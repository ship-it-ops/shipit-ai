'use client';

import { Badge, Card, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { EntityClaims, PropertyClaim, ResolutionStrategy, ResolvedProperty } from '@/lib/api';

const STRATEGY_EXPLANATION: Record<ResolutionStrategy, string> = {
  MANUAL_OVERRIDE_FIRST: 'Human claims always win. Best for: tier, lifecycle.',
  AUTHORITATIVE_ORDER: 'Ranked source priority. Best for: owner, language.',
  HIGHEST_CONFIDENCE: 'Highest confidence score wins. Best for: name, description.',
  LATEST_TIMESTAMP: 'Most recent claim wins. Best for: status, replicas.',
  MERGE_SET: 'All values combined into a set. Best for: tags, labels.',
};

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (Array.isArray(value)) return `[${value.map(fmt).join(', ')}]`;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function ClaimRow({
  claim,
  isWinner,
  strategy,
}: {
  claim: PropertyClaim;
  isWinner: boolean;
  strategy: ResolutionStrategy;
}) {
  return (
    <li
      className={
        'border-border bg-panel flex flex-col gap-2 rounded-xs border p-3 ' +
        (isWinner ? 'border-accent/60' : '')
      }
    >
      <div className="flex items-center gap-2">
        <Badge size="sm" variant={isWinner ? 'ok' : 'neutral'}>
          {claim.source}
        </Badge>
        {isWinner && (
          <Badge size="sm" variant="accent">
            Winning · {strategy}
          </Badge>
        )}
        <span className="text-text-muted ml-auto text-[11px]">
          confidence {claim.confidence.toFixed(2)} · {formatRelative(claim.ingested_at)}
        </span>
      </div>
      <div className="text-text font-mono text-[12px]">{fmt(claim.value)}</div>
      <div className="text-text-dim font-mono text-[10px]">{claim.source_id}</div>
    </li>
  );
}

function PropertyBlock({ prop }: { prop: ResolvedProperty }) {
  return (
    <section className="border-border bg-panel-2 rounded-base flex flex-col gap-3 border p-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-text font-mono text-[14px]">{prop.property_key}</h3>
            {prop.has_conflict ? (
              <Badge size="sm" variant="warn" icon={<IconGlyph name="warn" size={10} />}>
                conflict
              </Badge>
            ) : (
              <Badge size="sm" variant="ok" icon={<IconGlyph name="check" size={10} />}>
                agreed
              </Badge>
            )}
          </div>
          <p className="text-text-dim mt-1 text-[11px]">{STRATEGY_EXPLANATION[prop.strategy]}</p>
        </div>
        <div className="text-right">
          <div className="text-text-muted text-[11px]">Effective</div>
          <div className="text-text font-mono text-[13px]">{fmt(prop.effective_value)}</div>
        </div>
      </header>
      <ul className="flex list-none flex-col gap-2 p-0">
        {prop.claims.map((c, i) => (
          <ClaimRow
            key={c.source + i}
            claim={c}
            isWinner={
              prop.winning_claim?.source === c.source &&
              prop.winning_claim?.source_id === c.source_id
            }
            strategy={prop.strategy}
          />
        ))}
      </ul>
    </section>
  );
}

export function ClaimList({ data }: { data: EntityClaims }) {
  return (
    <div className="flex flex-col gap-3">
      <Card title={`${data.name} · ${data.label}`} className="!p-3">
        <p className="text-text-dim font-mono text-[11px]">{data.entityId}</p>
      </Card>
      <div className="flex flex-col gap-3">
        {data.properties.map((p) => (
          <PropertyBlock key={p.property_key} prop={p} />
        ))}
      </div>
    </div>
  );
}
