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
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });
    expect(await store.read('github-webhook-secret')).toBe('value');
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/proj/secrets/shipit-github-webhook-secret/versions/latest',
    });
  });

  it('honors the per-secret container-name env override', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({
      projectId: 'proj',
      env: { SHIPIT_GSM_SECRET_GITHUB_WEBHOOK_SECRET: 'custom' } as NodeJS.ProcessEnv,
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
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });
    expect(await store.read('oidc-client-secret')).toBeNull();
  });

  it('propagates non-NOT_FOUND errors (e.g. PERMISSION_DENIED) so boot fails loudly', async () => {
    const client = makeClient({
      accessSecretVersion: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('denied'), { code: 7 })),
    });
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });
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
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });
    await store.write('github-app-private-key', pem);
    expect(await store.read('github-app-private-key')).toBe(pem);
  });

  it('writes via addSecretVersion on the mapped container', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });
    await store.write('github-app-id', '12345');
    expect(client.addSecretVersion).toHaveBeenCalledWith({
      parent: 'projects/proj/secrets/shipit-github-app-id',
      payload: { data: Buffer.from('12345', 'utf-8') },
    });
  });

  it('refuses bootstrap-secret writes client-side', async () => {
    const client = makeClient();
    const store = new GsmSecretStore({ projectId: 'proj', env: {} as NodeJS.ProcessEnv, client });
    await expect(store.write('neo4j-aura-password', 'x')).rejects.toThrow(
      SecretWriteForbiddenError,
    );
    expect(client.addSecretVersion).not.toHaveBeenCalled();
  });
});
