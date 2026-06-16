import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { clientConfig } from '@/lib/client-config';
import { InstanceTab } from './instance-tab';

vi.mock('@/lib/api', () => ({
  updateOidcProvider: vi.fn().mockResolvedValue({ ok: true, restartRequired: true }),
}));
import { updateOidcProvider } from '@/lib/api';

// Controllable current-user so we can exercise the admin gating on Config export.
const { mockUser } = vi.hoisted(() => ({ mockUser: { role: 'admin' } }));
vi.mock('@/lib/current-user', () => ({ useCurrentUser: () => mockUser }));

describe('InstanceTab', () => {
  beforeEach(() => {
    mockUser.role = 'admin';
  });
  it('submits OIDC settings and surfaces the restart notice', async () => {
    render(<InstanceTab />);
    fireEvent.change(screen.getByLabelText(/issuer url/i), {
      target: { value: 'https://idp.example.com' },
    });
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: /save oidc settings/i }));

    await waitFor(() =>
      expect(updateOidcProvider).toHaveBeenCalledWith({
        issuerUrl: 'https://idp.example.com',
        clientId: 'cid',
        clientSecret: 's3cret',
      }),
    );
    expect(await screen.findByText(/restart/i)).toBeInTheDocument();
  });

  it('shows the backend error message when the save is rejected', async () => {
    vi.mocked(updateOidcProvider).mockRejectedValueOnce(new Error('Admin role required.'));
    render(<InstanceTab />);
    fireEvent.change(screen.getByLabelText(/issuer url/i), {
      target: { value: 'https://idp.example.com' },
    });
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'cid' } });
    fireEvent.click(screen.getByRole('button', { name: /save oidc settings/i }));

    expect(await screen.findByText('Admin role required.')).toBeInTheDocument();
  });

  it('renders the config export download link for admins', () => {
    render(<InstanceTab />);
    const link = screen.getByRole('link', { name: /export config/i });
    // Absolute against the configured api origin — the web-ui and api-server
    // run on different origins in local dev, so a relative href would 404.
    expect(link).toHaveAttribute('href', `${clientConfig.api.url}/api/config/export`);
  });

  it('hides the config export for non-admin users', () => {
    mockUser.role = 'member';
    render(<InstanceTab />);
    expect(screen.queryByRole('link', { name: /export config/i })).not.toBeInTheDocument();
    // The OIDC card is unaffected by this change.
    expect(screen.getByLabelText(/issuer url/i)).toBeInTheDocument();
  });
});
