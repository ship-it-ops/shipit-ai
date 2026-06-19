'use client';

// Admin-only login & access management (T7 of admin-portal-settings). Three
// cards: the OAuth login client, the admin email list, and the login
// allow-list. Each is a self-lockout hazard, so the destructive paths are
// gated behind confirm dialogs:
//   - changing the OAuth client can break sign-in for everyone;
//   - removing your own email from admins is blocked server-side (422
//     SELF_LOCKOUT) and surfaced inline;
//   - emptying the allow-list lets ANYONE sign in, so we confirm first.
// The server 403s non-admins regardless; the page hides this tab for them.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, Field, Input, Textarea } from '@ship-it-ui/ui';
import {
  fetchPortalSettings,
  updateAdminEmails,
  updateAllowlist,
  updateOAuthClient,
} from '@/lib/api';

export function AccessTab() {
  const settingsQuery = useQuery({
    queryKey: ['portal-settings'],
    queryFn: fetchPortalSettings,
    retry: false,
  });

  if (settingsQuery.isLoading) {
    return (
      <Card>
        <p className="text-text-dim m-0 py-6 text-center text-[12px]">Loading access settings…</p>
      </Card>
    );
  }
  if (settingsQuery.error) {
    return (
      <Card>
        <p className="text-err m-0 py-6 text-center text-[12px]" role="alert">
          {(settingsQuery.error as Error).message}
        </p>
      </Card>
    );
  }

  const data = settingsQuery.data!;
  return (
    <div className="flex flex-col gap-4">
      <OAuthCard configured={data.oauth.configured} />
      {/* Keying by the server value remounts the editor with fresh local
          state whenever the saved list changes — no setState-in-effect. */}
      <AdminEmailsCard key={data.admins.join('\n')} initial={data.admins} />
      <AllowlistCard key={data.allowlist.join('\n')} initial={data.allowlist} />
    </div>
  );
}

function OAuthCard({ configured }: { configured: boolean }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setConfirmOpen(false);
    setStatus('saving');
    setError(null);
    try {
      await updateOAuthClient({ clientId, clientSecret });
      setStatus('saved');
      setClientSecret('');
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }

  return (
    <Card title="OAuth login client">
      <p className="text-text-muted mb-3 text-[12px]">
        The client used for sign-in.{' '}
        {configured ? (
          <Badge variant="ok" size="sm">
            Configured
          </Badge>
        ) : (
          <Badge variant="warn" size="sm">
            Not configured
          </Badge>
        )}
      </p>
      <div className="flex flex-col gap-3">
        <Field label="Client ID">
          {(p) => <Input {...p} value={clientId} onChange={(e) => setClientId(e.target.value)} />}
        </Field>
        <Field label="Client secret">
          {(p) => (
            <Input
              {...p}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          )}
        </Field>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={status === 'saving' || !clientId || !clientSecret}
          >
            Save OAuth client
          </Button>
          {status === 'saved' && <span className="text-text-muted text-[12px]">Saved.</span>}
          {status === 'error' && error && (
            <span className="text-err text-[12px]" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Change the OAuth client?"
        description="Changing this can lock users out of login if the new client is wrong. Make sure the client ID and secret are correct before saving."
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={save}>
              Save anyway
            </Button>
          </>
        }
      />
    </Card>
  );
}

/**
 * Parse a textarea of emails (one per line or comma-separated) into a
 * deduped, trimmed list. Validation proper lives on the server (it returns
 * INVALID_*); this just normalizes input shape.
 */
function parseEmails(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function AdminEmailsCard({ initial }: { initial: string[] }) {
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState(initial.join('\n'));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => updateAdminEmails(parseEmails(raw)),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['portal-settings'] });
    },
    // 422 SELF_LOCKOUT ("can't remove yourself") and 400 INVALID_ADMIN_EMAIL
    // arrive with actionable messages.
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save admins'),
  });

  return (
    <Card title="Admin emails">
      <p className="text-text-muted mb-3 text-[12px]">
        One email per line. Admins can manage every setting here. You can&apos;t remove your own
        email.
      </p>
      <Textarea
        aria-label="Admin emails"
        rows={4}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="alice@example.com&#10;bob@example.com"
      />
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save admins'}
        </Button>
        {mutation.isSuccess && !error && (
          <span className="text-text-muted text-[12px]">Saved.</span>
        )}
        {error && (
          <span className="text-err text-[12px]" role="alert">
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}

function AllowlistCard({ initial }: { initial: string[] }) {
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState(initial.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [confirmEmptyOpen, setConfirmEmptyOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: () => updateAllowlist(parseEmails(raw)),
    onSuccess: () => {
      setError(null);
      setConfirmEmptyOpen(false);
      queryClient.invalidateQueries({ queryKey: ['portal-settings'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save allow-list'),
  });

  function handleSave() {
    setError(null);
    // Emptying the allow-list opens sign-in to EVERYONE — confirm first.
    if (parseEmails(raw).length === 0) {
      setConfirmEmptyOpen(true);
      return;
    }
    mutation.mutate();
  }

  return (
    <Card title="Login allow-list">
      <p className="text-text-muted mb-3 text-[12px]">
        One email per line. Only these users can sign in — admins always bypass the allow-list.
        Leaving it empty allows anyone to sign in.
      </p>
      <Textarea
        aria-label="Login allow-list"
        rows={4}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="alice@example.com&#10;bob@example.com"
      />
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={handleSave} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save allow-list'}
        </Button>
        {mutation.isSuccess && !error && (
          <span className="text-text-muted text-[12px]">Saved.</span>
        )}
        {error && (
          <span className="text-err text-[12px]" role="alert">
            {error}
          </span>
        )}
      </div>

      <Dialog
        open={confirmEmptyOpen}
        onOpenChange={setConfirmEmptyOpen}
        title="Allow everyone to sign in?"
        description="Saving an empty allow-list allows ANYONE to sign in to this instance. Are you sure?"
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEmptyOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => mutation.mutate()}>
              Allow everyone
            </Button>
          </>
        }
      />
    </Card>
  );
}
