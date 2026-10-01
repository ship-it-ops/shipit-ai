import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@ship-it-ui/ui';
import { AddKubernetesConnectorWizard } from './add-kubernetes-connector-wizard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/connectors',
}));

const uploadMutate = vi.fn();
const probeMutate = vi.fn();
const createMutate = vi.fn();
const syncMutate = vi.fn();

vi.mock('@/lib/hooks/use-connectors', () => ({
  useUploadKubernetesCredentials: () => ({ mutateAsync: uploadMutate, isPending: false }),
  useProbeConnector: () => ({ mutateAsync: probeMutate, reset: vi.fn(), isPending: false }),
  useCreateConnector: () => ({ mutateAsync: createMutate, reset: vi.fn(), isPending: false }),
  useTriggerSync: () => ({ mutateAsync: syncMutate, isPending: false }),
  useConnectors: () => ({ data: [], isLoading: false }),
}));

function renderWizard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AddKubernetesConnectorWizard open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const advanceButton = () => screen.getByRole('button', { name: /store credentials and continue/i });

describe('AddKubernetesConnectorWizard — Access step', () => {
  beforeEach(() => {
    uploadMutate.mockReset();
    probeMutate.mockReset();
    createMutate.mockReset();
    syncMutate.mockReset();
  });

  it('defaults to in-cluster access and asks for a cluster name', () => {
    renderWizard();
    expect(screen.getByLabelText(/cluster name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run in this cluster/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // aria-pressed alone is invisible; the card itself has to show which mode is
  // active (the focus ring reads as "selected" and then vanishes on blur).
  it('marks the selected access mode card and moves the mark when another is picked', async () => {
    const user = userEvent.setup();
    renderWizard();

    const cardOf = (name: RegExp) =>
      screen.getByRole('button', { name }).closest('[data-selected]');
    expect(cardOf(/run in this cluster/i)).toHaveAttribute('data-selected', 'true');
    expect(cardOf(/paste a kubeconfig/i)).toHaveAttribute('data-selected', 'false');

    await user.click(screen.getByRole('button', { name: /paste a kubeconfig/i }));

    expect(cardOf(/run in this cluster/i)).toHaveAttribute('data-selected', 'false');
    expect(cardOf(/paste a kubeconfig/i)).toHaveAttribute('data-selected', 'true');
  });

  // The credentials route is keyed by connectorId and runs BEFORE the connector
  // exists, so the id has to be derivable at this step — that is why cluster
  // name lives here rather than with the rest of the config.
  it('uploads a pasted kubeconfig under an id derived from the cluster name', async () => {
    uploadMutate.mockResolvedValue({
      mode: 'kubeconfig',
      kubeconfigPath: '/data/keys/kubeconfig-k8s-prod-eu.yaml',
      context: 'prod',
      contexts: ['prod'],
    });
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /paste a kubeconfig/i }));
    await user.type(screen.getByLabelText(/kubeconfig/i), 'apiVersion: v1');
    await user.click(advanceButton());

    expect(uploadMutate).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'k8s-prod-eu', mode: 'kubeconfig' }),
    );
  });

  it('does not upload anything for in-cluster access', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(advanceButton());
    expect(uploadMutate).not.toHaveBeenCalled();
  });

  it('blocks the continue action until the cluster name is valid', async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(advanceButton()).toBeDisabled();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    expect(advanceButton()).toBeEnabled();
  });

  // A rejected kubeconfig must keep the user here with the server's own reason
  // visible — that message names the offending field (proxy-url, exec, ...).
  it('keeps the user on the step and shows why when the upload is rejected', async () => {
    uploadMutate.mockRejectedValue(
      new Error('kubeconfig cluster sets proxy-url, which ShipIt cannot honour'),
    );
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /paste a kubeconfig/i }));
    await user.type(screen.getByLabelText(/kubeconfig/i), 'apiVersion: v1');
    await user.click(advanceButton());

    // Match the server's sentence, not just 'proxy-url' — the mode card's own
    // copy names that field too.
    expect(await screen.findByText(/ShipIt cannot honour/)).toBeInTheDocument();
  });

  it('never renders the pasted credential value back to the user', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /server and serviceaccount token/i }));
    await user.type(screen.getByLabelText(/serviceaccount token/i), 'super-secret-value');
    // The input holds it, but nothing else on the page echoes it.
    expect(screen.queryAllByText(/super-secret-value/)).toHaveLength(0);
  });
});

describe('AddKubernetesConnectorWizard — Connect step', () => {
  beforeEach(() => {
    uploadMutate.mockReset();
    probeMutate.mockReset();
    createMutate.mockReset();
    syncMutate.mockReset();
  });

  async function reachConnectStep() {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(advanceButton());
    return user;
  }

  it('reports the cluster version, namespaces in scope and per-kind access', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit', 'monitoring'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'forbidden' },
    });
    const user = await reachConnectStep();

    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/v1\.31\.2/)).toBeInTheDocument();
    expect(screen.getByText(/monitoring/)).toBeInTheDocument();
    expect(screen.getByText(/CronJob/)).toBeInTheDocument();
  });

  // Parity with the GitHub wizard, which says "Connected to <org>" in an ok
  // banner: a bare list of facts does not tell the user the test passed.
  it('shows an explicit success banner naming the cluster after a good probe', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', CronJob: 'forbidden' },
    });
    const user = await reachConnectStep();

    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    const banner = await screen.findByText(/connected to cluster/i);
    expect(banner).toHaveTextContent(/prod-eu/);
    expect(screen.getByText('Deployment').closest('li')).toHaveTextContent(/readable/i);
    expect(screen.getByText('CronJob').closest('li')).toHaveTextContent(/denied/i);
  });

  // An all-green probe is NOT a cluster-wide guarantee: `kinds` is measured
  // against one namespace only, so the step says which.
  it('names the namespace the per-kind verdict was measured against', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok' },
    });
    const user = await reachConnectStep();

    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/measured against namespace/i)).toBeInTheDocument();
  });

  it('warns when a kind is denied instead of failing the step', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', CronJob: 'forbidden' },
    });
    const user = await reachConnectStep();

    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/preselects only the kinds/i)).toBeInTheDocument();
  });

  it('explains an in-cluster probe failure instead of showing the raw code', async () => {
    probeMutate.mockResolvedValue({
      ok: false,
      code: 'IN_CLUSTER_UNAVAILABLE',
      message: 'no in-cluster ServiceAccount token found',
    });
    const user = await reachConnectStep();

    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/not running inside a cluster/i)).toBeInTheDocument();
  });

  // KUBECONFIG_INVALID's own message already names the offending field, so it
  // is shown verbatim rather than mapped to generic copy.
  it('passes a kubeconfig validation message through untouched', async () => {
    probeMutate.mockResolvedValue({
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'kubeconfig user relies on an exec/auth-provider plugin',
    });
    const user = await reachConnectStep();

    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/exec\/auth-provider plugin/)).toBeInTheDocument();
  });
});

describe('AddKubernetesConnectorWizard — Configure step', () => {
  beforeEach(() => {
    uploadMutate.mockReset();
    probeMutate.mockReset();
    createMutate.mockReset();
    syncMutate.mockReset();
  });

  async function reachConfigureStep(kinds: Record<string, string>) {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds,
    });
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(advanceButton());
    await user.click(await screen.findByRole('button', { name: /test connection/i }));
    await screen.findByText(/v1\.31\.2/);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    return user;
  }

  // A placeholder is not a value: the user reads "shipit-demo" in the box and
  // assumes it is set. Prefill for real, and keep the fallback if they clear it.
  it('prefills the display name with the cluster name and lets the user override it', async () => {
    const user = await reachConfigureStep({ Deployment: 'ok' });

    const name = await screen.findByLabelText(/display name/i);
    expect(name).toHaveValue('prod-eu');

    await user.clear(name);
    await user.type(name, 'EU production');
    expect(name).toHaveValue('EU production');
  });

  // The one behaviour here with no server-side counterpart: a denied kind left
  // selected would warn on every single sync, forever.
  it('preselects only the kinds that probed ok, leaving a forbidden kind unchecked', async () => {
    await reachConfigureStep({
      Deployment: 'ok',
      StatefulSet: 'ok',
      DaemonSet: 'ok',
      CronJob: 'forbidden',
    });

    expect(await screen.findByRole('checkbox', { name: /Deployment/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /StatefulSet/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /DaemonSet/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /CronJob/ })).not.toBeChecked();
  });

  // Falling back to nothing would leave an unsubmittable selection — the
  // schema requires at least one kind.
  it('falls back to every kind when the probe reported none as ok', async () => {
    await reachConfigureStep({
      Deployment: 'error',
      StatefulSet: 'error',
      DaemonSet: 'error',
      CronJob: 'error',
    });

    expect(await screen.findByRole('checkbox', { name: /Deployment/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /CronJob/ })).toBeChecked();
  });

  it('lets the user override the preselection', async () => {
    const user = await reachConfigureStep({ Deployment: 'ok', CronJob: 'forbidden' });

    const cronJob = await screen.findByRole('checkbox', { name: /CronJob/ });
    expect(cronJob).not.toBeChecked();
    await user.click(cronJob);
    expect(cronJob).toBeChecked();
  });

  it('defaults the namespace scope to the schema defaults', async () => {
    await reachConfigureStep({ Deployment: 'ok' });

    expect(await screen.findByLabelText(/include namespaces/i)).toHaveValue('*');
    expect(screen.getByLabelText(/exclude namespaces/i)).toHaveValue(
      'kube-system, kube-public, kube-node-lease',
    );
  });
});

describe('AddKubernetesConnectorWizard — Review step', () => {
  beforeEach(() => {
    uploadMutate.mockReset();
    probeMutate.mockReset();
    createMutate.mockReset();
    syncMutate.mockReset();
  });

  async function reachReviewStep() {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'ok' },
    });
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(advanceButton());
    await user.click(await screen.findByRole('button', { name: /test connection/i }));
    await screen.findByText(/v1\.31\.2/);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByRole('checkbox', { name: /Deployment/ });
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    return user;
  }

  it('creates the connector with a bare display name and the stored access block', async () => {
    createMutate.mockResolvedValue({ id: 'k8s-prod-eu' });
    const user = await reachReviewStep();

    await user.click(await screen.findByRole('button', { name: /create connector/i }));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'k8s-prod-eu',
        type: 'kubernetes',
        // BARE — connector-identity.ts composes "Kubernetes · prod-eu" at render time.
        name: 'prod-eu',
        cluster: { name: 'prod-eu' },
        access: { mode: 'in-cluster' },
        schedule: '*/5 * * * *',
        scope: {
          namespaces: {
            include: ['*'],
            exclude: ['kube-system', 'kube-public', 'kube-node-lease'],
          },
          kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'],
        },
      }),
    );
  });

  // The scheduler's start() only registers the cron job; nothing runs until the
  // next tick (an hour away on "0 * * * *"). The GitHub wizard fires a sync
  // right after create so the card fills in — the first live run showed this
  // one sat at "0 entities · never synced" until someone pressed Sync now.
  it('triggers an initial sync right after creating the connector', async () => {
    createMutate.mockResolvedValue({ id: 'k8s-prod-eu' });
    syncMutate.mockResolvedValue({ connectorId: 'k8s-prod-eu', state: 'running' });
    const user = await reachReviewStep();

    await user.click(await screen.findByRole('button', { name: /create connector/i }));

    expect(syncMutate).toHaveBeenCalledWith('k8s-prod-eu');
    expect(await screen.findByText(/kubernetes connector created/i)).toBeInTheDocument();
  });

  it('shows the access mode but never the credential values', async () => {
    await reachReviewStep();
    expect(await screen.findByText(/in-cluster/)).toBeInTheDocument();
  });

  it('keeps the user on the step and shows why when creation fails', async () => {
    createMutate.mockRejectedValue(new Error('connector k8s-prod-eu already exists'));
    const user = await reachReviewStep();

    await user.click(await screen.findByRole('button', { name: /create connector/i }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });
});
