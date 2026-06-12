import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetupPage from './page';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => '/setup',
}));

const setupLib = {
  fetchHealthMode: vi.fn(),
  fetchSetupStatus: vi.fn(),
  postSetupAdmin: vi.fn(),
  postSetupComplete: vi.fn(),
};
vi.mock('@/lib/setup', () => ({
  fetchHealthMode: (...args: unknown[]) => setupLib.fetchHealthMode(...args),
  fetchSetupStatus: (...args: unknown[]) => setupLib.fetchSetupStatus(...args),
  postSetupAdmin: (...args: unknown[]) => setupLib.postSetupAdmin(...args),
  postSetupComplete: (...args: unknown[]) => setupLib.postSetupComplete(...args),
}));

const FRESH_GATES = {
  oauthClientPresent: false,
  adminConfigured: false,
  sessionSecretPresent: true,
  allowedOriginsConfigured: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  setupLib.fetchSetupStatus.mockResolvedValue({
    mode: 'setup',
    gates: FRESH_GATES,
    ready: false,
  });
});

describe('SetupPage', () => {
  it('redirects to /login when the api-server is in active mode', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('active');
    render(<SetupPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
  });

  it('shows a retryable error when the api-server is unreachable', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('unreachable');
    render(<SetupPage />);
    expect(await screen.findByText(/can't reach the api server/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the wizard on a fresh setup-mode deployment, starting at the admin step', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('setup');
    render(<SetupPage />);
    expect(
      await screen.findByRole('heading', { name: /set up your shipit instance/i }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/administrator email/i)).toBeInTheDocument();
  });

  it('submits the admin email and advances to the GitHub step', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('setup');
    setupLib.postSetupAdmin.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SetupPage />);

    const input = await screen.findByLabelText(/administrator email/i);
    await user.type(input, 'admin@example.com');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(setupLib.postSetupAdmin).toHaveBeenCalledWith('admin@example.com');
    expect(await screen.findByRole('button', { name: /create github app/i })).toBeInTheDocument();
    expect(screen.getByText(/administrator captured/i)).toBeInTheDocument();
  });

  it('surfaces admin-step errors inline', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('setup');
    setupLib.postSetupAdmin.mockRejectedValue(new Error('"nope" is not a valid email address.'));
    const user = userEvent.setup();
    render(<SetupPage />);

    await user.type(await screen.findByLabelText(/administrator email/i), 'nope@x.y');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a valid email/i);
  });

  it('skips completed steps when status says the wizard already progressed', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('setup');
    // Pod restarted mid-wizard: admin + OAuth client already persisted.
    setupLib.fetchSetupStatus.mockResolvedValue({
      mode: 'setup',
      gates: { ...FRESH_GATES, adminConfigured: true, oauthClientPresent: true },
      ready: true,
    });
    render(<SetupPage />);
    expect(await screen.findByRole('button', { name: /finish setup/i })).toBeInTheDocument();
  });

  it('finishes setup and polls health until the restarted server is active', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('setup');
    setupLib.fetchSetupStatus.mockResolvedValue({
      mode: 'setup',
      gates: { ...FRESH_GATES, adminConfigured: true, oauthClientPresent: true },
      ready: true,
    });
    setupLib.postSetupComplete.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<SetupPage />);

    await user.click(await screen.findByRole('button', { name: /finish setup/i }));
    expect(await screen.findByText(/restarting/i)).toBeInTheDocument();

    // Next poll sees the restarted (active) server → handoff to /login.
    setupLib.fetchHealthMode.mockResolvedValue('active');
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'), { timeout: 5000 });
  });

  it('renders the 409 gate list when complete() says setup is unfinished', async () => {
    setupLib.fetchHealthMode.mockResolvedValue('setup');
    setupLib.fetchSetupStatus.mockResolvedValue({
      mode: 'setup',
      gates: { ...FRESH_GATES, adminConfigured: true, oauthClientPresent: true },
      ready: true,
    });
    setupLib.postSetupComplete.mockResolvedValue({
      ok: false,
      missing: ['sessionSecret'],
      messages: ['session signing secret env var "SHIPIT_SESSION_SECRET" must be set.'],
    });
    const user = userEvent.setup();
    render(<SetupPage />);

    await user.click(await screen.findByRole('button', { name: /finish setup/i }));
    expect(await screen.findByText(/session signing secret/i)).toBeInTheDocument();
  });
});
