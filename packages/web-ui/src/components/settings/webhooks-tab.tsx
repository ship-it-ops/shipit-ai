'use client';

// Admin-only GitHub webhook management (T7 of admin-portal-settings). Lists
// each connector's App identity, whether a secret is configured, and the
// last verified delivery the receiver has seen. The "Set up" / "Rotate"
// action mints a fresh secret on the server and reveals it once in a
// dialog — the portal is the source of truth, so the admin copies the
// secret + numbered steps into the GitHub App. Non-admins never reach this
// (the page hides the tab), but the server also 403s them.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, EmptyState, Spinner, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  fetchPortalSettings,
  setConnectorWebhookSecret,
  type WebhookConnectorStatus,
  type WebhookSecretResult,
} from '@/lib/api';

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      icon={<IconGlyph name={copied ? 'check' : 'copy'} />}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function WebhooksTab() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['portal-settings'],
    queryFn: fetchPortalSettings,
    retry: false,
  });

  // Dialog state for the revealed secret. We keep the connectorId around so
  // the title can name the App, and the action label so the copy-warning
  // copy reads right for a rotate.
  const [reveal, setReveal] = useState<WebhookSecretResult | null>(null);

  if (settingsQuery.isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center gap-2 py-8">
          <Spinner size="sm" />
          <span className="text-text-dim text-[12px]">Loading webhook settings…</span>
        </div>
      </Card>
    );
  }

  if (settingsQuery.error) {
    return (
      <EmptyState
        tone="accent"
        icon={<IconGlyph name="bolt" size={22} />}
        title="Webhook settings aren't available"
        description={(settingsQuery.error as Error).message}
      />
    );
  }

  const data = settingsQuery.data!;
  const connectors = data.webhooks;

  return (
    <div className="flex flex-col gap-4">
      <Card title="Receiver URL">
        <p className="text-text-muted mb-3 text-[12px]">
          Paste this Payload URL into each GitHub App&apos;s webhook settings. All connectors share
          this single endpoint — the per-App secret is what routes and verifies each delivery.
        </p>
        <div className="flex items-center gap-2">
          <code className="border-border bg-panel-2 text-text min-w-0 flex-1 truncate rounded border p-2 font-mono text-[12px]">
            {data.webhookUrl}
          </code>
          <CopyButton value={data.webhookUrl} />
        </div>
      </Card>

      <Card title="Connectors">
        {connectors.length === 0 ? (
          <p className="text-text-dim m-0 text-[12px]">
            No connectors yet. Add a GitHub connector to configure its webhook.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {connectors.map((c) => (
              <ConnectorRow
                key={c.connectorId}
                connector={c}
                onRevealed={(result) => {
                  setReveal(result);
                  queryClient.invalidateQueries({ queryKey: ['portal-settings'] });
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      <SecretRevealDialog reveal={reveal} onClose={() => setReveal(null)} />
    </div>
  );
}

function ConnectorRow({
  connector,
  onRevealed,
}: {
  connector: WebhookConnectorStatus;
  onRevealed: (result: WebhookSecretResult) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const action = connector.secretConfigured ? 'rotate' : 'setup';

  const mutation = useMutation({
    mutationFn: () => setConnectorWebhookSecret(connector.connectorId, action),
    onSuccess: (result) => {
      setError(null);
      onRevealed(result);
    },
    // NO_RESOLVABLE_APP and GSM/file-mode failures arrive here with an
    // actionable message; show it inline beside this connector's row.
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not update secret'),
  });

  const title = connector.org ?? connector.connectorId;

  return (
    <li className="border-border flex flex-col gap-2 rounded border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-text text-[13px] font-medium">{title}</div>
          <div className="text-text-dim mt-[2px] flex flex-wrap items-center gap-2 text-[11px]">
            <span>{connector.appId ? `App ${connector.appId}` : 'Shared global App'}</span>
            <span aria-hidden>·</span>
            {connector.secretConfigured ? (
              <Badge variant="ok" size="sm">
                Secret configured
              </Badge>
            ) : (
              <Badge variant="neutral" size="sm">
                No secret
              </Badge>
            )}
          </div>
          <div className="text-text-dim mt-[2px] text-[11px]">
            {connector.lastVerifiedDelivery
              ? `Last verified: ${formatRelative(connector.lastVerifiedDelivery.ts)} (${connector.lastVerifiedDelivery.event})`
              : 'No verified delivery yet'}
          </div>
        </div>
        <Button
          variant={connector.secretConfigured ? 'outline' : 'primary'}
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending
            ? 'Working…'
            : connector.secretConfigured
              ? 'Rotate secret'
              : 'Set up'}
        </Button>
      </div>
      {error && (
        <div className="text-err text-[12px]" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

function SecretRevealDialog({
  reveal,
  onClose,
}: {
  reveal: WebhookSecretResult | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={reveal !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Webhook secret"
      description="Copy this now — rotating later generates a new one and this value won't be shown again."
      width={560}
      footer={
        <Button variant="primary" onClick={onClose}>
          I&apos;ve copied it
        </Button>
      }
    >
      {reveal && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-text text-[12px] font-medium">Secret</span>
            <div className="flex items-center gap-2">
              <code className="border-border bg-panel-2 text-text min-w-0 flex-1 rounded border p-2 font-mono text-[12px] break-all">
                {reveal.secret}
              </code>
              <CopyButton value={reveal.secret} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-text text-[12px] font-medium">Payload URL</span>
            <div className="flex items-center gap-2">
              <code className="border-border bg-panel-2 text-text min-w-0 flex-1 truncate rounded border p-2 font-mono text-[12px]">
                {reveal.webhookUrl}
              </code>
              <CopyButton value={reveal.webhookUrl} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-text text-[12px] font-medium">Steps</span>
            <ol className="text-text-muted m-0 flex list-decimal flex-col gap-1 pl-5 text-[12px]">
              {reveal.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Dialog>
  );
}
