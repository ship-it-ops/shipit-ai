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

  it('does not clobber GITHUB_APP_PRIVATE_KEY_PATH already set', async () => {
    const env = {
      SHIPIT_GITHUB_APP_KEY_DIR: tmpDir,
      GITHUB_APP_PRIVATE_KEY_PATH: '/operator/my.pem',
    } as NodeJS.ProcessEnv;
    await hydrateFromStore(fakeGsmStore({ 'github-app-private-key': PEM }), env);
    expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe('/operator/my.pem');
  });
});
