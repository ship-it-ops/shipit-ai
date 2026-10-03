import { describe, it, expect } from 'vitest';
import {
  checkDefinitionAgainstPolicy,
  grantedServiceEffects,
  parseAgentDefinition,
  type AgentDefinition,
} from '../definition.js';

const valid = {
  instructions: 'Answer questions about service ownership.',
  model: 'claude-opus',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
};

function parsed(input: unknown): AgentDefinition {
  const result = parseAgentDefinition(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

describe('parseAgentDefinition', () => {
  it('fills in empty grants and no output schema by default', () => {
    expect(parsed(valid)).toEqual({
      ...valid,
      grants: { services: {}, tools: {} },
      output: { schema: null },
    });
  });

  it('defaults unspecified effects of a service to off', () => {
    const def = parsed({ ...valid, grants: { services: { graph: { read: 'allow' } } } });
    expect(def.grants.services.graph).toEqual({ read: 'allow', write: 'off', delete: 'off' });
    expect(def.grants.tools).toEqual({});
  });

  it('never accepts allow on delete', () => {
    const result = parseAgentDefinition({
      ...valid,
      grants: { services: { graph: { delete: 'allow' } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('grants.services.graph.delete');
  });

  it('accepts ask on delete', () => {
    const def = parsed({ ...valid, grants: { services: { graph: { delete: 'ask' } } } });
    expect(def.grants.services.graph!.delete).toBe('ask');
  });

  it.each([
    ['blank instructions', { ...valid, instructions: '   ' }, 'instructions'],
    ['oversized instructions', { ...valid, instructions: 'x'.repeat(50_001) }, 'instructions'],
    ['missing model', { ...valid, model: '' }, 'model'],
    ['zero steps', { ...valid, limits: { ...valid.limits, maxSteps: 0 } }, 'limits.maxSteps'],
    [
      'fractional tokens',
      { ...valid, limits: { ...valid.limits, maxTokens: 1500.5 } },
      'limits.maxTokens',
    ],
    ['missing limits', { instructions: 'x', model: 'm' }, 'limits'],
    ['unknown top-level key', { ...valid, secret: 'x' }, ''],
    [
      'unknown policy',
      { ...valid, grants: { services: { graph: { read: 'yes' } } } },
      'grants.services.graph.read',
    ],
    [
      'bad service key',
      { ...valid, grants: { services: { 'Graph!': { read: 'allow' } } } },
      'grants.services.Graph!',
    ],
    [
      'tool id without a service',
      { ...valid, grants: { tools: { blast_radius: 'allow' } } },
      'grants.tools.blast_radius',
    ],
  ])('rejects %s', (_name, input, path) => {
    const result = parseAgentDefinition(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain(path);
  });

  it.each([null, 'text', 42, []])('rejects a non-object definition: %j', (input) => {
    expect(parseAgentDefinition(input).ok).toBe(false);
  });
});

describe('checkDefinitionAgainstPolicy', () => {
  const policy = {
    modelKeys: ['claude-opus', 'claude-sonnet'],
    ceilings: { maxSteps: 25, maxTokens: 400_000, timeoutSeconds: 900, dailyTokens: 4_000_000 },
  };

  it('passes a definition inside every ceiling', () => {
    expect(checkDefinitionAgainstPolicy(parsed(valid), policy)).toEqual([]);
  });

  it('passes a definition exactly at the ceilings', () => {
    expect(
      checkDefinitionAgainstPolicy(parsed({ ...valid, limits: policy.ceilings }), policy),
    ).toEqual([]);
  });

  it('names the model when it is not offered', () => {
    const issues = checkDefinitionAgainstPolicy(parsed({ ...valid, model: 'gpt-x' }), policy);
    expect(issues).toEqual([expect.objectContaining({ path: 'model', code: 'UNKNOWN_MODEL' })]);
    expect(issues[0]!.message).toContain('claude-opus, claude-sonnet');
  });

  it('says so when the instance has no models at all', () => {
    const issues = checkDefinitionAgainstPolicy(parsed(valid), { ...policy, modelKeys: [] });
    expect(issues[0]!.message).toContain('no models configured');
  });

  it('reports every limit above its ceiling', () => {
    const issues = checkDefinitionAgainstPolicy(
      parsed({
        ...valid,
        limits: { maxSteps: 26, maxTokens: 400_001, timeoutSeconds: 300, dailyTokens: 1000 },
      }),
      policy,
    );
    expect(issues.map((i) => i.path)).toEqual(['limits.maxSteps', 'limits.maxTokens']);
    expect(issues.every((i) => i.code === 'LIMIT_EXCEEDS_CEILING')).toBe(true);
  });
});

describe('grantedServiceEffects', () => {
  it('lists each service and effect that is not off', () => {
    const def = parsed({
      ...valid,
      grants: {
        services: {
          graph: { read: 'allow', write: 'ask' },
          github: { read: 'off', delete: 'ask' },
        },
      },
    });
    expect(grantedServiceEffects(def)).toEqual([
      { service: 'graph', effect: 'read' },
      { service: 'graph', effect: 'write' },
      { service: 'github', effect: 'delete' },
    ]);
  });

  it('counts a tool-level grant as write on its service, once', () => {
    const def = parsed({
      ...valid,
      grants: {
        tools: { 'github.open_pull_request': 'ask', 'github.comment': 'allow', 'graph.x': 'off' },
      },
    });
    expect(grantedServiceEffects(def)).toEqual([{ service: 'github', effect: 'write' }]);
  });

  it('is empty for an agent with no grants', () => {
    expect(grantedServiceEffects(parsed(valid))).toEqual([]);
  });
});
