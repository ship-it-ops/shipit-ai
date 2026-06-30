import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@ship-it-ui/ui';
import { ClaimList } from './claim-list';
import type { EntityClaims, PropertyClaim, ResolvedProperty } from '@/lib/api';
import { ManualClaimError } from '@/lib/api';

// Mock the api client — the same seam existing web-ui tests mock.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    setManualClaim: vi.fn(),
    revertManualClaim: vi.fn(),
    verifyClaim: vi.fn(),
  };
});
import { setManualClaim, revertManualClaim } from '@/lib/api';

// Controllable current-user so we can flip capabilities/role/email per test.
const { mockUser } = vi.hoisted(() => ({
  mockUser: {
    email: 'me@example.com',
    role: 'member',
    capabilities: ['graph:write'] as string[],
  },
}));
vi.mock('@/lib/current-user', () => ({ useCurrentUser: () => mockUser }));

function claim(overrides: Partial<PropertyClaim> = {}): PropertyClaim {
  return {
    property_key: 'tier',
    value: 'T1',
    source: 'github:repo',
    source_id: 'repo-1',
    ingested_at: new Date().toISOString(),
    confidence: 0.9,
    evidence: null,
    ...overrides,
  };
}

function prop(overrides: Partial<ResolvedProperty> = {}): ResolvedProperty {
  const winning = overrides.winning_claim ?? claim();
  return {
    property_key: 'tier',
    effective_value: 'T1',
    winning_claim: winning,
    strategy: 'HIGHEST_CONFIDENCE',
    has_conflict: false,
    claims: overrides.claims ?? [winning],
    confidence: 0.9,
    breakdown: {
      base: 0.9,
      base_source: 'github',
      decay: 0,
      corroboration: 0,
      corroboration_sources: [],
      conflict: 0,
      conflict_sources: [],
      ambiguity: 0,
      verified: false,
      effective: 0.9,
      terms: [{ label: 'base (github)', delta: 0.9 }],
    },
    status: 'UNVERIFIED',
    needs_review: false,
    ...overrides,
  };
}

function entityClaims(p: ResolvedProperty): EntityClaims {
  return { entityId: 'svc://demo', label: 'LogicalService', name: 'demo', properties: [p] };
}

function renderList(data: EntityClaims, opts?: { compact?: boolean }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ClaimList data={data} showHeader={false} compact={opts?.compact} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ClaimList manual edit affordances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.email = 'me@example.com';
    mockUser.role = 'member';
    mockUser.capabilities = ['graph:write'];
  });

  it('Edit dialog submits and calls setManualClaim then invalidates', async () => {
    vi.mocked(setManualClaim).mockResolvedValue({ property: prop(), claimsRev: 2 });
    renderList(entityClaims(prop()));

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    const valueInput = await screen.findByLabelText(/value \(text\)/i);
    fireEvent.change(valueInput, { target: { value: 'T0' } });
    fireEvent.change(screen.getByLabelText(/evidence/i), {
      target: { value: 'pager owner confirmed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save value/i }));

    await waitFor(() =>
      expect(setManualClaim).toHaveBeenCalledWith(
        'svc://demo',
        'tier',
        'T0',
        'pager owner confirmed',
      ),
    );
    expect(await screen.findByText(/manual value saved/i)).toBeInTheDocument();
  });

  it('renders the manual-override badge with the actor when the winning claim is manual', () => {
    renderList(
      entityClaims(prop({ winning_claim: claim({ source: 'manual:alice@example.com' }) })),
    );
    expect(screen.getByText(/manual · alice@example.com/i)).toBeInTheDocument();
  });

  it('does NOT render a manual badge for a non-manual winning claim', () => {
    renderList(entityClaims(prop({ winning_claim: claim({ source: 'github:repo' }) })));
    expect(screen.queryByText(/^manual ·/i)).not.toBeInTheDocument();
  });

  it('Revert calls revertManualClaim when the user owns the manual claim', async () => {
    vi.mocked(revertManualClaim).mockResolvedValue(null);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderList(entityClaims(prop({ winning_claim: claim({ source: 'manual:me@example.com' }) })));

    fireEvent.click(screen.getByRole('button', { name: /revert/i }));

    await waitFor(() =>
      // Own claim → no targetActor argument.
      expect(revertManualClaim).toHaveBeenCalledWith('svc://demo', 'tier', undefined),
    );
    expect(await screen.findByText(/manual override reverted/i)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('does not revert when the confirm dialog is dismissed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderList(entityClaims(prop({ winning_claim: claim({ source: 'manual:me@example.com' }) })));
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(revertManualClaim).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('hides Edit/Revert when the user lacks graph:write', () => {
    mockUser.capabilities = [];
    renderList(entityClaims(prop({ winning_claim: claim({ source: 'manual:me@example.com' }) })));
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revert/i })).not.toBeInTheDocument();
    // Verify is unaffected — it's not part of the write-capability gate.
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
  });

  it('lets an admin revert another actor’s manual claim via targetActor', async () => {
    vi.mocked(revertManualClaim).mockResolvedValue(null);
    mockUser.role = 'admin';
    mockUser.capabilities = ['*'];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderList(entityClaims(prop({ winning_claim: claim({ source: 'manual:bob@example.com' }) })));

    fireEvent.click(screen.getByRole('button', { name: /revert/i }));

    await waitFor(() =>
      expect(revertManualClaim).toHaveBeenCalledWith('svc://demo', 'tier', 'bob@example.com'),
    );
    confirmSpy.mockRestore();
  });

  it('shows the FEATURE_DISABLED toast on a 403 kill-switch error', async () => {
    vi.mocked(setManualClaim).mockRejectedValue(
      new ManualClaimError('FEATURE_DISABLED', 'manual editing is disabled', 403),
    );
    renderList(entityClaims(prop()));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(await screen.findByLabelText(/value \(text\)/i), { target: { value: 'T2' } });
    fireEvent.click(screen.getByRole('button', { name: /save value/i }));

    expect(await screen.findByText(/manual editing is disabled/i)).toBeInTheDocument();
  });

  it('shows the rate-limit toast on a 429 error', async () => {
    vi.mocked(setManualClaim).mockRejectedValue(
      new ManualClaimError('RATE_LIMITED', 'Too many edits — slow down.', 429),
    );
    renderList(entityClaims(prop()));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(await screen.findByLabelText(/value \(text\)/i), { target: { value: 'T2' } });
    fireEvent.click(screen.getByRole('button', { name: /save value/i }));

    expect(await screen.findByText(/too many edits, slow down/i)).toBeInTheDocument();
  });
});
