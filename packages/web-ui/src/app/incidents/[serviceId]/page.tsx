'use client';

import { useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { EntitySearchBox } from '@/components/search/entity-search-box';
import { IncidentBlastRadiusTable } from '@/components/incident/incident-blast-radius-table';
import { IncidentDependencies } from '@/components/incident/incident-dependencies';
import { IncidentFooter } from '@/components/incident/incident-footer';
import { IncidentHeader } from '@/components/incident/incident-header';
import { IncidentMonitors } from '@/components/incident/incident-monitors';
import { IncidentRecentChanges } from '@/components/incident/incident-recent-changes';
import { IncidentResponders } from '@/components/incident/incident-responders';
import { IncidentSafetyVerdict } from '@/components/incident/incident-safety-verdict';
import { PanelErrorBoundary } from '@/components/incident/panel-error-boundary';
import { recordIncidentView } from '@/lib/api';
import { useIncidentContext } from '@/lib/hooks/use-incident-context';
import { useRecentlyViewed } from '@/lib/hooks/use-recently-viewed';
import {
  directDependencies,
  directDependents,
  findService,
  monitorsFor,
  oldestSyncAgeSeconds,
  rankedBlastRadius,
  recentChanges,
  responders,
} from '@/lib/incident/derivations';

/**
 * Decode a `[serviceId]` URL segment back to the canonical id. Same pattern
 * as `/catalog/[id]/page.tsx` — App Router gives us the raw segment, and
 * `shipit://...` ids carry `://` and `/` that have to round-trip through
 * `decodeURIComponent` for downstream lookups to find the node.
 */
function decodeServiceId(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  const segment = Array.isArray(raw) ? raw[0] : raw;
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default function IncidentDashboardPage() {
  const router = useRouter();
  const params = useParams<{ serviceId: string }>();
  const serviceId = decodeServiceId(params?.serviceId);

  const ctx = useIncidentContext(serviceId ?? undefined);
  const { neighborhood, blast, claims } = ctx;

  // ─────────────────────────────────────────────────────────────────────────
  // Pure derivations — every panel reads from the same in-memory shape.
  // ─────────────────────────────────────────────────────────────────────────
  const service = useMemo(
    () => (serviceId ? findService(neighborhood.data, serviceId) : undefined),
    [neighborhood.data, serviceId],
  );
  const upstream = useMemo(
    () => (serviceId ? directDependencies(neighborhood.data, serviceId) : []),
    [neighborhood.data, serviceId],
  );
  const downstream = useMemo(
    () => (serviceId ? directDependents(neighborhood.data, serviceId) : []),
    [neighborhood.data, serviceId],
  );
  const changes = useMemo(
    () => (serviceId ? recentChanges(neighborhood.data, serviceId, 5) : []),
    [neighborhood.data, serviceId],
  );
  const monitors = useMemo(
    () => (serviceId ? monitorsFor(neighborhood.data, serviceId) : []),
    [neighborhood.data, serviceId],
  );
  const respondersData = useMemo(
    () =>
      serviceId
        ? responders(neighborhood.data, serviceId)
        : { onCall: [], owningTeams: [], codeOwners: { teams: [], people: [] } },
    [neighborhood.data, serviceId],
  );
  const blastRanked = useMemo(
    () => (serviceId ? rankedBlastRadius(blast.data, serviceId) : []),
    [blast.data, serviceId],
  );
  const pageOldest = useMemo(
    () => oldestSyncAgeSeconds(neighborhood.data?.nodes ?? []),
    [neighborhood.data],
  );

  // Track the visit for the landing-page "recently viewed" list and for
  // server-side adoption analytics.
  const { add } = useRecentlyViewed();
  useEffect(() => {
    if (!serviceId) return;
    if (!service) return;
    add({ id: serviceId, name: service.name, type: service.type });
    void recordIncidentView(serviceId);
  }, [serviceId, service, add]);

  // ─────────────────────────────────────────────────────────────────────────
  // States that bypass the panel layout
  // ─────────────────────────────────────────────────────────────────────────
  if (!serviceId) {
    return (
      <div className="p-6">
        <EmptyState
          tone="err"
          icon={<IconGlyph name="warn" size={22} />}
          title="Missing service id"
          description="The URL didn't include a catalog service id."
          action={
            <Button variant="outline" size="sm" onClick={() => router.push('/incidents')}>
              Back to Incident Mode
            </Button>
          }
        />
      </div>
    );
  }

  if (neighborhood.isLoading && !neighborhood.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // 404 / typo case — service id valid format but not in the catalog.
  if (!neighborhood.isLoading && !service) {
    return (
      <div className="p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <EmptyState
            tone="warn"
            icon={<IconGlyph name="warn" size={22} />}
            title="Service not in catalog"
            description={`No catalog entity matches "${serviceId}". It may have been removed since the catalog was last synced, or this URL is from a different environment.`}
          />
          <div>
            <h2 className="text-text-dim mb-2 font-mono text-[10px] tracking-[1.4px] uppercase">
              Try searching
            </h2>
            <EntitySearchBox
              autoFocus
              size="lg"
              preferLabel="LogicalService"
              placeholder="Search by service name…"
              onSelect={(r) => router.push(`/incidents/${encodeURIComponent(r.id)}`)}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => router.push('/incidents')}>
            Back to Incident Mode
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <IncidentHeader
        serviceId={serviceId}
        service={service}
        neighborhood={neighborhood.data}
        pageOldestSyncAgeSeconds={pageOldest}
        loading={neighborhood.isFetching}
      />

      <main className="flex flex-col gap-4 px-6 py-6">
        <PanelErrorBoundary title="Safety verdict">
          <IncidentSafetyVerdict
            service={service}
            blast={blastRanked}
            claims={claims.data}
            loading={blast.isLoading}
          />
        </PanelErrorBoundary>

        <div className="grid gap-4 lg:grid-cols-2">
          <PanelErrorBoundary title="Responders">
            <IncidentResponders
              service={service}
              responders={respondersData}
              loading={neighborhood.isLoading}
            />
          </PanelErrorBoundary>

          <PanelErrorBoundary title="Recent changes">
            <IncidentRecentChanges entries={changes} />
          </PanelErrorBoundary>
        </div>

        <PanelErrorBoundary title="Blast radius">
          <IncidentBlastRadiusTable
            serviceId={serviceId}
            serviceName={service?.name}
            blast={blast.data}
            loading={blast.isLoading}
            error={blast.error ?? null}
            truncated={blast.data?.truncated}
          />
        </PanelErrorBoundary>

        <div className="grid gap-4 lg:grid-cols-2">
          <PanelErrorBoundary title="Direct dependencies">
            <IncidentDependencies upstream={upstream} downstream={downstream} />
          </PanelErrorBoundary>

          <PanelErrorBoundary title="Monitors">
            <IncidentMonitors monitors={monitors} />
          </PanelErrorBoundary>
        </div>
      </main>

      <IncidentFooter service={service} responders={respondersData} />
    </div>
  );
}
