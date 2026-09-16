import { describe, it, expect, vi } from 'vitest';
import type { GitHubConnectorConfig } from '@shipit-ai/shared';
import { connectorInstanceSchema } from '@shipit-ai/shared';
import { getConnectorType, connectorTypeFor } from '../../services/connector-types/index.js';
import type { BuildContext } from '../../services/connector-types/types.js';

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    globalApp: { id: 'app-1', privateKeyPath: '/keys/global.pem' },
    readPrivateKey: vi.fn().mockReturnValue('PEM'),
    keyDir: '/keys',
    listConnectors: () => [],
    ...overrides,
  };
}

const gh = connectorInstanceSchema.parse({
  id: 'gh-acme',
  type: 'github',
  name: 'Acme',
  installationId: '42',
  org: 'acme',
}) as GitHubConnectorConfig;

describe('connector-types registry', () => {
  it('knows github (incremental poll) and nothing else yet', () => {
    expect(getConnectorType('github')?.pollMode).toBe('incremental');
    expect(getConnectorType('nope')).toBeUndefined();
    expect(() => connectorTypeFor({ ...gh, type: 'nope' as never })).toThrow(
      /No connector type registered/,
    );
  });

  it('github does not sweep absent nodes — its full sync is bounded, not exhaustive', () => {
    expect(getConnectorType('github')?.sweepsAbsent).toBe(false);
  });
});

describe('github connector type', () => {
  it('builds a GitHubConnector with the resolved App credentials and installation', async () => {
    const c = ctx();
    const built = await getConnectorType('github')!.build(gh, c);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.connector.manifest.name).toBe('github');
    expect(built.sdkConfig).toEqual({
      id: 'gh-acme',
      type: 'github',
      credentials: { appId: 'app-1', privateKey: 'PEM', installationId: '42' },
      scope: { org: 'acme' },
    });
    expect(c.readPrivateKey).toHaveBeenCalledWith('/keys/global.pem');
  });

  it('prefers the per-connector App override', async () => {
    const c = ctx();
    const built = await getConnectorType('github')!.build(
      { ...gh, app: { id: 'app-2', privateKeyPath: '/keys/override.pem' } },
      c,
    );
    if (!built.ok) throw new Error('unreachable');
    expect(built.sdkConfig.credentials.appId).toBe('app-2');
    expect(c.readPrivateKey).toHaveBeenCalledWith('/keys/override.pem');
  });

  it('fails structurally when no App is configured or the key is unreadable', async () => {
    const none = await getConnectorType('github')!.build(
      gh,
      ctx({ globalApp: { id: '', privateKeyPath: '' } }),
    );
    expect(none).toMatchObject({ ok: false, code: 'APP_NOT_CONFIGURED' });
    const unreadable = await getConnectorType('github')!.build(
      gh,
      ctx({
        readPrivateKey: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(unreadable).toMatchObject({
      ok: false,
      code: 'PRIVATE_KEY_UNREADABLE',
      message: expect.stringContaining('ENOENT'),
    });
  });
});
