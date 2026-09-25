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
  Field,
  Input,
  Textarea,
  WizardDialog,
  type WizardStep,
} from '@ship-it-ui/ui';
import { useProbeConnector, useUploadKubernetesCredentials } from '@/lib/hooks/use-connectors';
import type { KubernetesAccess, KubernetesWorkloadKind, ProbeResult } from '@/lib/api';
import { cn } from '@/lib/utils';

// Mirrors the server-side schema exactly; the cluster name is part of every
// Kubernetes canonical id, so a rejected value here is a rejected write later.
const CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

type AccessMode = 'in-cluster' | 'kubeconfig' | 'token';

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
  return (
    <div
      className={cn(
        'rounded-base border-border bg-panel border p-3',
        selected && 'border-border-strong',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="focus-visible:ring-accent-dim w-full rounded-sm text-left outline-none focus-visible:ring-[3px]"
      >
        <span className="text-text block text-[14px] font-medium">{title}</span>
        <span className="text-text-muted mt-0.5 block text-[12px]">{description}</span>
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

  const upload = useUploadKubernetesCredentials();
  const probeConnector = useProbeConnector();

  // Kinds the cluster actually let us read. Drives the Configure step's
  // default selection so a denied kind does not warn on every sync.
  const okKinds = Object.entries(probe?.kinds ?? {})
    .filter(([, status]) => status === 'ok')
    .map(([kind]) => kind as KubernetesWorkloadKind);
  const hasForbiddenKind = Object.values(probe?.kinds ?? {}).some((s) => s === 'forbidden');

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
              <div>
                Cluster version <code>{probe.cluster?.version}</code>
              </div>
              <div>Namespaces in scope: {(probe.namespaces ?? []).join(', ') || 'none'}</div>
              <ul className="flex flex-col gap-1">
                {Object.entries(probe.kinds ?? {}).map(([kind, status]) => (
                  <li key={kind}>
                    {kind}: {status}
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
