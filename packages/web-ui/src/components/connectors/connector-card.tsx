'use client';

import { Badge, StatusDot, formatRelative, type StatusState } from '@ship-it-ui/ui';
import { DynamicIconGlyph } from '@ship-it-ui/icons';
import {
  connectorInfo,
  type Connector,
  type ConnectorInfo,
  type SyncRuntimeStatus,
} from '@/lib/api';

// Portrait-oriented connector card. Replaces the DS ConnectorCard (which
// is a horizontal list-row layout) so the Connector Hub reads as a tile
// grid: logo on top, name + org centered, status pinned to the corner,
// entity count + last-sync timestamp at the foot. Aspect ratio is fixed
// 4:5 (slightly taller than wide) so cells stay visually consistent
// regardless of the longest name.

const statusDotState: Record<ConnectorInfo['status'], StatusState> = {
  healthy: 'ok',
  degraded: 'sync',
  failed: 'err',
  not_connected: 'off',
};

const statusLabel: Record<ConnectorInfo['status'], string> = {
  healthy: 'Connected',
  degraded: 'Syncing',
  failed: 'Error',
  not_connected: 'Disconnected',
};

interface ConnectorCardProps {
  connector: Connector;
  runtime?: SyncRuntimeStatus | null;
  onClick: () => void;
}

export function ConnectorCard({ connector, runtime, onClick }: ConnectorCardProps) {
  const info = connectorInfo(connector, runtime ?? null);
  // For GitHub connectors the org is the most useful disambiguator —
  // multi-org setups have several `github · <org>` cards and the org
  // text is what users scan for.
  const subtitle = connector.type === 'github' ? connector.org : undefined;
  const time = info.lastSync ? formatRelative(info.lastSync, new Date()) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${connector.name} connector`}
      className={
        'rounded-base border-border bg-panel hover:bg-panel-2 focus-visible:ring-accent-dim ' +
        'flex aspect-[4/5] w-full flex-col items-center justify-between gap-3 ' +
        'cursor-pointer border p-5 text-center outline-none ' +
        'transition-colors duration-(--duration-micro) focus-visible:ring-[3px]'
      }
    >
      {/* Status dot pinned top-right — small, doesn't compete with logo */}
      <div className="flex w-full items-start justify-end">
        <StatusDot
          state={statusDotState[info.status]}
          pulse={info.status === 'degraded'}
          label={statusLabel[info.status]}
        />
      </div>

      {/* Logo + name + subtitle, vertically centered in the body */}
      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden
          className="bg-panel-2 grid h-16 w-16 shrink-0 place-items-center rounded-md"
        >
          <DynamicIconGlyph name={connector.type} kind="connector" size={36} />
        </span>
        <div className="flex flex-col items-center gap-[2px]">
          <span className="text-text line-clamp-2 text-[14px] leading-tight font-medium">
            {connector.name}
          </span>
          {subtitle && <span className="text-text-muted truncate text-[12px]">{subtitle}</span>}
        </div>
      </div>

      {/* Foot: entity count chip + last synced timestamp */}
      <div className="flex w-full flex-col items-center gap-1">
        <Badge variant="neutral" size="sm">
          {info.entityCount.toLocaleString()} entities
        </Badge>
        {time && <span className="text-text-dim font-mono text-[10px]">last synced {time}</span>}
      </div>
    </button>
  );
}
