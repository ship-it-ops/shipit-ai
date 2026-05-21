'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { ConnectorCard } from '@/components/connectors/connector-card';
import { ConnectorDetailDrawer } from '@/components/connectors/connector-detail-drawer';
import {
  AddConnectorPicker,
  type ConnectorTypeId,
} from '@/components/connectors/add-connector-picker';
import { AddGitHubConnectorWizard } from '@/components/connectors/add-github-connector-wizard';
import { useConnectors } from '@/lib/hooks/use-connectors';

export default function ConnectorHubPage() {
  const { data: connectors = [] } = useConnectors();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Two-stage entry: picker → type-specific wizard. `activeWizard` holds
  // the picked type (currently only 'github' resolves to a real flow);
  // setting it to null returns to "no dialog open" rather than reopening
  // the picker, so a cancelled wizard doesn't bounce back to selection.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeWizard, setActiveWizard] = useState<ConnectorTypeId | null>(null);

  // Auto-open the GitHub wizard when the user lands here after the App
  // manifest callback — `?from=app-manifest` is the breadcrumb the
  // callback page sets. The wizard's polling picks up the now-configured
  // global App on the first refresh.
  useEffect(() => {
    if (searchParams.get('from') === 'app-manifest') {
      setActiveWizard('github');
    }
  }, [searchParams]);

  const handlePick = (type: ConnectorTypeId) => {
    // The picker disables non-available types, so this is reached only
    // for connectors that have a wizard. Belt-and-suspenders guard so a
    // future enum addition can't silently no-op.
    if (type === 'github') {
      setPickerOpen(false);
      setActiveWizard('github');
    }
  };

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-text text-[22px] font-semibold tracking-tight">Connector Hub</h1>
          <p className="text-text-muted text-[13px]">Manage your data source integrations</p>
        </div>
        <Button icon={<IconGlyph name="add" />} onClick={() => setPickerOpen(true)}>
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

      {selectedId && (
        <ConnectorDetailDrawer connectorId={selectedId} onClose={() => setSelectedId(null)} />
      )}

      <AddConnectorPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={handlePick} />
      <AddGitHubConnectorWizard
        open={activeWizard === 'github'}
        onOpenChange={(open) => {
          if (!open) setActiveWizard(null);
        }}
      />
    </div>
  );
}

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
        Connectors pull data from external systems — GitHub, Kubernetes, Datadog, and more — into
        your knowledge graph. GitHub is available today; the others are on the roadmap. Pick a
        source from the dialog above to get started.
      </p>
    </div>
  );
}
