'use client';

import { Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { fetchConflicts, fetchEntityClaims, type ConflictRow, type EntityClaims } from '@/lib/api';
import { ClaimList } from '@/components/claims/claim-list';
import { ConflictTable } from '@/components/claims/conflict-table';

function ClaimExplorerContent() {
  const router = useRouter();
  const params = useSearchParams();
  const entity = params.get('entity');
  const property = params.get('property');

  const setEntity = useCallback(
    (entityId: string | null) => {
      const next = new URLSearchParams();
      if (entityId) next.set('entity', entityId);
      router.push(`/operations/claims${next.toString() ? '?' + next.toString() : ''}`);
    },
    [router],
  );

  return (
    <div className="mx-auto flex h-full max-w-[1200px] flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-text text-[22px] font-semibold tracking-tight">Claim Explorer</h1>
          <p className="text-text-muted mt-1 text-[13px]">
            {entity
              ? 'Per-property claims with provenance and resolution audit trail.'
              : 'Properties where multiple sources disagree. Click a row to drill into the resolution audit trail.'}
          </p>
        </div>
        {entity && (
          <Button variant="outline" size="sm" onClick={() => setEntity(null)}>
            <IconGlyph name="prev" size={12} /> Back to conflicts
          </Button>
        )}
      </header>

      {entity ? (
        <EntityClaimsView entityId={entity} highlightProperty={property} />
      ) : (
        <ConflictDashboard
          onSelect={(row) => {
            const next = new URLSearchParams();
            next.set('entity', row.entityId);
            next.set('property', row.propertyKey);
            router.push(`/operations/claims?${next.toString()}`);
          }}
        />
      )}
    </div>
  );
}

function ConflictDashboard({ onSelect }: { onSelect: (row: ConflictRow) => void }) {
  const { data, isLoading, error } = useQuery<ConflictRow[]>({
    queryKey: ['conflicts'],
    queryFn: () => fetchConflicts({ limit: 100 }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState
        tone="err"
        icon={<IconGlyph name="warn" size={22} />}
        title="Failed to load conflicts"
        description={(error as Error).message}
      />
    );
  }
  return <ConflictTable conflicts={data ?? []} onSelect={onSelect} />;
}

function EntityClaimsView({
  entityId,
  highlightProperty,
}: {
  entityId: string;
  highlightProperty: string | null;
}) {
  const { data, isLoading, error } = useQuery<EntityClaims>({
    queryKey: ['claims', entityId],
    queryFn: () => fetchEntityClaims(entityId),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (error || !data) {
    return (
      <EmptyState
        tone="err"
        icon={<IconGlyph name="warn" size={22} />}
        title="Failed to load entity claims"
        description={(error as Error | null)?.message ?? 'Entity not found.'}
      />
    );
  }

  const ordered = highlightProperty
    ? [...data.properties].sort((a, b) =>
        a.property_key === highlightProperty ? -1 : b.property_key === highlightProperty ? 1 : 0,
      )
    : data.properties;

  return <ClaimList data={{ ...data, properties: ordered }} />;
}

export default function ClaimExplorerPage() {
  // useSearchParams must live inside a Suspense boundary for streaming/SSG.
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ClaimExplorerContent />
    </Suspense>
  );
}
