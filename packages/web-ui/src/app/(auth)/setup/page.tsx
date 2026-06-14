'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  fetchHealthMode,
  fetchSetupStatus,
  postSetupAdmin,
  postSetupOAuth,
  postSetupComplete,
  type SetupGates,
} from '@/lib/setup';

// First-run setup wizard. Reached when the api-server boots in SETUP MODE
// (fresh deployment: auth enabled but no provider configured and the GSM
// secret store is empty). The api-server serves only /api/health,
// /api/setup/* and the GitHub App manifest flow in that state; everything
// else 401s with code SETUP_MODE — so this page is the only usable
// surface, and the login page redirects here when it detects the mode.
//
// Flow:
//   1. capture the first admin email   → POST /api/setup/admin (→ GSM)
//   2. capture the login OAuth App's client id/secret → POST
//      /api/setup/oauth (→ GSM). "Sign in with GitHub" runs on a classic
//      GitHub OAuth App the operator creates by hand (GitHub has no
//      one-click manifest flow for OAuth Apps). The Connector Hub's GitHub
//      App(s) for data sync are a separate concern set up later.
//   3. POST /api/setup/complete → api-server validates + restarts into
//      enforced auth; poll /api/health until mode flips → /login

type PageState =
  | { kind: 'probing' }
  | { kind: 'unreachable' }
  | { kind: 'wizard' }
  | { kind: 'restarting' }
  | { kind: 'restart-timeout' };

const STATUS_POLL_MS = 2000;
// ~2 minutes of restart polling before we show the "taking longer than
// expected" copy. The pod usually comes back well inside this.
const RESTART_POLL_LIMIT = 60;

export default function SetupPage() {
  const router = useRouter();
  const [page, setPage] = useState<PageState>({ kind: 'probing' });

  // Mode probe on mount: an active deployment must never render the
  // wizard (its mutating endpoints all 409 anyway — this is UX, not the
  // security boundary; that lives server-side).
  useEffect(() => {
    if (page.kind !== 'probing') return;
    let cancelled = false;
    (async () => {
      const mode = await fetchHealthMode();
      if (cancelled) return;
      if (mode === 'setup') setPage({ kind: 'wizard' });
      else if (mode === 'active') router.replace('/login');
      else setPage({ kind: 'unreachable' });
    })();
    return () => {
      cancelled = true;
    };
  }, [page.kind, router]);

  // Restart polling after a successful /complete: fetch failures are
  // expected (the pod is going down) and just mean "keep waiting".
  useEffect(() => {
    if (page.kind !== 'restarting') return;
    let cancelled = false;
    let polls = 0;
    const timer = setInterval(async () => {
      polls += 1;
      const mode = await fetchHealthMode();
      if (cancelled) return;
      if (mode === 'active') {
        clearInterval(timer);
        router.replace('/login');
      } else if (polls >= RESTART_POLL_LIMIT) {
        clearInterval(timer);
        setPage({ kind: 'restart-timeout' });
      }
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [page.kind, router]);

  return (
    <div className="w-full max-w-[460px] space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Image
          src="/ShipItLogo.png"
          alt=""
          width={48}
          height={48}
          priority
          className="rounded-lg"
        />
        <div className="space-y-1.5">
          <h1 className="text-text text-[22px] font-semibold tracking-tight">
            Set up your ShipIt instance
          </h1>
          <p className="text-text-muted text-[13px] leading-relaxed">
            First-run setup: name an administrator and connect GitHub sign-in.
          </p>
        </div>
      </div>

      <Card className="p-5">
        {page.kind === 'probing' && (
          <CenteredNote>
            <Spinner size="sm" />
            <span className="text-text-dim text-[12.5px]">Checking deployment state…</span>
          </CenteredNote>
        )}
        {page.kind === 'unreachable' && (
          <CenteredNote>
            <span className="text-err text-[13px]">
              Can&apos;t reach the API server. Reload this page once it&apos;s up.
            </span>
            <Button variant="secondary" onClick={() => setPage({ kind: 'probing' })}>
              Retry
            </Button>
          </CenteredNote>
        )}
        {page.kind === 'wizard' && (
          <SetupWizard onRestarting={() => setPage({ kind: 'restarting' })} />
        )}
        {page.kind === 'restarting' && (
          <CenteredNote>
            <Spinner size="sm" />
            <span className="text-text-dim text-[12.5px]">
              Setup complete — the server is restarting with sign-in enforced…
            </span>
          </CenteredNote>
        )}
        {page.kind === 'restart-timeout' && (
          <CenteredNote>
            <span className="text-warn text-[13px]">
              The restart is taking longer than expected. Give it a minute, then refresh — if it
              keeps failing, check the api-server pod logs.
            </span>
          </CenteredNote>
        )}
      </Card>

      <p className="text-text-dim text-center text-[11.5px]">
        This wizard is only available while the deployment has no authentication configured.
      </p>
    </div>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-4" aria-live="polite">
      {children}
    </div>
  );
}

type WizardStep = 'admin' | 'github' | 'finish';

function SetupWizard({ onRestarting }: { onRestarting: () => void }) {
  const [step, setStep] = useState<WizardStep>('admin');
  const [gates, setGates] = useState<SetupGates | null>(null);

  // Steps can already be satisfied on mount (e.g. a pod restart mid-wizard
  // re-enters setup mode with the OAuth client persisted) — seed from
  // status so the operator doesn't redo finished steps.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await fetchSetupStatus();
        if (cancelled) return;
        setGates(status.gates);
        if (status.gates.adminConfigured) {
          setStep(status.gates.oauthClientPresent ? 'finish' : 'github');
        }
      } catch {
        // Status is a convenience here; the wizard still works step by step.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <ol className="space-y-5">
        <WizardStepShell
          index={1}
          title="Administrator email"
          state={step === 'admin' ? 'current' : 'done'}
        >
          {step === 'admin' ? (
            <AdminEmailStep onDone={() => setStep('github')} />
          ) : (
            <p className="text-text-dim text-[12.5px]">Administrator captured.</p>
          )}
        </WizardStepShell>

        <WizardStepShell
          index={2}
          title="Connect GitHub sign-in"
          state={step === 'github' ? 'current' : step === 'finish' ? 'done' : 'pending'}
        >
          {step === 'github' && <GitHubAppStep onDone={() => setStep('finish')} />}
          {step === 'finish' && (
            <p className="text-text-dim text-[12.5px]">GitHub OAuth client created.</p>
          )}
        </WizardStepShell>

        <WizardStepShell
          index={3}
          title="Finish and enforce sign-in"
          state={step === 'finish' ? 'current' : 'pending'}
        >
          {step === 'finish' && <FinishStep gates={gates} onRestarting={onRestarting} />}
        </WizardStepShell>
      </ol>
    </div>
  );
}

function WizardStepShell({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: 'pending' | 'current' | 'done';
  children: React.ReactNode;
}) {
  const badge =
    state === 'done'
      ? 'bg-ok/15 text-ok'
      : state === 'current'
        ? 'bg-accent/15 text-accent'
        : 'bg-panel text-text-dim';
  return (
    <li className="flex gap-3">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${badge}`}
        aria-hidden="true"
      >
        {state === 'done' ? <IconGlyph name="check" size={13} /> : index}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p
          className={`text-[13.5px] font-medium ${state === 'pending' ? 'text-text-dim' : 'text-text'}`}
        >
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

function AdminEmailStep({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postSetupAdmin(email);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the admin email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-text-muted text-[12.5px] leading-relaxed">
        First sign-in with this email gets the <strong>admin</strong> role. Use the address your
        GitHub account is registered under.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Administrator email"
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy || email.trim() === ''}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-err text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}

function GitHubAppStep({ onDone }: { onDone: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The OAuth App's "Authorization callback URL" must match the
  // redirect_uri the server sends at login. In the single-origin
  // deployment that's this page's own origin + the auth callback path.
  const callbackUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/auth/callback/github`
      : '/api/auth/callback/github';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postSetupOAuth(clientId, clientSecret);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the OAuth client.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-text-muted text-[12.5px] leading-relaxed">
        &quot;Sign in with GitHub&quot; uses a GitHub <strong>OAuth App</strong>. Create one under{' '}
        <a
          href="https://github.com/settings/applications/new"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline"
        >
          Developer settings → OAuth Apps → New OAuth App
        </a>
        , set its <strong>Authorization callback URL</strong> to the value below, then paste the
        Client ID and a generated Client Secret here.
      </p>
      <div className="bg-panel-2 border-border rounded border px-3 py-2">
        <p className="text-text-dim text-[10px] tracking-[1.4px] uppercase">
          Authorization callback URL
        </p>
        <code className="text-text text-[12px] break-all">{callbackUrl}</code>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID (e.g. Ov23li…)"
          aria-label="OAuth App Client ID"
          disabled={busy}
        />
        <Input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Client secret"
          aria-label="OAuth App Client secret"
          disabled={busy}
        />
        <Button
          type="submit"
          variant="primary"
          icon={<IconGlyph name="github" />}
          disabled={busy || clientId.trim() === '' || clientSecret.trim() === ''}
        >
          {busy ? 'Saving…' : 'Save OAuth client'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-err text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}

const OPERATOR_GATE_COPY: ReadonlyArray<{ key: keyof SetupGates; label: string }> = [
  { key: 'sessionSecretPresent', label: 'Session signing secret (set by the operator/chart)' },
  { key: 'allowedOriginsConfigured', label: 'Web allowed origins (set in the deployed config)' },
];

function FinishStep({
  gates,
  onRestarting,
}: {
  gates: SetupGates | null;
  onRestarting: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operatorProblems = OPERATOR_GATE_COPY.filter((g) => gates && !gates[g.key]);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await postSetupComplete();
      if (result.ok) {
        onRestarting();
        return;
      }
      setError(result.messages.join(' '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete setup.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-text-muted text-[12.5px] leading-relaxed">
        The server restarts with sign-in enforced. Afterwards, sign in with GitHub using the admin
        email from step 1.
      </p>
      {operatorProblems.length > 0 && (
        <div role="alert" className="border-err bg-err/10 rounded-md border px-3 py-2">
          <p className="text-err text-[12px] font-medium">
            These must be fixed in the deployment itself — the wizard can&apos;t set them:
          </p>
          <ul className="text-err list-inside list-disc text-[12px]">
            {operatorProblems.map((g) => (
              <li key={g.key}>{g.label}</li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="primary" onClick={() => void finish()} disabled={busy}>
        {busy ? 'Finishing…' : 'Finish setup'}
      </Button>
      {error && (
        <p role="alert" className="text-err text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}
