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

  it('write() for the PEM is a silent no-op — read() still returns null (file mode is path-based)', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const store = new FileSecretStore(env);
    await store.write('github-app-private-key', 'pem-value');
    expect(await store.read('github-app-private-key')).toBeNull();
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('write() refuses bootstrap secrets', async () => {
    const store = new FileSecretStore({} as NodeJS.ProcessEnv);
    await expect(store.write('session-secret', 'x')).rejects.toThrow(SecretWriteForbiddenError);
  });
});
