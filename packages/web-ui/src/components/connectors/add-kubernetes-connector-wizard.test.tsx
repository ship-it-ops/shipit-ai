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

vi.mock('@/lib/hooks/use-connectors', () => ({
  useUploadKubernetesCredentials: () => ({ mutateAsync: uploadMutate, isPending: false }),
  useProbeConnector: () => ({ mutateAsync: probeMutate, reset: vi.fn(), isPending: false }),
  useCreateConnector: () => ({ mutateAsync: createMutate, reset: vi.fn(), isPending: false }),
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
  });

  it('defaults to in-cluster access and asks for a cluster name', () => {
    renderWizard();
    expect(screen.getByLabelText(/cluster name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run in this cluster/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
