# GSM-Backed Dynamic Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Operator standing rules:** ask before EVERY commit and push (plan approval ≠ commit approval). Never add a `Co-Authored-By` trailer to commit messages.

**Goal:** Onboarding-created credentials (GitHub App PEM, webhook secret, OAuth client id/secret, App ID, OIDC client secret) persist to Google Secret Manager via Workload Identity and re-hydrate on boot, plus a config-export endpoint so runtime config survives redeploys.

**Architecture:** A `SecretStore` interface with `FileSecretStore` (local dev, default — behavior-neutral) and `GsmSecretStore` (ADC + `accessSecretVersion`/`addSecretVersion`) implementations, selected by `SHIPIT_SECRET_STORE`. A boot-time hydration step (gsm only) pulls GSM values into `process.env` / a materialized PEM file _before_ `loadConfig()`, so all existing consumers stay unchanged. Write paths (manifest exchange, new OIDC settings endpoint) use the store directly. A `GET /api/config/export` endpoint returns the merged raw base+local YAML (placeholders preserved, secrets/run-history scrubbed) for the operator to commit as the chart's next seed.

**Spec:** `docs/superpowers/specs/2026-06-09-gsm-secret-store-design.md` (approved 2026-06-09).

**Tech Stack:** TypeScript ESM, Fastify v5, `@google-cloud/secret-manager` v6, `yaml`, Vitest, pnpm workspaces.

**Conventions used below:**

- All api-server paths relative to `packages/api-server/`.
- Test commands: `pnpm --filter @shipit-ai/api-server exec vitest run <file>` (api-server), `pnpm --filter @shipit-ai/shared exec vitest run <file>` (shared), `pnpm --filter @shipit-ai/web-ui exec vitest run <file>` (web-ui).
- Every service takes its collaborators via constructor options with injectable seams (mirror `GitHubAppManifestService`'s `fetchImpl` pattern).
- ESM imports inside the repo end in `.js`.

---

### Task 1: Add the GSM SDK dependency

**Files:**

- Modify: `packages/api-server/package.json`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @shipit-ai/api-server add @google-cloud/secret-manager
```

- [ ] **Step 2: Verify install + typecheck still passes**

Run: `pnpm --filter @shipit-ai/api-server typecheck` (or `pnpm -r typecheck` if no per-package script)
Expected: PASS, lockfile updated.

- [ ] **Step 3: Commit (ask operator first)**

```bash
git add packages/api-server/package.json pnpm-lock.yaml
git commit -m "deps(api-server): add @google-cloud/secret-manager for GSM secret store"
```

---

### Task 2: `secrets/types.ts` — logical names, container map, writability

**Files:**

- Create: `packages/api-server/src/secrets/types.ts`
- Test: `packages/api-server/src/__tests__/secrets/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  GSM_CONTAINER_DEFAULTS,
  ENV_VAR_FOR,
  WRITABLE_SECRETS,
  SecretWriteForbiddenError,
  assertWritable,
  gsmContainerFor,
} from '../../secrets/types.js';

describe('secret taxonomy', () => {
  it('maps every logical secret to its Terraform container name', () => {
    expect(GSM_CONTAINER_DEFAULTS).toEqual({
      'github-app-private-key': 'shipit-github-app-private-key',
      'github-webhook-secret': 'shipit-github-webhook-secret',
      'github-oauth-client-secret': 'shipit-github-oauth-client-secret',
      'oidc-client-secret': 'shipit-oidc-client-secret',
      'github-app-id': 'shipit-github-app-id',
      'github-oauth-client-id': 'shipit-github-oauth-client-id',
      'neo4j-aura-password': 'shipit-neo4j-aura-password',
      'session-secret': 'shipit-session-secret',
    });
  });

  it('maps env-consumed secrets to their env var names (PEM has none — it is a file)', () => {
    expect(ENV_VAR_FOR['github-webhook-secret']).toBe('GITHUB_WEBHOOK_SECRET');
    expect(ENV_VAR_FOR['github-oauth-client-secret']).toBe('GITHUB_OAUTH_CLIENT_SECRET');
    expect(ENV_VAR_FOR['oidc-client-secret']).toBe('OIDC_CLIENT_SECRET');
    expect(ENV_VAR_FOR['github-app-id']).toBe('GITHUB_APP_ID');
    expect(ENV_VAR_FOR['github-oauth-client-id']).toBe('GITHUB_OAUTH_CLIENT_ID');
    expect(ENV_VAR_FOR['neo4j-aura-password']).toBe('NEO4J_PASSWORD');
    expect(ENV_VAR_FOR['session-secret']).toBe('SHIPIT_SESSION_SECRET');
    expect(ENV_VAR_FOR['github-app-private-key']).toBeUndefined();
  });

  it('refuses writes to bootstrap secrets, allows feature + public-ID writes', () => {
    expect(() => assertWritable('neo4j-aura-password')).toThrow(SecretWriteForbiddenError);
    expect(() => assertWritable('session-secret')).toThrow(SecretWriteForbiddenError);
    expect(WRITABLE_SECRETS.has('github-app-private-key')).toBe(true);
    expect(() => assertWritable('github-app-id')).not.toThrow();
  });

  it('resolves container names from hard-mapped defaults with per-secret env override', () => {
    expect(gsmContainerFor('github-app-private-key', {})).toBe('shipit-github-app-private-key');
    expect(
      gsmContainerFor('github-app-private-key', {
        SHIPIT_GSM_SECRET_GITHUB_APP_PRIVATE_KEY: 'custom-name',
      }),
    ).toBe('custom-name');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/types.test.ts`
Expected: FAIL — module `../../secrets/types.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// Logical secret taxonomy for the SecretStore abstraction. The GSM
// container names are the Terraform-managed names from the infra repo
// (Ship-It-Ops/shipit-ai-infra, terraform/modules/secret-manager) —
// hard-mapped here per the Q1 contract decision, overridable per secret
// via SHIPIT_GSM_SECRET_<LOGICAL_NAME> for emergencies. The app NEVER
// creates containers, only adds versions to existing ones.
//
// Bootstrap secrets (neo4j-aura-password, session-secret) are
// deliberately NOT writable: the pod's GCP service account has no
// addVersion grant on them, and we fail closed client-side before IAM
// would deny it. See docs/superpowers/specs/2026-06-09-gsm-secret-store-design.md.

export type LogicalSecret =
  | 'github-app-private-key'
  | 'github-webhook-secret'
  | 'github-oauth-client-secret'
  | 'oidc-client-secret'
  | 'github-app-id'
  | 'github-oauth-client-id'
  | 'neo4j-aura-password'
  | 'session-secret';

export const GSM_CONTAINER_DEFAULTS: Record<LogicalSecret, string> = {
  'github-app-private-key': 'shipit-github-app-private-key',
  'github-webhook-secret': 'shipit-github-webhook-secret',
  'github-oauth-client-secret': 'shipit-github-oauth-client-secret',
  'oidc-client-secret': 'shipit-oidc-client-secret',
  'github-app-id': 'shipit-github-app-id',
  'github-oauth-client-id': 'shipit-github-oauth-client-id',
  'neo4j-aura-password': 'shipit-neo4j-aura-password',
  'session-secret': 'shipit-session-secret',
};

// Which env var each logical secret is consumed through. The PEM has no
// entry — it is consumed as a file via GITHUB_APP_PRIVATE_KEY_PATH.
export const ENV_VAR_FOR: Partial<Record<LogicalSecret, string>> = {
  'github-webhook-secret': 'GITHUB_WEBHOOK_SECRET',
  'github-oauth-client-secret': 'GITHUB_OAUTH_CLIENT_SECRET',
  'oidc-client-secret': 'OIDC_CLIENT_SECRET',
  'github-app-id': 'GITHUB_APP_ID',
  'github-oauth-client-id': 'GITHUB_OAUTH_CLIENT_ID',
  'neo4j-aura-password': 'NEO4J_PASSWORD',
  'session-secret': 'SHIPIT_SESSION_SECRET',
};

export const WRITABLE_SECRETS: ReadonlySet<LogicalSecret> = new Set<LogicalSecret>([
  'github-app-private-key',
  'github-webhook-secret',
  'github-oauth-client-secret',
  'oidc-client-secret',
  'github-app-id',
  'github-oauth-client-id',
]);

export class SecretWriteForbiddenError extends Error {
  constructor(name: LogicalSecret) {
    super(
      `Refusing to write bootstrap secret "${name}" — bootstrap secrets are operator-managed ` +
        `(see scripts/bootstrap-secrets.md in the infra repo).`,
    );
    this.name = 'SecretWriteForbiddenError';
  }
}

export function assertWritable(name: LogicalSecret): void {
  if (!WRITABLE_SECRETS.has(name)) throw new SecretWriteForbiddenError(name);
}

// SHIPIT_GSM_SECRET_GITHUB_APP_PRIVATE_KEY etc. — logical name upper-snaked.
export function gsmContainerFor(name: LogicalSecret, env: NodeJS.ProcessEnv): string {
  const override = env[`SHIPIT_GSM_SECRET_${name.toUpperCase().replace(/-/g, '_')}`];
  return override && override.trim() ? override.trim() : GSM_CONTAINER_DEFAULTS[name];
}

export interface SecretStore {
  // 'file' keeps today's local behavior; 'gsm' is the GKE deployment.
  readonly kind: 'file' | 'gsm';
  // null = no value exists yet (first run) — never an error.
  read(name: LogicalSecret): Promise<string | null>;
  // Throws SecretWriteForbiddenError for bootstrap secrets.
  write(name: LogicalSecret, value: string): Promise<void>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/secrets/types.ts packages/api-server/src/__tests__/secrets/types.test.ts
git commit -m "feat(api-server): secret taxonomy + SecretStore interface"
```

---

### Task 3: `FileSecretStore`

**Files:**

- Create: `packages/api-server/src/secrets/file-store.ts`
- Test: `packages/api-server/src/__tests__/secrets/file-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FileSecretStore } from '../../secrets/file-store.js';
import { SecretWriteForbiddenError } from '../../secrets/types.js';

describe('FileSecretStore', () => {
  it('reads env-consumed secrets from the injected env', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'hush' } as NodeJS.ProcessEnv;
    const store = new FileSecretStore(env);
    expect(await store.read('github-webhook-secret')).toBe('hush');
    expect(await store.read('oidc-client-secret')).toBeNull();
  });

  it('treats empty-string env values as absent', async () => {
    const store = new FileSecretStore({ OIDC_CLIENT_SECRET: '' } as NodeJS.ProcessEnv);
    expect(await store.read('oidc-client-secret')).toBeNull();
  });

  it('returns null for the PEM (path-based locally, never env)', async () => {
    const store = new FileSecretStore({} as NodeJS.ProcessEnv);
    expect(await store.read('github-app-private-key')).toBeNull();
  });

  it('write() sets the env var for the current process (session-scoped persistence)', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const store = new FileSecretStore(env);
    await store.write('oidc-client-secret', 's3cret');
    expect(env.OIDC_CLIENT_SECRET).toBe('s3cret');
  });

  it('write() refuses bootstrap secrets', async () => {
    const store = new FileSecretStore({} as NodeJS.ProcessEnv);
    await expect(store.write('session-secret', 'x')).rejects.toThrow(SecretWriteForbiddenError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/file-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Default store for local dev and CI. Reads resolve from process.env
// (the same vars the app consumes today), so behavior with
// SHIPIT_SECRET_STORE=file is identical to before the store existed.
// Writes update the injected env for the CURRENT PROCESS only — durable
// local persistence stays what it is today (the operator's shell/.env).
// The PEM is never read through this store locally; it stays path-based
// via connectors.github.app.privateKeyPath.
import { assertWritable, ENV_VAR_FOR, type LogicalSecret, type SecretStore } from './types.js';

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;

  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  async read(name: LogicalSecret): Promise<string | null> {
    const envVar = ENV_VAR_FOR[name];
    if (!envVar) return null;
    const value = this.env[envVar];
    return value && value.length > 0 ? value : null;
  }

  async write(name: LogicalSecret, value: string): Promise<void> {
    assertWritable(name);
    const envVar = ENV_VAR_FOR[name];
    if (envVar) this.env[envVar] = value;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/file-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/secrets/file-store.ts packages/api-server/src/__tests__/secrets/file-store.test.ts
git commit -m "feat(api-server): FileSecretStore (env-backed, behavior-neutral default)"
```

---

### Task 4: `GsmSecretStore`

**Files:**

- Create: `packages/api-server/src/secrets/gsm-store.ts`
- Test: `packages/api-server/src/__tests__/secrets/gsm-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { GsmSecretStore, type GsmClientLike } from '../../secrets/gsm-store.js';
import { SecretWriteForbiddenError } from '../../secrets/types.js';

function makeClient(overrides: Partial<GsmClientLike> = {}): GsmClientLike {
  return {
    accessSecretVersion: vi.fn().mockResolvedValue([{ payload: { data: Buffer.from('value') } }]),
    addSecretVersion: vi.fn().mockResolvedValue([{}]),
    ...overrides,
  };
}

describe('GsmSecretStore', () => {
  it('reads latest version from the mapped container', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    expect(await store.read('github-webhook-secret')).toBe('value');
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/proj/secrets/shipit-github-webhook-secret/versions/latest',
    });
  });

  it('honors the per-secret container-name env override', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({
      projectId: 'proj',
      env: { SHIPIT_GSM_SECRET_GITHUB_WEBHOOK_SECRET: 'custom' },
      client,
    });
    await store.read('github-webhook-secret');
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/proj/secrets/custom/versions/latest',
    });
  });

  it('returns null when the container has no version yet (grpc NOT_FOUND, code 5)', async () => {
    const client = makeClient({
      accessSecretVersion: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { code: 5 })),
    });
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    expect(await store.read('oidc-client-secret')).toBeNull();
  });

  it('propagates non-NOT_FOUND errors (e.g. PERMISSION_DENIED) so boot fails loudly', async () => {
    const client = makeClient({
      accessSecretVersion: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('denied'), { code: 7 })),
    });
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    await expect(store.read('oidc-client-secret')).rejects.toThrow('denied');
  });

  it('round-trips a multiline PEM byte-for-byte (no trailing-newline mangling)', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\n';
    const written: Buffer[] = [];
    const client = makeClient({
      addSecretVersion: vi.fn().mockImplementation(async (req: { payload: { data: Buffer } }) => {
        written.push(req.payload.data);
        return [{}];
      }),
      accessSecretVersion: vi
        .fn()
        .mockImplementation(async () => [{ payload: { data: written[0] } }]),
    });
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    await store.write('github-app-private-key', pem);
    expect(await store.read('github-app-private-key')).toBe(pem);
  });

  it('writes via addSecretVersion on the mapped container', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    await store.write('github-app-id', '12345');
    expect(client.addSecretVersion).toHaveBeenCalledWith({
      parent: 'projects/proj/secrets/shipit-github-app-id',
      payload: { data: Buffer.from('12345', 'utf-8') },
    });
  });

  it('refuses bootstrap-secret writes client-side', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    await expect(store.write('neo4j-aura-password', 'x')).rejects.toThrow(
      SecretWriteForbiddenError,
    );
    expect(client.addSecretVersion).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/gsm-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// GSM-backed store. Authenticates via Application Default Credentials —
// on GKE that resolves through the metadata server to the pod's
// Workload Identity (GSA shipit-api-server@<project>). NO explicit
// credentials, NO JSON key files, ever. Containers are Terraform-managed;
// this store never calls createSecret.
//
// The real SecretManagerServiceClient is constructed lazily so tests can
// inject a mock (GsmClientLike) and so merely importing this module
// doesn't pull grpc bootstrap cost into processes that run in file mode.
import { assertWritable, gsmContainerFor, type LogicalSecret, type SecretStore } from './types.js';

// Narrow structural view of SecretManagerServiceClient — the seam tests mock.
export interface GsmClientLike {
  accessSecretVersion(req: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string | null } | null }]>;
  addSecretVersion(req: { parent: string; payload: { data: Buffer } }): Promise<unknown>;
}

const GRPC_NOT_FOUND = 5;

export interface GsmSecretStoreOptions {
  projectId: string;
  env?: NodeJS.ProcessEnv;
  client?: GsmClientLike;
}

export class GsmSecretStore implements SecretStore {
  readonly kind = 'gsm' as const;
  private projectId: string;
  private env: NodeJS.ProcessEnv;
  private client: GsmClientLike | null;

  constructor(opts: GsmSecretStoreOptions) {
    this.projectId = opts.projectId;
    this.env = opts.env ?? process.env;
    this.client = opts.client ?? null;
  }

  private async getClient(): Promise<GsmClientLike> {
    if (!this.client) {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      this.client = new SecretManagerServiceClient() as unknown as GsmClientLike;
    }
    return this.client;
  }

  // Container name for a logical secret — exposed so error messages can
  // tell the operator exactly which GSM container was involved.
  containerFor(name: LogicalSecret): string {
    return gsmContainerFor(name, this.env);
  }

  async read(name: LogicalSecret): Promise<string | null> {
    const client = await this.getClient();
    const container = this.containerFor(name);
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${this.projectId}/secrets/${container}/versions/latest`,
      });
      const data = version.payload?.data;
      if (data == null) return null;
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
      return text.length > 0 ? text : null;
    } catch (err) {
      // NOT_FOUND = the container exists but holds no version yet (or the
      // container name is wrong — IAM makes those indistinguishable).
      // That's the legitimate first-run state, not an error.
      if ((err as { code?: number }).code === GRPC_NOT_FOUND) return null;
      throw err;
    }
  }

  async write(name: LogicalSecret, value: string): Promise<void> {
    assertWritable(name);
    const client = await this.getClient();
    const container = this.containerFor(name);
    await client.addSecretVersion({
      parent: `projects/${this.projectId}/secrets/${container}`,
      payload: { data: Buffer.from(value, 'utf-8') },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/gsm-store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/secrets/gsm-store.ts packages/api-server/src/__tests__/secrets/gsm-store.test.ts
git commit -m "feat(api-server): GsmSecretStore (ADC, addSecretVersion/accessSecretVersion)"
```

---

### Task 5: `makeSecretStore` factory + secrets barrel

**Files:**

- Create: `packages/api-server/src/secrets/index.ts`
- Test: `packages/api-server/src/__tests__/secrets/factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { makeSecretStore } from '../../secrets/index.js';
import { FileSecretStore } from '../../secrets/file-store.js';
import { GsmSecretStore } from '../../secrets/gsm-store.js';

describe('makeSecretStore', () => {
  it('defaults to file mode', () => {
    expect(makeSecretStore({} as NodeJS.ProcessEnv)).toBeInstanceOf(FileSecretStore);
  });

  it('builds the GSM store when SHIPIT_SECRET_STORE=gsm', () => {
    const store = makeSecretStore({
      SHIPIT_SECRET_STORE: 'gsm',
      GOOGLE_CLOUD_PROJECT: 'proj',
    } as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(GsmSecretStore);
  });

  it('fails loudly when gsm is selected without GOOGLE_CLOUD_PROJECT', () => {
    expect(() => makeSecretStore({ SHIPIT_SECRET_STORE: 'gsm' } as NodeJS.ProcessEnv)).toThrow(
      /GOOGLE_CLOUD_PROJECT/,
    );
  });

  it('rejects unknown store kinds', () => {
    expect(() => makeSecretStore({ SHIPIT_SECRET_STORE: 'vault' } as NodeJS.ProcessEnv)).toThrow(
      /Unknown SHIPIT_SECRET_STORE/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/factory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
export { FileSecretStore } from './file-store.js';
export { GsmSecretStore, type GsmClientLike } from './gsm-store.js';
export { hydrateFromStore, type HydrationResult } from './hydrate.js'; // added in Task 6 — omit this line until then
export {
  SecretWriteForbiddenError,
  assertWritable,
  gsmContainerFor,
  GSM_CONTAINER_DEFAULTS,
  ENV_VAR_FOR,
  WRITABLE_SECRETS,
  type LogicalSecret,
  type SecretStore,
} from './types.js';

import { FileSecretStore } from './file-store.js';
import { GsmSecretStore } from './gsm-store.js';
import type { SecretStore } from './types.js';

// Selection contract (Q1): infra injects SHIPIT_SECRET_STORE=gsm +
// GOOGLE_CLOUD_PROJECT on the GKE pod; everything else defaults to file.
export function makeSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  const mode = env.SHIPIT_SECRET_STORE?.trim() || 'file';
  if (mode === 'file') return new FileSecretStore(env);
  if (mode === 'gsm') {
    const projectId = env.GOOGLE_CLOUD_PROJECT?.trim();
    if (!projectId) {
      throw new Error(
        'SHIPIT_SECRET_STORE=gsm requires GOOGLE_CLOUD_PROJECT to be set (the GKE chart injects it).',
      );
    }
    return new GsmSecretStore({ projectId, env });
  }
  throw new Error(`Unknown SHIPIT_SECRET_STORE "${mode}" — expected "file" or "gsm".`);
}
```

(Leave the `hydrate.js` re-export line commented out or omitted until Task 6 creates the file, then add it there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/factory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/secrets/index.ts packages/api-server/src/__tests__/secrets/factory.test.ts
git commit -m "feat(api-server): makeSecretStore factory keyed on SHIPIT_SECRET_STORE"
```

---

### Task 6: Boot hydration

**Files:**

- Create: `packages/api-server/src/secrets/hydrate.ts`
- Modify: `packages/api-server/src/secrets/index.ts` (add the `hydrate.js` re-export)
- Test: `packages/api-server/src/__tests__/secrets/hydrate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateFromStore } from '../../secrets/hydrate.js';
import { FileSecretStore } from '../../secrets/file-store.js';
import type { LogicalSecret, SecretStore } from '../../secrets/types.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\n';

// Minimal in-memory gsm-shaped store — hydration only cares about kind+read.
function fakeGsmStore(values: Partial<Record<LogicalSecret, string>>): SecretStore {
  return {
    kind: 'gsm',
    read: async (name) => values[name] ?? null,
    write: async () => {},
  };
}

describe('hydrateFromStore', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-hydrate-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op in file mode', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = await hydrateFromStore(new FileSecretStore(env), env);
    expect(result).toEqual({ hydrated: [], pemPath: null });
    expect(env).toEqual({});
  });

  it('exports present secrets + public IDs into env and materializes the PEM', async () => {
    const env = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir } as NodeJS.ProcessEnv;
    const store = fakeGsmStore({
      'github-app-id': '777',
      'github-oauth-client-id': 'Iv1.abc',
      'github-webhook-secret': 'hush',
      'github-oauth-client-secret': 'oauth-secret',
      'oidc-client-secret': 'oidc-secret',
      'github-app-private-key': PEM,
    });
    const result = await hydrateFromStore(store, env);

    expect(env.GITHUB_APP_ID).toBe('777');
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBe('Iv1.abc');
    expect(env.GITHUB_WEBHOOK_SECRET).toBe('hush');
    expect(env.GITHUB_OAUTH_CLIENT_SECRET).toBe('oauth-secret');
    expect(env.OIDC_CLIENT_SECRET).toBe('oidc-secret');

    const pemPath = join(tmpDir, 'github-app-777.pem');
    expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe(pemPath);
    expect(result.pemPath).toBe(pemPath);
    // Byte-exact round-trip — the PEM contract with the GitHub client.
    expect(readFileSync(pemPath, 'utf-8')).toBe(PEM);
    expect(statSync(pemPath).mode & 0o777).toBe(0o600);
    expect(result.hydrated).toContain('github-app-private-key');
  });

  it('does not clobber env vars already set by the environment', async () => {
    const env = {
      SHIPIT_GITHUB_APP_KEY_DIR: tmpDir,
      GITHUB_WEBHOOK_SECRET: 'operator-override',
    } as NodeJS.ProcessEnv;
    await hydrateFromStore(fakeGsmStore({ 'github-webhook-secret': 'from-gsm' }), env);
    expect(env.GITHUB_WEBHOOK_SECRET).toBe('operator-override');
  });

  it('skips absent secrets quietly (first-run lands in onboarding)', async () => {
    const env = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir } as NodeJS.ProcessEnv;
    const result = await hydrateFromStore(fakeGsmStore({}), env);
    expect(result.hydrated).toEqual([]);
    expect(result.pemPath).toBeNull();
    expect(env.GITHUB_APP_ID).toBeUndefined();
  });

  it('materializes a PEM even when the app id is absent (fallback filename)', async () => {
    const env = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir } as NodeJS.ProcessEnv;
    const result = await hydrateFromStore(fakeGsmStore({ 'github-app-private-key': PEM }), env);
    expect(result.pemPath).toBe(join(tmpDir, 'github-app.pem'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/hydrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Boot-time hydration: pull GSM values into the places the app already
// reads secrets from (process.env + a PEM file on disk), BEFORE
// loadConfig() runs so ${GITHUB_APP_ID:-}-style substitutions in the
// chart-seeded config resolve. This is what keeps every existing
// consumer (server.ts env reads, resolveAppCredentials/privateKeyPath)
// untouched — only write paths know the store exists.
//
// Pre-set env vars always win (operator overrides). ADC/permission
// errors propagate so a misconfigured Workload Identity fails the boot
// loudly instead of silently starting an empty instance; a missing
// secret version is just first-run and hydrates as "not set".
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_VAR_FOR, type LogicalSecret, type SecretStore } from './types.js';

// Order matters: github-app-id must hydrate before the PEM so the
// materialized file can carry the github-app-<id>.pem name the rest of
// the wizard tooling uses.
const ENV_HYDRATED: LogicalSecret[] = [
  'github-app-id',
  'github-oauth-client-id',
  'github-webhook-secret',
  'github-oauth-client-secret',
  'oidc-client-secret',
];

export interface HydrationResult {
  hydrated: LogicalSecret[];
  pemPath: string | null;
}

export async function hydrateFromStore(
  store: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HydrationResult> {
  if (store.kind !== 'gsm') return { hydrated: [], pemPath: null };

  const hydrated: LogicalSecret[] = [];
  for (const name of ENV_HYDRATED) {
    const value = await store.read(name);
    if (value === null) continue;
    hydrated.push(name);
    const envVar = ENV_VAR_FOR[name]!;
    if (!env[envVar]) env[envVar] = value;
  }

  let pemPath: string | null = null;
  const pem = await store.read('github-app-private-key');
  if (pem !== null) {
    hydrated.push('github-app-private-key');
    const keyDir = env.SHIPIT_GITHUB_APP_KEY_DIR || join(homedir(), '.shipit', 'keys');
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const appId = env.GITHUB_APP_ID;
    pemPath = join(keyDir, appId ? `github-app-${appId}.pem` : 'github-app.pem');
    // Exact bytes — the PEM round-trip contract. mode 0600 like the
    // manifest service's own writes.
    writeFileSync(pemPath, pem, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(pemPath, 0o600);
    if (!env.GITHUB_APP_PRIVATE_KEY_PATH) env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
  }

  return { hydrated, pemPath };
}
```

Also add to `packages/api-server/src/secrets/index.ts`:

```ts
export { hydrateFromStore, type HydrationResult } from './hydrate.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/secrets/hydrate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/secrets/hydrate.ts packages/api-server/src/secrets/index.ts packages/api-server/src/__tests__/secrets/hydrate.test.ts
git commit -m "feat(api-server): boot-time GSM hydration into env + materialized PEM"
```

---

### Task 7: Wire the store into the boot path

**Files:**

- Modify: `packages/api-server/src/index.ts` (top of `main()`, manifest-service construction, exports)

- [ ] **Step 1: Add hydration before `loadConfig()`**

In `main()` (currently `const config = loadConfig();` is the first line), change to:

```ts
async function main() {
  // Secret store + hydration MUST run before loadConfig(): in gsm mode
  // hydration populates the env vars (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH,
  // OAuth/OIDC secrets) that the chart-seeded config's ${ENV} placeholders
  // reference. In file mode (default) this is a no-op.
  const secretStore = makeSecretStore();
  const hydration = await hydrateFromStore(secretStore);
  if (hydration.hydrated.length > 0) {
    console.log(
      `Hydrated ${hydration.hydrated.length} secret(s) from GSM: ${hydration.hydrated.join(', ')}` +
        (hydration.pemPath ? ` (PEM at ${hydration.pemPath})` : ''),
    );
  } else if (secretStore.kind === 'gsm') {
    console.log('GSM secret store active; no secrets present yet (first run — use the onboarding wizard).');
  }

  const config = loadConfig();
  // ... rest unchanged
```

Add the import at the top:

```ts
import { hydrateFromStore, makeSecretStore } from './secrets/index.js';
```

- [ ] **Step 2: Pass the store to the manifest service and server**

```ts
const githubAppManifestService = new GitHubAppManifestService({
  templatePath: manifestTemplatePath,
  appService: githubAppService,
  // Local-dev default; container deploys override.
  keyDir: process.env.SHIPIT_GITHUB_APP_KEY_DIR,
  secretStore,
});
```

and in the `createServer({...})` call add `secretStore,` (option added in Task 9).
(The manifest-service option lands in Task 8 and the server option in Task 9 — if executing tasks strictly in order, add these two lines during those tasks instead; nothing breaks either way as long as the compile is green at each commit.)

- [ ] **Step 3: Re-export the secrets module for consumers/tests**

Add to the export block at the top of `index.ts`:

```ts
export {
  makeSecretStore,
  hydrateFromStore,
  FileSecretStore,
  GsmSecretStore,
  SecretWriteForbiddenError,
} from './secrets/index.js';
export type { SecretStore, LogicalSecret } from './secrets/index.js';
```

- [ ] **Step 4: Typecheck + full api-server test suite**

Run: `pnpm --filter @shipit-ai/api-server typecheck && pnpm --filter @shipit-ai/api-server test`
Expected: PASS — boot wiring compiles, no existing test regressions.

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/index.ts
git commit -m "feat(api-server): hydrate secrets from store before config load at boot"
```

---

### Task 8: Manifest exchange persists to GSM

**Files:**

- Modify: `packages/api-server/src/services/github-app-manifest-service.ts`
- Modify: `packages/api-server/src/routes/connectors.ts:461-491` (success-page copy)
- Test: `packages/api-server/src/__tests__/services/github-app-manifest-service.test.ts` (extend the existing file; if none exists for this service, create it with these cases)

- [ ] **Step 1: Write the failing tests**

Add to the manifest-service test file (reuse its existing fixtures/mocks — it already injects `fetchImpl`, a tmp `keyDir`, and a stub `GitHubAppService`):

```ts
import { GsmSecretStore } from '../../secrets/gsm-store.js';
import type { GsmClientLike } from '../../secrets/gsm-store.js';

// Conversion payload used by the existing tests, now with the OAuth pair
// GitHub actually returns (and we previously discarded).
const conversionPayload = {
  id: 99,
  name: 'shipit-test',
  slug: 'shipit-test',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
  webhook_secret: 'hush',
  client_id: 'Iv1.abc123',
  client_secret: 'oauth-s3cret',
};

describe('exchangeAndPersist → GSM persistence', () => {
  it('writes PEM, webhook secret, OAuth pair and App ID to GSM and updates process.env', async () => {
    const writes: Array<[string, string]> = [];
    const client: GsmClientLike = {
      accessSecretVersion: async () => [{ payload: { data: Buffer.from('') } }],
      addSecretVersion: async (req) => {
        writes.push([req.parent, req.payload.data.toString('utf-8')]);
        return [{}];
      },
    };
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    const svc = makeService({ secretStore: store }); // existing helper + new option
    const result = await svc.exchangeAndPersist('code-123', {});

    expect(result.persistedToGsm).toBe(true);
    const byContainer = Object.fromEntries(
      writes.map(([parent, value]) => [parent.split('/').pop(), value]),
    );
    expect(byContainer['shipit-github-app-private-key']).toBe(conversionPayload.pem);
    expect(byContainer['shipit-github-webhook-secret']).toBe('hush');
    expect(byContainer['shipit-github-oauth-client-secret']).toBe('oauth-s3cret');
    expect(byContainer['shipit-github-app-id']).toBe('99');
    expect(byContainer['shipit-github-oauth-client-id']).toBe('Iv1.abc123');
    expect(process.env.GITHUB_WEBHOOK_SECRET).toBe('hush');
    expect(process.env.GITHUB_APP_ID).toBe('99');
  });

  it('does NOT touch GSM in file mode (local behavior byte-for-byte)', async () => {
    const svc = makeService({}); // no store / file store
    const result = await svc.exchangeAndPersist('code-123', {});
    expect(result.persistedToGsm).toBe(false);
  });

  it('surfaces GSM write failures with the container name and recovery hint', async () => {
    const client: GsmClientLike = {
      accessSecretVersion: async () => [{ payload: { data: Buffer.from('') } }],
      addSecretVersion: async () => {
        throw Object.assign(new Error('permission denied'), { code: 7 });
      },
    };
    const store = new GsmSecretStore({ projectId: 'proj', env: {}, client });
    const svc = makeService({ secretStore: store });
    await expect(svc.exchangeAndPersist('code-123', {})).rejects.toThrow(
      /shipit-github-app-private-key.*key is on disk/s,
    );
  });
});
```

Notes for the implementer: `makeService` is whatever construction helper the existing test file uses — extend it to accept `secretStore`. Clean up the `process.env` keys you assert on in an `afterEach` (`delete process.env.GITHUB_WEBHOOK_SECRET;` etc.) so tests don't leak.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/github-app-manifest-service.test.ts`
Expected: new tests FAIL (`persistedToGsm` undefined / option not accepted); pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `github-app-manifest-service.ts`:

1. Add to `ManifestServiceOptions`:

```ts
  // Optional secret store. When it's the GSM store, the exchange also
  // persists the minted credentials durably (Workload Identity write
  // path). File mode deliberately skips this so local behavior is
  // byte-for-byte unchanged.
  secretStore?: SecretStore;
```

with `import type { SecretStore } from '../secrets/types.js';` and store it on the instance (`private secretStore?: SecretStore`).

2. Add to `ConversionResult`:

```ts
// True when the credentials were durably persisted to GSM (gsm store
// active). The callback page uses this to drop the "export
// GITHUB_WEBHOOK_SECRET=$(cat …)" manual step.
persistedToGsm: boolean;
```

3. In `exchangeAndPersist`, after the sidecar write (line ~269) and before the `target` branch, add:

```ts
let persistedToGsm = false;
if (this.secretStore?.kind === 'gsm') {
  await this.persistToGsm({
    appId,
    pem,
    webhookSecret,
    oauthClientId: payload.client_id ?? '',
    oauthClientSecret: payload.client_secret ?? '',
    keyPath,
  });
  persistedToGsm = true;
}
```

include `persistedToGsm` in the returned object, and add the private method:

```ts
  // Persist the minted credentials to GSM. Empty values are skipped
  // (GitHub omits webhook_secret when the manifest had no hook config).
  // On failure we throw with the container name + recovery path: the App
  // already exists on GitHub and the PEM is on disk, so the operator can
  // re-run the wizard or upload the value manually.
  private async persistToGsm(args: {
    appId: string;
    pem: string;
    webhookSecret: string;
    oauthClientId: string;
    oauthClientSecret: string;
    keyPath: string;
  }): Promise<void> {
    const store = this.secretStore!;
    const writes: Array<[LogicalSecret, string, string | undefined]> = [
      ['github-app-private-key', args.pem, undefined],
      ['github-app-id', args.appId, 'GITHUB_APP_ID'],
      ['github-webhook-secret', args.webhookSecret, 'GITHUB_WEBHOOK_SECRET'],
      ['github-oauth-client-id', args.oauthClientId, 'GITHUB_OAUTH_CLIENT_ID'],
      ['github-oauth-client-secret', args.oauthClientSecret, 'GITHUB_OAUTH_CLIENT_SECRET'],
    ];
    for (const [name, value, envVar] of writes) {
      if (!value) continue;
      try {
        await store.write(name, value);
      } catch (err) {
        const container =
          store instanceof GsmSecretStore ? store.containerFor(name) : String(name);
        throw new Error(
          `GSM persistence failed for "${container}": ${(err as Error).message}. ` +
            `The GitHub App was created and the key is on disk at ${args.keyPath} — ` +
            `fix the pod's Secret Manager IAM and re-run the wizard, or upload the value manually.`,
        );
      }
      // The running process sees fresh values immediately — no ESO
      // round-trip (feature secrets aren't ESO-synced at all anymore).
      if (envVar) process.env[envVar] = value;
    }
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = args.keyPath;
  }
```

with imports `import { GsmSecretStore } from '../secrets/gsm-store.js';` and `import type { LogicalSecret, SecretStore } from '../secrets/types.js';`.

4. In `routes/connectors.ts` callback success page (~line 484-489), make the manual-export hint conditional:

```ts
              ${
                result.persistedToGsm
                  ? `<p>Credentials were persisted to Secret Manager — they survive restarts. Install the App on your org from
                <a href="${escapeHtml(result.installUrl)}/installations/new" target="_blank" rel="noreferrer">GitHub</a>.</p>`
                  : `<p>
                Wire the webhook secret into your environment:<br/>
                <code>export GITHUB_WEBHOOK_SECRET=$(cat ${escapeHtml(result.webhookSecretPath)})</code><br/>
                Then install the App on your org from
                <a href="${escapeHtml(result.installUrl)}/installations/new" target="_blank" rel="noreferrer">GitHub</a>.
              </p>`
              }
```

- [ ] **Step 4: Run the service + route test files**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/github-app-manifest-service.test.ts src/__tests__/routes/connectors.test.ts`
Expected: PASS (existing connectors route tests exercise the non-GSM copy path; they keep passing because `persistedToGsm` is `false` without a gsm store).

- [ ] **Step 5: Commit (ask operator first)**

```bash
git add packages/api-server/src/services/github-app-manifest-service.ts packages/api-server/src/routes/connectors.ts packages/api-server/src/__tests__/services/github-app-manifest-service.test.ts
git commit -m "feat(api-server): manifest exchange persists App credentials to GSM"
```

---

### Task 9: OIDC settings service + `PUT /api/auth/providers/oidc`

**Files:**

- Create: `packages/api-server/src/services/auth/oidc-settings-service.ts`
- Modify: `packages/api-server/src/server.ts` (accept `secretStore` + `oidcSettingsService` options; register nothing new — route lives in auth routes)
- Modify: `packages/api-server/src/routes/auth.ts` (new PUT route)
- Modify: `packages/api-server/src/index.ts` (construct + pass the service)
- Test: `packages/api-server/src/__tests__/services/oidc-settings-service.test.ts`
- Test: `packages/api-server/src/__tests__/routes/auth.test.ts` (extend)

- [ ] **Step 1: Write the failing service test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { OidcSettingsService } from '../../services/auth/oidc-settings-service.js';
import { FileSecretStore } from '../../secrets/file-store.js';
import { makeTestConfig } from '../test-config.js';

describe('OidcSettingsService', () => {
  let tmpDir: string;
  let localPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-oidc-'));
    localPath = join(tmpDir, 'shipit.config.local.yaml');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('persists secret via store, identifiers via local YAML, and mutates live config', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const config = makeTestConfig();
    const svc = new OidcSettingsService({
      localConfigPath: localPath,
      authConfig: config.accessControl.auth,
      secretStore: new FileSecretStore(env),
      env,
    });

    await svc.update({
      issuerUrl: 'https://idp.example.com',
      clientId: 'shipit-client',
      clientSecret: 'super-secret',
    });

    // Secret: store + current-process env, never YAML.
    expect(env.OIDC_CLIENT_SECRET).toBe('super-secret');
    const yaml = parseYaml(readFileSync(localPath, 'utf-8'));
    expect(JSON.stringify(yaml)).not.toContain('super-secret');
    // Identifiers + wiring in YAML.
    expect(yaml.accessControl.auth.providers.oidc).toMatchObject({
      enabled: true,
      issuerUrl: 'https://idp.example.com',
      clientId: 'shipit-client',
      clientSecretEnv: 'OIDC_CLIENT_SECRET',
    });
    // Live reference updated in place (same pattern as GitHubAppService).
    expect(config.accessControl.auth.providers.oidc.enabled).toBe(true);
    expect(config.accessControl.auth.providers.oidc.issuerUrl).toBe('https://idp.example.com');
  });

  it('rejects missing fields with statusCode 400', async () => {
    const svc = new OidcSettingsService({
      localConfigPath: localPath,
      authConfig: makeTestConfig().accessControl.auth,
      secretStore: new FileSecretStore({} as NodeJS.ProcessEnv),
      env: {} as NodeJS.ProcessEnv,
    });
    await expect(
      svc.update({ issuerUrl: '', clientId: 'x', clientSecret: 'y' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps the existing secret when clientSecret is omitted (edit identifiers only)', async () => {
    const env = { OIDC_CLIENT_SECRET: 'existing' } as NodeJS.ProcessEnv;
    const svc = new OidcSettingsService({
      localConfigPath: localPath,
      authConfig: makeTestConfig().accessControl.auth,
      secretStore: new FileSecretStore(env),
      env,
    });
    await svc.update({ issuerUrl: 'https://idp.example.com', clientId: 'cid' });
    expect(env.OIDC_CLIENT_SECRET).toBe('existing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/oidc-settings-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// Persists OIDC provider settings entered through the web-UI: the client
// secret goes to the SecretStore (GSM in prod — durable across pod
// restarts) + the current process env; the public identifiers go to
// shipit.config.local.yaml using the same parseDocument + atomic-rename
// pattern as GitHubAppService. The secret NEVER lands in YAML (secretlint
// and the schema's env-name-only convention both forbid it).
//
// Providers are constructed once at server boot (server.ts), so changes
// here take effect on the next restart. On GKE that restart re-hydrates
// the secret from GSM — that's the durable path this service feeds.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Config } from '@shipit-ai/shared';
import type { SecretStore } from '../../secrets/types.js';

type AuthConfig = Config['accessControl']['auth'];

export interface OidcSettingsInput {
  issuerUrl: string;
  clientId: string;
  // Omitted = keep the existing secret (identifier-only edit).
  clientSecret?: string;
}

export interface OidcSettingsServiceOptions {
  localConfigPath: string;
  // Live reference to config.accessControl.auth — mutated in place.
  authConfig: AuthConfig;
  secretStore: SecretStore;
  env?: NodeJS.ProcessEnv;
}

export class OidcSettingsService {
  private localConfigPath: string;
  private authConfig: AuthConfig;
  private secretStore: SecretStore;
  private env: NodeJS.ProcessEnv;

  constructor(opts: OidcSettingsServiceOptions) {
    this.localConfigPath = opts.localConfigPath;
    this.authConfig = opts.authConfig;
    this.secretStore = opts.secretStore;
    this.env = opts.env ?? process.env;
  }

  async update(input: OidcSettingsInput): Promise<{ restartRequired: boolean }> {
    const issuerUrl = input.issuerUrl?.trim() ?? '';
    const clientId = input.clientId?.trim() ?? '';
    if (!issuerUrl || !clientId) {
      throw Object.assign(new Error('issuerUrl and clientId are required'), { statusCode: 400 });
    }
    const hasExistingSecret = Boolean(this.env.OIDC_CLIENT_SECRET);
    const clientSecret = input.clientSecret?.trim();
    if (!clientSecret && !hasExistingSecret) {
      throw Object.assign(
        new Error('clientSecret is required (no existing OIDC client secret is configured)'),
        { statusCode: 400 },
      );
    }

    if (clientSecret) {
      await this.secretStore.write('oidc-client-secret', clientSecret);
      this.env.OIDC_CLIENT_SECRET = clientSecret;
    }

    this.persistIdentifiers({ issuerUrl, clientId });

    const oidc = this.authConfig.providers.oidc;
    oidc.enabled = true;
    oidc.issuerUrl = issuerUrl;
    oidc.clientId = clientId;
    if (!oidc.clientSecretEnv) oidc.clientSecretEnv = 'OIDC_CLIENT_SECRET';

    // Provider objects are built at boot; a restart picks these up (and
    // on GKE re-hydrates the secret from GSM).
    return { restartRequired: true };
  }

  private persistIdentifiers(values: { issuerUrl: string; clientId: string }): void {
    const raw = existsSync(this.localConfigPath) ? readFileSync(this.localConfigPath, 'utf-8') : '';
    const doc = raw.trim() ? parseDocument(raw) : parseDocument('');
    const base = ['accessControl', 'auth', 'providers', 'oidc'];
    doc.setIn([...base, 'enabled'], true);
    doc.setIn([...base, 'issuerUrl'], values.issuerUrl);
    doc.setIn([...base, 'clientId'], values.clientId);
    doc.setIn([...base, 'clientSecretEnv'], 'OIDC_CLIENT_SECRET');
    const next = String(doc);
    const tmp = join(
      dirname(this.localConfigPath),
      `.${process.pid}.${Date.now()}.shipit-oidc.tmp`,
    );
    writeFileSync(tmp, next, 'utf-8');
    renameSync(tmp, this.localConfigPath);
  }
}
```

- [ ] **Step 4: Run the service test**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/oidc-settings-service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing route test**

Extend `src/__tests__/routes/auth.test.ts` (follow its existing server-construction helpers; it already covers the auth routes with `makeTestConfig`):

```ts
describe('PUT /api/auth/providers/oidc', () => {
  it('403s for non-admin principals', async () => {
    // Build a server with auth enabled and inject a session/principal with
    // role 'member' the way the existing auth route tests do, then:
    const res = await server.inject({
      method: 'PUT',
      url: '/api/auth/providers/oidc',
      payload: { issuerUrl: 'https://idp.example.com', clientId: 'cid', clientSecret: 's' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('persists settings and reports restartRequired for admins', async () => {
    // Admin principal (auth disabled ⇒ dev-fallback principal is role
    // 'admin', simplest setup — see require-auth.ts buildDevFallbackPrincipal).
    const res = await adminServer.inject({
      method: 'PUT',
      url: '/api/auth/providers/oidc',
      payload: { issuerUrl: 'https://idp.example.com', clientId: 'cid', clientSecret: 's' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restartRequired: true });
  });

  it('503s when no OidcSettingsService is wired', async () => {
    // Server built without oidcSettingsService option.
    const res = await bareServer.inject({
      method: 'PUT',
      url: '/api/auth/providers/oidc',
      payload: { issuerUrl: 'https://idp.example.com', clientId: 'cid', clientSecret: 's' },
    });
    expect(res.statusCode).toBe(503);
  });
});
```

- [ ] **Step 6: Implement the route + server option**

In `server.ts`: add `secretStore?: SecretStore;` and `oidcSettingsService?: OidcSettingsService;` to `CreateServerOptions`, decorate them (`server.decorate('secretStore', opts.secretStore ?? null)` / same for the service — follow how `githubAppManifestService` is decorated today, including the `declare module 'fastify'` augmentation).

In `routes/auth.ts` add:

```ts
// PUT /api/auth/providers/oidc — operator pastes externally-registered
// OIDC client credentials; the secret persists via the SecretStore
// (GSM in prod), identifiers via local YAML. Admin-only: this mutates
// instance-wide auth config.
server.put<{ Body: { issuerUrl?: string; clientId?: string; clientSecret?: string } }>(
  '/providers/oidc',
  async (request, reply) => {
    if (request.ctx.user.role !== 'admin') {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin role required.' },
      });
    }
    const svc = server.oidcSettingsService;
    if (!svc) {
      return reply.status(503).send({
        error: {
          code: 'OIDC_SETTINGS_DISABLED',
          message: 'OIDC settings persistence is not wired on this deployment.',
        },
      });
    }
    const { restartRequired } = await svc.update({
      issuerUrl: request.body?.issuerUrl ?? '',
      clientId: request.body?.clientId ?? '',
      clientSecret: request.body?.clientSecret,
    });
    return reply.send({ ok: true, restartRequired });
  },
);
```

In `index.ts`, construct and pass it:

```ts
const oidcSettingsService = new OidcSettingsService({
  localConfigPath: localPath,
  authConfig: config.accessControl.auth,
  secretStore,
});
```

and add `secretStore, oidcSettingsService,` to the `createServer({...})` call.

- [ ] **Step 7: Run route + full suite**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/auth.test.ts && pnpm --filter @shipit-ai/api-server test`
Expected: PASS.

- [ ] **Step 8: Commit (ask operator first)**

```bash
git add packages/api-server/src/services/auth/oidc-settings-service.ts packages/api-server/src/routes/auth.ts packages/api-server/src/server.ts packages/api-server/src/index.ts packages/api-server/src/__tests__/services/oidc-settings-service.test.ts packages/api-server/src/__tests__/routes/auth.test.ts
git commit -m "feat(api-server): OIDC settings endpoint persisting secret via SecretStore"
```

---

### Task 10: Config export — shared `deepMerge` export + endpoint

**Files:**

- Modify: `packages/shared/src/config/loader.ts` (export `deepMerge`)
- Modify: `packages/shared/src/index.ts` (re-export)
- Create: `packages/api-server/src/services/config-export-service.ts`
- Create: `packages/api-server/src/routes/config-export.ts`
- Modify: `packages/api-server/src/server.ts` (register route, accept `configPaths` option)
- Modify: `packages/api-server/src/index.ts` (pass `configPaths`)
- Test: `packages/shared/src/config/__tests__/loader.test.ts` or wherever shared config tests live (one deepMerge export check)
- Test: `packages/api-server/src/__tests__/services/config-export-service.test.ts`
- Test: `packages/api-server/src/__tests__/routes/config-export.test.ts`

- [ ] **Step 1: Export `deepMerge` from shared**

In `packages/shared/src/config/loader.ts` change `function deepMerge` to `export function deepMerge`, and add `deepMerge` to the package barrel (`packages/shared/src/index.ts`, alongside `loadConfig`/`findConfigPaths`). Run the shared test suite: `pnpm --filter @shipit-ai/shared test` — expected PASS.

- [ ] **Step 2: Write the failing service test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigExportService } from '../../services/config-export-service.js';

const BASE = `
backend:
  api:
    port: 3001
connectors:
  github:
    app:
      id: "\${GITHUB_APP_ID:-}"
      webhookSecret: ""
`;

const LOCAL = `
connectors:
  github:
    app:
      privateKeyPath: /data/keys/github-app-777.pem
      webhookSecret: "should-never-survive"
  instances:
    - id: gh-acme
      type: github
      name: Acme
      installationId: "123"
      org: acme
      lastRuns:
        - startedAt: "2026-06-09T00:00:00Z"
          durationMs: 100
          status: success
          entitiesSynced: 5
`;

describe('ConfigExportService', () => {
  let tmpDir: string;
  let svc: ConfigExportService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-export-'));
    writeFileSync(join(tmpDir, 'shipit.config.yaml'), BASE, 'utf-8');
    writeFileSync(join(tmpDir, 'shipit.config.local.yaml'), LOCAL, 'utf-8');
    svc = new ConfigExportService({
      basePath: join(tmpDir, 'shipit.config.yaml'),
      localPath: join(tmpDir, 'shipit.config.local.yaml'),
    });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('merges base + local, preserving ${ENV} placeholders unsubstituted', () => {
    const out = svc.buildExport();
    const parsed = parseYaml(out);
    expect(parsed.connectors.github.app.id).toBe('${GITHUB_APP_ID:-}');
    expect(parsed.connectors.github.app.privateKeyPath).toBe('/data/keys/github-app-777.pem');
    expect(parsed.backend.api.port).toBe(3001);
  });

  it('scrubs webhookSecret and per-connector lastRuns', () => {
    const out = svc.buildExport();
    expect(out).not.toContain('should-never-survive');
    const parsed = parseYaml(out);
    expect(parsed.connectors.github.app.webhookSecret).toBeUndefined();
    expect(parsed.connectors.instances[0].lastRuns).toBeUndefined();
    expect(parsed.connectors.instances[0].id).toBe('gh-acme');
  });

  it('prepends a provenance header comment', () => {
    expect(svc.buildExport()).toMatch(/^# Exported from a running ShipIt-AI instance/);
  });

  it('works when no local file exists (fresh instance)', () => {
    rmSync(join(tmpDir, 'shipit.config.local.yaml'));
    const parsed = parseYaml(svc.buildExport());
    expect(parsed.backend.api.port).toBe(3001);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/config-export-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

```ts
// Builds the exportable config: the raw base + local YAML files merged
// (the SAME deepMerge loadConfig uses), WITHOUT ${ENV} substitution —
// placeholders survive into the export so the operator can commit it as
// the chart's seed shipit.config.yaml and env injection keeps working on
// the next deploy. This is the durability story for everything that is
// config rather than credential: connector instances, scope, App
// id/key-path wiring, OIDC identifiers. Credentials live in GSM.
//
// Scrubbed on the way out (fail-closed hygiene):
//   - connectors.github.app.webhookSecret (secrets are env-only by ADR)
//   - connectors.instances[*].lastRuns (runtime history; lives in Redis)
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { deepMerge } from '@shipit-ai/shared';

export interface ConfigExportServiceOptions {
  basePath: string;
  localPath: string;
}

export class ConfigExportService {
  constructor(private paths: ConfigExportServiceOptions) {}

  buildExport(now: Date = new Date()): string {
    const base = this.readRaw(this.paths.basePath) ?? {};
    const local = this.readRaw(this.paths.localPath);
    const merged = (local ? deepMerge(base, local) : base) as Record<string, unknown>;
    this.scrub(merged);
    const header =
      `# Exported from a running ShipIt-AI instance on ${now.toISOString()}.\n` +
      `# Commit this as the deployment's seed shipit.config.yaml (infra repo chart)\n` +
      `# so the next deploy resumes from this configuration. Secrets are NOT in\n` +
      `# this file — they live in Secret Manager / env.\n`;
    return header + stringifyYaml(merged);
  }

  private readRaw(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    return (parseYaml(readFileSync(path, 'utf-8')) ?? {}) as Record<string, unknown>;
  }

  private scrub(merged: Record<string, unknown>): void {
    const connectors = merged.connectors as Record<string, unknown> | undefined;
    const app = (connectors?.github as Record<string, unknown> | undefined)?.app as
      | Record<string, unknown>
      | undefined;
    if (app) delete app.webhookSecret;
    const instances = connectors?.instances;
    if (Array.isArray(instances)) {
      for (const instance of instances) {
        if (instance && typeof instance === 'object') {
          delete (instance as Record<string, unknown>).lastRuns;
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run the service test**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/services/config-export-service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the failing route test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';

describe('GET /api/config/export', () => {
  let server: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-export-route-'));
    writeFileSync(
      join(tmpDir, 'shipit.config.yaml'),
      'backend:\n  api:\n    port: 3001\n',
      'utf-8',
    );
    server = await createServer({
      config: makeTestConfig(),
      configPaths: {
        basePath: join(tmpDir, 'shipit.config.yaml'),
        localPath: join(tmpDir, 'shipit.config.local.yaml'),
      },
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the export as a YAML attachment (dev-fallback principal is admin)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/config/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-yaml');
    expect(res.headers['content-disposition']).toBe('attachment; filename="shipit.config.yaml"');
    expect(res.body).toContain('# Exported from a running ShipIt-AI instance');
    expect(res.body).toContain('port: 3001');
  });

  it('503s when configPaths are not wired', async () => {
    const bare = await createServer({ config: makeTestConfig() });
    await bare.ready();
    const res = await bare.inject({ method: 'GET', url: '/api/config/export' });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});
```

Also add a 403 case mirroring the OIDC route test's non-admin setup (auth-enabled server + member principal).

- [ ] **Step 7: Implement the route**

`packages/api-server/src/routes/config-export.ts`:

```ts
// GET /api/config/export — download the merged raw config (placeholders
// preserved, secrets scrubbed) for committing as the deployment's next
// seed config. Admin-only: the export reveals instance-wide wiring.
import type { FastifyInstance } from 'fastify';
import { ConfigExportService } from '../services/config-export-service.js';

export async function configExportRoutes(server: FastifyInstance): Promise<void> {
  server.get('/export', async (request, reply) => {
    if (request.ctx.user.role !== 'admin') {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin role required.' },
      });
    }
    const paths = server.configPaths;
    if (!paths) {
      return reply.status(503).send({
        error: {
          code: 'CONFIG_EXPORT_DISABLED',
          message: 'Config export is not wired on this deployment.',
        },
      });
    }
    const body = new ConfigExportService(paths).buildExport();
    return reply
      .type('application/x-yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="shipit.config.yaml"')
      .send(body);
  });
}
```

In `server.ts`: add `configPaths?: { basePath: string; localPath: string };` to `CreateServerOptions`, decorate it like the other options, and register the route next to the existing route registrations:

```ts
await server.register(configExportRoutes, { prefix: '/api/config' });
```

In `index.ts`, pass `configPaths: { basePath: findConfigPaths().basePath, localPath },` to `createServer` (reuse the already-computed `localPath`; hoist `const { basePath, localPath } = findConfigPaths();` so it's computed once).

- [ ] **Step 8: Run route test + full suite**

Run: `pnpm --filter @shipit-ai/api-server exec vitest run src/__tests__/routes/config-export.test.ts && pnpm --filter @shipit-ai/api-server test && pnpm --filter @shipit-ai/shared test`
Expected: PASS.

- [ ] **Step 9: Commit (ask operator first)**

```bash
git add packages/shared/src/config/loader.ts packages/shared/src/index.ts packages/api-server/src/services/config-export-service.ts packages/api-server/src/routes/config-export.ts packages/api-server/src/server.ts packages/api-server/src/index.ts packages/api-server/src/__tests__/services/config-export-service.test.ts packages/api-server/src/__tests__/routes/config-export.test.ts
git commit -m "feat: config export endpoint for redeploy-surviving seed config"
```

---

### Task 11: Web-UI — Instance tab (OIDC form + config export)

**Files:**

- Modify: `packages/web-ui/src/lib/api.ts` (add `updateOidcProvider`)
- Create: `packages/web-ui/src/components/settings/instance-tab.tsx`
- Modify: `packages/web-ui/src/app/(app)/settings/page.tsx` (add the tab)
- Test: `packages/web-ui/src/components/settings/instance-tab.test.tsx`

- [ ] **Step 1: Add the API helper**

In `packages/web-ui/src/lib/api.ts` (follow the existing `apiFetch` helpers):

```ts
export async function updateOidcProvider(input: {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
}): Promise<{ ok: boolean; restartRequired: boolean }> {
  return apiFetch('/api/auth/providers/oidc', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
```

- [ ] **Step 2: Write the failing component test**

Follow the conventions of the existing `page.test.tsx` colocated tests (testing-library + vitest):

```tsx
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

  it('renders the config export download link', () => {
    render(<InstanceTab />);
    const link = screen.getByRole('link', { name: /export config/i });
    expect(link).toHaveAttribute('href', '/api/config/export');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @shipit-ai/web-ui exec vitest run src/components/settings/instance-tab.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 4: Implement the component**

```tsx
'use client';

// Instance-level operator settings: OIDC provider credentials (persisted
// durably via the api-server's SecretStore — GSM in prod) and the config
// export used to seed the next deployment. Distinct from the per-user
// tabs (appearance/notifications): everything here is admin-scoped.
import { useState } from 'react';
import { Button, Card, Input } from '@ship-it-ui/ui';
import { updateOidcProvider } from '@/lib/api';

export function InstanceTab() {
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setStatus('saving');
    setError(null);
    try {
      await updateOidcProvider({
        issuerUrl,
        clientId,
        // Empty secret = keep the existing one (identifier-only edit).
        clientSecret: clientSecret || undefined,
      });
      setStatus('saved');
      setClientSecret('');
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <Card title="OIDC sign-in">
        <p className="text-text-muted mb-3 text-[12px]">
          Register a client in your IdP, then paste its details here. The client secret is stored in
          the deployment&apos;s secret manager — it never lands in config files.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[13px]">
            Issuer URL
            <Input
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              placeholder="https://idp.example.com"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            Client ID
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            Client secret
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Leave blank to keep the current secret"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={status === 'saving' || !issuerUrl || !clientId}>
              Save OIDC settings
            </Button>
            {status === 'saved' && (
              <span className="text-text-muted text-[12px]">
                Saved. Takes effect on the next restart.
              </span>
            )}
            {status === 'error' && <span className="text-danger text-[12px]">{error}</span>}
          </div>
        </div>
      </Card>

      <Card title="Config export">
        <p className="text-text-muted mb-3 text-[12px]">
          Download the instance&apos;s current configuration (connectors, scopes, wiring — no
          secrets) to commit as the seed config for the next deployment.
        </p>
        <Button variant="outline" asChild>
          <a href="/api/config/export" download>
            Export config
          </a>
        </Button>
      </Card>
    </div>
  );
}
```

In `settings/page.tsx`, add the tab (import `InstanceTab`, add `<Tab value="instance">Instance</Tab>` to `TabsList` and `<TabsContent value="instance"><InstanceTab /></TabsContent>` alongside the existing tab contents).

- [ ] **Step 5: Run web-ui tests**

Run: `pnpm --filter @shipit-ai/web-ui test`
Expected: PASS (new tests + existing settings page test).

- [ ] **Step 6: Commit (ask operator first)**

```bash
git add packages/web-ui/src/lib/api.ts packages/web-ui/src/components/settings/instance-tab.tsx packages/web-ui/src/components/settings/instance-tab.test.tsx 'packages/web-ui/src/app/(app)/settings/page.tsx'
git commit -m "feat(web-ui): Instance settings tab — OIDC credentials + config export"
```

---

### Task 12: Full verification + docs/agent capture

**Files:**

- Modify: `docs/agent/MANIFEST.md`, create `docs/agent/decisions/gsm-secret-store-and-config-export.md` (decision capture happens in-session per ship-agent-context; the executor verifies it exists)

- [ ] **Step 1: Full repo verification**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: PASS across all workspaces. (If a workspace lacks a script, turbo skips it — only failures matter.)

- [ ] **Step 2: Manual smoke (file mode unchanged)**

Run the api-server locally (`pnpm --filter @shipit-ai/api-server dev` or the repo's usual dev command) **without** `SHIPIT_SECRET_STORE` set. Verify: boots clean, no GSM log lines, `/api/config/export` downloads YAML, existing wizard pages render.

- [ ] **Step 3: Confirm the infra answers are communicated**

The PR description must carry the Q1–Q5 answers + scope notes from the spec's "Cross-repo follow-ups for infra" section (the infra agent reads them from there).

- [ ] **Step 4: Final commit + PR (ask operator first for commit AND push, separately)**

```bash
git add docs/agent docs/superpowers
git commit -m "docs: capture GSM secret-store decision + plan"
```

PR title: `Dynamic GSM secrets: onboarding persists its own credentials (+ config export)`.

---

## Self-review notes

- **Spec coverage:** taxonomy/types (T2), FileStore (T3), GsmStore + PEM round-trip (T4), selection env (T5), hydration incl. `GITHUB_APP_PRIVATE_KEY_PATH` export (T6, T7), manifest-exchange writes incl. OAuth pair + App ID + in-process env updates + error surfacing (T8), OIDC UI-entry + persist (T9, T11), config export with placeholder preservation + scrubbing + header (T10, T11), least-privilege write refusal (T2–T4), fail-loud boot (T4 propagation + T5 factory + T7 wiring), non-breaking file default (T3, T8 gate, T12 smoke).
- **Known judgment calls for the executor:** exact placement of decorations in `server.ts` follows the existing `githubAppManifestService` pattern; the auth route tests should reuse that file's existing session-injection helpers rather than invent new ones; if `@ship-it-ui/ui`'s `Input`/`Button` props differ from the sketch, match `api-keys-tab.tsx` usage.
- **Out of scope (per spec):** webhook receiver, DCR, bootstrap-secret delivery changes, multi-replica.
