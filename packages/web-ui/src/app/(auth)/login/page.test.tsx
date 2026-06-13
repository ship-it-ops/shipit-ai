import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage from './page';

// Search params are mutable per-test: tests assign `currentParams` before
// rendering to simulate the callback redirect (`/login?error=<CODE>`).
let currentParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/login',
  useSearchParams: () => currentParams,
}));

vi.mock('@/lib/setup', () => ({
  fetchHealthMode: vi.fn().mockResolvedValue('active'),
}));

// /api/auth/providers is the page's only fetch — return one provider so
// the page settles into its ready state.
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ providers: [{ id: 'github', displayName: 'GitHub' }] }),
  }),
);

beforeEach(() => {
  currentParams = new URLSearchParams();
});

describe('LoginPage — callback error messages', () => {
  it('tells not-allow-listed users this is a private beta and how to request access', async () => {
    currentParams = new URLSearchParams('error=NOT_ALLOWLISTED');
    render(<LoginPage />);
    expect(await screen.findByText(/private beta/i)).toBeInTheDocument();
    expect(screen.getByText(/reach out to your administrator/i)).toBeInTheDocument();
  });

  it('shows no error banner without an error param', async () => {
    render(<LoginPage />);
    expect(await screen.findByRole('button', { name: /github/i })).toBeInTheDocument();
    expect(screen.queryByText(/private beta/i)).not.toBeInTheDocument();
  });
});
