'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Textarea,
  formatRelative,
  useToast,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  ManualClaimError,
  revertManualClaim,
  setManualClaim,
  verifyClaim,
  type ConfidenceBreakdown,
  type EntityClaims,
  type PropertyClaim,
  type ResolutionStrategy,
  type ResolvedProperty,
  type VerificationStatus,
} from '@/lib/api';
import { useCurrentUser } from '@/lib/current-user';

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

/**
 * The actor of an effective manual override, or null. A claim source is a
 * manual override iff it starts with exactly `manual:` (pinned to the colon so
 * a hypothetical `manualish:` source can never be mistaken for one).
 */
function manualActor(source: string | undefined): string | null {
  if (!source) return null;
  return source.startsWith('manual:') ? source.slice('manual:'.length) : null;
}

/** Whether the winning claim on a property is a manual override. */
function winningManualActor(prop: ResolvedProperty): string | null {
  return manualActor(prop.winning_claim?.source);
}

/**
 * Map a thrown mutation error to friendly toast copy. ManualClaimError carries
 * the backend's structured code so FEATURE_DISABLED, FORBIDDEN, rate-limit, and
 * value-type failures each get distinct, actionable text.
 */
function manualErrorToast(err: unknown): { title: string; description?: string } {
  if (err instanceof ManualClaimError) {
    switch (err.code) {
      case 'FEATURE_DISABLED':
        return {
          title: 'Manual editing is disabled',
          description: 'An administrator has turned off manual edits.',
        };
      case 'FORBIDDEN':
        return {
          title: "You don't have permission",
          description: 'You need graph-write access to edit claims.',
        };
      case 'RATE_LIMITED':
        return {
          title: 'Too many edits, slow down',
          description: 'Wait a moment before editing again.',
        };
      case 'INVALID_VALUE_TYPE':
        return {
          title: 'Value must be text',
          description: 'Manual claim values are strings in this version.',
        };
      case 'ENTITY_NOT_FOUND':
        return {
          title: 'Entity not found',
          description: 'It may have been removed since this page loaded.',
        };
      case 'MANUAL_EDIT_DISABLED':
        return {
          title: 'Manual editing is unavailable',
          description: 'The manual-edit service is not configured.',
        };
      default:
        return { title: 'Edit failed', description: err.message };
    }
  }
  return { title: 'Edit failed', description: err instanceof Error ? err.message : undefined };
}

/**
 * Inline dialog for authoring/replacing a property's manual claim. Value is
 * string-only in v1 (labeled as such); evidence is optional free text. No
 * optimistic update — onSuccess invalidates `['claims', entityId]`, mirroring
 * the existing Verify mutation.
 */
function EditClaimDialog({
  open,
  onOpenChange,
  entityId,
  prop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  prop: ResolvedProperty;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const initial =
    typeof prop.effective_value === 'string' ? prop.effective_value : fmt(prop.effective_value);
  const [value, setValue] = useState(initial);
  const [evidence, setEvidence] = useState('');

  const save = useMutation({
    mutationFn: () => setManualClaim(entityId, prop.property_key, value, evidence.trim() || null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['claims', entityId] });
      toast({ variant: 'ok', title: 'Manual value saved' });
      onOpenChange(false);
    },
    onError: (err) => toast({ variant: 'err', ...manualErrorToast(err) }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the draft when the dialog (re)opens so a stale edit doesn't
        // linger; closing keeps it harmless.
        if (next) {
          setValue(initial);
          setEvidence('');
        }
        onOpenChange(next);
      }}
      title={`Edit ${prop.property_key}`}
      description="Set a manual value for this property. Manual claims win over ingested sources."
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending || value.trim() === ''}
          >
            {save.isPending ? 'Saving…' : 'Save value'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Value (text)" hint="String values only in this version.">
          {(field) => (
            <Input
              {...field}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="New value"
              autoFocus
            />
          )}
        </Field>
        <Field
          label="Evidence (optional)"
          hint="Why this value? A link or short note for the audit trail."
        >
          {(field) => (
            <Textarea
              {...field}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              rows={3}
              placeholder="e.g. confirmed with the owning team in #platform"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
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
  const { toast } = useToast();
  const user = useCurrentUser();
  // members + admins carry graph:write; wildcard `*` (dev-fallback admin)
  // grants everything. Anonymous / token-only principals lack it.
  const canWrite = user.capabilities.includes('graph:write') || user.capabilities.includes('*');
  const isAdmin = user.role === 'admin';
  const [editOpen, setEditOpen] = useState(false);

  const overrideActor = winningManualActor(prop);

  const verify = useMutation({
    mutationFn: () => verifyClaim(entityId, prop.property_key, prop.effective_value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['claims', entityId] }),
  });

  const revert = useMutation({
    // Non-admins may only revert their own claim (no targetActor). Admins
    // reverting someone else's pass `?actor=` via targetActor.
    mutationFn: (targetActor?: string) =>
      revertManualClaim(entityId, prop.property_key, targetActor),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['claims', entityId] });
      toast({ variant: 'ok', title: 'Manual override reverted' });
    },
    onError: (err) => toast({ variant: 'err', ...manualErrorToast(err) }),
  });

  const confirmRevert = (targetActor?: string) => {
    const who = targetActor ? `${targetActor}'s` : 'your';
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Revert ${who} manual override on "${prop.property_key}"?`)
    ) {
      return;
    }
    revert.mutate(targetActor);
  };

  // The revert affordance only makes sense when a manual override exists. A
  // member can revert their own; an admin can revert anyone's.
  const canRevertOwn = canWrite && overrideActor !== null && overrideActor === user.email;
  const canRevertAny = isAdmin && overrideActor !== null;
  const revertTarget = canRevertAny && overrideActor !== user.email ? overrideActor : undefined;
  const showRevert = canRevertOwn || canRevertAny;

  const editDialog = canWrite ? (
    <EditClaimDialog open={editOpen} onOpenChange={setEditOpen} entityId={entityId} prop={prop} />
  ) : null;

  const ManualBadge = overrideActor ? (
    <Badge size="sm" variant="purple" icon={<IconGlyph name="person" size={10} />}>
      manual · {overrideActor}
    </Badge>
  ) : null;

  // Compact view (catalog entity page): just the resolved value, status, and a
  // confidence %. Drops the strategy text, breakdown sentence, and the raw
  // per-source claim rows — the "Open in explorer" link surfaces those.
  if (compact) {
    const sources = Array.from(new Set(prop.claims.map((c) => sourceLabel(c.source))));
    return (
      <div className="border-border bg-panel-2 rounded-base flex flex-col gap-1.5 border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-text font-mono text-[13px]">{prop.property_key}</h3>
          <Badge size="sm" variant={STATUS_VARIANT[prop.status]}>
            {STATUS_LABEL[prop.status]}
          </Badge>
          {ManualBadge}
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
          <div className="ml-auto flex items-center gap-1">
            {canWrite && (
              <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>
                <IconGlyph name="edit" size={11} /> Edit
              </Button>
            )}
            {showRevert && (
              <Button
                variant="ghost"
                size="sm"
                disabled={revert.isPending}
                onClick={() => confirmRevert(revertTarget)}
              >
                <IconGlyph name="history" size={11} /> Revert
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={verify.isPending}
              onClick={() => verify.mutate()}
            >
              {prop.status === 'USER_VERIFIED' ? 'Re-verify' : 'Verify'}
            </Button>
          </div>
        </div>
        {editDialog}
      </div>
    );
  }

  return (
    <section className="border-border bg-panel-2 rounded-base flex flex-col gap-3 border p-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-text font-mono text-[14px]">{prop.property_key}</h3>
            <Badge size="sm" variant={STATUS_VARIANT[prop.status]}>
              {STATUS_LABEL[prop.status]}
            </Badge>
            {ManualBadge}
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
          <div className="flex items-center gap-2">
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <IconGlyph name="edit" size={12} /> Edit
              </Button>
            )}
            {showRevert && (
              <Button
                variant="outline"
                size="sm"
                disabled={revert.isPending}
                onClick={() => confirmRevert(revertTarget)}
              >
                <IconGlyph name="history" size={12} /> Revert
              </Button>
            )}
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
        </div>
      </header>
      <ul className="flex list-none flex-col gap-2 p-0">
        {prop.claims.map((c) => (
          <ClaimRow
            key={`${c.source}:${c.source_id}`}
            claim={c}
            isWinner={
              prop.winning_claim?.source === c.source &&
              prop.winning_claim?.source_id === c.source_id
            }
            strategy={prop.strategy}
          />
        ))}
      </ul>
      {editDialog}
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
