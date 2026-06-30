import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@ship-it-ui/ui';
import { RelationManager } from './relation-manager';
import {
  RelationEditError,
  type GraphData,
  type SearchResult,
  type SchemaWithHash,
} from '@/lib/api';

// Mock the api client — the same seam the v1a claim-list test mocks. fetchSchema
// feeds the type dropdown; create/deleteRelation are the write calls under test.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    fetchSchema: vi.fn(),
    createRelation: vi.fn(),
    deleteRelation: vi.fn(),
  };
});
import { fetchSchema, createRelation, deleteRelation } from '@/lib/api';

// Controllable current-user so we can flip capabilities per test.
const { mockUser } = vi.hoisted(() => ({
  mockUser: {
    email: 'me@example.com',
    role: 'member',
    capabilities: ['graph:write'] as string[],
  },
}));
vi.mock('@/lib/current-user', () => ({ useCurrentUser: () => mockUser }));

// Replace the Radix Select with a native <select> (reliable in jsdom) and the
// entity-search-box with a one-click picker, so the test drives behavior, not
// third-party widget internals.
vi.mock('@ship-it-ui/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ship-it-ui/ui')>();
  return {
    ...actual,
    Select: ({
      options,
      value,
      onValueChange,
      'aria-label': ariaLabel,
    }: {
      options: string[];
      value?: string;
      onValueChange?: (v: string) => void;
      'aria-label'?: string;
    }) => (
      <select
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={(e) => onValueChange?.(e.target.value)}
      >
        <option value="" disabled>
          Choose…
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    ),
  };
});

const TARGET: SearchResult = {
  id: 'svc://billing',
  name: 'billing',
  label: 'LogicalService',
  canonicalId: 'svc://billing',
};

vi.mock('@/components/search/entity-search-box', () => ({
  EntitySearchBox: ({ onSelect }: { onSelect: (r: SearchResult) => void }) => (
    <button type="button" onClick={() => onSelect(TARGET)}>
      pick-target
    </button>
  ),
}));

const ENTITY_ID = 'svc://demo';

function schema(): SchemaWithHash {
  return {
    hash: 'h1',
    schema: {
      version: '1',
      mode: 'simple',
      node_types: {},
      relationship_types: {
        DEPENDS_ON: { from: 'LogicalService', to: 'LogicalService', cardinality: 'N:M' },
        OWNS: { from: 'Team', to: 'LogicalService', cardinality: '1:N' },
      },
    },
  };
}

// A neighborhood graph centered on ENTITY_ID with one manual outgoing edge, one
// connector outgoing edge, and one inbound edge.
function graph(): GraphData {
  return {
    nodes: [
      { data: { id: ENTITY_ID, label: 'LogicalService', name: 'demo', type: 'LogicalService' } },
      { data: { id: 'svc://api', label: 'LogicalService', name: 'api', type: 'LogicalService' } },
      { data: { id: 'svc://db', label: 'LogicalService', name: 'db', type: 'LogicalService' } },
      { data: { id: 'svc://web', label: 'LogicalService', name: 'web', type: 'LogicalService' } },
    ],
    edges: [
      // manual outgoing — deletable
      {
        data: {
          id: 'e1',
          source: ENTITY_ID,
          target: 'svc://api',
          type: 'DEPENDS_ON',
          _manual_actor: 'me@example.com',
        },
      },
      // connector outgoing — delete disabled
      { data: { id: 'e2', source: ENTITY_ID, target: 'svc://db', type: 'DEPENDS_ON' } },
      // inbound — no delete affordance at all
      { data: { id: 'e3', source: 'svc://web', target: ENTITY_ID, type: 'DEPENDS_ON' } },
    ],
  };
}

function renderManager(data: GraphData | undefined = graph()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RelationManager
          entityId={ENTITY_ID}
          entityLabel="LogicalService"
          data={data}
          onOpen={() => {}}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openAddAndPick(type = 'DEPENDS_ON') {
  fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
  const typeSelect = await screen.findByLabelText(/relationship type/i);
  // The type options are schema-driven (the ['schema'] query feeds them), so the
  // <select> mounts before fetchSchema resolves — at which point its only option
  // is the disabled "Choose…" placeholder and a change to `type` is a no-op
  // (leaving the form unsubmittable). Wait for the requested option to populate
  // before selecting it, mirroring what a real user can only do once it appears.
  await screen.findByRole('option', { name: type });
  fireEvent.change(typeSelect, { target: { value: type } });
  fireEvent.click(await screen.findByRole('button', { name: /pick-target/i }));
}

describe('RelationManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.email = 'me@example.com';
    mockUser.role = 'member';
    mockUser.capabilities = ['graph:write'];
    vi.mocked(fetchSchema).mockResolvedValue(schema());
  });

  it('Add dialog submits → createRelation called with from/target/type', async () => {
    vi.mocked(createRelation).mockResolvedValue({ created: true });
    renderManager();
    await openAddAndPick();
    fireEvent.click(screen.getByRole('button', { name: /^create relationship$/i }));

    await waitFor(() =>
      expect(createRelation).toHaveBeenCalledWith(ENTITY_ID, 'svc://billing', 'DEPENDS_ON'),
    );
  });

  it('renders the "relationship added" toast on created:true', async () => {
    vi.mocked(createRelation).mockResolvedValue({ created: true });
    renderManager();
    await openAddAndPick();
    fireEvent.click(screen.getByRole('button', { name: /^create relationship$/i }));
    expect(await screen.findByText(/relationship added/i)).toBeInTheDocument();
  });

  it('renders the "you already added this" toast on created:false (no connector)', async () => {
    vi.mocked(createRelation).mockResolvedValue({ created: false });
    renderManager();
    await openAddAndPick();
    fireEvent.click(screen.getByRole('button', { name: /^create relationship$/i }));
    expect(await screen.findByText(/you already added this relationship/i)).toBeInTheDocument();
  });

  it('renders the "connector already owns this" toast on preexistingConnectorEdge', async () => {
    vi.mocked(createRelation).mockResolvedValue({ created: false, preexistingConnectorEdge: true });
    renderManager();
    await openAddAndPick();
    fireEvent.click(screen.getByRole('button', { name: /^create relationship$/i }));
    expect(
      await screen.findByText(/a connector already owns this relationship/i),
    ).toBeInTheDocument();
  });

  it('deletes a manual outgoing relation via deleteRelation', async () => {
    vi.mocked(deleteRelation).mockResolvedValue(true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderManager();

    fireEvent.click(screen.getByRole('button', { name: /^delete relationship$/i }));

    await waitFor(() =>
      expect(deleteRelation).toHaveBeenCalledWith(ENTITY_ID, 'svc://api', 'DEPENDS_ON'),
    );
    expect(await screen.findByText(/relationship removed/i)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirm dialog is dismissed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: /^delete relationship$/i }));
    expect(deleteRelation).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('shows the connector-owned message on a 409 CONNECTOR_EDGE error', async () => {
    vi.mocked(deleteRelation).mockRejectedValue(
      new RelationEditError('CONNECTOR_EDGE', 'connector-owned', 409),
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: /^delete relationship$/i }));
    expect(await screen.findByText(/can't delete — connector-owned/i)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('disables delete for a connector-owned relation (tooltip-explained)', () => {
    renderManager();
    const disabled = screen.getByRole('button', {
      name: /delete relationship \(connector-owned, disabled\)/i,
    });
    expect(disabled).toBeDisabled();
  });

  it('hides Add and Delete when the user lacks graph:write', () => {
    mockUser.capabilities = [];
    renderManager();
    expect(screen.queryByRole('button', { name: /add relationship/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^delete relationship$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete relationship \(connector-owned/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no relationships', () => {
    renderManager({ nodes: [], edges: [] });
    expect(screen.getByText(/no relationships yet/i)).toBeInTheDocument();
  });

  it('shows the rate-limit toast on a 429 error from createRelation', async () => {
    vi.mocked(createRelation).mockRejectedValue(
      new RelationEditError('RATE_LIMITED', 'Too many edits — slow down.', 429),
    );
    renderManager();
    await openAddAndPick();
    fireEvent.click(screen.getByRole('button', { name: /^create relationship$/i }));
    expect(await screen.findByText(/too many edits, slow down/i)).toBeInTheDocument();
  });
});
