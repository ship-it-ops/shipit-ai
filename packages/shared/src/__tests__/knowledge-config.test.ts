import { describe, it, expect } from 'vitest';
import { configSchema } from '../config/schema.js';

// Minimal fixture (same shape as ai-config-schema.test.ts): Zod won't parse a
// partial without the required tree, and nothing here touches `knowledge`, so
// the tests exercise the section's defaults.
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
      rateLimits: { graphQueryPerDay: 100, rowLimit: 1000, hopLimit: 6, queryTimeoutMs: 10000 },
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

function parse(knowledge?: Record<string, unknown>) {
  const result = configSchema.safeParse(knowledge ? { ...baseConfig, knowledge } : baseConfig);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data.knowledge;
}

describe('knowledge config section', () => {
  it('fills every default when the section is absent', () => {
    const k = parse();
    expect(k.enabled).toBe(true);
    expect(k.embedding).toEqual({ model: 'gemini-embedding-2', dimensions: 768 });
    expect(k.sync).toEqual({ maxRunMinutes: 10, reconcileCron: '0 3 * * *' });
    expect(k.worker).toEqual({ concurrency: 8, batchSize: 16 });
    expect(k.index).toEqual({ maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 });
    expect(k.linking).toEqual({ labels: ['LogicalService', 'Repository', 'Team'], stopList: [] });
    expect(k.search).toEqual({
      defaultLimit: 8,
      maxLimit: 25,
      candidatesPerLeg: 50,
      resultChars: 1500,
    });
    expect(k.suggestions).toEqual({
      enabled: true,
      minSupport: 3,
      extraction: { enabled: false, model: '', dailyTokens: 2000000 },
    });
    expect(k.agents).toEqual({ askWritesAfterRead: true });
    expect(k.retention).toEqual({ tombstoneDays: 30 });
  });

  it('accepts partial overrides and keeps the rest', () => {
    const k = parse({ enabled: false, worker: { concurrency: 2 } });
    expect(k.enabled).toBe(false);
    expect(k.worker).toEqual({ concurrency: 2, batchSize: 16 });
  });

  it('rejects a malformed reconcile cron', () => {
    expect(() => parse({ sync: { reconcileCron: 'every day' } })).toThrow(/5-field crontab/);
  });
});
