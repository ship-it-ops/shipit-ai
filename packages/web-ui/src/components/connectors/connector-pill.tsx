'use client';

import { Badge } from '@ship-it-ui/ui';
import { DynamicIconGlyph } from '@ship-it-ui/icons';
import type { ConnectorIdentity } from '@/lib/connector-identity';

interface ConnectorPillProps {
  identity: ConnectorIdentity;
  // When true, render only the short name (catalog table). When false, render
  // the long form 'GitHub · acme-prod' (entity detail / drawer).
  compact?: boolean;
  className?: string;
}

/**
 * Renders a node's source connector as a small badge with the connector's
 * icon + name. Visually dimmed when the connector instance can't be matched
 * against `/api/connectors` (deleted or pre-field-existed node), so users
 * can tell stale provenance at a glance.
 */
export function ConnectorPill({ identity, compact = false, className }: ConnectorPillProps) {
  const label = compact ? identity.shortName : identity.displayName;
  return (
    <Badge
      variant="neutral"
      className={
        // Unresolved (deleted/legacy connector) is dimmed via opacity — the
        // Badge has no muted variant, so the distinction is visual + title.
        // max-w-full + min-w-0 let the pill shrink inside a constrained cell so
        // a long source label ellipsizes instead of overflowing the card.
        'max-w-full min-w-0 font-mono text-[11px] ' +
        (identity.resolved ? '' : 'opacity-60 ') +
        (className ?? '')
      }
      title={identity.resolved ? identity.displayName : `${identity.displayName} (unresolved)`}
    >
      <DynamicIconGlyph
        name={identity.type}
        kind="connector"
        size={11}
        aria-hidden
        className="mr-[6px] shrink-0"
      />
      <span className="min-w-0 truncate">{label}</span>
    </Badge>
  );
}
