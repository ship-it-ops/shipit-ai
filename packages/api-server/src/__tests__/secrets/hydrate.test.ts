import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateSecrets } from '../../secrets/hydrate.js';
import type { SecretStore } from '../../secrets/types.js';
import type { SecretsRegistry } from '@shipit-ai/shared';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\n';

// Full registry fixture matching the real default configuration.
const FULL_REG: SecretsRegistry = {
  'github-app-id': {
    gsmContainer: 'shipit-github-app-id',
    consume: 'env',
    env: 'GITHUB_APP_ID',
    writable: true,
    required: false,
  },
  'github-oauth-client-id': {
    gsmContainer: 'shipit-github-oauth-client-id',
    consume: 'env',
    env: 'GITHUB_OAUTH_CLIENT_ID',
    writable: true,
    required: false,
  },
  'github-webhook-secret': {
    gsmContainer: 'shipit-github-webhook-secret',
    consume: 'env',
    env: 'GITHUB_WEBHOOK_SECRET',
    writable: true,
    required: false,
  },
  'github-oauth-client-secret': {
    gsmContainer: 'shipit-github-oauth-client-secret',
    consume: 'env',
    env: 'GITHUB_OAUTH_CLIENT_SECRET',
    writable: true,
    required: false,
  },
  'oidc-client-secret': {
    gsmContainer: 'shipit-oidc-client-secret',
    consume: 'env',
    env: 'OIDC_CLIENT_SECRET',
    writable: true,
    required: false,
  },
  'auth-admin-emails': {
    gsmContainer: 'shipit-auth-admin-emails',
    consume: 'env',
    env: 'SHIPIT_AUTH_ADMINS',
    writable: true,
    required: false,
  },
  'auth-allow-list-emails': {
    gsmContainer: 'shipit-auth-allow-list-emails',
    consume: 'env',
    env: 'SHIPIT_AUTH_ALLOWLIST',
    writable: true,
    required: false,
  },
  'github-feedback-token': {
    gsmContainer: 'shipit-github-feedback-token',
    consume: 'env',
    env: 'FEEDBACK_GITHUB_TOKEN',
    writable: false,
    required: false,
  },
  'neo4j-aura-password': {
    gsmContainer: 'shipit-neo4j-aura-password',
    consume: 'env',
    env: 'NEO4J_PASSWORD',
    writable: false,
    required: false, // tests that exercise FULL_REG don't supply this value
  },
  'session-secret': {
    gsmContainer: 'shipit-session-secret',
    consume: 'env',
    env: 'SHIPIT_SESSION_SECRET',
    writable: false,
    required: false, // tests that exercise FULL_REG don't supply this value
  },
  'github-app-private-key': {
    gsmContainer: 'shipit-github-app-private-key',
    consume: 'file',
    filePathEnv: 'GITHUB_APP_PRIVATE_KEY_PATH',
    writable: true,
    required: false,
  },
  'setup-completed': {
    gsmContainer: 'shipit-setup-completed',
    consume: 'store-only',
    writable: true,
    required: false,
  },
  'connector-apps': {
    gsmContainer: 'shipit-connector-apps',
    consume: 'store-only',
    writable: true,
    required: false,
  },
};

// Minimal registry for focused tests.
const MINIMAL_REG: SecretsRegistry = {
  'github-feedback-token': {
    gsmContainer: 'c',
    consume: 'env',
    env: 'FEEDBACK_GITHUB_TOKEN',
    writable: false,
    required: false,
  },
  'setup-completed': {
    gsmContainer: 'c2',
    consume: 'store-only',
    writable: true,
    required: false,
  },
} as unknown as SecretsRegistry;

function fakeGsmStore(values: Record<string, string | null>): SecretStore {
  return {
    kind: 'gsm',
    read: vi.fn(async (n: string) => values[n] ?? null),
    write: vi.fn(),
  } as unknown as SecretStore;
}

function fakeFileStore(values: Record<string, string | null>): SecretStore {
  return {
    kind: 'file',
    read: vi.fn(async (n: string) => values[n] ?? null),
    write: vi.fn(),
  } as unknown as SecretStore;
}

describe('hydrateSecrets — pre-set env wins when GSM returns null', () => {
  it('resolved.get returns the operator-pre-set env value even when GSM returns null', async () => {
    // Simulates a Helm-seeded env var: GITHUB_APP_ID is already set in the
    // container's environment but the GSM secret doesn't exist yet (first-run).
    // After hydration the accessor must return the pre-set value, not null.
    const env: NodeJS.ProcessEnv = { GITHUB_APP_ID: 'preset-id' };
    const reg: SecretsRegistry = {
      'github-app-id': {
        gsmContainer: 'shipit-github-app-id',
        consume: 'env',
        env: 'GITHUB_APP_ID',
        writable: true,
        required: false,
      },
    } as unknown as SecretsRegistry;
    const { resolved } = await hydrateSecrets(
      fakeGsmStore({}), // GSM returns null for every key
      reg,
      env,
    );
    expect(resolved.get('github-app-id')).toBe('preset-id');
    // The env var must be unchanged (no-clobber is a no-op when GSM is null).
    expect(env.GITHUB_APP_ID).toBe('preset-id');
  });

  it('never reads GSM for a consume:env secret the platform already injected, even when GSM would deny it', async () => {
    // Production shape (2026-09-16, sha-e30da0f deploy): NEO4J_PASSWORD and
    // SHIPIT_SESSION_SECRET reach the pod through an ExternalSecret → k8s
    // Secret → envFrom, and the api-server GSA deliberately holds NO
    // secretAccessor grant on those two containers. Reading them from GSM
    // anyway throws PERMISSION_DENIED (gRPC code 7), which the store
    // re-throws by design (a missing grant must be loud) — and boot crashed.
    // A value the platform already put in env must short-circuit the read.
    const env: NodeJS.ProcessEnv = {
      NEO4J_PASSWORD: 'from-eso',
      SHIPIT_SESSION_SECRET: 'from-eso-too',
    };
    const denied = Object.assign(
      new Error(
        "7 PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied on resource",
      ),
      { code: 7 },
    );
    const store = {
      kind: 'gsm',
      read: vi.fn(async () => {
        throw denied;
      }),
      write: vi.fn(),
    } as unknown as SecretStore;
    const reg: SecretsRegistry = {
      'neo4j-aura-password': {
        gsmContainer: 'shipit-neo4j-aura-password',
        consume: 'env',
        env: 'NEO4J_PASSWORD',
        writable: false,
        required: true,
      },
      'session-secret': {
        gsmContainer: 'shipit-session-secret',
        consume: 'env',
        env: 'SHIPIT_SESSION_SECRET',
        writable: false,
        required: true,
      },
    } as unknown as SecretsRegistry;

    const { resolved, hydrated } = await hydrateSecrets(store, reg, env);

    expect(store.read).not.toHaveBeenCalled();
    expect(resolved.get('neo4j-aura-password')).toBe('from-eso');
    expect(resolved.get('session-secret')).toBe('from-eso-too');
    expect(hydrated).toEqual(expect.arrayContaining(['neo4j-aura-password', 'session-secret']));
    // Required fail-fast is satisfied by the pre-set env values.
    expect(env.NEO4J_PASSWORD).toBe('from-eso');
  });
});

describe('hydrateSecrets — basic consume modes', () => {
  it('sets env + snapshot for consume:env, skips store-only', async () => {
    const env: NodeJS.ProcessEnv = {};
    const { resolved, hydrated } = await hydrateSecrets(
      fakeGsmStore({ 'github-feedback-token': 'tok', 'setup-completed': '1' }),
      MINIMAL_REG,
      env,
    );
    expect(env.FEEDBACK_GITHUB_TOKEN).toBe('tok');
    expect(resolved.get('github-feedback-token')).toBe('tok');
    expect(resolved.get('setup-completed')).toBeNull(); // store-only not snapshotted
    expect(hydrated).toContain('github-feedback-token');
  });

  it('does not clobber a pre-set env var', async () => {
    const env: NodeJS.ProcessEnv = { FEEDBACK_GITHUB_TOKEN: 'preset' };
    await hydrateSecrets(fakeGsmStore({ 'github-feedback-token': 'fromgsm' }), MINIMAL_REG, env);
    expect(env.FEEDBACK_GITHUB_TOKEN).toBe('preset');
  });
});

describe('hydrateSecrets — PEM materialization and two-pass ordering', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-hydrate-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports present secrets + public IDs into env and materializes the PEM', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const store = fakeGsmStore({
      'github-app-id': '777',
      'github-oauth-client-id': 'Iv1.abc',
      'github-webhook-secret': 'hush',
      'github-oauth-client-secret': 'oauth-secret',
      'oidc-client-secret': 'oidc-secret',
      'github-app-private-key': PEM,
    });
    const result = await hydrateSecrets(store, FULL_REG, env);

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

  it('two-pass: GITHUB_APP_ID is available when the PEM is named (consume:env before consume:file)', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const result = await hydrateSecrets(
      fakeGsmStore({ 'github-app-id': '42', 'github-app-private-key': PEM }),
      FULL_REG,
      env,
    );
    // The PEM filename must embed the app-id, proving github-app-id was hydrated first.
    expect(result.pemPath).toBe(join(tmpDir, 'github-app-42.pem'));
  });

  it('hydrates the setup-wizard admin emails into SHIPIT_AUTH_ADMINS', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const result = await hydrateSecrets(
      fakeGsmStore({ 'auth-admin-emails': 'admin@example.com' }),
      FULL_REG,
      env,
    );
    expect(env.SHIPIT_AUTH_ADMINS).toBe('admin@example.com');
    expect(result.hydrated).toContain('auth-admin-emails');
  });

  it('hydrates the login allow-list emails into SHIPIT_AUTH_ALLOWLIST', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const result = await hydrateSecrets(
      fakeGsmStore({ 'auth-allow-list-emails': 'a@x.com,b@y.com' }),
      FULL_REG,
      env,
    );
    expect(env.SHIPIT_AUTH_ALLOWLIST).toBe('a@x.com,b@y.com');
    expect(result.hydrated).toContain('auth-allow-list-emails');
  });

  it('does not clobber env vars already set by the environment', async () => {
    const env: NodeJS.ProcessEnv = {
      SHIPIT_GITHUB_APP_KEY_DIR: tmpDir,
      GITHUB_WEBHOOK_SECRET: 'operator-override',
    };
    await hydrateSecrets(fakeGsmStore({ 'github-webhook-secret': 'from-gsm' }), FULL_REG, env);
    expect(env.GITHUB_WEBHOOK_SECRET).toBe('operator-override');
  });

  it('skips absent secrets quietly (first-run lands in onboarding)', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const result = await hydrateSecrets(fakeGsmStore({}), FULL_REG, env);
    expect(result.hydrated).toEqual([]);
    expect(result.pemPath).toBeNull();
    expect(env.GITHUB_APP_ID).toBeUndefined();
  });

  it('materializes a PEM even when the app id is absent (fallback filename)', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const result = await hydrateSecrets(
      fakeGsmStore({ 'github-app-private-key': PEM }),
      FULL_REG,
      env,
    );
    expect(result.pemPath).toBe(join(tmpDir, 'github-app.pem'));
  });

  it('does not clobber GITHUB_APP_PRIVATE_KEY_PATH already set', async () => {
    const env: NodeJS.ProcessEnv = {
      SHIPIT_GITHUB_APP_KEY_DIR: tmpDir,
      GITHUB_APP_PRIVATE_KEY_PATH: '/operator/my.pem',
    };
    await hydrateSecrets(fakeGsmStore({ 'github-app-private-key': PEM }), FULL_REG, env);
    expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe('/operator/my.pem');
  });

  it('skips PEM materialization in file mode', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_GITHUB_APP_KEY_DIR: tmpDir };
    const result = await hydrateSecrets(fakeFileStore({}), FULL_REG, env);
    expect(result.pemPath).toBeNull();
    expect(result.hydrated).toEqual([]);
    expect(env).toEqual({ SHIPIT_GITHUB_APP_KEY_DIR: tmpDir });
  });
});

describe('hydrateSecrets — required fail-fast (gsm mode only)', () => {
  it('throws in gsm mode when a required secret is absent', async () => {
    const env: NodeJS.ProcessEnv = {};
    const regWithRequired: SecretsRegistry = {
      'neo4j-aura-password': {
        gsmContainer: 'shipit-neo4j-aura-password',
        consume: 'env',
        env: 'NEO4J_PASSWORD',
        writable: false,
        required: true,
      },
    } as unknown as SecretsRegistry;
    await expect(hydrateSecrets(fakeGsmStore({}), regWithRequired, env)).rejects.toThrow(
      /neo4j-aura-password/,
    );
  });

  it('does not throw in file mode even when a required secret is absent', async () => {
    const env: NodeJS.ProcessEnv = {};
    const regWithRequired: SecretsRegistry = {
      'neo4j-aura-password': {
        gsmContainer: 'shipit-neo4j-aura-password',
        consume: 'env',
        env: 'NEO4J_PASSWORD',
        writable: false,
        required: true,
      },
    } as unknown as SecretsRegistry;
    await expect(hydrateSecrets(fakeFileStore({}), regWithRequired, env)).resolves.toBeDefined();
  });
});

describe('hydrateSecrets — ResolvedSecrets live-view keys', () => {
  it('resolved.get reads auth-emails live from env (post-boot mutations visible)', async () => {
    const env: NodeJS.ProcessEnv = { SHIPIT_AUTH_ADMINS: 'boot@example.com' };
    const { resolved } = await hydrateSecrets(
      fakeGsmStore({ 'auth-admin-emails': 'boot@example.com' }),
      FULL_REG,
      env,
    );
    expect(resolved.get('auth-admin-emails')).toBe('boot@example.com');
    // Simulate a post-boot env mutation (e.g., SettingsService.setAdmins).
    env.SHIPIT_AUTH_ADMINS = 'new@example.com';
    expect(resolved.get('auth-admin-emails')).toBe('new@example.com');
  });
});
