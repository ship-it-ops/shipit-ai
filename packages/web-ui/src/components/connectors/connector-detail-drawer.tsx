'use client';

// Right-side drawer for one connector instance. Tabs: Overview / Runs /
// Scope / Settings. The Scope tab is ETag-aware — edits route through
// patchConnector with the hash from the most recent fetch, and a 409
// surfaces as a "discard + reload" banner. Webhook deliveries tab lands in
// P1 alongside the webhook receiver.

import { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  Spinner,
  Tab,
  Tabs,
  TabsContent,
  TabsList,
  useToast,
  type BadgeProps,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  EtagConflictError,
  connectorInfo,
  type Connector,
  type ConnectorRun,
  type ConnectorScope,
  type SyncRuntimeStatus,
} from '@/lib/api';
import {
  useConnector,
  useConnectorRuns,
  useConnectorStatus,
  useDeleteConnector,
  usePatchConnector,
  useTriggerSync,
} from '@/lib/hooks/use-connectors';

const statusVariant: Record<string, BadgeProps['variant']> = {
  healthy: 'ok',
  degraded: 'warn',
  failed: 'err',
  not_connected: 'neutral',
  idle: 'neutral',
  running: 'warn',
};

interface ConnectorDetailDrawerProps {
  connectorId: string;
  onClose: () => void;
}

export function ConnectorDetailDrawer({ connectorId, onClose }: ConnectorDetailDrawerProps) {
  const { data, isPending } = useConnector(connectorId);
  const { data: runsData } = useConnectorRuns(connectorId);
  const { data: status } = useConnectorStatus(connectorId);
  const triggerSync = useTriggerSync();
  const deleteConn = useDeleteConnector();
  const { toast } = useToast();

  return (
    <aside
      className="bg-panel border-border z-overlay fixed inset-y-0 right-0 w-[460px] border-l shadow-lg"
      aria-label={data ? `${data.connector.name} details` : 'Connector details'}
    >
      <div className="border-border flex items-center justify-between border-b p-4">
        <h3 className="text-text text-[14px] font-semibold">
          {data?.connector.name ?? 'Loading…'}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-text-dim hover:text-text rounded-sm p-1 leading-none"
        >
          ×
        </button>
      </div>

      {isPending && (
        <div className="flex items-center justify-center p-8">
          <Spinner />
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <HeaderRow connector={data.connector} runtime={status ?? null} />
          <Tabs defaultValue="overview" variant="underline">
            <TabsList>
              <Tab value="overview">Overview</Tab>
              <Tab value="runs">Runs</Tab>
              <Tab value="scope">Scope</Tab>
              <Tab value="settings">Settings</Tab>
            </TabsList>

            <TabsContent value="overview">
              <OverviewTab
                connector={data.connector}
                runtime={status ?? null}
                onSync={() => triggerSync.mutate(data.connector.id)}
                syncing={triggerSync.isPending}
              />
            </TabsContent>

            <TabsContent value="runs">
              <RunsTab runs={runsData?.runs ?? []} />
            </TabsContent>

            <TabsContent value="scope">
              <ScopeTab connector={data.connector} hash={data.hash} />
            </TabsContent>

            <TabsContent value="settings">
              <SettingsTab
                connector={data.connector}
                hash={data.hash}
                onDelete={async () => {
                  if (
                    !confirm(`Delete connector "${data.connector.name}"? This cannot be undone.`)
                  ) {
                    return;
                  }
                  try {
                    await deleteConn.mutateAsync({
                      id: data.connector.id,
                      ifMatch: data.hash ?? undefined,
                    });
                    toast({ variant: 'ok', title: 'Connector deleted' });
                    onClose();
                  } catch (err) {
                    toast({
                      variant: 'err',
                      title: 'Delete failed',
                      description: (err as Error).message,
                    });
                  }
                }}
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </aside>
  );
}

function HeaderRow({
  connector,
  runtime,
}: {
  connector: Connector;
  runtime: SyncRuntimeStatus | null;
}) {
  const info = connectorInfo(connector, runtime);
  const isRunning = runtime?.state === 'running';
  return (
    <div className="flex items-center gap-2">
      {!isRunning && (
        <Badge variant={statusVariant[info.status] ?? 'neutral'}>
          {info.status.replace('_', ' ')}
        </Badge>
      )}
      {isRunning && (
        <Badge variant="warn">
          <Spinner size="sm" /> syncing
        </Badge>
      )}
      <span className="text-text-muted text-[12px]">
        {info.entityCount.toLocaleString()} entities · {connector.org}
      </span>
    </div>
  );
}

function OverviewTab({
  connector,
  runtime,
  onSync,
  syncing,
}: {
  connector: Connector;
  runtime: SyncRuntimeStatus | null;
  onSync: () => void;
  syncing: boolean;
}) {
  const lastRun = connector.lastRuns[0];
  // Determine display string for the GitHub App backing this connector:
  // "global" when no override exists, or "App <id> (override)" when one
  // does. Useful at a glance in multi-App setups.
  const appLabel = connector.app
    ? `${connector.app.id ?? '(global id)'} (override)`
    : 'global (env vars)';
  return (
    <div className="flex flex-col gap-4 pt-3">
      <dl className="flex flex-col gap-3 text-[13px]">
        <Row label="Installation" value={connector.installationId} />
        <Row label="GitHub App" value={appLabel} />
        <Row label="Schedule" value={<code>{connector.schedule}</code>} />
        <Row
          label="Last sync"
          value={lastRun ? new Date(lastRun.startedAt).toLocaleString() : 'Never'}
        />
        {runtime?.lastError && (
          <Row label="Last error" value={<span className="text-err">{runtime.lastError}</span>} />
        )}
      </dl>
      <div className="flex gap-2">
        <Button
          icon={<IconGlyph name="refresh" />}
          onClick={onSync}
          disabled={syncing || !connector.enabled}
        >
          {syncing ? 'Queuing…' : 'Sync now'}
        </Button>
      </div>
    </div>
  );
}

function RunsTab({ runs }: { runs: ConnectorRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="text-text-muted py-4 text-center text-[12px]">
        No runs yet. Trigger one from Overview.
      </div>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-3 text-[12px]">
      {runs.map((r) => (
        <li
          key={r.startedAt}
          className="bg-panel-2 border-border flex flex-col gap-1 rounded-md border px-3 py-2"
        >
          <div className="flex items-center justify-between">
            <Badge
              variant={r.status === 'success' ? 'ok' : r.status === 'partial' ? 'warn' : 'err'}
            >
              {r.status}
            </Badge>
            <span className="text-text-dim font-mono">
              {new Date(r.startedAt).toLocaleString()} · {Math.round(r.durationMs / 100) / 10}s
            </span>
          </div>
          <div className="text-text-muted">{r.entitiesSynced.toLocaleString()} entities synced</div>
          {r.errors.length > 0 && (
            <details className="mt-1">
              <summary className="text-err cursor-pointer">{r.errors.length} error(s)</summary>
              <pre className="bg-panel mt-1 max-h-32 overflow-auto rounded p-2 text-[11px]">
                {r.errors.join('\n')}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function ScopeTab({ connector, hash }: { connector: Connector; hash: string | null }) {
  const patch = usePatchConnector();
  const { toast } = useToast();
  const [scope, setScope] = useState<ConnectorScope>(connector.scope);
  const [conflict, setConflict] = useState<string | null>(null);

  // Reset local edits whenever the server-side connector refreshes (e.g.
  // another writer edited the same connector while this drawer was open).
  useEffect(() => {
    setScope(connector.scope);
    setConflict(null);
  }, [connector.scope, connector.id]);

  const handleSave = async () => {
    try {
      await patch.mutateAsync({
        id: connector.id,
        input: { scope },
        ifMatch: hash ?? undefined,
      });
      toast({ variant: 'ok', title: 'Scope updated' });
    } catch (err) {
      if (err instanceof EtagConflictError) {
        setConflict(
          'Another writer changed this connector. Reload to see the latest scope, then re-apply your edits.',
        );
      } else {
        toast({ variant: 'err', title: 'Save failed', description: (err as Error).message });
      }
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-3 text-[13px]">
      {conflict && <Banner tone="err">{conflict}</Banner>}
      <Field label="Include patterns" hint="One glob per line.">
        {(p) => (
          <Input
            {...p}
            value={scope.repos.include.join('\n')}
            onChange={(e) =>
              setScope({
                ...scope,
                repos: { ...scope.repos, include: e.target.value.split('\n').filter(Boolean) },
              })
            }
          />
        )}
      </Field>
      <Field label="Exclude patterns" hint="Optional.">
        {(p) => (
          <Input
            {...p}
            value={scope.repos.exclude.join('\n')}
            onChange={(e) =>
              setScope({
                ...scope,
                repos: { ...scope.repos, exclude: e.target.value.split('\n').filter(Boolean) },
              })
            }
          />
        )}
      </Field>
      <Checkbox
        label="Remove safety cap"
        checked={scope.cappedAcknowledged}
        onCheckedChange={(checked) => {
          const v = checked === true;
          setScope({ ...scope, cappedAcknowledged: v, cappedAt: v ? null : 100 });
        }}
      />
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={patch.isPending}>
          {patch.isPending ? 'Saving…' : 'Save scope'}
        </Button>
      </div>
    </div>
  );
}

function SettingsTab({
  connector,
  hash,
  onDelete,
}: {
  connector: Connector;
  hash: string | null;
  onDelete: () => void;
}) {
  const patch = usePatchConnector();
  const { toast } = useToast();
  const [name, setName] = useState(connector.name);
  const [schedule, setSchedule] = useState(connector.schedule);
  const [enabled, setEnabled] = useState(connector.enabled);

  useEffect(() => {
    setName(connector.name);
    setSchedule(connector.schedule);
    setEnabled(connector.enabled);
  }, [connector]);

  const handleSave = async () => {
    try {
      await patch.mutateAsync({
        id: connector.id,
        input: { name, schedule, enabled },
        ifMatch: hash ?? undefined,
      });
      toast({ variant: 'ok', title: 'Settings updated' });
    } catch (err) {
      toast({ variant: 'err', title: 'Save failed', description: (err as Error).message });
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-3 text-[13px]">
      <Field label="Display name">
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Cron schedule" hint="Polling cadence as a 5-field cron string.">
        {(p) => <Input {...p} value={schedule} onChange={(e) => setSchedule(e.target.value)} />}
      </Field>
      <Checkbox label="Enabled" checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} />
      <div className="flex justify-between gap-2 pt-2">
        <Button variant="ghost" onClick={onDelete}>
          Delete connector…
        </Button>
        <Button onClick={handleSave} disabled={patch.isPending}>
          {patch.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
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
