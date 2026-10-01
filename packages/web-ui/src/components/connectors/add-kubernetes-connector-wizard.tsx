'use client';

// Four-step wizard for adding a Kubernetes cluster as a connector:
//   Access · Connect · Configure · Review
//
// Mirrors add-github-connector-wizard.tsx's mechanics (useState per field,
// WizardStep[] with canAdvance gates, one-word step labels because
// WizardDialog allocates fixed-width indicator slots) but shares no code with
// it — that wizard is almost entirely GitHub App manifest specifics.
//
// Why the cluster name is collected in step 1 rather than with the rest of the
// config: POST /api/connectors/kubernetes/credentials is keyed by connectorId
// and runs BEFORE the connector exists, so the field the id derives from has to
// be collected before the upload. It also keeps the stored credential filenames
// readable (kubeconfig-k8s-prod-eu.yaml) rather than nonce-based, which matters
// when someone is looking at the key dir during an incident.
//
// WizardDialog exposes no "before next" hook, so the credential upload cannot
// hang off its Next button. The Access step owns an explicit advance action
// that uploads and then calls ctx.goNext(); Next stays gated by canAdvance,
// which only passes once the access block has been stored.

import { useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  Textarea,
  WizardDialog,
  useToast,
  type WizardStep,
} from '@ship-it-ui/ui';
import {
  useCreateConnector,
  useProbeConnector,
  useTriggerSync,
  useUploadKubernetesCredentials,
} from '@/lib/hooks/use-connectors';
import type { KubernetesAccess, KubernetesWorkloadKind, ProbeResult } from '@/lib/api';
import { cn } from '@/lib/utils';

// Mirrors the server-side schema exactly; the cluster name is part of every
// Kubernetes canonical id, so a rejected value here is a rejected write later.
const CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

type AccessMode = 'in-cluster' | 'kubeconfig' | 'token';

// Order matters — it is the order the schema declares and the order the
// Configure step renders.
const ALL_KINDS: KubernetesWorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'];
const DEFAULT_INCLUDE = '*';
const DEFAULT_EXCLUDE = 'kube-system, kube-public, kube-node-lease';

/** Connector id derived from the cluster name; see the header comment. */
export function k8sConnectorId(clusterName: string): string {
  return `k8s-${clusterName}`;
}

// Probe failures reach the user as sentences, not codes. KUBECONFIG_INVALID and
// UNSUPPORTED_AUTH_PLUGIN are deliberately absent: their server-side message
// already names the offending field (exec, auth-provider, proxy-url, a file
// reference), so it is shown verbatim.
const PROBE_MESSAGES: Record<string, string> = {
  IN_CLUSTER_UNAVAILABLE:
    'This ShipIt instance is not running inside a cluster. Use kubeconfig or token access instead.',
  CREDENTIALS_UNREADABLE: 'ShipIt cannot read the stored credential file. Re-upload it.',
  UNAUTHORIZED: 'The cluster rejected these credentials.',
  API_UNREACHABLE: 'ShipIt cannot reach the API server from its network.',
  TIMEOUT: 'The cluster did not answer in time.',
};

// Per-kind probe verdicts as a dot + word rather than the raw API value, so
// `forbidden` reads as something the user can act on (grant the ClusterRole).
const KIND_STATUS: Record<
  NonNullable<ProbeResult['kinds']>[string],
  { dot: string; label: string }
> = {
  ok: { dot: 'bg-ok', label: 'readable' },
  forbidden: { dot: 'bg-warn', label: 'denied — grant list on this kind' },
  error: { dot: 'bg-err', label: 'error' },
  skipped: { dot: 'bg-text-muted', label: 'skipped — no namespace in scope' },
};

function probeMessage(result: ProbeResult): string {
  return (
    PROBE_MESSAGES[result.code ?? ''] ?? result.message ?? 'The connection test did not succeed.'
  );
}

interface AddKubernetesConnectorWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ModeCard({
  selected,
  title,
  description,
  onSelect,
  children,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  // Same selected treatment as the GitHub wizard's option cards (accent border,
  // tinted panel, radio dot) so the active mode reads without relying on the
  // focus ring — which is what a bare border-strong swap amounted to in the
  // dark theme once the button blurred.
  return (
    <div
      data-selected={selected}
      className={cn(
        'rounded-base border-border bg-panel border p-3 transition-colors',
        selected ? 'border-accent bg-accent-dim/40' : 'hover:border-border-strong',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="group focus-visible:ring-accent-dim flex w-full items-start gap-2.5 rounded-sm text-left outline-none focus-visible:ring-[3px]"
      >
        <span
          aria-hidden
          className={cn(
            'mt-[3px] inline-block h-3 w-3 shrink-0 rounded-full border',
            selected ? 'border-accent bg-accent' : 'border-border-strong',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="text-text block text-[14px] font-medium">{title}</span>
          <span className="text-text-muted mt-0.5 block text-[12px]">{description}</span>
        </span>
      </button>
      {selected && children ? <div className="mt-3 flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}

export function AddKubernetesConnectorWizard({
  open,
  onOpenChange,
}: AddKubernetesConnectorWizardProps) {
  const [clusterName, setClusterName] = useState('');
  const [mode, setMode] = useState<AccessMode>('in-cluster');
  const [kubeconfig, setKubeconfig] = useState('');
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [caData, setCaData] = useState('');
  const [access, setAccess] = useState<KubernetesAccess | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  // null = untouched: the field shows (and submits) the cluster name, and keeps
  // following it if the user goes Back and renames the cluster. Once edited it
  // is theirs; an emptied field still falls back to the cluster name on submit.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const effectiveName = (displayName ?? clusterName).trim() || clusterName;
  const [include, setInclude] = useState(DEFAULT_INCLUDE);
  const [exclude, setExclude] = useState(DEFAULT_EXCLUDE);
  const [schedule, setSchedule] = useState('*/5 * * * *');
  // Null until the user touches it; the effective value is derived from the
  // probe so the default tracks what the cluster actually allows.
  const [kinds, setKinds] = useState<KubernetesWorkloadKind[] | null>(null);

  const [createError, setCreateError] = useState<string | null>(null);

  const upload = useUploadKubernetesCredentials();
  const probeConnector = useProbeConnector();
  const createConnector = useCreateConnector();
  const triggerSync = useTriggerSync();
  const { toast } = useToast();

  // Kinds the cluster actually let us read. Drives the Configure step's
  // default selection so a denied kind does not warn on every sync.
  const okKinds = Object.entries(probe?.kinds ?? {})
    .filter(([, status]) => status === 'ok')
    .map(([kind]) => kind as KubernetesWorkloadKind);
  const hasForbiddenKind = Object.values(probe?.kinds ?? {}).some((s) => s === 'forbidden');

  // Default to exactly what probed `ok`. Falling back to every kind when the
  // probe found none keeps the selection submittable — the schema requires at
  // least one — and the Connect step's warning is still on screen to explain it.
  const effectiveKinds = kinds ?? (okKinds.length > 0 ? okKinds : ALL_KINDS);

  function toggleKind(kind: KubernetesWorkloadKind): void {
    setKinds(
      effectiveKinds.includes(kind)
        ? effectiveKinds.filter((k) => k !== kind)
        : [...effectiveKinds, kind],
    );
  }

  async function runProbe(): Promise<void> {
    if (!access) return;
    setProbe(await probeConnector.mutateAsync({ type: 'kubernetes', access }));
  }

  const clusterNameValid = CLUSTER_NAME.test(clusterName);
  const accessStepValid =
    clusterNameValid &&
    (mode === 'in-cluster' ||
      (mode === 'kubeconfig' && kubeconfig.trim().length > 0) ||
      (mode === 'token' && HTTPS_URL.test(server) && token.trim().length > 0));

  // Credentials are stored on leaving the Access step so the Connect step can
  // probe exactly the access block the connector will use. Returns whether the
  // step may advance — a rejected kubeconfig must keep the user here with the
  // server's own reason visible.
  async function storeCredentials(): Promise<boolean> {
    setUploadError(null);
    if (mode === 'in-cluster') {
      setAccess({ mode: 'in-cluster' });
      return true;
    }
    const connectorId = k8sConnectorId(clusterName);
    try {
      if (mode === 'kubeconfig') {
        const r = await upload.mutateAsync({ connectorId, mode: 'kubeconfig', kubeconfig });
        if (r.mode !== 'kubeconfig') return false;
        setAccess({ mode: 'kubeconfig', kubeconfigPath: r.kubeconfigPath, context: r.context });
      } else {
        const r = await upload.mutateAsync({
          connectorId,
          mode: 'token',
          token,
          ...(caData.trim() ? { caData } : {}),
        });
        if (r.mode !== 'token') return false;
        setAccess({
          mode: 'token',
          server,
          tokenPath: r.tokenPath,
          ...(r.caDataPath ? { caDataPath: r.caDataPath } : {}),
        });
      }
      return true;
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not store credentials');
      return false;
    }
  }

  const splitList = (s: string): string[] =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  async function submit(): Promise<void> {
    if (!access) return;
    setCreateError(null);
    let created: Awaited<ReturnType<typeof createConnector.mutateAsync>>;
    try {
      created = await createConnector.mutateAsync({
        id: k8sConnectorId(clusterName),
        type: 'kubernetes',
        // Bare on purpose — the type prefix is composed at render time, and a
        // pre-composed name renders as "Kubernetes · Kubernetes · prod-eu".
        name: effectiveName,
        cluster: { name: clusterName },
        access,
        schedule,
        scope: {
          namespaces: { include: splitList(include), exclude: splitList(exclude) },
          kinds: effectiveKinds,
        },
      });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the connector');
      return;
    }
    // Create succeeded, so the dialog is done: close it before anything that
    // can still fail. A retry from here would re-POST the same deterministic
    // id and collide with the connector that now exists.
    onOpenChange(false);

    // The scheduler only registers the cron job on create; nothing runs until
    // the next tick. Fire the first sync now (as the GitHub wizard does) so the
    // card shows entities instead of "waiting for first sync". A failure here
    // is not a failed create — the cron will pick it up — so it only warns.
    try {
      await triggerSync.mutateAsync(created.id);
      toast({
        variant: 'ok',
        title: 'Kubernetes connector created',
        description: `First sync of ${clusterName} started.`,
      });
    } catch {
      toast({
        variant: 'warn',
        title: 'Kubernetes connector created',
        description: `Couldn't start the first sync of ${clusterName}; it will run on schedule.`,
      });
    }
  }

  const steps: WizardStep[] = [
    {
      id: 'access',
      label: 'Access',
      canAdvance: () => accessStepValid && access !== null,
      content: (ctx) => (
        <div className="flex flex-col gap-3">
          <Field
            label="Cluster name"
            required
            hint="Lowercase letters, digits and hyphens. Part of every id ShipIt writes for this cluster, so it cannot be changed later."
            error={clusterName && !clusterNameValid ? 'Invalid cluster name.' : undefined}
          >
            {(p) => (
              <Input
                {...p}
                value={clusterName}
                onChange={(e) => setClusterName(e.target.value)}
                placeholder="prod-eu"
              />
            )}
          </Field>

          <ModeCard
            selected={mode === 'in-cluster'}
            title="Run in this cluster (in-cluster)"
            description="Uses the ShipIt pod's ServiceAccount. Needs the shipit-reader ClusterRole."
            onSelect={() => setMode('in-cluster')}
          />

          <ModeCard
            selected={mode === 'kubeconfig'}
            title="Paste a kubeconfig"
            description="Data-only kubeconfig. exec, auth-provider, proxy-url and file references are rejected."
            onSelect={() => setMode('kubeconfig')}
          >
            <Field label="Kubeconfig" required>
              {(p) => (
                <Textarea
                  {...p}
                  rows={8}
                  value={kubeconfig}
                  onChange={(e) => setKubeconfig(e.target.value)}
                />
              )}
            </Field>
          </ModeCard>

          <ModeCard
            selected={mode === 'token'}
            title="Server and ServiceAccount token"
            description="Point at the API server directly with a token you minted."
            onSelect={() => setMode('token')}
          >
            <Field label="API server URL" required>
              {(p) => (
                <Input
                  {...p}
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="https://10.0.0.1:6443"
                />
              )}
            </Field>
            <Field label="ServiceAccount token" required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              )}
            </Field>
            <Field label="CA certificate (PEM, optional)">
              {(p) => (
                <Textarea
                  {...p}
                  rows={4}
                  value={caData}
                  onChange={(e) => setCaData(e.target.value)}
                />
              )}
            </Field>
          </ModeCard>

          {uploadError && <Banner tone="err">{uploadError}</Banner>}

          <Button
            onClick={() => {
              void storeCredentials().then((stored) => {
                if (stored) ctx.goNext();
              });
            }}
            disabled={!accessStepValid || upload.isPending}
          >
            Store credentials and continue
          </Button>
        </div>
      ),
    },
    {
      id: 'connect',
      label: 'Connect',
      canAdvance: () => probe?.ok === true,
      content: (
        <div className="flex flex-col gap-3">
          <Button onClick={() => void runProbe()} disabled={probeConnector.isPending}>
            Test connection
          </Button>

          {probe && !probe.ok && <Banner tone="err">{probeMessage(probe)}</Banner>}

          {probe?.ok && (
            <div className="flex flex-col gap-2 text-[13px]">
              {/* Same shape as the GitHub wizard's success banner: one green
                  sentence that says the test passed, then the details. */}
              <Banner tone="ok">
                Connected to cluster <strong>{clusterName}</strong> running Kubernetes{' '}
                <code>{probe.cluster?.version ?? 'unknown'}</code>.{' '}
                {(probe.namespaces ?? []).length} namespace
                {(probe.namespaces ?? []).length === 1 ? '' : 's'} in scope.
                {(probe.namespaces ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    {(probe.namespaces ?? []).map((ns) => (
                      <span key={ns} className="bg-panel-2 rounded px-1.5 py-0.5">
                        {ns}
                      </span>
                    ))}
                  </div>
                )}
              </Banner>
              <ul className="flex flex-col gap-1">
                {Object.entries(probe.kinds ?? {}).map(([kind, status]) => (
                  <li key={kind} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        'inline-block h-2 w-2 shrink-0 rounded-full',
                        KIND_STATUS[status]?.dot ?? 'bg-text-muted',
                      )}
                    />
                    <span className="text-text">{kind}</span>
                    <span className="text-text-muted">{KIND_STATUS[status]?.label ?? status}</span>
                  </li>
                ))}
              </ul>
              {probe.probedNamespace && (
                <Banner tone="accent">
                  Access measured against namespace <strong>{probe.probedNamespace}</strong>. A
                  namespace-scoped RoleBinding elsewhere can still fail at sync time.
                </Banner>
              )}
              {hasForbiddenKind && (
                <Banner tone="warn">
                  Some resource kinds are denied. The next step preselects only the kinds ShipIt can
                  read, so syncs do not warn about the rest on every run.
                </Banner>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'configure',
      label: 'Configure',
      canAdvance: () => effectiveKinds.length > 0,
      content: (
        <div className="flex flex-col gap-3">
          <Field
            label="Display name"
            hint="Shown on the connector card. Stored bare — ShipIt adds the &ldquo;Kubernetes &middot;&rdquo; prefix when it renders."
          >
            {(p) => (
              <Input
                {...p}
                value={displayName ?? clusterName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={clusterName}
              />
            )}
          </Field>
          <Field label="Include namespaces" hint="Comma-separated globs.">
            {(p) => <Input {...p} value={include} onChange={(e) => setInclude(e.target.value)} />}
          </Field>
          <Field label="Exclude namespaces" hint="Comma-separated globs.">
            {(p) => <Input {...p} value={exclude} onChange={(e) => setExclude(e.target.value)} />}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-text text-[13px] font-medium">Workload kinds</legend>
            {ALL_KINDS.map((kind) => (
              <Checkbox
                key={kind}
                label={kind}
                checked={effectiveKinds.includes(kind)}
                onCheckedChange={() => toggleKind(kind)}
              />
            ))}
          </fieldset>
          <Field label="Sync schedule" hint="Crontab expression.">
            {(p) => <Input {...p} value={schedule} onChange={(e) => setSchedule(e.target.value)} />}
          </Field>
        </div>
      ),
    },
    {
      id: 'review',
      label: 'Review',
      content: (
        <div className="flex flex-col gap-3">
          <dl className="flex flex-col gap-1 text-[13px]">
            <div>Cluster: {clusterName}</div>
            {/* The MODE only. Credential values never reach this screen. */}
            <div>Access: {mode}</div>
            <div>Name: {effectiveName}</div>
            <div>
              Namespaces: include {include || '*'}; exclude {exclude || 'none'}
            </div>
            <div>Kinds: {effectiveKinds.join(', ')}</div>
            <div>Schedule: {schedule}</div>
          </dl>
          {createError && <Banner tone="err">{createError}</Banner>}
          <Button
            onClick={() => void submit()}
            disabled={createConnector.isPending || triggerSync.isPending}
          >
            Create connector
          </Button>
        </div>
      ),
    },
  ];

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      steps={steps}
      title="Add Kubernetes connector"
      description="Connect a cluster so ShipIt can map its workloads to your services."
      width={640}
    />
  );
}
