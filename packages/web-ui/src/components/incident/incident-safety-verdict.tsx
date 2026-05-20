'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, Spinner } from '@ship-it-ui/ui';
import { type GlyphName, IconGlyph } from '@ship-it-ui/icons';
import { ConfidenceIndicator } from '@ship-it-ui/shipit';
import {
  type BlastRadiusEntry,
  type SafetyLevel,
  type ServiceNode,
  VERDICT_INPUT_PROPERTY_KEYS,
  safetyVerdict,
} from '@/lib/incident/derivations';
import type { EntityClaims } from '@/lib/api';

interface Props {
  service: ServiceNode | undefined;
  blast: BlastRadiusEntry[];
  claims: EntityClaims | undefined;
  loading?: boolean;
}

const LEVEL_TONE: Record<
  SafetyLevel,
  { bg: string; text: string; icon: GlyphName; label: string }
> = {
  red: { bg: 'bg-err/10', text: 'text-err', icon: 'incident', label: 'CRITICAL' },
  yellow: { bg: 'bg-warn/10', text: 'text-warn', icon: 'warn', label: 'ELEVATED' },
  green: { bg: 'bg-ok/10', text: 'text-ok', icon: 'check', label: 'LOW' },
  unknown: { bg: 'bg-panel-2', text: 'text-text-dim', icon: 'help', label: 'UNKNOWN' },
};

/**
 * The opinionated traffic-light verdict the user explicitly chose.
 *
 * Mitigation against the design-review concern about wrong tier metadata:
 *   1. Always shows the inputs that drove the verdict (transparent rules)
 *   2. Surfaces a claim-conflict warning when tier/lifecycle is contested
 *      so the IC sees "this verdict is based on data the catalog disagrees
 *      with itself about" before acting
 *   3. "Why this verdict?" disclosure with the rule that fired
 */
export function IncidentSafetyVerdict({ service, blast, claims, loading }: Props) {
  const verdict = useMemo(() => safetyVerdict(service, blast), [service, blast]);
  const tone = LEVEL_TONE[verdict.level];
  const [showWhy, setShowWhy] = useState(false);

  // Detect contested input properties — same logic the claims explorer uses,
  // but scoped to the keys this verdict actually consumes. Surface the
  // winning claim's confidence so the IC sees a numeric trust signal,
  // not just a binary "conflict / no conflict".
  const contested = useMemo(() => {
    if (!claims) return [] as Array<{ key: string; confidence: number }>;
    return claims.properties
      .filter(
        (p) =>
          (VERDICT_INPUT_PROPERTY_KEYS as readonly string[]).includes(p.property_key) &&
          p.has_conflict,
      )
      .map((p) => ({
        key: p.property_key,
        confidence: Math.round((p.winning_claim?.confidence ?? 0) * 100),
      }));
  }, [claims]);

  return (
    <Card>
      <div className="flex flex-col gap-3">
        {contested.length > 0 && (
          <div className="border-warn bg-warn/10 text-warn rounded-base flex flex-col gap-2 border px-3 py-2 text-[12px]">
            <div className="flex items-start gap-2">
              <IconGlyph name="warn" size={14} />
              <div className="flex flex-1 flex-col gap-1">
                <span className="font-medium">
                  Verdict may be unreliable — catalog has unresolved conflicts on{' '}
                  <code className="font-mono">{contested.map((c) => c.key).join(', ')}</code>.
                </span>
                <Link
                  href={`/operations/claims?entity=${encodeURIComponent(service?.id ?? '')}`}
                  className="text-warn underline-offset-2 hover:underline"
                >
                  Inspect claims →
                </Link>
              </div>
            </div>
            <div className="flex flex-col gap-1 pl-6">
              {contested.map((c) => (
                <div key={c.key} className="flex items-center gap-2 text-[11px]">
                  <span className="text-text-dim w-24 truncate font-mono">{c.key}</span>
                  <ConfidenceIndicator value={c.confidence} width={140} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className={`rounded-base flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-5 ${tone.bg}`}
        >
          <div className="flex shrink-0 items-center gap-3">
            <span aria-hidden className={tone.text}>
              <IconGlyph name={tone.icon} size={28} />
            </span>
            <div className="flex flex-col">
              <span className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">
                Change risk
              </span>
              <span className={`text-[18px] font-bold tracking-wide ${tone.text}`}>
                {tone.label}
              </span>
            </div>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            {loading && <Spinner size="sm" />}
            {verdict.reasons.map((r) => (
              <Badge key={r} variant="neutral" className="text-[10px]">
                {r}
              </Badge>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowWhy((s) => !s)}
            icon={<IconGlyph name={showWhy ? 'caretUp' : 'caretDown'} size={11} />}
          >
            Why?
          </Button>
        </div>

        {showWhy && (
          <div className="text-text-muted bg-panel-2 rounded-base flex flex-col gap-2 px-4 py-3 text-[12px]">
            <span className="text-text font-medium">Decision rule</span>
            <RuleExplanation level={verdict.level} />
            <span className="text-text-dim">
              These rules are conservative — when in doubt the verdict is ELEVATED. Override using
              your own judgment; the catalog data may be incomplete or stale.
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function RuleExplanation({ level }: { level: SafetyLevel }) {
  const items: Array<[SafetyLevel, string]> = [
    ['red', 'CRITICAL if tier 1, OR any tier-1 service depends on this one downstream.'],
    ['yellow', 'ELEVATED if tier 2, OR ≥5 services downstream, OR service is flagged for PII.'],
    [
      'green',
      'LOW if tier 3 AND zero downstream impact AND lifecycle is experimental/deprecated/decommissioned.',
    ],
    ['unknown', 'UNKNOWN if the service is missing from the catalog.'],
  ];
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map(([l, text]) => (
        <li
          key={l}
          className={`flex items-start gap-2 ${l === level ? 'text-text font-medium' : 'text-text-dim'}`}
        >
          <span aria-hidden>{l === level ? '→' : ' '}</span>
          {text}
        </li>
      ))}
    </ul>
  );
}
