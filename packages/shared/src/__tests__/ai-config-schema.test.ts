import { describe, expect, it } from 'vitest';
import { configSchema } from '../config/schema.js';

// Minimal fixture: Zod won't parse a partial without the required tree.
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

const model = (key: string) => ({
  key,
  label: key,
  family: 'anthropic',
  modelId: `${key}-id`,
  contextWindow: 1000,
});

function parse(ai?: unknown) {
  return configSchema.safeParse(ai === undefined ? baseConfig : { ...baseConfig, ai });
}

describe('ai config section', () => {
  it('defaults to enabled, with no database, no models and the standard ceilings', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ai).toEqual({
      enabled: true,
      database: { url: '' },
      vertex: { project: '', location: 'global' },
      models: [],
      defaultModel: '',
      limits: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
    });
  });

  it('fills in the parts a partial block leaves out', () => {
    const result = parse({ database: { url: 'postgres://db/shipit' }, limits: { maxSteps: 5 } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ai.database.url).toBe('postgres://db/shipit');
    expect(result.data.ai.limits).toEqual({
      maxSteps: 5,
      maxTokens: 400_000,
      timeoutSeconds: 900,
      dailyTokens: 4_000_000,
    });
    expect(result.data.ai.vertex.location).toBe('global');
  });

  it('defaults a model to tool-capable', () => {
    const result = parse({ models: [model('claude-opus')], defaultModel: 'claude-opus' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ai.models[0]!.tools).toBe(true);
  });

  it('rejects two models with the same key', () => {
    const result = parse({ models: [model('m'), model('m')] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toContain('ai.models.1.key');
  });

  it('rejects a default model that is not in the catalog', () => {
    const result = parse({ models: [model('m')], defaultModel: 'other' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toContain('ai.defaultModel');
  });

  it.each([
    ['an upper-case model key', { models: [{ ...model('m'), key: 'Claude' }] }],
    ['an unknown family', { models: [{ ...model('m'), family: 'openai' }] }],
    ['a zero context window', { models: [{ ...model('m'), contextWindow: 0 }] }],
    ['a negative ceiling', { limits: { maxSteps: -1 } }],
    ['a non-boolean enabled', { enabled: 'yes' }],
  ])('rejects %s', (_name, ai) => {
    expect(parse(ai).success).toBe(false);
  });
});
