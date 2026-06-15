import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@ship-it-ui/ui';
import { AddGitHubConnectorWizard } from './add-github-connector-wizard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/connectors',
}));

const inertMutation = () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false });
vi.mock('@/lib/hooks/use-connectors', () => ({
  useProbeConnector: () => inertMutation(),
  useCreateConnector: () => inertMutation(),
  useTriggerSync: () => inertMutation(),
  useUpdateGitHubApp: () => inertMutation(),
  useGitHubAppInstallations: () => ({ data: undefined, isLoading: false }),
  useGitHubAppStatus: () => ({ data: undefined }),
}));

function renderWizard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AddGitHubConnectorWizard open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Regression: the per-org manifest flow created the App and captured its
// credentials correctly, but dropped them silently into the collapsed
// "I already have an App — paste credentials manually" section while the
// card still showed "Create App on GitHub". Users concluded the App was
// never created. The wizard must surface a prominent, persistent
// confirmation when an App was created/attached via the manifest flow.
describe('AddGitHubConnectorWizard — per-org manifest App created confirmation', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('surfaces a visible "created and attached" confirmation when returning with claimed credentials', () => {
    // Simulate the returning tab: the launching tab stashed the claimed
    // App into the cross-tab resume record before the user navigated back
    // via the callback page's "Return to ShipIt-AI" link.
    window.localStorage.setItem(
      'shipit:pending-github-app',
      JSON.stringify({
        nonce: 'test-nonce-12345678',
        mode: 'per-org',
        manifestOwner: 'shipit-ai-demo-org',
        connectorId: 'github-shipit-ai-demo-org',
        name: 'GitHub · shipit-ai-demo-org',
        org: 'shipit-ai-demo-org',
        scope: {
          repos: { include: ['**'], exclude: [] },
          teams: { include: ['**'], exclude: [] },
          cappedAt: 100,
          cappedAcknowledged: false,
        },
        entities: {
          repository: true,
          team: true,
          pipeline: true,
          codeowners: true,
          environment: false,
          deployment: false,
          branchProtection: false,
          workflowRun: false,
        },
        createdAt: Date.now(),
        claimed: {
          appId: '4062823',
          appName: 'ShipIt-AI-Demo',
          privateKeyPath: '/data/keys/github-app-4062823.pem',
        },
      }),
    );

    renderWizard();

    // Prominent confirmation copy naming the created App — not buried in
    // the collapsed manual-paste details.
    expect(screen.getByText(/App .*ShipIt-AI-Demo.* created and attached/i)).toBeInTheDocument();
    // The created App's id is surfaced so the user knows it worked.
    expect(screen.getByText('4062823')).toBeInTheDocument();
  });
});
