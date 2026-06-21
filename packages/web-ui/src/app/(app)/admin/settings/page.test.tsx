import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminSettingsPage from './page';
import * as currentUser from '@/lib/current-user';

// The tabs themselves are covered by their own component tests; here we only
// assert the page-level admin gate.
vi.mock('@/components/settings/webhooks-tab', () => ({ WebhooksTab: () => <div>webhooks</div> }));
vi.mock('@/components/settings/access-tab', () => ({ AccessTab: () => <div>access</div> }));
vi.mock('@/components/settings/instance-tab', () => ({ InstanceTab: () => <div>instance</div> }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminSettingsPage />
    </QueryClientProvider>,
  );
}

describe('AdminSettingsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the admin tabs for an admin', () => {
    vi.spyOn(currentUser, 'useCurrentUserQuery').mockReturnValue({
      data: { role: 'admin' },
      isLoading: false,
    } as ReturnType<typeof currentUser.useCurrentUserQuery>);
    renderPage();
    expect(screen.getByRole('heading', { name: /admin settings/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /github webhooks/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /login & access/i })).toBeInTheDocument();
  });

  it('blocks a non-admin with an access-required message', () => {
    vi.spyOn(currentUser, 'useCurrentUserQuery').mockReturnValue({
      data: { role: 'member' },
      isLoading: false,
    } as ReturnType<typeof currentUser.useCurrentUserQuery>);
    renderPage();
    expect(screen.getByText(/admin access required/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /github webhooks/i })).not.toBeInTheDocument();
  });
});
