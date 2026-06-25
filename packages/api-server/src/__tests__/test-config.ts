import type { Config } from '@shipit-ai/shared';

export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    backend: {
      neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' },
      redis: { url: 'redis://localhost:6379' },
      api: { port: 0, trustProxy: false },
      schema: { path: '/tmp/schema.yaml' },
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
    connectors: {
      github: {
        app: {
          id: '',
          privateKeyPath: '',
          webhookSecret: '',
          webhookPublicUrl: 'http://localhost:3001/api/webhooks/github',
        },
        rateLimits: { conditionalRequests: true, maxConcurrentSyncs: 3 },
      },
      instances: [],
    },
    accessControl: {
      auth: {
        enabled: false,
        providers: {
          oidc: {
            enabled: false,
            issuerUrl: '',
            clientId: '',
            clientSecretEnv: '',
            scopes: ['openid', 'email', 'profile'],
            emailClaim: 'email',
            displayName: 'OIDC',
          },
          github: {
            enabled: false,
            clientId: '',
            clientSecretEnv: '',
            allowedOrgs: [],
            displayName: 'GitHub',
          },
        },
        admins: [],
        allowList: [],
        session: {
          ttlHours: 12,
          cookieName: 'shipit_sid',
          sameSite: 'lax',
          secure: true,
          signingSecretEnv: 'SHIPIT_SESSION_SECRET',
        },
      },
      web: {
        allowedOrigins: ['http://localhost:3000'],
      },
      manualWrite: {
        enabled: true,
      },
    },
    ...overrides,
  };
}
