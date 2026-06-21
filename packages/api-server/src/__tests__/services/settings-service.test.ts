import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConnectorInstanceConfig, GitHubConnectorConfig } from '@shipit-ai/shared';
import {
  SettingsService,
  NoResolvableAppError,
  InvalidAllowlistEmailError,
} from '../../services/settings-service.js';
import type { ConnectorAppStore } from '../../services/connector-app-store.js';
import type { ConnectorRegistry } from '../../services/connector-registry.js';
import type { LogicalSecret, SecretStore } from '../../secrets/types.js';
import type { WebhookRefetchPort } from '../../routes/webhooks.js';

function fakeStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: 'gsm',
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name: LogicalSecret, value: string) => {
      values.set(name, value);
    },
  };
}

function ghConnector(overrides: Partial<GitHubConnectorConfig> = {}): GitHubConnectorConfig {
  return {
    id: 'conn-acme',
    type: 'github',
    enabled: true,
    name: 'Acme',
    installationId: '99',
    org: 'acme',
    app: {},
    ...overrides,
  } as GitHubConnectorConfig;
}

function fakeRegistry(connectors: GitHubConnectorConfig[]): ConnectorRegistry {
  const byId = new Map(connectors.map((c) => [c.id, c]));
  return {
    list: () => connectors as unknown as ConnectorInstanceConfig[],
    get: (id: string) => {
      const c = byId.get(id);
      if (!c) throw new Error(`unknown connector ${id}`);
      return c as unknown as ConnectorInstanceConfig;
    },
  } as unknown as ConnectorRegistry;
}

function fakeAppStore() {
  return {
    setWebhookSecret: vi.fn(async () => {}),
  } as unknown as ConnectorAppStore & { setWebhookSecret: ReturnType<typeof vi.fn> };
}

describe('SettingsService.setConnectorWebhookSecret', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = {};
  });

  it('global App: writes github-webhook-secret + sets env, returns secret + url + steps', async () => {
    const store = fakeStore();
    const appStore = fakeAppStore();
    const svc = new SettingsService({
      secretStore: store,
      globalApp: { id: 'global-app', webhookPublicUrl: 'https://x.example/api/webhooks/github' },
      registry: fakeRegistry([ghConnector()]),
      connectorAppStore: appStore,
      env,
    });

    const result = await svc.setConnectorWebhookSecret('conn-acme');

    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.webhookUrl).toBe('https://x.example/api/webhooks/github');
    expect(result.steps.some((s) => s.includes(result.secret))).toBe(true);
    expect(store.values.get('github-webhook-secret')).toBe(result.secret);
    expect(env.GITHUB_WEBHOOK_SECRET).toBe(result.secret);
    // Global App path never touches the per-org store.
    expect(appStore.setWebhookSecret).not.toHaveBeenCalled();
  });

  it('per-org App (override): routes to connectorAppStore.setWebhookSecret, never the global secret', async () => {
    const store = fakeStore();
    const appStore = fakeAppStore();
    const connectors = [ghConnector({ app: { id: 'org-app' } as GitHubConnectorConfig['app'] })];
    const svc = new SettingsService({
      secretStore: store,
      globalApp: { id: 'global-app', webhookPublicUrl: 'https://x.example/api/webhooks/github' },
      registry: fakeRegistry(connectors),
      connectorAppStore: appStore,
      env,
    });

    const result = await svc.setConnectorWebhookSecret('conn-acme');

    expect(appStore.setWebhookSecret).toHaveBeenCalledWith('org-app', result.secret, connectors);
    expect(store.values.get('github-webhook-secret')).toBeUndefined();
    expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
  });

  it('throws NoResolvableAppError when no App id resolves', async () => {
    const svc = new SettingsService({
      secretStore: fakeStore(),
      globalApp: {},
      registry: fakeRegistry([ghConnector({ app: {} })]),
      connectorAppStore: fakeAppStore(),
      env,
    });
    await expect(svc.setConnectorWebhookSecret('conn-acme')).rejects.toBeInstanceOf(
      NoResolvableAppError,
    );
  });
});

describe('SettingsService allow-list + getters', () => {
  it('setAllowlist validates, writes the secret + env (proves auth-allow-list-emails is writable)', async () => {
    const env: NodeJS.ProcessEnv = {};
    const store = fakeStore();
    const svc = new SettingsService({
      secretStore: store,
      globalApp: {},
      registry: fakeRegistry([]),
      connectorAppStore: fakeAppStore(),
      env,
    });

    await svc.setAllowlist([' a@example.com ', 'b@example.com', '']);
    expect(store.values.get('auth-allow-list-emails')).toBe('a@example.com,b@example.com');
    expect(env.SHIPIT_AUTH_ALLOWLIST).toBe('a@example.com,b@example.com');
    expect(svc.getAllowlist()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('setAllowlist rejects an invalid email', async () => {
    const svc = new SettingsService({
      secretStore: fakeStore(),
      globalApp: {},
      registry: fakeRegistry([]),
      connectorAppStore: fakeAppStore(),
      env: {},
    });
    await expect(svc.setAllowlist(['not-an-email'])).rejects.toBeInstanceOf(
      InvalidAllowlistEmailError,
    );
  });

  it('getAdmins prefers env, falls back to config admins', () => {
    const withEnv = new SettingsService({
      secretStore: fakeStore(),
      globalApp: {},
      registry: fakeRegistry([]),
      connectorAppStore: fakeAppStore(),
      env: { SHIPIT_AUTH_ADMINS: 'x@example.com, y@example.com' },
    });
    expect(withEnv.getAdmins(['config@example.com'])).toEqual(['x@example.com', 'y@example.com']);

    const noEnv = new SettingsService({
      secretStore: fakeStore(),
      globalApp: {},
      registry: fakeRegistry([]),
      connectorAppStore: fakeAppStore(),
      env: {},
    });
    expect(noEnv.getAdmins(['config@example.com'])).toEqual(['config@example.com']);
  });

  it('getOAuthConfigured reflects both env vars present', () => {
    const make = (env: NodeJS.ProcessEnv) =>
      new SettingsService({
        secretStore: fakeStore(),
        globalApp: {},
        registry: fakeRegistry([]),
        connectorAppStore: fakeAppStore(),
        env,
      });
    expect(make({}).getOAuthConfigured()).toBe(false);
    expect(make({ GITHUB_OAUTH_CLIENT_ID: 'id' }).getOAuthConfigured()).toBe(false);
    expect(
      make({
        GITHUB_OAUTH_CLIENT_ID: 'id',
        GITHUB_OAUTH_CLIENT_SECRET: 'sec',
      }).getOAuthConfigured(),
    ).toBe(true);
  });
});

describe('SettingsService.listWebhooks', () => {
  it('reports secretConfigured + lastVerifiedDelivery per github connector', async () => {
    const refetch = {
      getLastVerifiedDelivery: vi.fn(async (id: string) =>
        id === 'conn-acme'
          ? { event: 'push', deliveryId: 'd-1', ts: '2026-06-18T00:00:00Z' }
          : null,
      ),
    } as unknown as WebhookRefetchPort;
    const svc = new SettingsService({
      secretStore: fakeStore(),
      // Global App + a global webhook secret in env → secretConfigured true.
      globalApp: { id: 'global-app', webhookPublicUrl: 'https://x.example/hook' },
      registry: fakeRegistry([ghConnector()]),
      connectorAppStore: fakeAppStore(),
      webhookRefetch: refetch,
      env: { GITHUB_WEBHOOK_SECRET: 'global-secret' },
    });

    const rows = await svc.listWebhooks();
    expect(rows).toEqual([
      {
        connectorId: 'conn-acme',
        appId: 'global-app',
        org: 'acme',
        secretConfigured: true,
        lastVerifiedDelivery: { event: 'push', deliveryId: 'd-1', ts: '2026-06-18T00:00:00Z' },
      },
    ]);
  });

  it('lastVerifiedDelivery is null when no refetch port is wired', async () => {
    const svc = new SettingsService({
      secretStore: fakeStore(),
      globalApp: { id: 'global-app' },
      registry: fakeRegistry([ghConnector()]),
      connectorAppStore: fakeAppStore(),
      env: {},
    });
    const rows = await svc.listWebhooks();
    expect(rows[0].lastVerifiedDelivery).toBeNull();
    // No global secret + no sidecar → not configured.
    expect(rows[0].secretConfigured).toBe(false);
  });
});
