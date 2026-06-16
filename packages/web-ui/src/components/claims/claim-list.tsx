'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  verifyClaim,
  type ConfidenceBreakdown,
  type EntityClaims,
  type PropertyClaim,
  type ResolutionStrategy,
  type ResolvedProperty,
  type VerificationStatus,
} from '@/lib/api';

const STRATEGY_EXPLANATION: Record<ResolutionStrategy, string> = {
  MANUAL_OVERRIDE_FIRST: 'Human claims always win. Best for: tier, lifecycle.',
  AUTHORITATIVE_ORDER: 'Ranked source priority. Best for: owner, language.',
  HIGHEST_CONFIDENCE: 'Highest confidence score wins. Best for: name, description.',
  LATEST_TIMESTAMP: 'Most recent claim wins. Best for: status, replicas.',
  MERGE_SET: 'All values combined into a set. Best for: tags, labels.',
};

const STATUS_VARIANT: Record<VerificationStatus, 'ok' | 'accent' | 'warn' | 'neutral'> = {
  USER_VERIFIED: 'ok',
  CORROBORATED: 'accent',
  DISPUTED: 'warn',
  STALE: 'neutral',
  UNVERIFIED: 'neutral',
};

const STATUS_LABEL: Record<VerificationStatus, string> = {
  USER_VERIFIED: 'verified',
  CORROBORATED: 'corroborated',
  DISPUTED: 'disputed',
  STALE: 'stale',
  UNVERIFIED: 'unverified',
};

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (Array.isArray(value)) return `[${value.map(fmt).join(', ')}]`;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function signed(n: number): string {
  const r = Math.round(n * 100) / 100;
  return (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2);
}

/** Friendly source name for the compact view: `verified:web-ui` -> `verified`. */
function sourceLabel(source: string): string {
  const i = source.indexOf(':');
  return i === -1 ? source : source.slice(0, i);
}

/** "0.90 base (github) − 0.02 decay + 0.03 corroborated by datadog = 0.91" */
function BreakdownSentence({ breakdown }: { breakdown: ConfidenceBreakdown }) {
  const [first, ...rest] = breakdown.terms;
  if (!first) return null;
  return (
    <p className="text-text-dim font-mono text-[10px]">
      {first.delta.toFixed(2)} {first.label}
      {rest.map((t, i) => (
        <span key={i}>
          {' '}
          {signed(t.delta)} {t.label}
        </span>
      ))}{' '}
      = <span className="text-text-muted">{breakdown.effective.toFixed(2)}</span>
    </p>
  );
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

function PropertyBlock({
  entityId,
  prop,
  compact = false,
}: {
  entityId: string;
  prop: ResolvedProperty;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const verify = useMutation({
    mutationFn: () => verifyClaim(entityId, prop.property_key, prop.effective_value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['claims', entityId] }),
  });

  // Compact view (catalog entity page): just the resolved value, status, and a
  // confidence %. Drops the strategy text, breakdown sentence, and the raw
  // per-source claim rows — the "Open in explorer" link surfaces those.
  if (compact) {
    const sources = Array.from(new Set(prop.claims.map((c) => sourceLabel(c.source))));
    return (
      <div className="border-border bg-panel-2 rounded-base flex flex-col gap-1.5 border p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-text font-mono text-[13px]">{prop.property_key}</h3>
          <Badge size="sm" variant={STATUS_VARIANT[prop.status]}>
            {STATUS_LABEL[prop.status]}
          </Badge>
          {prop.needs_review && (
            <Badge size="sm" variant="warn" icon={<IconGlyph name="warn" size={10} />}>
              needs review
            </Badge>
          )}
          <span className="text-text-muted ml-auto text-[12px]">
            {(prop.confidence * 100).toFixed(0)}%
          </span>
        </div>
        <div className="text-text font-mono text-[13px]">{fmt(prop.effective_value)}</div>
        <div className="flex items-center gap-2">
          <span className="text-text-dim text-[11px]">sources: {sources.join(' · ')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {prop.status === 'USER_VERIFIED' ? 'Re-verify' : 'Verify'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section className="border-border bg-panel-2 rounded-base flex flex-col gap-3 border p-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-text font-mono text-[14px]">{prop.property_key}</h3>
            <Badge size="sm" variant={STATUS_VARIANT[prop.status]}>
              {STATUS_LABEL[prop.status]}
            </Badge>
            {prop.needs_review && (
              <Badge size="sm" variant="warn" icon={<IconGlyph name="warn" size={10} />}>
                needs review
              </Badge>
            )}
          </div>
          <p className="text-text-dim mt-1 text-[11px]">{STRATEGY_EXPLANATION[prop.strategy]}</p>
          <BreakdownSentence breakdown={prop.breakdown} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="text-text-muted text-[11px]">
              Effective · {(prop.confidence * 100).toFixed(0)}%
            </div>
            <div className="text-text font-mono text-[13px]">{fmt(prop.effective_value)}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
          >
            <IconGlyph name="check" size={12} />{' '}
            {prop.status === 'USER_VERIFIED' ? 'Re-verify' : 'Verify'}
          </Button>
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

export function ClaimList({
  data,
  showHeader = true,
  compact = false,
}: {
  data: EntityClaims;
  /**
   * Render the `name · label · id` header card. The standalone claim explorer
   * wants it; embedding on the entity catalog page (which already shows the
   * header) passes `false` to avoid duplicating it.
   */
  showHeader?: boolean;
  /**
   * Compact rendering for the catalog entity page: value + status + confidence
   * only, no per-source claim rows or strategy/breakdown detail. The Explorer
   * (full detail) leaves this `false`.
   */
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {showHeader && (
        <Card title={`${data.name} · ${data.label}`} className="!p-3">
          <p className="text-text-dim font-mono text-[11px]">{data.entityId}</p>
        </Card>
      )}
      <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>
        {data.properties.map((p) => (
          <PropertyBlock key={p.property_key} entityId={data.entityId} prop={p} compact={compact} />
        ))}
      </div>
    </div>
  );
}
