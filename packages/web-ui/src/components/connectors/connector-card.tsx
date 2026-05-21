'use client';

import { Badge } from '@ship-it-ui/ui';
import { ConnectorCard as DSConnectorCard, type ConnectorStatus } from '@ship-it-ui/shipit';
import {
  connectorInfo,
  type Connector,
  type ConnectorInfo,
  type SyncRuntimeStatus,
} from '@/lib/api';

// Display-status mapping for the design-system component. Local — the card
// shouldn't leak the backend's runtime enum (idle/running/failed/degraded)
// into the rest of the app.
const statusMap: Record<ConnectorInfo['status'], ConnectorStatus> = {
  healthy: 'connected',
  degraded: 'syncing',
  failed: 'error',
  not_connected: 'disconnected',
};

interface ConnectorCardProps {
  connector: Connector;
  runtime?: SyncRuntimeStatus | null;
  onClick: () => void;
}

export function ConnectorCard({ connector, runtime, onClick }: ConnectorCardProps) {
  const info = connectorInfo(connector, runtime ?? null);
  // For GitHub connectors show the org alongside the name so multi-org
  // setups stay readable at a glance.
  const subtitle = connector.type === 'github' ? connector.org : undefined;
  return (
    <DSConnectorCard
      connector={connector.type}
      name={subtitle ? `${connector.name} · ${subtitle}` : connector.name}
      status={statusMap[info.status]}
      lastSyncedAt={info.lastSync ?? undefined}
      summary={
        <Badge variant="neutral" size="sm">
          {info.entityCount.toLocaleString()} entities
        </Badge>
      }
      onClick={onClick}
    />
  );
}
