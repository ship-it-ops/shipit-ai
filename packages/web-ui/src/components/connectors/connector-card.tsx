'use client';

import { Card, StatusDot, Badge, type StatusState } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { ConnectorInfo } from '@/lib/api';

const connectorGlyph: Record<string, string> = {
  github: 'github',
  kubernetes: 'kubernetes',
  datadog: 'datadog',
  backstage: 'backstage',
  jira: 'tag',
  identity: 'person',
};

const statusMap: Record<ConnectorInfo['status'], { state: StatusState; label: string }> = {
  healthy: { state: 'ok', label: 'Healthy' },
  degraded: { state: 'warn', label: 'Degraded' },
  failed: { state: 'err', label: 'Failed' },
  not_connected: { state: 'off', label: 'Not connected' },
};

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface ConnectorCardProps {
  connector: ConnectorInfo;
  onClick: () => void;
}

export function ConnectorCard({ connector, onClick }: ConnectorCardProps) {
  const status = statusMap[connector.status];
  const glyph = connectorGlyph[connector.type] ?? 'document';

  return (
    <Card interactive onClick={onClick}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="bg-panel-2 text-text-muted grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
        >
          <IconGlyph name={glyph} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-text truncate text-[14px] font-medium">{connector.name}</h3>
            <StatusDot state={status.state} label={status.label} />
          </div>
          <div className="text-text-muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span>Last sync: {formatRelativeTime(connector.lastSync)}</span>
            <Badge variant="neutral" size="sm">
              {connector.entityCount.toLocaleString()} entities
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
}
