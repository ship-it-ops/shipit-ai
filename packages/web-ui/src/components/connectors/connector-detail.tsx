'use client';

import { Button, Badge, Tabs, TabsList, Tab, TabsContent, type BadgeProps } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { ConnectorInfo } from '@/lib/api';

const statusVariant: Record<ConnectorInfo['status'], BadgeProps['variant']> = {
  healthy: 'ok',
  degraded: 'warn',
  failed: 'err',
  not_connected: 'neutral',
};

interface ConnectorDetailProps {
  connector: ConnectorInfo;
  onClose: () => void;
  onSync: () => void;
}

export function ConnectorDetail({ connector, onClose, onSync }: ConnectorDetailProps) {
  return (
    <aside
      className="bg-panel border-border z-overlay fixed inset-y-0 right-0 w-96 border-l shadow-lg"
      aria-label={`${connector.name} details`}
    >
      <div className="border-border flex items-center justify-between border-b p-4">
        <h3 className="text-text text-[14px] font-semibold">{connector.name}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-text-dim hover:text-text rounded-sm p-1 leading-none"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant[connector.status]}>
            {connector.status.replace('_', ' ')}
          </Badge>
          <span className="text-text-muted text-[12px]">
            {connector.entityCount.toLocaleString()} entities
          </span>
        </div>

        <Tabs defaultValue="overview" variant="underline">
          <TabsList>
            <Tab value="overview">Overview</Tab>
            <Tab value="sync">Sync history</Tab>
          </TabsList>

          <TabsContent value="overview">
            <dl className="flex flex-col gap-3 pt-3 text-[13px]">
              <Row label="Type" value={<span className="capitalize">{connector.type}</span>} />
              <Row
                label="Last sync"
                value={
                  connector.lastSync ? new Date(connector.lastSync).toLocaleString() : 'Never'
                }
              />
              {connector.nextSync && (
                <Row label="Next sync" value={new Date(connector.nextSync).toLocaleString()} />
              )}
            </dl>
          </TabsContent>

          <TabsContent value="sync">
            <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-3 text-[12px]">
              <li className="bg-panel-2 border-border flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-text">Full sync</span>
                <span className="text-text-dim font-mono">
                  {connector.lastSync ? new Date(connector.lastSync).toLocaleString() : 'N/A'}
                </span>
              </li>
            </ul>
          </TabsContent>
        </Tabs>

        <Button
          fullWidth
          icon={<IconGlyph name="refresh" />}
          onClick={onSync}
          disabled={connector.status === 'not_connected'}
        >
          Re-sync now
        </Button>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[2px]">
      <dt className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">{label}</dt>
      <dd className="text-text m-0">{value}</dd>
    </div>
  );
}
