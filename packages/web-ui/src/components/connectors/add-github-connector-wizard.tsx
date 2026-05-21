'use client';

// Four-step wizard for adding a GitHub org as a connector.
//
// Step count history:
//   - v1 (six steps): App · Installation · Probe · Org · Scope · Review
//   - v2 (five steps): App · Connect · Org · Scope · Review
//     (merged Installation + Probe — Probe was just a button click)
//   - v3 (four steps): App · Connect · Configure · Review
//     (merged Org + Scope — together they're "what to sync from this org"
//     and the step indicator was still overflowing narrow viewports)
//
// The reductions are about step-indicator fit, not about cramming. The
// "Configure" step has internal sections so the density stays readable.
//
// Step 1 ("App") is where the wizard's behavior forks based on whether a
// shared GitHub App is already configured:
//   - First connector ever (no global App configured): user picks "use one
//     App for all my orgs" (recommended) vs "use a separate App for this
//     org only". Either choice collects App ID + private-key path. The
//     shared choice persists to `connectors.github.app.*` on submit; the
//     per-org choice persists to `connectors.instances[*].app` on submit.
//   - Subsequent connector (global already configured): user picks "use
//     existing shared App" (shows the configured id) vs "override with a
//     separate App for this org". Existing shared changes nothing; override
//     persists only on the connector.
//
// Probe in step 3 always uses whatever credentials the user has at hand —
// either the existing global or the in-form values — so credentials get
// validated before any persistence happens.
//
// State lives in this component, not React Hook Form, because the existing
// wizards in this app share the same `useState` per field pattern (see
// onboarding-dialog.tsx). Adding a form library here would diverge for
// little gain.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import {
  type ConnectorAppOverride,
  type ConnectorEntities,
  type ConnectorScope,
  type ProbeResult,
} from '@/lib/api';
import {
  useCreateConnector,
  useGitHubAppStatus,
  useProbeConnector,
  useTriggerSync,
  useUpdateGitHubApp,
} from '@/lib/hooks/use-connectors';

interface AddGitHubConnectorWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_SCOPE: ConnectorScope = {
  repos: { include: ['**'], exclude: [] },
  teams: { include: ['**'], exclude: [] },
  cappedAt: 100,
  cappedAcknowledged: false,
};

const DEFAULT_ENTITIES: ConnectorEntities = {
  repository: true,
  team: true,
  pipeline: true,
  codeowners: true,
  // P1 entity types — default off until the schema additions and webhook
  // receiver are in place. The user can flip them on early as a feature
  // flag if they're testing the new fetchers.
  environment: false,
  deployment: false,
  branchProtection: false,
  workflowRun: false,
};

// 'shared' = inherit the global GitHub App (configure it here if not yet set).
// 'per-org' = override the global App with a connector-specific one.
type AppMode = 'shared' | 'per-org';

function looksLikeId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,40}$/.test(value);
}

function defaultIdFor(org: string): string {
  const safe = org
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  return safe ? `github-${safe}` : 'github-org';
}

export function AddGitHubConnectorWizard({ open, onOpenChange }: AddGitHubConnectorWizardProps) {
  const { toast } = useToast();
  const probe = useProbeConnector();
  const create = useCreateConnector();
  const triggerSync = useTriggerSync();
  const updateGlobalApp = useUpdateGitHubApp();
  // Only fetch the App status while the dialog is open — avoids a 503
  // request on every page mount when the GitHubAppService isn't wired
  // (e.g. tests, environments without a config).
  const appStatusQuery = useGitHubAppStatus();
  const appStatus = open ? appStatusQuery.data?.status : undefined;
  const appStatusHash = open ? appStatusQuery.data?.hash : null;

  const [installationId, setInstallationId] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [org, setOrg] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ConnectorScope>(DEFAULT_SCOPE);
  const [entities, setEntities] = useState<ConnectorEntities>(DEFAULT_ENTITIES);

  // App-identity state. `mode` is 'shared' by default — the recommended
  // path for most teams. `sharedAppId`/`sharedKeyPath` are populated only
  // when the user is configuring the global App for the first time;
  // `overrideAppId`/`overrideKeyPath` are populated only in per-org mode.
  const [mode, setMode] = useState<AppMode>('shared');
  const [sharedAppId, setSharedAppId] = useState('');
  const [sharedKeyPath, setSharedKeyPath] = useState('');
  const [overrideAppId, setOverrideAppId] = useState('');
  const [overrideKeyPath, setOverrideKeyPath] = useState('');

  // Whether the wizard's "shared App" choice is offering EXISTING global
  // credentials (no fields shown) or asking the user to configure them
  // for the first time (fields required).
  const globalConfigured = appStatus?.configured === true;

  // The override credentials we'll pass to the probe + create calls. In
  // shared mode with no global yet, the shared fields temporarily act as
  // an override so the probe validates them before any persistence.
  const effectiveOverride = useMemo<ConnectorAppOverride | undefined>(() => {
    if (mode === 'per-org') {
      return {
        ...(overrideAppId.trim() ? { id: overrideAppId.trim() } : {}),
        ...(overrideKeyPath.trim() ? { privateKeyPath: overrideKeyPath.trim() } : {}),
      };
    }
    // shared mode
    if (globalConfigured) return undefined; // probe will use existing global
    // Probing a not-yet-saved shared App: pretend it's an override so the
    // resolver picks up the in-form values without us writing first.
    return {
      ...(sharedAppId.trim() ? { id: sharedAppId.trim() } : {}),
      ...(sharedKeyPath.trim() ? { privateKeyPath: sharedKeyPath.trim() } : {}),
    };
  }, [mode, globalConfigured, sharedAppId, sharedKeyPath, overrideAppId, overrideKeyPath]);

  const reset = () => {
    setInstallationId('');
    setProbeResult(null);
    setOrg('');
    setConnectorId('');
    setName('');
    setScope(DEFAULT_SCOPE);
    setEntities(DEFAULT_ENTITIES);
    setMode('shared');
    setSharedAppId('');
    setSharedKeyPath('');
    setOverrideAppId('');
    setOverrideKeyPath('');
    probe.reset();
    create.reset();
    updateGlobalApp.reset();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  // Auto-populate id and name once the probe gives us an org.
  useEffect(() => {
    if (probeResult?.ok && probeResult.suggestedOrg && !org) {
      setOrg(probeResult.suggestedOrg);
      if (!connectorId) setConnectorId(defaultIdFor(probeResult.suggestedOrg));
      if (!name) setName(`GitHub · ${probeResult.suggestedOrg}`);
    }
  }, [probeResult, org, connectorId, name]);

  const installationValid = useMemo(() => looksLikeId(installationId), [installationId]);
  const probeOk = probeResult?.ok === true;
  const orgValid = !!org.trim();
  const idValid = connectorId.trim().length > 0 && /^[a-z0-9-]+$/.test(connectorId);
  const nameValid = name.trim().length > 0;

  // App step's "Next" gate: same shape for both modes — App ID + key path
  // must look reasonable, OR (shared mode) the global App is already
  // configured and we're inheriting it.
  const appStepValid = useMemo(() => {
    if (mode === 'shared') {
      if (globalConfigured) return true;
      return looksLikeId(sharedAppId) && sharedKeyPath.trim().length > 0;
    }
    // per-org
    return looksLikeId(overrideAppId) && overrideKeyPath.trim().length > 0;
  }, [mode, globalConfigured, sharedAppId, sharedKeyPath, overrideAppId, overrideKeyPath]);

  const handleProbe = async () => {
    if (!installationValid) return;
    const result = await probe.mutateAsync({ installationId, app: effectiveOverride });
    setProbeResult(result);
  };

  const handleCreate = async () => {
    try {
      // 1. If the user picked shared mode but the global App isn't
      //    configured yet, persist their App credentials as the global
      //    App now. The probe step has already validated them against
      //    the live GitHub API, so this write is safe.
      if (mode === 'shared' && !globalConfigured) {
        await updateGlobalApp.mutateAsync({
          id: sharedAppId.trim(),
          privateKeyPath: sharedKeyPath.trim(),
          ifMatch: appStatusHash ?? undefined,
        });
      }

      // 2. Create the connector. In per-org mode, attach the override;
      //    in shared mode, leave `app` undefined so the resolver falls
      //    back to the (now-configured) global.
      const created = await create.mutateAsync({
        id: connectorId,
        type: 'github',
        name,
        installationId,
        org,
        scope,
        entities,
        app:
          mode === 'per-org'
            ? {
                id: overrideAppId.trim(),
                privateKeyPath: overrideKeyPath.trim(),
              }
            : undefined,
      });

      // 3. Trigger initial sync.
      await triggerSync.mutateAsync(created.id);

      toast({
        variant: 'ok',
        title: 'GitHub connector created',
        description: `Initial sync started for ${created.org}.`,
      });
      handleOpenChange(false);
    } catch (err) {
      toast({
        variant: 'err',
        title: 'Failed to create connector',
        description: (err as Error).message,
      });
    }
  };

  const steps: WizardStep[] = [
    {
      id: 'app',
      // One-word labels everywhere — WizardDialog allocates fixed-width
      // slots per step and wraps anything longer, which looked broken
      // when only steps 1 and 4 wrapped. Detailed labels live in the
      // step body / banners, not the indicator.
      label: 'App',
      canAdvance: () => appStepValid,
      content: (
        <div className="flex flex-col gap-3">
          <Banner tone="accent">
            ShipIt-AI authenticates to GitHub through a{' '}
            <a
              href="/docs/connectors/github-setup"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              GitHub App
            </a>
            . Most teams use one shared App for all their orgs — pick the second option only if you
            need blast-radius isolation between orgs (e.g. dev vs prod).
          </Banner>

          <AppModeCard
            selected={mode === 'shared'}
            title={
              globalConfigured ? 'Use the shared GitHub App' : 'Use one shared App for all my orgs'
            }
            recommended
            description={
              globalConfigured
                ? 'This connector will use the App already configured on the server.'
                : 'You’ll set this up once — future connectors can reuse the same App without re-entering credentials.'
            }
            onSelect={() => setMode('shared')}
          >
            {globalConfigured ? (
              <div className="bg-panel-2 border-border rounded border p-2 text-[12px]">
                <Row label="App ID" value={<code>{appStatus?.id}</code>} />
                <Row label="Private key path" value={<code>{appStatus?.privateKeyPath}</code>} />
              </div>
            ) : (
              mode === 'shared' && (
                <SharedAppFields
                  appId={sharedAppId}
                  keyPath={sharedKeyPath}
                  onAppId={(v) => {
                    setSharedAppId(v);
                    setProbeResult(null);
                  }}
                  onKeyPath={(v) => {
                    setSharedKeyPath(v);
                    setProbeResult(null);
                  }}
                />
              )
            )}
          </AppModeCard>

          <AppModeCard
            selected={mode === 'per-org'}
            title="Use a separate App for this org"
            description={
              globalConfigured
                ? 'Override the shared App with a dedicated one. The override is stored on this connector only.'
                : 'Skip configuring a shared App — use these credentials for this org only.'
            }
            onSelect={() => setMode('per-org')}
          >
            {mode === 'per-org' && (
              <SharedAppFields
                appId={overrideAppId}
                keyPath={overrideKeyPath}
                onAppId={(v) => {
                  setOverrideAppId(v);
                  setProbeResult(null);
                }}
                onKeyPath={(v) => {
                  setOverrideKeyPath(v);
                  setProbeResult(null);
                }}
              />
            )}
          </AppModeCard>
        </div>
      ),
    },
    {
      id: 'connect',
      label: 'Connect',
      // Advances only after a successful probe — proves credentials work
      // before the user spends time on org/scope decisions.
      canAdvance: () => probeOk,
      content: (
        <div className="flex flex-col gap-3">
          <Field
            label="Installation ID"
            required
            hint="Numeric ID from the App's installation URL (e.g. 12345678). One per org."
          >
            {(p) => (
              <Input
                {...p}
                placeholder="12345678"
                value={installationId}
                onChange={(e) => {
                  setInstallationId(e.target.value);
                  setProbeResult(null);
                }}
              />
            )}
          </Field>
          <p className="text-text-muted text-[12px]">
            Find this in GitHub → App settings → Install App → the install URL ends in the numeric
            ID. If you haven't installed the App in this org yet, do that first.
          </p>
          <Button
            variant="outline"
            onClick={handleProbe}
            disabled={!installationValid || !appStepValid || probe.isPending}
          >
            {probe.isPending ? (
              <>
                <Spinner size="sm" /> Testing…
              </>
            ) : (
              'Test connection'
            )}
          </Button>
          {probeResult && !probeResult.ok && (
            <Banner tone="err">
              <strong>{probeResult.code ?? 'PROBE_FAILED'}:</strong>{' '}
              {probeResult.message ?? 'Probe failed for an unknown reason.'}
            </Banner>
          )}
          {probeResult?.ok && (
            <Banner tone="ok">
              Connected to <strong>{probeResult.installation?.account ?? 'unknown'}</strong> (
              {probeResult.installation?.accountType}). {probeResult.installation?.repoCount}{' '}
              repositories accessible.
              {probeResult.app?.overridden && mode === 'per-org' && (
                <div className="mt-1 text-[11px]">
                  Authenticated as App <code>{probeResult.app.id}</code> (per-org override).
                </div>
              )}
              {probeResult.sampleRepos && probeResult.sampleRepos.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {probeResult.sampleRepos.map((r) => (
                    <span key={r.name} className="bg-panel-2 rounded px-1.5 py-0.5">
                      {r.name}
                    </span>
                  ))}
                </div>
              )}
            </Banner>
          )}
        </div>
      ),
    },
    {
      id: 'configure',
      label: 'Configure',
      canAdvance: () => orgValid && idValid && nameValid,
      content: (
        <div className="flex flex-col gap-5">
          {/* Section 1: org identity. Three short text fields that the
              probe step has already defaulted from the GitHub response —
              the user usually just confirms and moves on. */}
          <ConfigureSection title="Org details">
            <Field
              label="GitHub org"
              required
              hint="The login of the org whose data this connector will sync."
            >
              {(p) => <Input {...p} value={org} onChange={(e) => setOrg(e.target.value)} />}
            </Field>
            <Field
              label="Connector ID"
              required
              hint="Used in the URL and as the BullMQ queue name. Lowercase letters, digits, hyphens."
            >
              {(p) => (
                <Input
                  {...p}
                  value={connectorId}
                  onChange={(e) => setConnectorId(e.target.value)}
                />
              )}
            </Field>
            <Field label="Display name" required>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
          </ConfigureSection>

          {/* Section 2: repo scope. The cap banner belongs here because
              the cap only applies to the include list, not entity types. */}
          <ConfigureSection title="Repo scope">
            <Banner tone="warn">
              Initial sync is capped at the first <strong>{scope.cappedAt ?? '∞'}</strong>{' '}
              repositories. Uncheck the cap below to remove it after you've reviewed scope.
            </Banner>
            <Field
              label="Include patterns"
              hint="Glob patterns, one per line. `**` matches everything."
            >
              {(p) => (
                <Input
                  {...p}
                  value={scope.repos.include.join('\n')}
                  onChange={(e) =>
                    setScope({
                      ...scope,
                      repos: {
                        ...scope.repos,
                        include: e.target.value.split('\n').filter(Boolean),
                      },
                    })
                  }
                />
              )}
            </Field>
            <Field label="Exclude patterns" hint="Optional. Applied after include.">
              {(p) => (
                <Input
                  {...p}
                  value={scope.repos.exclude.join('\n')}
                  onChange={(e) =>
                    setScope({
                      ...scope,
                      repos: {
                        ...scope.repos,
                        exclude: e.target.value.split('\n').filter(Boolean),
                      },
                    })
                  }
                />
              )}
            </Field>
            <Checkbox
              label="Remove the safety cap (sync all matching repos)"
              checked={scope.cappedAcknowledged}
              onCheckedChange={(checked) => {
                const v = checked === true;
                setScope({ ...scope, cappedAcknowledged: v, cappedAt: v ? null : 100 });
              }}
            />
          </ConfigureSection>

          {/* Section 3: entity-type toggles. Defaults are reasonable so
              most users skim past this. */}
          <ConfigureSection title="Entity types to sync">
            <div className="grid grid-cols-2 gap-2">
              <Checkbox
                label="Repositories"
                checked={entities.repository}
                onCheckedChange={(c) => setEntities({ ...entities, repository: c === true })}
              />
              <Checkbox
                label="Teams + members"
                checked={entities.team}
                onCheckedChange={(c) => setEntities({ ...entities, team: c === true })}
              />
              <Checkbox
                label="Pipelines (workflows)"
                checked={entities.pipeline}
                onCheckedChange={(c) => setEntities({ ...entities, pipeline: c === true })}
              />
              <Checkbox
                label="CODEOWNERS"
                checked={entities.codeowners}
                onCheckedChange={(c) => setEntities({ ...entities, codeowners: c === true })}
              />
            </div>
          </ConfigureSection>
        </div>
      ),
    },
    {
      id: 'review',
      label: 'Review',
      content: (
        <ReviewSummary
          rows={[
            { label: 'Connector ID', value: connectorId },
            { label: 'Name', value: name },
            { label: 'GitHub org', value: org },
            { label: 'Installation', value: installationId },
            {
              label: 'App',
              value:
                mode === 'shared'
                  ? globalConfigured
                    ? `shared (existing: ${appStatus?.id})`
                    : `shared (new: ${sharedAppId})`
                  : `per-org override: ${overrideAppId}`,
            },
            { label: 'Repo include', value: scope.repos.include.join(', ') || '**' },
            { label: 'Repo exclude', value: scope.repos.exclude.join(', ') || '—' },
            { label: 'Cap', value: scope.cappedAt ?? 'no cap' },
            {
              label: 'Entities',
              value: Object.entries(entities)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(', '),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <WizardDialog
      open={open}
      onOpenChange={handleOpenChange}
      steps={steps}
      title="Connect GitHub"
      description="Add a GitHub org to your knowledge graph."
      // Viewport-responsive: caps at 760px on desktop but shrinks with
      // the screen so the dialog never extends past the viewport edge.
      // Combined with the 5 one-word step labels, the step indicator
      // stays on a single line down to ~480px wide.
      width="min(760px, calc(100vw - 32px))"
      completeLabel={
        updateGlobalApp.isPending || create.isPending || triggerSync.isPending
          ? 'Creating…'
          : 'Create + sync'
      }
      cancelLabel="Cancel"
      onCancel={() => handleOpenChange(false)}
      onComplete={handleCreate}
    />
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function AppModeCard({
  selected,
  title,
  description,
  recommended,
  onSelect,
  children,
}: {
  selected: boolean;
  title: string;
  description: string;
  recommended?: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  // Clickable card acts as a radio. Native <input type=radio> would be
  // accessible but visually fights the rest of the wizard; this preserves
  // keyboard interaction via Enter/Space because the outer is a <button>.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        'border-border bg-panel hover:border-border-strong flex flex-col gap-2 rounded-md border p-3 text-left outline-none ' +
        'focus-visible:ring-accent-dim focus-visible:ring-[3px] ' +
        (selected ? 'border-accent bg-accent-dim/40' : '')
      }
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={
            'inline-block h-3 w-3 rounded-full border ' +
            (selected ? 'border-accent bg-accent' : 'border-border-strong')
          }
        />
        <span className="text-text text-[14px] font-medium">{title}</span>
        {recommended && (
          <span className="text-text-muted text-[10px] tracking-[1.4px] uppercase">
            Recommended
          </span>
        )}
      </div>
      <p className="text-text-muted text-[12px]">{description}</p>
      {children && <div className="flex flex-col gap-2 pt-1">{children}</div>}
    </button>
  );
}

function SharedAppFields({
  appId,
  keyPath,
  onAppId,
  onKeyPath,
}: {
  appId: string;
  keyPath: string;
  onAppId: (v: string) => void;
  onKeyPath: (v: string) => void;
}) {
  // Stop propagation on inputs so clicking them doesn't re-trigger the
  // surrounding card's onSelect (which would steal focus on each
  // keystroke). The card's role here is just radio selection.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div onClick={stop} className="flex flex-col gap-2">
      <Field label="App ID" required hint="Numeric App ID from the App's settings page.">
        {(p) => (
          <Input
            {...p}
            placeholder="123456"
            value={appId}
            onChange={(e) => onAppId(e.target.value)}
            onClick={stop}
          />
        )}
      </Field>
      <Field
        label="Private key path"
        required
        hint="Absolute path on the API server (e.g. /etc/shipit/keys/dev-app.pem)."
      >
        {(p) => (
          <Input
            {...p}
            placeholder="/path/to/app-private-key.pem"
            value={keyPath}
            onChange={(e) => onKeyPath(e.target.value)}
            onClick={stop}
          />
        )}
      </Field>
    </div>
  );
}

// Visual grouping inside the Configure step. The step packs three
// distinct concerns (org identity, repo scope, entity toggles), and
// without headers the form reads as one long undifferentiated list.
function ConfigureSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-text-muted font-mono text-[10px] tracking-[1.4px] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-text-muted font-mono text-[10px] tracking-[1.4px] uppercase">
        {label}
      </span>
      <span className="text-text font-mono">{value}</span>
    </div>
  );
}

function ReviewSummary({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return (
    <div className="border-border bg-panel-2 rounded-md border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="text-text-muted text-[24px] leading-none">
          <IconGlyph name="github" size={24} />
        </span>
        <div>
          <div className="text-text text-[14px] font-medium">GitHub connector</div>
          <div className="text-text-muted text-[12px]">
            One org per connector instance. Review and submit to create.
          </div>
        </div>
      </div>
      <dl className="m-0 flex flex-col gap-1 text-[12px]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="border-border flex items-center justify-between border-t border-dashed py-1"
          >
            <dt className="text-text-muted font-mono text-[10px] tracking-[1.4px] uppercase">
              {row.label}
            </dt>
            <dd className="text-text font-mono">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
