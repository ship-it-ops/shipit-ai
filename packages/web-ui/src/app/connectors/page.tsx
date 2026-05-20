'use client';

import { useState } from 'react';
import { Button } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { ConnectorCard } from '@/components/connectors/connector-card';
import { ConnectorDetail } from '@/components/connectors/connector-detail';
import { AddConnectorDialog } from '@/components/connectors/add-connector-dialog';
import { useConnectors, useTriggerSync } from '@/lib/hooks/use-connectors';

export default function ConnectorHubPage() {
  const { data: connectors = [] } = useConnectors();
  const syncMutation = useTriggerSync();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const selectedConnector = connectors.find((c) => c.id === selectedId);

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-text text-[22px] font-semibold tracking-tight">Connector Hub</h1>
          <p className="text-text-muted text-[13px]">Manage your data source integrations</p>
        </div>
        <Button icon={<IconGlyph name="add" />} onClick={() => setAddDialogOpen(true)}>
          Add connector
        </Button>
      </header>

      {connectors.length === 0 ? (
        <EmptyConnectorsHint />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {connectors.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              onClick={() => setSelectedId(connector.id)}
            />
          ))}
        </div>
      )}

      {selectedConnector && (
        <ConnectorDetail
          connector={selectedConnector}
          onClose={() => setSelectedId(null)}
          onSync={() => syncMutation.mutate(selectedConnector.id)}
        />
      )}

      <AddConnectorDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </div>
  );
}

// The "Add connector" button sits in the header's top-right. The hint nudges
// toward that corner with an up-right arrow so the user's eye lands on the
// only primary action on the page.
function EmptyConnectorsHint() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <div className="text-text flex items-center gap-2 text-[15px] font-medium">
        Add your first connector
        <span className="text-accent inline-flex translate-y-[-1px]" aria-hidden>
          <IconGlyph name="upRight" size={22} />
        </span>
      </div>
      <p className="text-text-muted max-w-sm text-[12px]">
        Connectors pull data from GitHub, Kubernetes, Datadog, and other tools into your knowledge
        graph. Start with whichever owns the most of your service catalog.
      </p>
    </div>
  );
}
