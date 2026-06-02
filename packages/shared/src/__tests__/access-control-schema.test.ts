import { describe, expect, it } from 'vitest';
import { configSchema } from '../config/schema.js';

// Minimal fixture mirroring config-loader.test.ts. We only care about the
// accessControl section here, but Zod won't parse a partial without the
// rest of the required tree.
const baseConfig = {
  backend: {
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'pw' },
    redis: { url: 'redis://localhost:6379' },
    api: { port: 3001 },
    schema: { path: './shipit-schema.yaml' },
    cypherQuery: { timeoutMs: 5000, rowLimit: 1000 },
    reconciliation: { threshold: 0.85 },
    mcp: {
      apiKeySecret: null,
      rateLimits: {
        graphQueryPerDay: 100,
        rowLimit: 1000,
        hopLimit: 6,
        queryTimeoutMs: 10000,
      },
    },
  },
  frontend: {
    api: { url: 'http://localhost:3001' },
    integrations: {
      pagerduty: { subdomain: null },
      datadog: { site: null },
      github: { org: null },
      slack: { workspace: null, channelPrefix: 'team-' },
      kubernetes: { consoleUrlTemplate: null },
    },
  },
};

describe('accessControl schema', () => {
  it('fills in disabled-auth defaults when accessControl is omitted', () => {
    const cfg = configSchema.parse(baseConfig);
    expect(cfg.accessControl.auth.enabled).toBe(false);
    expect(cfg.accessControl.auth.providers.oidc.enabled).toBe(false);
    expect(cfg.accessControl.auth.providers.github.enabled).toBe(false);
    expect(cfg.accessControl.auth.admins).toEqual([]);
    expect(cfg.accessControl.auth.allowList).toEqual([]);
    expect(cfg.accessControl.auth.session.cookieName).toBe('shipit_sid');
    expect(cfg.accessControl.auth.session.ttlHours).toBe(12);
    expect(cfg.accessControl.web.allowedOrigins).toEqual(['http://localhost:3000']);
  });

  it('accepts an OIDC provider with explicit settings', () => {
    const cfg = configSchema.parse({
      ...baseConfig,
      accessControl: {
        auth: {
          enabled: true,
          providers: {
            oidc: {
              enabled: true,
              issuerUrl: 'https://example.com',
              clientId: 'shipit',
              clientSecretEnv: 'OIDC_CLIENT_SECRET',
              displayName: 'Example IdP',
            },
          },
          admins: ['admin@example.com'],
        },
      },
    });
    expect(cfg.accessControl.auth.enabled).toBe(true);
    expect(cfg.accessControl.auth.providers.oidc.issuerUrl).toBe('https://example.com');
    expect(cfg.accessControl.auth.providers.oidc.displayName).toBe('Example IdP');
    // Defaulted scopes survive a partial provider config.
    expect(cfg.accessControl.auth.providers.oidc.scopes).toEqual(['openid', 'email', 'profile']);
    expect(cfg.accessControl.auth.admins).toEqual(['admin@example.com']);
  });

  it('accepts a GitHub OAuth provider with an allowed-orgs list', () => {
    const cfg = configSchema.parse({
      ...baseConfig,
      accessControl: {
        auth: {
          enabled: true,
          providers: {
            github: {
              enabled: true,
              clientId: 'gh-client',
              clientSecretEnv: 'GITHUB_OAUTH_SECRET',
              allowedOrgs: ['ship-it-ops', 'example-org'],
            },
          },
          admins: ['admin@example.com'],
        },
      },
    });
    expect(cfg.accessControl.auth.providers.github.allowedOrgs).toEqual([
      'ship-it-ops',
      'example-org',
    ]);
  });

  it('rejects an unknown sameSite value', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        accessControl: {
          auth: { session: { sameSite: 'banana' } },
        },
      }),
    ).toThrow();
  });

  // Provider-level refines: empty values are fine when the provider is
  // disabled (so feature-flagged YAML stays cheap to ship), but the
  // moment enabled flips to true the schema rejects the load with a
  // dotted-path error instead of letting a half-configured provider
  // 500 at first login.

  it('accepts an OIDC provider with empty values when disabled', () => {
    const cfg = configSchema.parse({
      ...baseConfig,
      accessControl: {
        auth: {
          providers: {
            oidc: { enabled: false, issuerUrl: '', clientId: '', clientSecretEnv: '' },
          },
        },
      },
    });
    expect(cfg.accessControl.auth.providers.oidc.enabled).toBe(false);
  });

  it('rejects an enabled OIDC provider with an empty issuerUrl', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        accessControl: {
          auth: {
            enabled: true,
            providers: {
              oidc: {
                enabled: true,
                issuerUrl: '',
                clientId: 'shipit',
                clientSecretEnv: 'OIDC_CLIENT_SECRET',
                displayName: 'IdP',
              },
            },
            admins: ['a@example.com'],
          },
        },
      }),
    ).toThrow(/oidc\.enabled is true[\s\S]*issuerUrl/);
  });

  it('rejects an enabled OIDC provider with an empty clientId', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        accessControl: {
          auth: {
            enabled: true,
            providers: {
              oidc: {
                enabled: true,
                issuerUrl: 'https://idp.example.com',
                clientId: '',
                clientSecretEnv: 'OIDC_CLIENT_SECRET',
                displayName: 'IdP',
              },
            },
            admins: ['a@example.com'],
          },
        },
      }),
    ).toThrow(/oidc\.enabled is true[\s\S]*clientId/);
  });

  it('rejects an enabled OIDC provider with an empty clientSecretEnv', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        accessControl: {
          auth: {
            enabled: true,
            providers: {
              oidc: {
                enabled: true,
                issuerUrl: 'https://idp.example.com',
                clientId: 'shipit',
                clientSecretEnv: '',
                displayName: 'IdP',
              },
            },
            admins: ['a@example.com'],
          },
        },
      }),
    ).toThrow(/oidc\.enabled is true[\s\S]*clientSecretEnv/);
  });

  it('accepts a GitHub OAuth provider with empty values when disabled', () => {
    const cfg = configSchema.parse({
      ...baseConfig,
      accessControl: {
        auth: {
          providers: {
            github: { enabled: false, clientId: '', clientSecretEnv: '' },
          },
        },
      },
    });
    expect(cfg.accessControl.auth.providers.github.enabled).toBe(false);
  });

  it('rejects an enabled GitHub OAuth provider with an empty clientId', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        accessControl: {
          auth: {
            enabled: true,
            providers: {
              github: { enabled: true, clientId: '', clientSecretEnv: 'GITHUB_OAUTH_SECRET' },
            },
            admins: ['a@example.com'],
          },
        },
      }),
    ).toThrow(/github\.enabled is true[\s\S]*clientId/);
  });

  it('rejects an enabled GitHub OAuth provider with an empty clientSecretEnv', () => {
    expect(() =>
      configSchema.parse({
        ...baseConfig,
        accessControl: {
          auth: {
            enabled: true,
            providers: {
              github: { enabled: true, clientId: 'gh-client', clientSecretEnv: '' },
            },
            admins: ['a@example.com'],
          },
        },
      }),
    ).toThrow(/github\.enabled is true[\s\S]*clientSecretEnv/);
  });
});
