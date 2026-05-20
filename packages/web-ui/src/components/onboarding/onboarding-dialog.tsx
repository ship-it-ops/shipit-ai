'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  Spinner,
  WizardDialog,
  useToast,
  type WizardStep,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { persistDevUserOverride, markOnboardingComplete } from '@/lib/current-user';
import type { DevUserConfig } from '@/lib/client-config';

const ALL_CAPABILITIES = [
  { id: 'admin', label: 'admin', hint: 'Full read/write to the graph & schema' },
  { id: 'graph:write', label: 'graph:write', hint: 'Write entities and edges' },
  { id: 'connectors:manage', label: 'connectors:manage', hint: 'Add/remove data sources' },
  { id: 'schema:edit', label: 'schema:edit', hint: 'Update the entity-type schema' },
  { id: 'mcp:invoke', label: 'mcp:invoke', hint: 'Call MCP tools from AI agents' },
] as const;

type SeedStatus = 'unknown' | 'empty' | 'has-data' | 'unreachable';

interface FormState {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  capabilities: Set<string>;
  seedRequested: boolean;
}

interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface IdentityFailure {
  message: string;
  manualYaml: string;
}

interface SeedFailure {
  message: string;
  stderr: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const initialState = (): FormState => ({
  firstName: '',
  lastName: '',
  email: '',
  role: 'Platform Admin',
  team: 'platform-team',
  joinedAt: todayIso(),
  capabilities: new Set(ALL_CAPABILITIES.map((c) => c.id)),
  seedRequested: true,
});

export function OnboardingDialog({ open, onOpenChange }: OnboardingDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(initialState);
  const [seedStatus, setSeedStatus] = useState<SeedStatus>('unknown');
  const [saving, setSaving] = useState<'idle' | 'identity' | 'seed'>('idle');
  const [identityFailure, setIdentityFailure] = useState<IdentityFailure | null>(null);
  const [seedFailure, setSeedFailure] = useState<SeedFailure | null>(null);

  // Probe seed status when the dialog opens. The wizard auto-skips the
  // Demo data step unless status === 'empty', so this races with the user's
  // click-through; the probe usually wins (it's a quick spawn).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSeedStatus('unknown');
    fetch('/api/onboarding/seed', { method: 'GET' })
      .then((r) => r.json())
      .then((body: { status: SeedStatus }) => {
        if (!cancelled) setSeedStatus(body.status ?? 'unreachable');
      })
      .catch(() => {
        if (!cancelled) setSeedStatus('unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleCapability = useCallback((id: string) => {
    setForm((prev) => {
      const next = new Set(prev.capabilities);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, capabilities: next };
    });
  }, []);

  const identityValid =
    form.firstName.trim() !== '' &&
    form.lastName.trim() !== '' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email);
  const profileValid =
    form.role.trim() !== '' && form.team.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(form.joinedAt);

  const handleComplete = useCallback(async () => {
    setIdentityFailure(null);
    setSeedFailure(null);
    setSaving('identity');

    const payload: DevUserConfig = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      role: form.role.trim(),
      team: form.team.trim(),
      joinedAt: form.joinedAt,
      capabilities: Array.from(form.capabilities),
    };

    let identityRes: Response;
    try {
      identityRes = await fetch('/api/onboarding/dev-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      setIdentityFailure({
        message: `Network error: ${(err as Error).message}`,
        manualYaml: '',
      });
      setSaving('idle');
      return;
    }

    if (!identityRes.ok) {
      const body = (await identityRes.json().catch(() => ({}))) as {
        message?: string;
        manualYaml?: string;
      };
      setIdentityFailure({
        message: body.message ?? `Save failed with HTTP ${identityRes.status}.`,
        manualYaml: body.manualYaml ?? '',
      });
      setSaving('idle');
      return;
    }

    // Identity saved — overlay into localStorage so the UI updates without a
    // dev-server restart. The YAML is the source of truth on next restart.
    persistDevUserOverride(payload);

    if (!form.seedRequested || seedStatus !== 'empty') {
      toast({
        variant: 'ok',
        title: 'Saved to shipit.config.local.yaml',
        description:
          'Restart your dev server to load this into the bundle (your UI already reflects it via localStorage).',
      });
      setSaving('idle');
      onOpenChange(false);
      return;
    }

    setSaving('seed');
    let seedRes: Response;
    try {
      seedRes = await fetch('/api/onboarding/seed', { method: 'POST' });
    } catch (err) {
      setSeedFailure({ message: `Network error: ${(err as Error).message}`, stderr: '' });
      setSaving('idle');
      return;
    }

    if (!seedRes.ok) {
      const body = (await seedRes.json().catch(() => ({}))) as {
        message?: string;
        stderr?: string;
      };
      setSeedFailure({
        message: body.message ?? `Seed failed with HTTP ${seedRes.status}.`,
        stderr: body.stderr ?? '',
      });
      setSaving('idle');
      return;
    }

    toast({
      variant: 'ok',
      title: 'Saved · demo data loaded',
      description: 'Your dev identity and the Acme Pay sample dataset are ready.',
    });
    setSaving('idle');
    onOpenChange(false);
  }, [form, seedStatus, toast, onOpenChange]);

  const handleManualPasteDismiss = useCallback(() => {
    markOnboardingComplete();
    setIdentityFailure(null);
    toast({
      variant: 'info',
      title: 'Got it',
      description: 'Marked onboarding as complete. Restart the dev server after pasting.',
    });
    onOpenChange(false);
  }, [toast, onOpenChange]);

  const handleCancel = useCallback(() => {
    // Cancelling without saving still suppresses the prompt; users can
    // re-trigger by clearing shipit:onboarding-complete in localStorage.
    markOnboardingComplete();
    onOpenChange(false);
  }, [onOpenChange]);

  // WizardDialog has no max-height or overflow handling of its own — a tall
  // step (Review with all seven rows + a failure banner, say) would push the
  // footer below the viewport. Wrap every step body in a scroll container so
  // overflow lives inside the dialog instead of falling off the page.
  const stepBody = (node: ReactNode): ReactNode => (
    <div className="max-h-[55vh] overflow-y-auto pr-1">{node}</div>
  );

  const steps = useMemo<WizardStep[]>(
    () => [
      {
        id: 'identity',
        label: 'Identity',
        canAdvance: () => identityValid,
        content: stepBody(
          <IdentityStep
            firstName={form.firstName}
            lastName={form.lastName}
            email={form.email}
            onChange={set}
          />,
        ),
      },
      {
        id: 'profile',
        label: 'Profile',
        canAdvance: () => profileValid,
        content: stepBody(
          <ProfileStep
            role={form.role}
            team={form.team}
            joinedAt={form.joinedAt}
            capabilities={form.capabilities}
            onChange={set}
            onToggleCapability={toggleCapability}
          />,
        ),
      },
      {
        id: 'seed',
        label: 'Seed',
        content: stepBody(
          <SeedStep
            status={seedStatus}
            seedRequested={form.seedRequested}
            onChange={(v) => set('seedRequested', v)}
          />,
        ),
      },
      {
        id: 'review',
        label: 'Review',
        content: stepBody(
          <ReviewStep
            form={form}
            seedStatus={seedStatus}
            saving={saving}
            identityFailure={identityFailure}
            seedFailure={seedFailure}
            onManualPasteDismiss={handleManualPasteDismiss}
          />,
        ),
      },
    ],
    [
      form,
      seedStatus,
      saving,
      identityFailure,
      seedFailure,
      identityValid,
      profileValid,
      set,
      toggleCapability,
      handleManualPasteDismiss,
    ],
  );

  const completeLabel = saving === 'idle' ? 'Save' : saving === 'identity' ? 'Saving…' : 'Seeding…';

  return (
    <WizardDialog
      open={open}
      onOpenChange={(next) => {
        // Only allow close via explicit cancel / save buttons; clicking the
        // overlay shouldn't lose half-typed form state.
        if (!next && saving !== 'idle') return;
        if (!next) handleCancel();
        else onOpenChange(true);
      }}
      steps={steps}
      title="Set up your dev identity"
      description="Local development onboarding — values are mock-only, saved to your gitignored shipit.config.local.yaml."
      width={720}
      completeLabel={completeLabel}
      cancelLabel="Skip for now"
      onCancel={handleCancel}
      onComplete={() => {
        if (saving !== 'idle') return;
        void handleComplete();
      }}
    />
  );
}

function IdentityStep({
  firstName,
  lastName,
  email,
  onChange,
}: {
  firstName: string;
  lastName: string;
  email: string;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="accent" icon={<IconGlyph name="info" />}>
        <strong>Local / dev onboarding.</strong> Real auth isn&apos;t wired up yet, so the identity
        you enter here is mock-only and saved to your gitignored{' '}
        <code className="font-mono text-[12px]">shipit.config.local.yaml</code>.
      </Banner>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required>
          {(p) => (
            <Input
              {...p}
              value={firstName}
              placeholder="Ada"
              onChange={(e) => onChange('firstName', e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Last name" required>
          {(p) => (
            <Input
              {...p}
              value={lastName}
              placeholder="Lovelace"
              onChange={(e) => onChange('lastName', e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Email" required hint="Used only in the UI; no email is sent.">
        {(p) => (
          <Input
            {...p}
            type="email"
            value={email}
            placeholder="ada@your-company.com"
            onChange={(e) => onChange('email', e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

function ProfileStep({
  role,
  team,
  joinedAt,
  capabilities,
  onChange,
  onToggleCapability,
}: {
  role: string;
  team: string;
  joinedAt: string;
  capabilities: Set<string>;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onToggleCapability: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role" hint="Free text.">
          {(p) => (
            <Input
              {...p}
              value={role}
              placeholder="Platform Admin"
              onChange={(e) => onChange('role', e.target.value)}
            />
          )}
        </Field>
        <Field label="Team" hint="Slug, e.g. platform-team.">
          {(p) => (
            <Input
              {...p}
              value={team}
              placeholder="platform-team"
              onChange={(e) => onChange('team', e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Joined date">
        {(p) => (
          <Input
            {...p}
            type="date"
            value={joinedAt}
            onChange={(e) => onChange('joinedAt', e.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-col gap-2">
        <div className="text-text text-[12px] font-medium">Capabilities</div>
        <p className="text-text-muted m-0 text-[11px]">
          Mock-RBAC scopes. All on by default; will map to real RBAC once Access Control lands.
        </p>
        <div className="border-border bg-panel flex flex-col rounded-md border">
          {ALL_CAPABILITIES.map((cap, idx) => (
            <label
              key={cap.id}
              className={
                'flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] ' +
                (idx > 0 ? 'border-border border-t' : '')
              }
            >
              <Checkbox
                checked={capabilities.has(cap.id)}
                onCheckedChange={() => onToggleCapability(cap.id)}
              />
              <span className="flex flex-1 flex-col">
                <span className="text-text font-mono">{cap.label}</span>
                <span className="text-text-muted text-[11px]">{cap.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function SeedStep({
  status,
  seedRequested,
  onChange,
}: {
  status: SeedStatus;
  seedRequested: boolean;
  onChange: (v: boolean) => void;
}) {
  if (status === 'unknown') {
    return (
      <div className="text-text-muted flex items-center gap-3 text-[12px]">
        <Spinner /> Checking Neo4j…
      </div>
    );
  }

  if (status === 'has-data') {
    return (
      <Banner tone="ok" icon={<IconGlyph name="check" />}>
        Graph already has data — skipping seed. Run{' '}
        <code className="font-mono text-[12px]">pnpm seed:reset</code> if you want to start over.
      </Banner>
    );
  }

  if (status === 'unreachable') {
    return (
      <Banner tone="warn" icon={<IconGlyph name="warn" />}>
        Neo4j isn&apos;t reachable, so the seed step is skipped. Start it with{' '}
        <code className="font-mono text-[12px]">pnpm start:infra</code> (or{' '}
        <code className="font-mono text-[12px]">pnpm start:all</code>) and run{' '}
        <code className="font-mono text-[12px]">pnpm seed</code> when you&apos;re ready.
      </Banner>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="border-border bg-panel hover:border-border-strong flex cursor-pointer items-start gap-3 rounded-md border p-3">
        <Checkbox checked={seedRequested} onCheckedChange={(v) => onChange(v === true)} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-text text-[13px] font-medium">
            Seed the Acme Pay sample dataset
          </span>
          <span className="text-text-muted text-[12px]">
            ~170 entities · ~300 edges. Gives the catalog, graph explorer, incident, and team views
            something to render. Usually finishes in 5–10 seconds.
          </span>
        </span>
      </label>
      <p className="text-text-muted text-[11px]">
        You can also run <code className="font-mono">pnpm seed</code> later, or{' '}
        <code className="font-mono">pnpm seed:reset</code> to clear.
      </p>
    </div>
  );
}

function ReviewStep({
  form,
  seedStatus,
  saving,
  identityFailure,
  seedFailure,
  onManualPasteDismiss,
}: {
  form: FormState;
  seedStatus: SeedStatus;
  saving: 'idle' | 'identity' | 'seed';
  identityFailure: IdentityFailure | null;
  seedFailure: SeedFailure | null;
  onManualPasteDismiss: () => void;
}) {
  const willSeed = form.seedRequested && seedStatus === 'empty';
  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: 'Name', value: `${form.firstName} ${form.lastName}` },
    { label: 'Email', value: form.email },
    { label: 'Role', value: form.role },
    { label: 'Team', value: form.team },
    { label: 'Joined', value: form.joinedAt },
    {
      label: 'Capabilities',
      value: Array.from(form.capabilities).join(', ') || '—',
    },
    {
      label: 'Seed demo data',
      value: willSeed
        ? 'Yes (Acme Pay)'
        : seedStatus === 'has-data'
          ? 'No (graph already populated)'
          : seedStatus === 'unreachable'
            ? 'No (Neo4j unreachable)'
            : 'No',
    },
  ];

  if (identityFailure) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="err" icon={<IconGlyph name="warn" />}>
          <strong>Couldn&apos;t save to shipit.config.local.yaml.</strong> {identityFailure.message}
        </Banner>
        {identityFailure.manualYaml && (
          <div className="flex flex-col gap-2">
            <p className="text-text-muted text-[12px]">
              Paste this into <code className="font-mono">shipit.config.local.yaml</code> at the
              repo root, under the existing <code className="font-mono">frontend:</code> block
              (replace the <code className="font-mono">devUser</code> subtree).
            </p>
            <pre className="border-border bg-panel-2 text-text overflow-x-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">
              {identityFailure.manualYaml}
            </pre>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(identityFailure.manualYaml);
                }}
                icon={<IconGlyph name="copy" />}
              >
                Copy snippet
              </Button>
              <Button onClick={onManualPasteDismiss}>I&apos;ve pasted it</Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="border-border bg-panel-2 rounded-md border p-4">
        <dl className="m-0 flex flex-col gap-1 text-[12px]">
          {rows.map((row) => (
            <div
              key={row.label}
              className="border-border flex items-start justify-between gap-4 border-t border-dashed py-1.5 first:border-t-0"
            >
              <dt className="text-text-muted font-mono text-[10px] tracking-[1.4px] uppercase">
                {row.label}
              </dt>
              <dd className="text-text text-right font-mono">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {saving !== 'idle' && (
        <div className="text-text-muted flex flex-col gap-2 text-[12px]">
          <div className="flex items-center gap-2">
            {saving === 'identity' ? <Spinner /> : <IconGlyph name="check" />} Writing
            shipit.config.local.yaml…
          </div>
          {willSeed && (
            <div className="flex items-center gap-2">
              {saving === 'seed' ? (
                <Spinner />
              ) : (
                <span className="text-text-dim font-mono text-[10px]">·</span>
              )}{' '}
              Seeding demo data{saving === 'seed' ? ' (5–10s)' : ''}…
            </div>
          )}
        </div>
      )}

      {seedFailure && (
        <Banner tone="warn" icon={<IconGlyph name="warn" />}>
          <div className="flex flex-col gap-2">
            <div>
              <strong>Identity saved, but the seed step failed.</strong> {seedFailure.message}
            </div>
            {seedFailure.stderr && (
              <pre className="border-border bg-panel text-text-muted max-h-32 overflow-y-auto rounded-md border p-2 font-mono text-[10px]">
                {seedFailure.stderr}
              </pre>
            )}
            <div className="text-[11px]">
              Run <code className="font-mono">pnpm seed</code> manually to retry.
            </div>
          </div>
        </Banner>
      )}
    </div>
  );
}
