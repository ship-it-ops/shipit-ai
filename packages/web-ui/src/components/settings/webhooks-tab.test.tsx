import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebhooksTab } from './webhooks-tab';

vi.mock('@/lib/api', () => ({
  fetchPortalSettings: vi.fn(),
  setConnectorWebhookSecret: vi.fn(),
}));
import { fetchPortalSettings, setConnectorWebhookSecret } from '@/lib/api';

// jsdom has no clipboard by default; the copy buttons call writeText.
Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

function renderWithQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const SETTINGS = {
  webhookUrl: 'https://shipit.example.com/api/webhooks/github',
  webhooks: [
    {
      connectorId: 'acme',
      appId: '12345',
      org: 'acme-corp',
      secretConfigured: false,
      lastVerifiedDelivery: null,
    },
    {
      connectorId: 'beta',
      appId: '67890',
      org: 'beta-inc',
      secretConfigured: true,
      lastVerifiedDelivery: { event: 'push', deliveryId: 'd1', ts: new Date().toISOString() },
    },
  ],
  oauth: { configured: true },
  admins: ['a@x.com'],
  allowlist: [],
};

describe('WebhooksTab', () => {
  beforeEach(() => {
    vi.mocked(fetchPortalSettings).mockResolvedValue(SETTINGS as never);
    vi.mocked(setConnectorWebhookSecret).mockReset();
  });

  it('renders the shared receiver URL and the tri-state per-connector status', async () => {
    renderWithQueryClient(<WebhooksTab />);
    expect(await screen.findByText(SETTINGS.webhookUrl)).toBeInTheDocument();
    expect(screen.getByText('acme-corp')).toBeInTheDocument();
    expect(screen.getByText('beta-inc')).toBeInTheDocument();
    // acme: no secret -> "Not set up"; beta: secret + verified -> "Active".
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/no verified delivery yet/i)).toBeInTheDocument();
    expect(screen.getByText(/last verified:/i)).toBeInTheDocument();
  });

  it('shows "Awaiting first delivery" when a secret is saved but nothing is verified', async () => {
    vi.mocked(fetchPortalSettings).mockResolvedValue({
      ...SETTINGS,
      webhooks: [
        {
          connectorId: 'acme',
          appId: '12345',
          org: 'acme-corp',
          secretConfigured: true,
          lastVerifiedDelivery: null,
        },
      ],
    } as never);
    renderWithQueryClient(<WebhooksTab />);
    expect(await screen.findByText('Awaiting first delivery')).toBeInTheDocument();
    expect(screen.getByText(/paste it into github to activate/i)).toBeInTheDocument();
    // Reserved green/Active state must NOT appear without a verified delivery.
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('does not mint a secret until the confirm dialog is accepted', async () => {
    renderWithQueryClient(<WebhooksTab />);
    fireEvent.click(await screen.findByRole('button', { name: /set up/i }));

    // The confirm dialog is shown; no server call yet.
    expect(await screen.findByText(/generate webhook secret\?/i)).toBeInTheDocument();
    expect(setConnectorWebhookSecret).not.toHaveBeenCalled();

    // Cancelling is a true no-op — still no server call.
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByText(/generate webhook secret\?/i)).not.toBeInTheDocument(),
    );
    expect(setConnectorWebhookSecret).not.toHaveBeenCalled();
  });

  it('reveals the secret + steps only after confirming setup', async () => {
    vi.mocked(setConnectorWebhookSecret).mockResolvedValue({
      secret: 'whsec_abc123',
      webhookUrl: SETTINGS.webhookUrl,
      steps: ['Open the App settings', 'Paste the secret'],
    });
    renderWithQueryClient(<WebhooksTab />);
    fireEvent.click(await screen.findByRole('button', { name: /set up/i }));
    fireEvent.click(await screen.findByRole('button', { name: /generate secret/i }));

    expect(await screen.findByText('whsec_abc123')).toBeInTheDocument();
    expect(screen.getByText('Open the App settings')).toBeInTheDocument();
    await waitFor(() => expect(setConnectorWebhookSecret).toHaveBeenCalledWith('acme', 'setup'));
  });

  it('shows NO_RESOLVABLE_APP inline without revealing a secret', async () => {
    vi.mocked(setConnectorWebhookSecret).mockRejectedValue(
      new Error('No resolvable GitHub App for this connector.'),
    );
    renderWithQueryClient(<WebhooksTab />);
    fireEvent.click(await screen.findByRole('button', { name: /set up/i }));
    fireEvent.click(await screen.findByRole('button', { name: /generate secret/i }));

    expect(
      await screen.findByText('No resolvable GitHub App for this connector.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/i've copied it/i)).not.toBeInTheDocument();
  });

  it('shows a hint and disables Copy when the receiver URL is empty', async () => {
    vi.mocked(fetchPortalSettings).mockResolvedValue({
      ...SETTINGS,
      webhookUrl: '',
    } as never);
    renderWithQueryClient(<WebhooksTab />);
    expect(await screen.findByText(/GITHUB_WEBHOOK_PUBLIC_URL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeDisabled();
  });
});
