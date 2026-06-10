'use client';

// Instance-level operator settings: OIDC provider credentials (persisted
// durably via the api-server's SecretStore — GSM in prod) and the config
// export used to seed the next deployment. Distinct from the per-user
// tabs (appearance/notifications): everything here is admin-scoped.
import { useState } from 'react';
import { Button, Card, Input } from '@ship-it-ui/ui';
import { clientConfig } from '@/lib/client-config';
import { updateOidcProvider } from '@/lib/api';

export function InstanceTab() {
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setStatus('saving');
    setError(null);
    try {
      await updateOidcProvider({
        issuerUrl,
        clientId,
        // Empty secret = keep the existing one (identifier-only edit).
        clientSecret: clientSecret || undefined,
      });
      setStatus('saved');
      setClientSecret('');
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="OIDC sign-in">
        <p className="text-text-muted mb-3 text-[12px]">
          Register a client in your IdP, then paste its details here. The client secret is stored in
          the deployment&apos;s secret manager — it never lands in config files.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[13px]">
            Issuer URL
            <Input
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              placeholder="https://idp.example.com"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            Client ID
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            Client secret
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Leave blank to keep the current secret"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={status === 'saving' || !issuerUrl || !clientId}>
              Save OIDC settings
            </Button>
            {status === 'saved' && (
              <span className="text-text-muted text-[12px]">
                Saved — the secret is durable. Export the config below and commit it as the
                deployment seed so the issuer/client ID survive redeploys, then restart.
              </span>
            )}
            {status === 'error' && <span className="text-danger text-[12px]">{error}</span>}
          </div>
        </div>
      </Card>

      <Card title="Config export">
        <p className="text-text-muted mb-3 text-[12px]">
          Download the instance&apos;s current configuration (connectors, scopes, wiring — no
          secrets) to commit as the seed config for the next deployment.
        </p>
        <Button variant="outline" asChild>
          <a href={`${clientConfig.api.url}/api/config/export`} download>
            Export config
          </a>
        </Button>
      </Card>
    </div>
  );
}
