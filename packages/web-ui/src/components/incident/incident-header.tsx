'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Spinner } from '@ship-it-ui/ui';
import { DynamicIconGlyph, IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta, StalenessChip } from '@ship-it-ui/shipit';
import { EntitySearchBox } from '@/components/search/entity-search-box';
import {
  type ServiceNode,
  serviceContext,
  repositoriesFor,
  deploymentsFor,
} from '@/lib/incident/derivations';
import {
  getDeploymentLinks,
  getRepositoryLinks,
  getServiceDashboardLinks,
} from '@/lib/integrations';
import type { GraphData } from '@/lib/api';

interface Props {
  serviceId: string;
  service: ServiceNode | undefined;
  /** Depth-1 neighborhood — used to resolve repo + deployment deeplinks. */
  neighborhood: GraphData | undefined;
  /** Combined oldest-sync across all panels. */
  pageOldestSyncAgeSeconds: number | undefined;
  loading?: boolean;
}

// Map integration ids to icon names from @ship-it-ui/icons. Brand glyphs exist
// for the major sources; everything else falls through to DynamicIconGlyph's
// text fallback. Integration ids come from server data, so we resolve via
// DynamicIconGlyph rather than the strictly-typed IconGlyph.
const INTEGRATION_ICON: Record<string, string> = {
  github: 'github',
  datadog: 'datadog',
  kubernetes: 'kubernetes',
  pagerduty: 'pagerduty',
  slack: 'mention',
};

/**
 * Sticky header for the incident dashboard.
 *
 * Layout: [back] · service icon + name + tier + env + lifecycle ·
 * [staleness chip] · [3 deeplink buttons] · [copy link] · [switch service]
 *
 * Mobile collapses to one line + horizontally-scrolling deeplink row.
 */
export function IncidentHeader({
  serviceId,
  service,
  neighborhood,
  pageOldestSyncAgeSeconds,
  loading,
}: Props) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  const meta = getEntityTypeMeta(service?.type ?? 'LogicalService');
  const tier = service?.tier;
  const tierVariant = tier === 1 ? 'err' : tier === 2 ? 'warn' : 'neutral';

  const handleCopy = useCallback(async () => {
    try {
      const url = `${window.location.origin}/incidents/${encodeURIComponent(serviceId)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied by browser permissions — fail silently.
    }
  }, [serviceId]);

  // Resolve deeplinks via the integration registry. Each adapter only
  // returns a URL when configured, so the buttons rendered here are exactly
  // the ones that will work for the current customer's toolchain.
  const ctx = service ? serviceContext(service) : null;
  const repos = neighborhood ? repositoriesFor(neighborhood, serviceId) : [];
  const deployments = neighborhood ? deploymentsFor(neighborhood, serviceId) : [];

  const deeplinks = ctx
    ? [
        ...getServiceDashboardLinks(ctx),
        ...repos.flatMap((r) => getRepositoryLinks(r)),
        ...deployments.flatMap((d) => getDeploymentLinks(d)),
      ]
    : [];

  const ageForChip = service?.lastSyncedAgeSeconds ?? pageOldestSyncAgeSeconds;

  return (
    <header className="border-border bg-bg sticky top-0 z-20 flex flex-col gap-3 border-b px-6 py-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => router.push('/incidents')}
          className="text-text-muted hover:text-text inline-flex items-center gap-1 text-[12px]"
        >
          <IconGlyph name="prev" size={11} />
          Incident Mode
        </button>

        <div className="hidden max-w-md min-w-0 flex-1 sm:block">
          <EntitySearchBox
            size="sm"
            preferLabel="LogicalService"
            placeholder="Switch service…"
            onSelect={(r) => router.push(`/incidents/${encodeURIComponent(r.id)}`)}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={<IconGlyph name={copied ? 'check' : 'external'} size={11} />}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className={
            'rounded-base grid h-12 w-12 shrink-0 place-items-center leading-none ' +
            meta.toneBg +
            ' ' +
            meta.toneClass
          }
        >
          <DynamicIconGlyph name={meta.iconName} size={24} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-text truncate text-[20px] font-semibold tracking-tight">
              {service?.name ?? (loading ? 'Loading…' : serviceId)}
            </h1>
            {tier !== undefined && (
              <Badge variant={tierVariant} className="font-mono text-[10px]">
                T{tier}
              </Badge>
            )}
            {service?.environment && (
              <Badge variant="neutral" className="font-mono text-[10px]">
                {service.environment}
              </Badge>
            )}
            {service?.lifecycle && (
              <Badge variant="neutral" className="font-mono text-[10px]">
                {service.lifecycle}
              </Badge>
            )}
            {loading && <Spinner size="sm" />}
            {ageForChip !== undefined && ageForChip >= 0 && (
              <StalenessChip
                ageSeconds={ageForChip}
                prefix="Synced"
                tooltip="When the catalog connector last refreshed this data — not when the underlying state changed."
              />
            )}
          </div>
          <span className="text-text-dim truncate font-mono text-[11px]">{serviceId}</span>
        </div>
      </div>

      {deeplinks.length > 0 && (
        <div className="-mx-1 flex flex-wrap gap-2 overflow-x-auto pb-1">
          {deeplinks.map((link) => (
            <a
              key={`${link.integrationId}-${link.url}`}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="border-border hover:bg-panel-2 inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-[12px]"
            >
              <DynamicIconGlyph
                name={INTEGRATION_ICON[link.integrationId] ?? 'external'}
                size={12}
              />
              <span className="text-text font-medium">{link.integrationName}</span>
              <IconGlyph name="external" size={10} />
            </a>
          ))}
        </div>
      )}
    </header>
  );
}
