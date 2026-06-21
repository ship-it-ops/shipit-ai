import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccessTab } from './access-tab';

vi.mock('@/lib/api', () => ({
  fetchPortalSettings: vi.fn(),
  updateOAuthClient: vi.fn(),
  updateAdminEmails: vi.fn(),
  updateAllowlist: vi.fn(),
}));
import {
  fetchPortalSettings,
  updateOAuthClient,
  updateAdminEmails,
  updateAllowlist,
} from '@/lib/api';

function renderWithQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const SETTINGS = {
  webhookUrl: 'https://x/api/webhooks/github',
  webhooks: [],
  oauth: { configured: true },
  admins: ['me@x.com', 'other@x.com'],
  allowlist: ['only@x.com'],
};

describe('AccessTab', () => {
  beforeEach(() => {
    vi.mocked(fetchPortalSettings).mockResolvedValue(SETTINGS as never);
    vi.mocked(updateOAuthClient).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(updateAdminEmails)
      .mockReset()
      .mockResolvedValue({ ok: true, admins: SETTINGS.admins });
    vi.mocked(updateAllowlist).mockReset().mockResolvedValue({ ok: true, emails: [] });
  });

  it('renders the three access cards seeded from settings', async () => {
    renderWithQueryClient(<AccessTab />);
    expect(await screen.findByText(/oauth login client/i)).toBeInTheDocument();
    expect(screen.getByText(/admin emails/i)).toBeInTheDocument();
    expect(screen.getByText(/login allow-list/i)).toBeInTheDocument();
    expect(screen.getByText(/configured/i)).toBeInTheDocument();
    expect((screen.getByLabelText(/admin emails/i) as HTMLTextAreaElement).value).toContain(
      'me@x.com',
    );
  });

  it('confirms before saving the OAuth client, then saves', async () => {
    renderWithQueryClient(<AccessTab />);
    await screen.findByText(/oauth login client/i);
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 'sec' } });
    fireEvent.click(screen.getByRole('button', { name: /save oauth client/i }));

    // Confirm dialog appears; nothing saved until confirmed.
    expect(await screen.findByText(/can lock users out/i)).toBeInTheDocument();
    expect(updateOAuthClient).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /save anyway/i }));
    await waitFor(() =>
      expect(updateOAuthClient).toHaveBeenCalledWith({ clientId: 'cid', clientSecret: 'sec' }),
    );
  });

  it('surfaces the SELF_LOCKOUT message when removing yourself from admins', async () => {
    vi.mocked(updateAdminEmails).mockRejectedValueOnce(
      new Error("You can't remove your own admin access."),
    );
    renderWithQueryClient(<AccessTab />);
    await screen.findByText(/admin emails/i);
    fireEvent.click(screen.getByRole('button', { name: /save admins/i }));
    expect(await screen.findByText("You can't remove your own admin access.")).toBeInTheDocument();
  });

  it('confirms before saving an empty allow-list', async () => {
    renderWithQueryClient(<AccessTab />);
    await screen.findByText(/login allow-list/i);
    const textarea = screen.getByLabelText(/login allow-list/i);
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save allow-list/i }));

    // Empty save must not fire until the "allow everyone" confirm is accepted.
    expect(
      await screen.findByText(/allows ANYONE to sign in to this instance/i),
    ).toBeInTheDocument();
    expect(updateAllowlist).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /allow everyone/i }));
    await waitFor(() => expect(updateAllowlist).toHaveBeenCalledWith([]));
  });
});
