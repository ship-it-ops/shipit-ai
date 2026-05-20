'use client';

import { Badge } from '@ship-it-ui/ui';
import { ConnectorCard as DSConnectorCard, type ConnectorStatus } from '@ship-it-ui/shipit';
import type { ConnectorInfo } from '@/lib/api';

const statusMap: Record<ConnectorInfo['status'], ConnectorStatus> = {
  healthy: 'connected',
  degraded: 'syncing',
  failed: 'error',
  not_connected: 'disconnected',
};

interface ConnectorCardProps {
  connector: ConnectorInfo;
  onClick: () => void;
}

export function ConnectorCard({ connector, onClick }: ConnectorCardProps) {
  return (
    <DSConnectorCard
      connector={connector.type}
      name={connector.name}
      status={statusMap[connector.status]}
      lastSyncedAt={connector.lastSync ?? undefined}
      summary={
        <Badge variant="neutral" size="sm">
          {connector.entityCount.toLocaleString()} entities
        </Badge>
      }
      onClick={onClick}
    />
  );
}
