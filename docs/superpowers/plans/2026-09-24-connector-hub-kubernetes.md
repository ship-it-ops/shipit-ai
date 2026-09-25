# Connector Hub — Kubernetes Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can add a Kubernetes connector from the Connector Hub UI without touching YAML or curl, and the hub renders Kubernetes connectors as honestly as GitHub ones.

**Architecture:** The web-ui API layer is widened from GitHub-only to a discriminated union on `type` (Task 1), a type-aware subtitle helper replaces two hardcoded `connector.org` reads (Task 2), and a new four-step `WizardDialog` (Access · Connect · Configure · Review) is built step by step (Tasks 3–6) before being wired into the hub (Task 7). No backend changes — every endpoint already shipped in PR #113.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, `@ship-it-ui/ui` design system (`WizardDialog`, `Banner`, `Field`, `Input`, `Textarea`, `Checkbox`, `Badge`, `Spinner`), TanStack Query v5, Vitest 4 + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-09-24-connector-hub-kubernetes-design.md`

## Global Constraints

- **Package:** all work is in `packages/web-ui`. Run commands from the repo root.
- **Test command:** `pnpm --filter @shipit-ai/web-ui test` (Vitest 4). A single file: `pnpm --filter @shipit-ai/web-ui exec vitest run src/path/to/file.test.tsx`.
- **Verify before commit:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` must all pass. `pnpm format:check` is a CI gate — run `npx prettier --write <files>` on anything you touch.
- **Never commit `packages/web-ui/next-env.d.ts`.** `pnpm build` rewrites its quote style; `git checkout -- packages/web-ui/next-env.d.ts` before committing.
- **Connector display names are stored BARE** — `"prod-eu"`, never `"Kubernetes · prod-eu"`. `lib/connector-identity.ts` composes the type prefix at render time. See `docs/agent/scars/connector-name-double-type-prefix.md`.
- **Cluster name regex (exact):** `/^[a-z0-9][a-z0-9-]{0,62}$/`
- **Connector id regex (exact, enforced server-side):** `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`
- **Workload kinds (exact, in this order):** `['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']`
- **Namespace defaults:** include `['*']`; exclude `['kube-system', 'kube-public', 'kube-node-lease']`
- **Schedule default:** `'*/5 * * * *'`
- **Step labels must be ONE word** — `WizardDialog` allocates fixed-width indicator slots and wraps longer labels.
- **Never log or echo credential values** (kubeconfig text, tokens, CA PEM). The Review step shows the access _mode_, never the secret.

---

## Task 1: Widen the web-ui API layer to a connector union

**Files:**

- Modify: `packages/web-ui/src/lib/api.ts`
- Modify: `packages/web-ui/src/lib/hooks/use-connectors.ts`
- Test: `packages/web-ui/src/lib/__tests__/api-kubernetes.test.ts` (create)

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `KubernetesAccess` = `{ mode: 'in-cluster' } | { mode: 'kubeconfig'; kubeconfigPath: string; context?: string } | { mode: 'token'; server: string; tokenPath: string; caDataPath?: string }`
  - `KubernetesConnector` — `{ id, type: 'kubernetes', enabled, name, schedule, cluster: { name: string }, access: KubernetesAccess, scope: KubernetesScope, mapping?: KubernetesMapping, lastRuns: ConnectorRun[] }`
  - `KubernetesScope` = `{ namespaces: { include: string[]; exclude: string[] }; kinds: KubernetesWorkloadKind[] }`
  - `KubernetesWorkloadKind` = `'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob'`
  - `Connector` = `GitHubConnector | KubernetesConnector`
  - `CreateConnectorInput` = `CreateGitHubConnectorInput | CreateKubernetesConnectorInput`
  - `ProbeInput` = `GitHubProbeInput | KubernetesProbeInput`
  - `KubernetesProbeResult` — `{ ok: boolean; code?: string; message?: string; cluster?: { version: string }; namespaces?: string[]; probedNamespace?: string; kinds?: Record<string, 'ok' | 'forbidden' | 'error' | 'skipped'> }`
  - `uploadKubernetesCredentials(input: UploadK8sCredentialsInput): Promise<UploadK8sCredentialsResult>`
  - `useUploadKubernetesCredentials()` — TanStack mutation wrapping the above

- [ ] **Step 1: Write the failing test**

Create `packages/web-ui/src/lib/__tests__/api-kubernetes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadKubernetesCredentials } from '../api';

describe('uploadKubernetesCredentials', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a kubeconfig and returns the stored path plus the contexts it found', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: 'kubeconfig',
          kubeconfigPath: '/data/keys/kubeconfig-k8s-prod.yaml',
          context: 'prod',
          contexts: ['prod', 'staging'],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await uploadKubernetesCredentials({
      connectorId: 'k8s-prod',
      mode: 'kubeconfig',
      kubeconfig: 'apiVersion: v1\n',
    });

    expect(result).toEqual({
      mode: 'kubeconfig',
      kubeconfigPath: '/data/keys/kubeconfig-k8s-prod.yaml',
      context: 'prod',
      contexts: ['prod', 'staging'],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/api/connectors/kubernetes/credentials');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      connectorId: 'k8s-prod',
      mode: 'kubeconfig',
      kubeconfig: 'apiVersion: v1\n',
    });
  });

  it('throws the server message on a rejected kubeconfig, so the wizard can show why', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'KUBECONFIG_INVALID',
            message: 'kubeconfig cluster sets proxy-url, which ShipIt cannot honour',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      uploadKubernetesCredentials({ connectorId: 'k8s-prod', mode: 'kubeconfig', kubeconfig: 'x' }),
    ).rejects.toThrow(/proxy-url/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/lib/__tests__/api-kubernetes.test.ts`
Expected: FAIL — `uploadKubernetesCredentials` is not exported from `../api`.

- [ ] **Step 3: Add the Kubernetes types and the upload function**

In `packages/web-ui/src/lib/api.ts`, after the existing `GitHubConnector` interface, add:

```ts
export type KubernetesWorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob';

export type KubernetesAccess =
  | { mode: 'in-cluster' }
  | { mode: 'kubeconfig'; kubeconfigPath: string; context?: string }
  | { mode: 'token'; server: string; tokenPath: string; caDataPath?: string };

export interface KubernetesScope {
  namespaces: { include: string[]; exclude: string[] };
  kinds: KubernetesWorkloadKind[];
}

export interface KubernetesMapping {
  environment?: { label?: string };
  ownership?: { teamLabel?: string };
  repoLink?: { annotation?: string; githubOrg?: string | null; nameMatch?: boolean };
}

export interface KubernetesConnector {
  id: string;
  type: 'kubernetes';
  enabled: boolean;
  name: string;
  schedule: string;
  cluster: { name: string };
  access: KubernetesAccess;
  scope: KubernetesScope;
  mapping?: KubernetesMapping;
  lastRuns: ConnectorRun[];
}
```

Then change the `Connector` alias (it currently reads `export type Connector = GitHubConnector;`):

```ts
// Discriminated on `type`. Narrow before reading a source-specific field —
// `connector.org` exists only on the GitHub arm.
export type Connector = GitHubConnector | KubernetesConnector;
```

Rename the existing `CreateConnectorInput` interface to `CreateGitHubConnectorInput` (leave its body unchanged), then add below it:

```ts
export interface CreateKubernetesConnectorInput {
  id: string;
  type: 'kubernetes';
  name: string;
  cluster: { name: string };
  access: KubernetesAccess;
  enabled?: boolean;
  schedule?: string;
  scope?: KubernetesScope;
  mapping?: KubernetesMapping;
}

export type CreateConnectorInput = CreateGitHubConnectorInput | CreateKubernetesConnectorInput;
```

Rename the existing `ProbeInput` interface to `GitHubProbeInput` (body unchanged), then add:

```ts
export interface KubernetesProbeInput {
  type: 'kubernetes';
  access: KubernetesAccess;
  namespaces?: { include?: string[]; exclude?: string[] };
  kinds?: KubernetesWorkloadKind[];
}

export type ProbeInput = GitHubProbeInput | KubernetesProbeInput;

export interface KubernetesProbeResult {
  ok: boolean;
  code?: string;
  message?: string;
  cluster?: { version: string };
  namespaces?: string[];
  // The ONE namespace `kinds` was measured against. Absent when nothing was in scope.
  probedNamespace?: string;
  kinds?: Record<string, 'ok' | 'forbidden' | 'error' | 'skipped'>;
}
```

Add `KubernetesProbeResult`'s fields to the existing `ProbeResult` interface as optional members so a single `probeConnector` serves both types — add these four lines inside `ProbeResult`:

```ts
  cluster?: { version: string };
  namespaces?: string[];
  probedNamespace?: string;
  kinds?: Record<string, 'ok' | 'forbidden' | 'error' | 'skipped'>;
```

Finally add the upload function at the end of the connector section:

```ts
export type UploadK8sCredentialsInput =
  | { connectorId: string; mode: 'kubeconfig'; kubeconfig: string; context?: string }
  | { connectorId: string; mode: 'token'; token: string; caData?: string };

export type UploadK8sCredentialsResult =
  | { mode: 'kubeconfig'; kubeconfigPath: string; context: string; contexts: string[] }
  | { mode: 'token'; tokenPath: string; caDataPath?: string };

// Stores pasted credentials as files in the api-server's key dir and returns the
// paths a subsequent createConnector() references. Runs BEFORE the connector
// exists — the route is keyed by connectorId, not by an existing connector.
export async function uploadKubernetesCredentials(
  input: UploadK8sCredentialsInput,
): Promise<UploadK8sCredentialsResult> {
  const res = await fetchApi(`${API_URL}/api/connectors/kubernetes/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Credential upload failed: ${res.status}`);
  }
  return (await res.json()) as UploadK8sCredentialsResult;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/lib/__tests__/api-kubernetes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Fix the three narrowing errors the union introduces**

Run: `pnpm typecheck`

Expected: errors at `connector-card.tsx:44`, `connector-detail-drawer.tsx:175`, `connector-detail-drawer.tsx:202`. Task 2 replaces the first two properly; for now make only `:202` type-safe, since the "Installation" row is genuinely GitHub-only. In `connector-detail-drawer.tsx`, change:

```tsx
<Row label="Installation" value={connector.installationId} />
```

to:

```tsx
{
  connector.type === 'github' && <Row label="Installation" value={connector.installationId} />;
}
```

For `:175` and `card:44`, narrow inline as a temporary measure — Task 2 replaces both:

```tsx
// card:44
const subtitle = connector.type === 'github' ? connector.org : connector.cluster.name;
```

```tsx
// drawer:175
{info.entityCount.toLocaleString()} entities ·{' '}
{connector.type === 'github' ? connector.org : connector.cluster.name}
```

- [ ] **Step 6: Add the upload hook**

In `packages/web-ui/src/lib/hooks/use-connectors.ts`, add after `useProbeConnector`:

```ts
export function useUploadKubernetesCredentials() {
  return useMutation({ mutationFn: uploadKubernetesCredentials });
}
```

Add `uploadKubernetesCredentials` to the existing import from `@/lib/api` at the top of the file.

- [ ] **Step 7: Verify everything passes**

Run: `pnpm typecheck && pnpm --filter @shipit-ai/web-ui test`
Expected: typecheck clean; web-ui suite green (171 existing tests + 2 new).

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/web-ui/src/lib/api.ts packages/web-ui/src/lib/hooks/use-connectors.ts packages/web-ui/src/lib/__tests__/api-kubernetes.test.ts packages/web-ui/src/components/connectors/connector-card.tsx packages/web-ui/src/components/connectors/connector-detail-drawer.tsx
git add packages/web-ui/src/lib packages/web-ui/src/components/connectors
git commit -m "web-ui: widen the connector API layer to a type union with Kubernetes"
```

---

## Task 2: Type-aware connector subtitle

**Files:**

- Create: `packages/web-ui/src/lib/connector-subtitle.ts`
- Create: `packages/web-ui/src/lib/connector-subtitle.test.ts`
- Modify: `packages/web-ui/src/components/connectors/connector-card.tsx:44`
- Modify: `packages/web-ui/src/components/connectors/connector-detail-drawer.tsx:175`

**Interfaces:**

- Consumes: `Connector` union from Task 1.
- Produces: `connectorSubtitle(connector: Connector): string | null`

- [ ] **Step 1: Write the failing test**

Create `packages/web-ui/src/lib/connector-subtitle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { connectorSubtitle } from './connector-subtitle';
import type { Connector } from './api';

const github = {
  id: 'gh-acme',
  type: 'github',
  enabled: true,
  name: 'acme',
  installationId: '123',
  org: 'acme-corp',
  schedule: '*/5 * * * *',
  scope: { repos: { include: [], exclude: [] }, teams: { include: [], exclude: [] } },
  entities: {},
  lastRuns: [],
} as unknown as Connector;

const kubernetes = {
  id: 'k8s-prod',
  type: 'kubernetes',
  enabled: true,
  name: 'prod',
  schedule: '*/5 * * * *',
  cluster: { name: 'prod-eu' },
  access: { mode: 'in-cluster' },
  scope: { namespaces: { include: ['*'], exclude: [] }, kinds: ['Deployment'] },
  lastRuns: [],
} as unknown as Connector;

describe('connectorSubtitle', () => {
  it('identifies a GitHub connector by its org', () => {
    expect(connectorSubtitle(github)).toBe('acme-corp');
  });

  it('identifies a Kubernetes connector by its cluster name', () => {
    expect(connectorSubtitle(kubernetes)).toBe('prod-eu');
  });

  it('returns null for an unrecognised type so callers render nothing', () => {
    const future = { ...github, type: 'datadog' } as unknown as Connector;
    expect(connectorSubtitle(future)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/lib/connector-subtitle.test.ts`
Expected: FAIL — cannot resolve `./connector-subtitle`.

- [ ] **Step 3: Write the helper**

Create `packages/web-ui/src/lib/connector-subtitle.ts`:

```ts
import type { Connector } from './api';

/**
 * The line that tells a user WHICH instance a connector is, given its type:
 * the GitHub org, the Kubernetes cluster. Returns null for a type we have no
 * identity line for, so callers render nothing rather than "undefined".
 *
 * One source of truth on purpose — a new connector type adds one case here
 * instead of needing an audit of every render site.
 */
export function connectorSubtitle(connector: Connector): string | null {
  switch (connector.type) {
    case 'github':
      return connector.org ?? null;
    case 'kubernetes':
      return connector.cluster?.name ?? null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/lib/connector-subtitle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Use it in the card**

In `connector-card.tsx`, replace the Task 1 temporary line:

```tsx
const subtitle = connector.type === 'github' ? connector.org : connector.cluster.name;
```

with:

```tsx
const subtitle = connectorSubtitle(connector);
```

Add the import: `import { connectorSubtitle } from '@/lib/connector-subtitle';`

The existing render already guards with `{subtitle && ...}`, so `null` renders nothing.

- [ ] **Step 6: Use it in the drawer**

In `connector-detail-drawer.tsx`, replace the Task 1 temporary block with:

```tsx
<span className="text-text-muted text-[12px]">
  {info.entityCount.toLocaleString()} entities
  {connectorSubtitle(connector) ? ` · ${connectorSubtitle(connector)}` : ''}
</span>
```

Add the import: `import { connectorSubtitle } from '@/lib/connector-subtitle';`

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm --filter @shipit-ai/web-ui test`
Expected: typecheck clean; suite green.

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/web-ui/src/lib/connector-subtitle.ts packages/web-ui/src/lib/connector-subtitle.test.ts packages/web-ui/src/components/connectors/connector-card.tsx packages/web-ui/src/components/connectors/connector-detail-drawer.tsx
git add packages/web-ui/src/lib packages/web-ui/src/components/connectors
git commit -m "web-ui: type-aware connector subtitle for card and drawer"
```

---

## Task 3: Wizard shell with the Access step

**Files:**

- Create: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx`
- Create: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx`

**Interfaces:**

- Consumes: `useUploadKubernetesCredentials` (Task 1).
- Produces: `AddKubernetesConnectorWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void })`, and internally `k8sConnectorId(clusterName: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@ship-it-ui/ui';
import { AddKubernetesConnectorWizard } from './add-kubernetes-connector-wizard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/connectors',
}));

const uploadMutate = vi.fn();
const probeMutate = vi.fn();
const createMutate = vi.fn();

vi.mock('@/lib/hooks/use-connectors', () => ({
  useUploadKubernetesCredentials: () => ({ mutateAsync: uploadMutate, isPending: false }),
  useProbeConnector: () => ({ mutateAsync: probeMutate, reset: vi.fn(), isPending: false }),
  useCreateConnector: () => ({ mutateAsync: createMutate, reset: vi.fn(), isPending: false }),
  useConnectors: () => ({ data: [], isLoading: false }),
}));

function renderWizard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AddKubernetesConnectorWizard open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AddKubernetesConnectorWizard — Access step', () => {
  it('defaults to in-cluster access and asks for a cluster name', () => {
    renderWizard();
    expect(screen.getByLabelText(/cluster name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /in-cluster/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // The credentials route is keyed by connectorId and runs BEFORE the connector
  // exists, so the id must be derivable at this step — that is why cluster name
  // lives here rather than with the rest of the config.
  it('uploads a pasted kubeconfig under an id derived from the cluster name', async () => {
    uploadMutate.mockResolvedValue({
      mode: 'kubeconfig',
      kubeconfigPath: '/data/keys/kubeconfig-k8s-prod-eu.yaml',
      context: 'prod',
      contexts: ['prod'],
    });
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /paste a kubeconfig/i }));
    await user.type(screen.getByLabelText(/kubeconfig/i), 'apiVersion: v1');
    await user.click(screen.getByRole('button', { name: /store credentials and continue/i }));

    expect(uploadMutate).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'k8s-prod-eu', mode: 'kubeconfig' }),
    );
  });

  it('does not upload anything for in-cluster access', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /store credentials and continue/i }));
    expect(uploadMutate).not.toHaveBeenCalled();
  });

  it('blocks the continue action until the cluster name is valid', async () => {
    const user = userEvent.setup();
    renderWizard();
    const advance = screen.getByRole('button', { name: /store credentials and continue/i });
    expect(advance).toBeDisabled();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    expect(advance).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: FAIL — cannot resolve `./add-kubernetes-connector-wizard`.

- [ ] **Step 3: Write the wizard shell and Access step**

Create `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx`:

```tsx
'use client';

// Four-step wizard for adding a Kubernetes cluster as a connector:
//   Access · Connect · Configure · Review
//
// Mirrors add-github-connector-wizard.tsx's mechanics (useState per field,
// WizardStep[] with canAdvance gates, one-word step labels because
// WizardDialog allocates fixed-width indicator slots) but shares no code with
// it — GitHub's wizard is almost entirely App-manifest specifics.
//
// Why cluster name is collected in step 1 rather than with the rest of the
// config: POST /api/connectors/kubernetes/credentials is keyed by connectorId
// and runs BEFORE the connector exists, so the field the id derives from has
// to be collected before the upload. This also keeps the stored credential
// filenames readable (kubeconfig-k8s-prod-eu.yaml) rather than nonce-based.

import { useState } from 'react';
import {
  Banner,
  Button,
  Field,
  Input,
  Textarea,
  WizardDialog,
  type WizardStep,
} from '@ship-it-ui/ui';
import { useUploadKubernetesCredentials } from '@/lib/hooks/use-connectors';
import type { KubernetesAccess } from '@/lib/api';
import { cn } from '@/lib/utils';

const CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

type AccessMode = 'in-cluster' | 'kubeconfig' | 'token';

/** Connector id derived from the cluster name; see the header comment. */
export function k8sConnectorId(clusterName: string): string {
  return `k8s-${clusterName}`;
}

interface AddKubernetesConnectorWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ModeCard({
  selected,
  title,
  description,
  onSelect,
  children,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-base border-border bg-panel border p-3',
        selected && 'border-border-strong',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="w-full text-left outline-none"
      >
        <span className="text-text block text-[14px] font-medium">{title}</span>
        <span className="text-text-muted mt-0.5 block text-[12px]">{description}</span>
      </button>
      {selected && children ? <div className="mt-3 flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}

export function AddKubernetesConnectorWizard({
  open,
  onOpenChange,
}: AddKubernetesConnectorWizardProps) {
  const [clusterName, setClusterName] = useState('');
  const [mode, setMode] = useState<AccessMode>('in-cluster');
  const [kubeconfig, setKubeconfig] = useState('');
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [caData, setCaData] = useState('');
  const [access, setAccess] = useState<KubernetesAccess | null>(null);
  const [contexts, setContexts] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = useUploadKubernetesCredentials();

  const clusterNameValid = CLUSTER_NAME.test(clusterName);
  const accessStepValid =
    clusterNameValid &&
    (mode === 'in-cluster' ||
      (mode === 'kubeconfig' && kubeconfig.trim().length > 0) ||
      (mode === 'token' && /^https:\/\/\S+$/.test(server) && token.trim().length > 0));

  // Credentials are stored on leaving the Access step so the Connect step can
  // probe exactly the access block the connector will use. Returns whether the
  // step may advance — a rejected kubeconfig must keep the user here with the
  // server's reason visible.
  async function storeCredentials(): Promise<boolean> {
    setUploadError(null);
    if (mode === 'in-cluster') {
      setAccess({ mode: 'in-cluster' });
      return true;
    }
    const connectorId = k8sConnectorId(clusterName);
    try {
      if (mode === 'kubeconfig') {
        const r = await upload.mutateAsync({ connectorId, mode: 'kubeconfig', kubeconfig });
        if (r.mode !== 'kubeconfig') return false;
        setContexts(r.contexts);
        setAccess({ mode: 'kubeconfig', kubeconfigPath: r.kubeconfigPath, context: r.context });
      } else {
        const r = await upload.mutateAsync({
          connectorId,
          mode: 'token',
          token,
          ...(caData.trim() ? { caData } : {}),
        });
        if (r.mode !== 'token') return false;
        setAccess({
          mode: 'token',
          server,
          tokenPath: r.tokenPath,
          ...(r.caDataPath ? { caDataPath: r.caDataPath } : {}),
        });
      }
      return true;
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not store credentials');
      return false;
    }
  }

  const steps: WizardStep[] = [
    {
      id: 'access',
      label: 'Access',
      canAdvance: () => accessStepValid && access !== null,
      // `content` takes a render function so the step can reach WizardContext.
      // WizardDialog has NO "before next" hook, so the credential upload cannot
      // hang off the Next button — this step owns an explicit advance action
      // that uploads and then calls ctx.goNext(). Next stays gated by
      // canAdvance, which only passes once `access` has been stored.
      content: (ctx) => (
        <div className="flex flex-col gap-3">
          <Field label="Cluster name" htmlFor="k8s-cluster-name">
            <Input
              id="k8s-cluster-name"
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value)}
              placeholder="prod-eu"
            />
          </Field>
          {clusterName && !clusterNameValid && (
            <Banner tone="warn">
              Cluster name must be lowercase letters, digits and hyphens, starting with a letter or
              digit.
            </Banner>
          )}

          <ModeCard
            selected={mode === 'in-cluster'}
            title="Run in this cluster (in-cluster)"
            description="Uses the ShipIt pod's ServiceAccount. Needs the shipit-reader ClusterRole."
            onSelect={() => setMode('in-cluster')}
          />
          <ModeCard
            selected={mode === 'kubeconfig'}
            title="Paste a kubeconfig"
            description="Data-only kubeconfig. exec, auth-provider, proxy-url and file references are rejected."
            onSelect={() => setMode('kubeconfig')}
          >
            <Field label="Kubeconfig" htmlFor="k8s-kubeconfig">
              <Textarea
                id="k8s-kubeconfig"
                rows={8}
                value={kubeconfig}
                onChange={(e) => setKubeconfig(e.target.value)}
              />
            </Field>
          </ModeCard>
          <ModeCard
            selected={mode === 'token'}
            title="Server and ServiceAccount token"
            description="Point at the API server directly with a token you minted."
            onSelect={() => setMode('token')}
          >
            <Field label="API server URL" htmlFor="k8s-server">
              <Input
                id="k8s-server"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://10.0.0.1:6443"
              />
            </Field>
            <Field label="ServiceAccount token" htmlFor="k8s-token">
              <Input
                id="k8s-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <Field label="CA certificate (PEM, optional)" htmlFor="k8s-ca">
              <Textarea
                id="k8s-ca"
                rows={4}
                value={caData}
                onChange={(e) => setCaData(e.target.value)}
              />
            </Field>
          </ModeCard>

          {uploadError && <Banner tone="danger">{uploadError}</Banner>}
          <Button
            onClick={() => {
              void storeCredentials().then((stored) => {
                if (stored) ctx.goNext();
              });
            }}
            disabled={!accessStepValid || upload.isPending}
          >
            Store credentials and continue
          </Button>
        </div>
      ),
    },
  ];

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      steps={steps}
      title="Add Kubernetes connector"
      description="Connect a cluster so ShipIt can map its workloads to your services."
      width={640}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx
git add packages/web-ui/src/components/connectors
git commit -m "web-ui: Kubernetes wizard shell with the Access step"
```

---

## Task 4: Connect step (probe)

**Files:**

- Modify: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx`
- Modify: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx`

**Interfaces:**

- Consumes: `access` state and `useProbeConnector` (Task 1).
- Produces: `probe: KubernetesProbeResult | null` state, and `okKinds: KubernetesWorkloadKind[]` derived from it for Task 5.

- [ ] **Step 1: Write the failing test**

Append to `add-kubernetes-connector-wizard.test.tsx`:

```tsx
describe('AddKubernetesConnectorWizard — Connect step', () => {
  it('renders the cluster version, namespaces and per-kind access, and names the probed namespace', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit', 'monitoring'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'forbidden' },
    });
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText('v1.31.2')).toBeInTheDocument();
    expect(screen.getByText(/shipit/)).toBeInTheDocument();
    // The caveat: an all-green probe is NOT a cluster-wide guarantee.
    expect(screen.getByText(/measured against namespace/i)).toBeInTheDocument();
    expect(screen.getByText(/CronJob/)).toBeInTheDocument();
  });

  it('explains an in-cluster probe failure instead of showing the raw code', async () => {
    probeMutate.mockResolvedValue({
      ok: false,
      code: 'IN_CLUSTER_UNAVAILABLE',
      message: 'no in-cluster ServiceAccount token found',
    });
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/not running inside a cluster/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: FAIL — no "Test connection" button exists.

- [ ] **Step 3: Add the probe state and the Connect step**

Add near the other state in the component:

```tsx
const [probe, setProbe] = useState<KubernetesProbeResult | null>(null);
const probeConnector = useProbeConnector();

const PROBE_MESSAGES: Record<string, string> = {
  IN_CLUSTER_UNAVAILABLE:
    'This ShipIt instance is not running inside a cluster. Use kubeconfig or token access instead.',
  CREDENTIALS_UNREADABLE: 'ShipIt cannot read the stored credential file. Re-upload it.',
  UNAUTHORIZED: 'The cluster rejected these credentials.',
  API_UNREACHABLE: 'ShipIt cannot reach the API server from its network.',
  TIMEOUT: 'The cluster did not answer in time.',
};

function probeMessage(result: KubernetesProbeResult): string {
  // KUBECONFIG_INVALID / UNSUPPORTED_AUTH_PLUGIN carry a message that already
  // names the offending field (exec, auth-provider, proxy-url) — show it as-is.
  return (
    PROBE_MESSAGES[result.code ?? ''] ?? result.message ?? 'The connection test did not succeed.'
  );
}

async function runProbe(): Promise<void> {
  if (!access) return;
  const result = (await probeConnector.mutateAsync({
    type: 'kubernetes',
    access,
  })) as KubernetesProbeResult;
  setProbe(result);
}

const okKinds = Object.entries(probe?.kinds ?? {})
  .filter(([, status]) => status === 'ok')
  .map(([kind]) => kind as KubernetesWorkloadKind);
```

Add the second step to the `steps` array:

```tsx
{
  id: 'connect',
  label: 'Connect',
  canAdvance: () => probe?.ok === true,
  content: (
    <div className="flex flex-col gap-3">
      <Button onClick={() => void runProbe()} disabled={probeConnector.isPending}>
        Test connection
      </Button>

      {probe && !probe.ok && <Banner tone="danger">{probeMessage(probe)}</Banner>}

      {probe?.ok && (
        <div className="flex flex-col gap-2">
          <div className="text-[13px]">
            Cluster version <span className="font-mono">{probe.cluster?.version}</span>
          </div>
          <div className="text-[13px]">
            Namespaces in scope: {(probe.namespaces ?? []).join(', ') || 'none'}
          </div>
          <ul className="flex flex-col gap-1">
            {Object.entries(probe.kinds ?? {}).map(([kind, status]) => (
              <li key={kind} className="text-[13px]">
                {kind}: {status}
              </li>
            ))}
          </ul>
          {probe.probedNamespace && (
            <Banner tone="neutral">
              Access measured against namespace <strong>{probe.probedNamespace}</strong>. A
              namespace-scoped RoleBinding elsewhere can still fail at sync time.
            </Banner>
          )}
          {Object.values(probe.kinds ?? {}).some((s) => s === 'forbidden') && (
            <Banner tone="warn">
              Some resource kinds are denied. The next step preselects only the kinds ShipIt can
              read, so syncs do not warn about the rest on every run.
            </Banner>
          )}
        </div>
      )}
    </div>
  ),
},
```

Import `useProbeConnector` from `@/lib/hooks/use-connectors` and `KubernetesProbeResult`, `KubernetesWorkloadKind` from `@/lib/api`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx
git add packages/web-ui/src/components/connectors
git commit -m "web-ui: Kubernetes wizard Connect step with probe results"
```

---

## Task 5: Configure step with forbidden-kind preselection

**Files:**

- Modify: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx`
- Modify: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx`

**Interfaces:**

- Consumes: `okKinds` (Task 4), `useConnectors` (for the GitHub org default).
- Produces: `displayName`, `include`, `exclude`, `kinds`, `schedule`, `githubOrg` state for Task 6.

- [ ] **Step 1: Write the failing test**

This is the behaviour with no server-side counterpart, so it is the most valuable test in the plan. Append:

```tsx
describe('AddKubernetesConnectorWizard — Configure step', () => {
  it('preselects only the kinds that probed ok, leaving a forbidden kind unchecked', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'forbidden' },
    });
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('button', { name: /test connection/i }));
    await screen.findByText('v1.31.2');
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByRole('checkbox', { name: /Deployment/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /StatefulSet/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /DaemonSet/ })).toBeChecked();
    // Denied — left off so the connector does not warn on every sync.
    expect(screen.getByRole('checkbox', { name: /CronJob/ })).not.toBeChecked();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: FAIL — no kind checkboxes exist.

- [ ] **Step 3: Add the Configure step**

Add state:

```tsx
const ALL_KINDS: KubernetesWorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'];

const [displayName, setDisplayName] = useState('');
const [include, setInclude] = useState('*');
const [exclude, setExclude] = useState('kube-system, kube-public, kube-node-lease');
const [schedule, setSchedule] = useState('*/5 * * * *');
const [kinds, setKinds] = useState<KubernetesWorkloadKind[] | null>(null);

// Null until the probe answers, then defaulted to exactly what probed `ok`.
// Falls back to every kind when the probe found none, so the user is never
// left with an unsubmittable empty selection (the schema requires >= 1).
const effectiveKinds = kinds ?? (okKinds.length > 0 ? okKinds : ALL_KINDS);

function toggleKind(kind: KubernetesWorkloadKind): void {
  const next = effectiveKinds.includes(kind)
    ? effectiveKinds.filter((k) => k !== kind)
    : [...effectiveKinds, kind];
  setKinds(next);
}
```

Add the third step:

```tsx
{
  id: 'configure',
  label: 'Configure',
  canAdvance: () => effectiveKinds.length > 0,
  content: (
    <div className="flex flex-col gap-3">
      <Field label="Display name" htmlFor="k8s-display-name">
        <Input
          id="k8s-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={clusterName}
        />
      </Field>
      <Field label="Include namespaces" htmlFor="k8s-include">
        <Input id="k8s-include" value={include} onChange={(e) => setInclude(e.target.value)} />
      </Field>
      <Field label="Exclude namespaces" htmlFor="k8s-exclude">
        <Input id="k8s-exclude" value={exclude} onChange={(e) => setExclude(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-text text-[13px] font-medium">Workload kinds</legend>
        {ALL_KINDS.map((kind) => (
          <Checkbox
            key={kind}
            label={kind}
            checked={effectiveKinds.includes(kind)}
            onCheckedChange={() => toggleKind(kind)}
          />
        ))}
      </fieldset>
      <Field label="Sync schedule" htmlFor="k8s-schedule">
        <Input id="k8s-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
      </Field>
    </div>
  ),
},
```

Import `Checkbox` from `@ship-it-ui/ui`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx
git add packages/web-ui/src/components/connectors
git commit -m "web-ui: Kubernetes wizard Configure step, kinds preselected from the probe"
```

---

## Task 6: Review step and connector creation

**Files:**

- Modify: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx`
- Modify: `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx`

**Interfaces:**

- Consumes: every field from Tasks 3–5, `useCreateConnector` (Task 1).
- Produces: nothing downstream; Task 7 only mounts the component.

- [ ] **Step 1: Write the failing test**

```tsx
describe('AddKubernetesConnectorWizard — Review step', () => {
  it('creates the connector with a bare display name and the stored access block', async () => {
    probeMutate.mockResolvedValue({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      probedNamespace: 'shipit',
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'ok' },
    });
    createMutate.mockResolvedValue({ id: 'k8s-prod-eu' });
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('button', { name: /test connection/i }));
    await screen.findByText('v1.31.2');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('button', { name: /create connector|done/i }));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'k8s-prod-eu',
        type: 'kubernetes',
        // BARE — connector-identity.ts composes "Kubernetes · prod-eu" at render time.
        name: 'prod-eu',
        cluster: { name: 'prod-eu' },
        access: { mode: 'in-cluster' },
      }),
    );
  });

  it('never shows the credential values on the review screen', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText(/cluster name/i), 'prod-eu');
    await user.click(screen.getByRole('button', { name: /paste a kubeconfig/i }));
    await user.type(screen.getByLabelText(/kubeconfig/i), 'super-secret-token-value');
    expect(screen.queryByText(/super-secret-token-value/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: FAIL — no Review step, `createMutate` never called.

- [ ] **Step 3: Add the Review step and submit**

```tsx
const createConnector = useCreateConnector();
const [createError, setCreateError] = useState<string | null>(null);

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

async function submit(): Promise<void> {
  if (!access) return;
  setCreateError(null);
  try {
    await createConnector.mutateAsync({
      id: k8sConnectorId(clusterName),
      type: 'kubernetes',
      // Stored bare — the type prefix is composed at render time.
      name: displayName.trim() || clusterName,
      cluster: { name: clusterName },
      access,
      schedule,
      scope: {
        namespaces: { include: splitList(include), exclude: splitList(exclude) },
        kinds: effectiveKinds,
      },
    });
    onOpenChange(false);
  } catch (err) {
    setCreateError(err instanceof Error ? err.message : 'Could not create the connector');
  }
}
```

Add the fourth step:

```tsx
{
  id: 'review',
  label: 'Review',
  content: (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1 text-[13px]">
        <div>Cluster: {clusterName}</div>
        {/* Mode only — never the credential values. */}
        <div>Access: {mode}</div>
        <div>Namespaces: include {include || '*'}; exclude {exclude || 'none'}</div>
        <div>Kinds: {effectiveKinds.join(', ')}</div>
        <div>Schedule: {schedule}</div>
      </dl>
      {createError && <Banner tone="danger">{createError}</Banner>}
      <Button onClick={() => void submit()} disabled={createConnector.isPending}>
        Create connector
      </Button>
    </div>
  ),
},
```

Import `useCreateConnector`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-kubernetes-connector-wizard.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.test.tsx
git add packages/web-ui/src/components/connectors
git commit -m "web-ui: Kubernetes wizard Review step and connector creation"
```

---

## Task 7: Wire into the Connector Hub

**Files:**

- Modify: `packages/web-ui/src/components/connectors/add-connector-picker.tsx`
- Modify: `packages/web-ui/src/app/(app)/connectors/page.tsx`
- Test: `packages/web-ui/src/components/connectors/add-connector-picker.test.tsx` (create)

**Interfaces:**

- Consumes: `AddKubernetesConnectorWizard` (Tasks 3–6).
- Produces: nothing — this is the last task.

- [ ] **Step 1: Write the failing test**

Create `packages/web-ui/src/components/connectors/add-connector-picker.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddConnectorPicker } from './add-connector-picker';

describe('AddConnectorPicker', () => {
  it('offers Kubernetes as a selectable type, not "coming soon"', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<AddConnectorPicker open onOpenChange={() => {}} onPick={onPick} />);

    const kubernetes = screen.getByRole('button', { name: /kubernetes/i });
    expect(kubernetes).toBeEnabled();
    await user.click(kubernetes);
    expect(onPick).toHaveBeenCalledWith('kubernetes');
  });

  it('still lists an unimplemented type as coming soon', () => {
    render(<AddConnectorPicker open onOpenChange={() => {}} onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /datadog — coming soon/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-connector-picker.test.tsx`
Expected: FAIL — the Kubernetes button is disabled and `onPick` is not called.

- [ ] **Step 3: Enable the picker entry**

In `add-connector-picker.tsx`, change the `kubernetes` entry's status:

```ts
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    glyph: 'kubernetes',
    description: 'Namespaces, deployments, services, pods',
    status: 'available',
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/connectors/add-connector-picker.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the wizard on the connectors page**

In `packages/web-ui/src/app/(app)/connectors/page.tsx`, add the import:

```tsx
import { AddKubernetesConnectorWizard } from '@/components/connectors/add-kubernetes-connector-wizard';
```

and render it beside the GitHub wizard:

```tsx
<AddKubernetesConnectorWizard
  open={activeWizard === 'kubernetes'}
  onOpenChange={(open) => {
    if (!open) setActiveWizard(null);
  }}
/>
```

Confirm `handlePick` already routes any picked type into `setActiveWizard` — if it special-cases `'github'`, widen it to accept the picked id directly.

- [ ] **Step 6: Verify the whole repo**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`
Expected: all green. Then `git checkout -- packages/web-ui/next-env.d.ts` if `pnpm build` ran at any point.

- [ ] **Step 7: Commit**

```bash
npx prettier --write "packages/web-ui/src/**/*.tsx"
git add packages/web-ui/src
git commit -m "web-ui: enable Kubernetes in the connector picker and mount its wizard"
```

---

## Self-Review Notes

**Spec coverage:** Access/Connect/Configure/Review → Tasks 3–6. Cluster name in step 1 with id derivation → Task 3. `probedNamespace` caveat → Task 4. Forbidden-kind preselection → Task 5. Bare display name → Task 6. Picker + page wiring → Task 7. Subtitle helper for card and drawer → Task 2. API-layer widening (spec §Architecture) → Task 1.

**Known gaps deliberately left to the implementer:**

- The **advanced Configure panel** (`repoLink.githubOrg`, `environment.label`, `ownership.teamLabel`) is specified but has no task. It is additive, needs no new interfaces, and every field has a schema default, so a connector created without it is correct. Add it inside Task 5 if the `useConnectors`-derived org default is wanted in v1.
- **Checkbox `label` prop.** Task 5 assumes `<Checkbox label=... />` renders an accessible name. Confirm against the DS; if it needs a wrapping `<label>`, adjust both component and test together.
