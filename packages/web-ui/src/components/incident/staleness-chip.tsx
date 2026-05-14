'use client';

import { Badge, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from '@ship-it-ui/ui';

interface Props {
  /**
   * Server-computed age in seconds. Server-side because corporate-laptop
   * clock skew is real — `Date.now() - lastSynced` on the client is a
   * footgun.
   */
  ageSeconds: number | undefined;
  /** Override the default labels (e.g., "Synced", "Updated"). */
  prefix?: string;
}

const HOUR = 3600;
const DAY = 86400;

function formatAge(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < HOUR) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  return `${Math.floor(seconds / DAY)}d ago`;
}

/**
 * Renders a colored pill that shows when the underlying catalog data was
 * last refreshed by a connector. Three buckets:
 *   - <  6h  : ok    — we trust this
 *   - 6-24h  : warn  — getting old
 *   - > 24h  : err   — actively dangerous (stale on-call paged the wrong human)
 *
 * Important honesty constraint: the tooltip says "connector freshness" not
 * "data freshness". A repo that hasn't merged in 6 months still shows green
 * if its connector synced 5 minutes ago. The chip tells you when we last
 * looked, not when it last changed.
 */
export function StalenessChip({ ageSeconds, prefix = 'synced' }: Props) {
  if (ageSeconds === undefined || ageSeconds < 0) return null;

  const variant: 'ok' | 'warn' | 'err' =
    ageSeconds < 6 * HOUR ? 'ok' : ageSeconds < DAY ? 'warn' : 'err';

  const label = `${prefix} ${formatAge(ageSeconds)}`;

  return (
    <TooltipProvider delayDuration={300}>
      <TooltipRoot>
        <TooltipTrigger asChild>
          <Badge variant={variant} className="font-mono text-[10px]">
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          When the catalog connector last refreshed this data — not when the
          underlying state changed.
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
}
