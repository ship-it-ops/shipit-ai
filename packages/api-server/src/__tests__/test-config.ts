import type { Config } from '@shipit-ai/shared';
import { loadSecretsRegistry } from '@shipit-ai/shared';
import { ResolvedSecrets } from '../secrets/index.js';

// Builds a ResolvedSecrets whose live-view maps every consume:'env' registry
// key to its corresponding env var name. Reads are live against `env`
// (defaults to process.env) so tests that already set e.g.
// process.env.SHIPIT_SESSION_SECRET work unchanged — just pass resolved to
// createServer instead of relying on the direct process.env read.
export function makeTestResolved(env: NodeJS.ProcessEnv = process.env): ResolvedSecrets {
  const registry = loadSecretsRegistry();
  const liveEnvByKey: Record<string, string> = {};
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.consume === 'env' && entry.env) {
      liveEnvByKey[key] = entry.env;
    }
  }
  return new ResolvedSecrets(new Map(), liveEnvByKey, env);
}

export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    backend: {
      neo4j: {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test',
        passwordSecret: 'neo4j-aura-password',
      },
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
          idSecret: 'github-app-id',
          webhookSecretRef: 'github-webhook-secret',
          privateKeySecret: 'github-app-private-key',
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
            clientSecretRef: 'oidc-client-secret',
            scopes: ['openid', 'email', 'profile'],
            emailClaim: 'email',
            displayName: 'OIDC',
          },
          github: {
            enabled: false,
            clientId: '',
            clientSecretRef: 'github-oauth-client-secret',
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
          secretRef: 'session-secret',
        },
      },
      web: {
        allowedOrigins: ['http://localhost:3000'],
      },
      manualWrite: {
        enabled: true,
        auditRetentionDays: 90,
      },
    },
    feedback: {
      enabled: true,
      repo: { owner: '', name: '' },
      defaultLabels: ['user-report'],
      tokenSecret: 'github-feedback-token',
    },
    ai: {
      enabled: true,
      database: { url: '' },
      vertex: { project: 'test-project', location: 'global' },
      defaultModel: 'claude-opus',
      models: [
        {
          key: 'claude-opus',
          label: 'Claude Opus',
          family: 'anthropic',
          modelId: 'claude-opus-5-5',
          contextWindow: 1_000_000,
          tools: true,
        },
        {
          key: 'gemini',
          label: 'Gemini',
          family: 'gemini',
          modelId: 'gemini-test',
          contextWindow: 1_000_000,
          tools: true,
        },
      ],
      runner: { concurrency: 4 },
      limits: {
        maxSteps: 25,
        maxTokens: 400_000,
        timeoutSeconds: 900,
        dailyTokens: 4_000_000,
        toolResultChars: 50_000,
        chatIdleMinutes: 60,
      },
    },
    knowledge: {
      enabled: true,
      embedding: { model: 'gemini-embedding-2', dimensions: 768 },
      sync: { maxRunMinutes: 10, reconcileCron: '0 3 * * *' },
      worker: { concurrency: 8, batchSize: 16 },
      index: { maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 },
      linking: { labels: ['LogicalService', 'Repository', 'Team'], stopList: [] },
      search: { defaultLimit: 8, maxLimit: 25, candidatesPerLeg: 50, resultChars: 1500 },
      suggestions: {
        enabled: true,
        minSupport: 3,
        extraction: { enabled: false, model: '', dailyTokens: 2000000 },
      },
      agents: { askWritesAfterRead: true },
      retention: { tombstoneDays: 30 },
    },
    secrets: {},
    ...overrides,
  };
}
