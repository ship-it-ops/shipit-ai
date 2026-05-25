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
  buildManifestLaunchUrl,
  fetchPendingInstanceApp,
  GitHubAppNotConfiguredError,
  type ConnectorAppOverride,
  type ConnectorEntities,
  type ConnectorScope,
  type GitHubAppInstallation,
  type ProbeResult,
} from '@/lib/api';
import {
  useCreateConnector,
  useGitHubAppInstallations,
  useGitHubAppStatus,
  useProbeConnector,
  useTriggerSync,
  useUpdateGitHubApp,
} from '@/lib/hooks/use-connectors';
import { useQueryClient } from '@tanstack/react-query';

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
  const queryClient = useQueryClient();
  // Only fetch the App status while the dialog is open — avoids a 503
  // request on every page mount when the GitHubAppService isn't wired
  // (e.g. tests, environments without a config).
  const appStatusQuery = useGitHubAppStatus();
  const appStatus = open ? appStatusQuery.data?.status : undefined;
  const appStatusHash = open ? appStatusQuery.data?.hash : null;

  // Tracks whether the user has opened the manifest flow in another tab.
  // While true, we poll the global-App status so the wizard auto-detects
  // when the callback finishes persisting the new App. Used by the
  // shared card (target=global).
  const [manifestPending, setManifestPending] = useState(false);
  // Owner org for the manifest "Create App" button. Optional for the
  // shared path (empty → personal account), required for the per-org
  // path (the App is scoped to this org).
  const [manifestOwner, setManifestOwner] = useState('');

  // Per-org manifest flow state. The wizard generates `perOrgNonce`
  // when the user clicks "Create App on GitHub" in the per-org card;
  // it's threaded through the launch URL so the manifest callback
  // can stash credentials keyed by it. While `perOrgPending` is true,
  // a polling effect calls /manifest/pending-instance/:nonce until
  // the credentials arrive (or the user cancels).
  const [perOrgPending, setPerOrgPending] = useState(false);
  const [perOrgNonce, setPerOrgNonce] = useState<string | null>(null);

  const [installationId, setInstallationId] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [org, setOrg] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ConnectorScope>(DEFAULT_SCOPE);
  const [entities, setEntities] = useState<ConnectorEntities>(DEFAULT_ENTITIES);

  // App-identity state. `mode` defaults to 'per-org' because GitHub Apps
  // created via our manifest are private ("Only on this account") and
  // can only be installed in the account that owns them. Sharing one App
  // across multiple orgs requires marking it public on GitHub, which
  // most teams reject (the App becomes discoverable on github.com/apps/
  // and anyone can install it). Per-org keeps each App private and
  // contained — the trade-off is one App to maintain per org. The
  // shared path stays available for users who do want a public App.
  const [mode, setMode] = useState<AppMode>('per-org');
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
    setMode('per-org');
    setSharedAppId('');
    setSharedKeyPath('');
    setOverrideAppId('');
    setOverrideKeyPath('');
    setManifestOwner('');
    setManifestPending(false);
    setPerOrgPending(false);
    setPerOrgNonce(null);
    probe.reset();
    create.reset();
    updateGlobalApp.reset();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  // Defensive: reset transient pending state whenever the dialog opens
  // fresh. The dialog's parent component does call reset() on close, but
  // if a hydration error or React-fast-refresh caused the component to
  // hold state across mounts, this is the seatbelt. Cheap to run.
  useEffect(() => {
    if (open) {
      setManifestPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-populate id and name once the probe gives us an org.
  useEffect(() => {
    if (probeResult?.ok && probeResult.suggestedOrg && !org) {
      setOrg(probeResult.suggestedOrg);
      if (!connectorId) setConnectorId(defaultIdFor(probeResult.suggestedOrg));
      if (!name) setName(`GitHub · ${probeResult.suggestedOrg}`);
    }
  }, [probeResult, org, connectorId, name]);

  // While the manifest flow is pending (user clicked "Create from
  // template", popup is somewhere with their attention), poll the
  // app-status query so the wizard auto-detects when the callback
  // finishes persisting. Two seconds is responsive without being chatty.
  // Stops as soon as `configured` flips to true.
  useEffect(() => {
    if (!manifestPending || !open) return;
    const handle = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['github-app-status'] });
    }, 2000);
    return () => clearInterval(handle);
  }, [manifestPending, open, queryClient]);

  // Clear pending once the global App is configured. Whatever event
  // triggered the persist (manifest callback, manual PUT in another
  // tab, etc.) we trust the status — pending was just a hint.
  useEffect(() => {
    if (manifestPending && appStatus?.configured) {
      setManifestPending(false);
      toast({
        variant: 'ok',
        title: 'GitHub App configured',
        description: `Using App ${appStatus.id}. You can continue the wizard.`,
      });
    }
  }, [manifestPending, appStatus, toast]);

  const installationValid = useMemo(() => looksLikeId(installationId), [installationId]);

  // Installations picker — only useful when a shared App is already
  // configured on the server, because we authenticate as that App's JWT
  // to call `/app/installations`. In per-org mode (the user is bringing
  // their own App PEM inline) we don't have the App keys server-side
  // yet, so the picker can't help — they fall back to manual entry.
  const pickerEligible = mode === 'shared' && globalConfigured;
  const installationsQuery = useGitHubAppInstallations({
    enabled: open && pickerEligible,
  });

  // Cross-reference the picked installation against the picker's data
  // to detect when the user picked one that's already wired to another
  // connector. Blocks Next so we don't create a duplicate.
  const pickedInstallation = useMemo<GitHubAppInstallation | undefined>(
    () => installationsQuery.data?.installations.find((i) => String(i.id) === installationId),
    [installationsQuery.data, installationId],
  );
  const duplicateConnectorId = pickedInstallation?.usedByConnectorId ?? null;

  const probeOk = probeResult?.ok === true && !duplicateConnectorId;
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

  // Kick off the App manifest flow.
  //
  // GitHub's manifest mechanism requires an HTML form POST whose body
  // carries the manifest JSON — there is no `manifest_url` query param
  // that GitHub fetches (the earlier implementation got that wrong and
  // produced an empty App-creation form). The server hosts an HTML page
  // at /api/connectors/github/manifest/launch that contains the auto-
  // submitting form; we just open that URL in a new tab. Same-origin
  // means no popup-blocker issues and no async work inside the click.
  const handleCreateFromTemplate = () => {
    const url = buildManifestLaunchUrl({
      ownerOrg: manifestOwner.trim() || undefined,
    });
    // noopener+noreferrer keeps the new tab from accessing the wizard's
    // window via `opener` — defense in depth, github.com is trustworthy
    // but the launch page → github.com chain is two navigations.
    window.open(url, '_blank', 'noopener,noreferrer');
    setManifestPending(true);
  };

  // Per-org variant of the manifest flow. Generates a wizard-side
  // nonce, opens the launch URL with target=instance, and arms the
  // polling effect below — when the callback stashes credentials in
  // the pending-instance map, the next poll claims them and fills the
  // override fields. The user never has to copy-paste anything.
  const handleCreateInstanceApp = () => {
    const owner = manifestOwner.trim();
    if (!owner) return;
    const nonce =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    const url = buildManifestLaunchUrl({
      ownerOrg: owner,
      target: 'instance',
      nonce,
    });
    window.open(url, '_blank', 'noopener,noreferrer');
    setPerOrgNonce(nonce);
    setPerOrgPending(true);
  };

  // Poll for pending-instance credentials. 2-second cadence matches the
  // global-App polling under the shared flow. Stops when credentials
  // arrive, the user cancels, or the dialog closes.
  useEffect(() => {
    if (!perOrgPending || !perOrgNonce || !open) return;
    let cancelled = false;
    const handle = setInterval(() => {
      void (async () => {
        try {
          const creds = await fetchPendingInstanceApp(perOrgNonce);
          if (cancelled || !creds) return;
          setOverrideAppId(creds.appId);
          setOverrideKeyPath(creds.privateKeyPath);
          setPerOrgPending(false);
          setPerOrgNonce(null);
          setProbeResult(null);
          toast({
            variant: 'ok',
            title: 'GitHub App created',
            description: `App ${creds.appName} (id ${creds.appId}) credentials attached. Continue the wizard.`,
          });
        } catch {
          // Network blip — keep polling. The TTL on the pending entry
          // is 15 minutes; the user can cancel via the link below.
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [perOrgPending, perOrgNonce, open, toast]);

  // Accepts an explicit id so the installation picker can fire the probe
  // in the same tick as `setInstallationId` — React state updates haven't
  // applied yet at the call site, so reading `installationId` from state
  // would race against the click handler.
  const handleProbe = async (idOverride?: string) => {
    const id = idOverride ?? installationId;
    if (!looksLikeId(id)) return;
    const result = await probe.mutateAsync({ installationId: id, app: effectiveOverride });
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
            . The recommended path is one App per org — each App stays private to its owner account,
            which is GitHub&apos;s default (&ldquo;Only on this account&rdquo;). The shared path
            needs you to make the App <strong>public</strong> in GitHub so it can be installed on
            accounts you don&apos;t own.
          </Banner>

          <AppModeCard
            selected={mode === 'per-org'}
            title="One App for this org"
            recommended
            description={
              globalConfigured
                ? 'Create or paste credentials for a dedicated App scoped to this org. The App stays private ("Only on this account") and the override is stored on this connector only.'
                : 'Create or paste credentials for a GitHub App that lives in this org. Recommended — the App stays private ("Only on this account") and a leaked key only reads this one org.'
            }
            onSelect={() => setMode('per-org')}
          >
            {mode === 'per-org' && (
              <>
                {/* Per-org manifest flow: same one-click create as
                    shared, but the callback stashes credentials in a
                    per-instance pending slot keyed by `perOrgNonce`
                    instead of writing to the global App slot. The
                    polling effect above watches that slot and fills
                    the override fields below when the callback fires. */}
                <div className="bg-panel-2 border-border flex flex-col gap-2 rounded border p-3">
                  <div className="text-text text-[12px] font-medium">
                    Create the App in this org{' '}
                    <span className="text-text-muted text-[10px] tracking-[1.4px] uppercase">
                      Recommended
                    </span>
                  </div>
                  <p className="text-text-muted text-[12px]">
                    Opens GitHub with a pre-filled &ldquo;Register GitHub App&rdquo; form scoped to
                    your org. The App stays private (&ldquo;Only on this account&rdquo;). After you
                    click Create on GitHub, the wizard auto-fills the App ID and private- key path
                    below.
                  </p>
                  <Field
                    label="Org login"
                    required
                    hint="GitHub org login — the slug after github.com/, e.g. `acme-corp`. The org must already exist and you must be an admin."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        placeholder="acme-corp"
                        value={manifestOwner}
                        onChange={(e) => setManifestOwner(e.target.value)}
                        disabled={perOrgPending}
                      />
                    )}
                  </Field>
                  <p className="text-text-muted text-[11px]">
                    Will open:{' '}
                    <code className="text-text">
                      {manifestOwner.trim()
                        ? `github.com/organizations/${manifestOwner.trim()}/settings/apps/new`
                        : '— enter an org login first —'}
                    </code>
                  </p>
                  <Button
                    onClick={handleCreateInstanceApp}
                    disabled={!manifestOwner.trim() || perOrgPending}
                  >
                    {perOrgPending ? (
                      <>
                        <Spinner size="sm" /> Waiting for GitHub…
                      </>
                    ) : (
                      'Create App on GitHub'
                    )}
                  </Button>
                  {perOrgPending && (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-text-muted text-[11px]">
                        A new tab is open at github.com. Complete the create flow there — this page
                        polls every 2 s and auto-fills credentials below when ready.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setPerOrgPending(false);
                          setPerOrgNonce(null);
                        }}
                        className="text-text-muted hover:text-text shrink-0 text-[11px] underline"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>

                {/* Manual paste fallback: collapsed because the manifest
                    path is the recommended one. Stays visible for users
                    who already have an App or for recovery if the
                    callback failed to stash credentials. */}
                <details className="border-border bg-panel-2 rounded border">
                  <summary className="text-text-muted cursor-pointer px-3 py-2 text-[12px]">
                    I already have an App — paste credentials manually
                  </summary>
                  <div className="px-3 pb-3">
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
                  </div>
                </details>
              </>
            )}
          </AppModeCard>

          <AppModeCard
            selected={mode === 'shared'}
            title={
              globalConfigured ? 'Use the shared GitHub App' : 'Use one shared App across orgs'
            }
            description={
              globalConfigured
                ? 'This connector will use the App already configured on the server. Requires the App to be marked public in GitHub.'
                : 'One App, installed in many orgs. Saves setup work but requires you to mark the App public in GitHub so it can be installed on accounts you don’t own — the App becomes discoverable on github.com/apps/<slug>.'
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
                <>
                  {/* Recommended path: create the App from our template
                      via GitHub's manifest flow. Pre-fills permissions,
                      events, webhook URL — user just clicks Create on
                      GitHub's side and comes back to a fully-wired App. */}
                  <div className="bg-panel-2 border-border flex flex-col gap-2 rounded border p-3">
                    <div className="text-text text-[12px] font-medium">
                      Create the App from our template{' '}
                      <span className="text-text-muted text-[10px] tracking-[1.4px] uppercase">
                        Recommended
                      </span>
                    </div>
                    <p className="text-text-muted text-[12px]">
                      We&apos;ll send you to GitHub with the permissions, events, and webhook URL
                      already filled in. After you click Create on GitHub, this wizard auto- detects
                      the new App and you can keep going.
                    </p>
                    <Field
                      label="Owner organization (optional)"
                      hint="GitHub org LOGIN — the slug after github.com/, e.g. `acme-corp`. The org must already exist. Leave blank to create the App under your personal GitHub account; you can transfer it to an org from GitHub later."
                    >
                      {(p) => (
                        <Input
                          {...p}
                          placeholder="acme-corp"
                          value={manifestOwner}
                          onChange={(e) => setManifestOwner(e.target.value)}
                          disabled={manifestPending}
                        />
                      )}
                    </Field>
                    {/* Live preview of the destination URL. Removes any
                        ambiguity about where the user is about to land —
                        the previous "App owner" label was guessed-at and
                        sent users to nonexistent org URLs. */}
                    <p className="text-text-muted text-[11px]">
                      Will open:{' '}
                      <code className="text-text">
                        {manifestOwner.trim()
                          ? `github.com/organizations/${manifestOwner.trim()}/settings/apps/new`
                          : 'github.com/settings/apps/new'}
                      </code>
                      {manifestOwner.trim() && (
                        <>
                          {' '}
                          —{' '}
                          <a
                            href={`https://github.com/${encodeURIComponent(manifestOwner.trim())}`}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            verify the org exists
                          </a>{' '}
                          before clicking Create.
                        </>
                      )}
                    </p>
                    <Button onClick={handleCreateFromTemplate} disabled={manifestPending}>
                      {manifestPending ? (
                        <>
                          <Spinner size="sm" /> Waiting for GitHub…
                        </>
                      ) : (
                        'Create App on GitHub'
                      )}
                    </Button>
                    {manifestPending && (
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-text-muted text-[11px]">
                          A new tab is open at github.com. Complete the create flow there; this page
                          will refresh automatically once the App is configured.
                        </p>
                        {/* Explicit escape hatch — if the user closed the
                            GitHub tab without finishing (wrong org URL,
                            changed their mind, etc.) they need a way out
                            of "Waiting…" that doesn't require closing the
                            whole wizard. */}
                        <button
                          type="button"
                          onClick={() => setManifestPending(false)}
                          className="text-text-muted hover:text-text shrink-0 text-[11px] underline"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Manual path: collapsible, for users who already
                      have an App created (or who can't use the manifest
                      flow because the org locks who can create Apps). */}
                  <details className="border-border bg-panel-2 rounded border">
                    <summary className="text-text-muted cursor-pointer px-3 py-2 text-[12px]">
                      I already have a GitHub App — paste credentials manually
                    </summary>
                    <div className="px-3 pb-3">
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
                    </div>
                  </details>
                </>
              )
            )}
          </AppModeCard>

          {mode === 'shared' && (
            <Banner tone="warn">
              <strong>Reminder:</strong> sharing one App across orgs requires marking it{' '}
              <strong>public</strong> in GitHub (App settings → &ldquo;Where can this GitHub App be
              installed?&rdquo; → <em>Any account</em>). Public Apps are listed on{' '}
              <code>github.com/apps/&lt;slug&gt;</code> and anyone with the link can install them on
              their own accounts. If that&apos;s not acceptable, switch back to{' '}
              <strong>One App for this org</strong>.
            </Banner>
          )}
        </div>
      ),
    },
    {
      id: 'connect',
      label: 'Connect',
      // Advances only after a successful probe — proves credentials work
      // before the user spends time on org/scope decisions. The duplicate
      // guard inside `probeOk` also blocks here so two connector instances
      // can't claim the same installation.
      canAdvance: () => probeOk,
      content: (
        <div className="flex flex-col gap-3">
          {pickerEligible ? (
            <InstallationPicker
              query={installationsQuery}
              selectedId={installationId}
              onSelect={(inst) => {
                const id = String(inst.id);
                setInstallationId(id);
                setProbeResult(null);
                // Probe immediately — saves the user a "Test connection"
                // click since the picker selection already implies intent.
                void handleProbe(id);
              }}
            />
          ) : (
            <ManualInstallationEntry
              value={installationId}
              onChange={(v) => {
                setInstallationId(v);
                setProbeResult(null);
              }}
              onTest={() => void handleProbe()}
              testing={probe.isPending}
              disabled={!installationValid || !appStepValid}
              // In per-org mode, link the user to the App they're about
              // to override (the URL we'd use otherwise comes from the
              // installations endpoint, which isn't queried in this mode).
              installUrl={null}
            />
          )}

          {duplicateConnectorId && (
            <Banner tone="warn">
              This installation is already connected to <code>{duplicateConnectorId}</code>. Each
              installation can back only one connector — pick a different org or remove the existing
              connector first.
            </Banner>
          )}

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

          {/* Advanced fallback: keeps the manual ID flow accessible from
              the picker view too. Required for users whose picker call
              fails (network, GitHub rate limits) and for any edge case
              where the listed installations don't include the target. */}
          {pickerEligible && (
            <details className="border-border bg-panel-2 rounded border">
              <summary className="text-text-muted cursor-pointer px-3 py-2 text-[12px]">
                I don&apos;t see my org — paste an installation ID manually
              </summary>
              <div className="px-3 pb-3">
                <ManualInstallationEntry
                  value={installationId}
                  onChange={(v) => {
                    setInstallationId(v);
                    setProbeResult(null);
                  }}
                  onTest={() => void handleProbe()}
                  testing={probe.isPending}
                  disabled={!installationValid || !appStepValid}
                  installUrl={installationsQuery.data?.installUrl ?? null}
                />
              </div>
            </details>
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
              repositories. Uncheck the cap below to remove it after you&apos;ve reviewed scope.
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
  // The card is a <div>, not a <button>, because its `children` slot
  // routinely contains interactive elements (buttons, inputs, details
  // expanders) and nesting buttons inside a button is invalid HTML —
  // React's hydration check will scream and Firefox/Safari render the
  // tree inconsistently.
  //
  // Selection happens via the header button at the top (radio dot +
  // title). The card visually changes background/border based on
  // `selected`, but only the header captures the click. The children
  // area sits as a sibling, free to host its own widgets.
  return (
    <div
      role="radiogroup"
      aria-checked={selected}
      className={
        'border-border bg-panel rounded-md border p-3 outline-none ' +
        (selected ? 'border-accent bg-accent-dim/40' : '')
      }
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={
          'group flex w-full flex-col gap-2 text-left outline-none ' +
          'focus-visible:ring-accent-dim focus-visible:ring-[3px]'
        }
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              'inline-block h-3 w-3 shrink-0 rounded-full border ' +
              (selected
                ? 'border-accent bg-accent'
                : 'border-border-strong group-hover:border-border-strong')
            }
          />
          <span className="text-text text-[14px] font-medium">{title}</span>
          {recommended && (
            <span className="text-text-muted text-[10px] tracking-[1.4px] uppercase">
              Recommended
            </span>
          )}
        </span>
        <span className="text-text-muted block text-[12px]">{description}</span>
      </button>
      {children && <div className="flex flex-col gap-2 pt-3">{children}</div>}
    </div>
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

// Picks an org from the App's actual installations. The previous "paste
// an installation ID" textbox was the #1 source of "I tested against the
// wrong org" confusion — the user pasted org A's ID into a wizard meant
// for org B because there was no way to enumerate installations.
function InstallationPicker({
  query,
  selectedId,
  onSelect,
}: {
  query: ReturnType<typeof useGitHubAppInstallations>;
  selectedId: string;
  onSelect: (inst: GitHubAppInstallation) => void;
}) {
  const data = query.data;
  const notConfigured = query.error instanceof GitHubAppNotConfiguredError;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="text-text text-[13px] font-medium">Pick the org to connect</div>
          <div className="text-text-muted text-[11px]">
            One installation = one connector instance.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="text-text-muted hover:text-text text-[11px] underline disabled:opacity-50"
          >
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {data?.installUrl && (
            <a
              href={data.installUrl}
              target="_blank"
              rel="noreferrer"
              className="border-border-strong text-text hover:bg-panel-2 rounded-xs border px-2 py-1 text-[12px]"
            >
              Install in another org ↗
            </a>
          )}
        </div>
      </div>

      {query.isLoading && (
        <div className="text-text-muted flex items-center gap-2 text-[12px]">
          <Spinner size="sm" /> Loading installations…
        </div>
      )}

      {query.isError && !notConfigured && (
        <Banner tone="err">
          Could not list App installations: {(query.error as Error).message}. Use the manual entry
          below.
        </Banner>
      )}

      {data && data.installations.length === 0 && (
        <Banner tone="warn">
          <strong>{data.appName || 'The App'}</strong> isn&apos;t installed in any organization yet.
          Click <strong>Install in another org</strong> above to add it where you want to sync —
          when the install completes and you return to this tab, the list refreshes automatically.
        </Banner>
      )}

      {data?.installations.map((inst) => {
        const used = inst.usedByConnectorId !== null;
        const selected = String(inst.id) === selectedId;
        return (
          <button
            key={inst.id}
            type="button"
            onClick={() => onSelect(inst)}
            aria-pressed={selected}
            className={
              'border-border bg-panel hover:bg-panel-2 focus-visible:ring-accent-dim ' +
              'flex items-center gap-3 rounded-md border px-3 py-2 text-left outline-none ' +
              'transition-colors focus-visible:ring-[3px] ' +
              (selected ? 'border-accent bg-accent-dim/40 hover:bg-accent-dim/40' : '') +
              (used && !selected ? ' opacity-70' : '')
            }
          >
            {inst.account.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={inst.account.avatarUrl}
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 shrink-0 rounded-md"
              />
            ) : (
              <span className="bg-panel-2 grid h-8 w-8 shrink-0 place-items-center rounded-md">
                <IconGlyph name="github" size={16} />
              </span>
            )}
            <div className="flex flex-1 flex-col">
              <span className="text-text text-[13px] font-medium">{inst.account.login}</span>
              <span className="text-text-muted text-[11px]">
                {inst.account.type} · ID {inst.id} ·{' '}
                {inst.repositorySelection === 'all' ? 'All repos' : 'Selected repos'}
              </span>
            </div>
            {used && (
              <span className="text-text-muted bg-panel-2 rounded px-2 py-0.5 font-mono text-[10px] tracking-[1.2px] uppercase">
                Used by {inst.usedByConnectorId}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Manual installation-ID entry — the path the wizard used exclusively
// before the picker existed. Still required for per-org override mode
// (no global App keys server-side → can't list installations) and as a
// fallback when the picker call fails or omits the target org.
function ManualInstallationEntry({
  value,
  onChange,
  onTest,
  testing,
  disabled,
  installUrl,
}: {
  value: string;
  onChange: (next: string) => void;
  onTest: () => void;
  testing: boolean;
  disabled: boolean;
  installUrl: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Installation ID"
        required
        hint="Numeric ID for THIS org's install of the App. One installation = one connector instance."
      >
        {(p) => (
          <Input
            {...p}
            placeholder="12345678"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </Field>
      <div className="bg-panel-2 border-border flex flex-col gap-2 rounded border p-3 text-[12px]">
        <div className="text-text font-medium">Where to find it</div>
        <div className="text-text-muted">
          <strong className="text-text">If you haven&apos;t installed the App yet:</strong>{' '}
          {installUrl ? (
            <>
              open{' '}
              <a href={installUrl} target="_blank" rel="noreferrer" className="text-text underline">
                the App&apos;s install page
              </a>
            </>
          ) : (
            <>
              go to <code>github.com/apps/&lt;your-app-name&gt;/installations/new</code>
            </>
          )}
          , pick the org or user, click <strong>Install</strong>. The URL after install ends in the
          numeric ID.
        </div>
        <div className="text-text-muted">
          <strong className="text-text">If the App is already installed:</strong> the easiest way
          back to the ID is via the <strong>Configure</strong> link in GitHub&apos;s App settings —
          the URL becomes <code>.../settings/installations/&lt;ID&gt;</code>, and the trailing
          number is what you paste here.
        </div>
      </div>
      <Button variant="outline" onClick={onTest} disabled={disabled || testing}>
        {testing ? (
          <>
            <Spinner size="sm" /> Testing…
          </>
        ) : (
          'Test connection'
        )}
      </Button>
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
