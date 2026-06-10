import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InstanceTab } from './instance-tab';

vi.mock('@/lib/api', () => ({
  updateOidcProvider: vi.fn().mockResolvedValue({ ok: true, restartRequired: true }),
}));
import { updateOidcProvider } from '@/lib/api';

describe('InstanceTab', () => {
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

  it('renders the config export download link', () => {
    render(<InstanceTab />);
    const link = screen.getByRole('link', { name: /export config/i });
    expect(link).toHaveAttribute('href', '/api/config/export');
  });
});
