import { describe, it, expect } from 'vitest';
import type { AgentDefinition, GrantPolicy, ToolEffect } from '../definition.js';
import { modelToolName, resolvePolicy, resolveTools, type ToolDescriptor } from '../tools.js';
import { AGENT_RUNS_QUEUE, RUN_EVENTS_CHANNEL, RUNNER_HEARTBEAT_KEY } from '../queues.js';

const base: AgentDefinition = {
  instructions: 'x',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: { services: {}, tools: {} },
  output: { schema: null },
};

const withGrants = (grants: Partial<AgentDefinition['grants']>): AgentDefinition => ({
  ...base,
  grants: { services: grants.services ?? {}, tools: grants.tools ?? {} },
});

const tool = (
  id: string,
  effect: ToolEffect,
  extra: Partial<ToolDescriptor> = {},
): ToolDescriptor => ({
  id,
  service: id.split('.')[0]!,
  effect,
  description: `${id} tool`,
  inputSchema: { type: 'object', properties: {} },
  source: 'builtin',
  effectConfirmed: true,
  enabled: true,
  ...extra,
});

describe('modelToolName', () => {
  it('replaces the dot, which provider name rules reject', () => {
    expect(modelToolName('graph.blast_radius')).toBe('graph__blast_radius');
    expect(modelToolName('my-mcp.list-issues')).toBe('my-mcp__list-issues');
  });

  it('keeps every name within 64 characters, starting with a letter, and distinct', () => {
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}`;
    const longer = `${'a'.repeat(60)}.${'b'.repeat(59)}c`;
    for (const id of [long, longer, '1password.read_item']) {
      expect(modelToolName(id)).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
    }
    expect(modelToolName(long)).not.toBe(modelToolName(longer));
    expect(modelToolName(long)).toBe(modelToolName(long));
  });
});

describe('resolvePolicy', () => {
  // [description, definition grants, tool, write policy, expected]
  const cases: Array<
    [
      string,
      Partial<AgentDefinition['grants']>,
      ToolDescriptor,
      'as_granted' | 'always_ask',
      GrantPolicy,
    ]
  > = [
    ['no grant at all is off', {}, tool('graph.find_owners', 'read'), 'as_granted', 'off'],
    [
      'a service grant applies to every tool of that effect',
      { services: { graph: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('graph.find_owners', 'read'),
      'as_granted',
      'allow',
    ],
    [
      'a service grant for another effect does not apply',
      { services: { graph: { read: 'off', write: 'allow', delete: 'off' } } },
      tool('graph.find_owners', 'read'),
      'as_granted',
      'off',
    ],
    [
      'a tool grant beats the service grant',
      {
        services: { graph: { read: 'allow', write: 'off', delete: 'off' } },
        tools: { 'graph.graph_query': 'off' },
      },
      tool('graph.graph_query', 'read'),
      'as_granted',
      'off',
    ],
    [
      'a tool grant can open a tool the service grant leaves off',
      { tools: { 'graph.graph_query': 'ask' } },
      tool('graph.graph_query', 'read'),
      'as_granted',
      'ask',
    ],
    [
      'ceiling 1: delete is never allowed unattended',
      { tools: { 'github.delete_branch': 'allow' } },
      tool('github.delete_branch', 'delete'),
      'as_granted',
      'ask',
    ],
    [
      'ceiling 2: always_ask turns an allowed write into ask',
      { services: { github: { read: 'allow', write: 'allow', delete: 'off' } } },
      tool('github.comment', 'write'),
      'always_ask',
      'ask',
    ],
    [
      'ceiling 2 leaves reads alone',
      { services: { graph: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('graph.find_owners', 'read'),
      'always_ask',
      'allow',
    ],
    [
      'ceiling 3: an unconfirmed tool is a write that asks, whatever its hint',
      { services: { slack: { read: 'allow', write: 'allow', delete: 'off' } } },
      tool('slack.post', 'read', { source: 'connection', effectConfirmed: false }),
      'as_granted',
      'ask',
    ],
    [
      'ceiling 3: an unconfirmed tool with no write grant is off',
      { services: { slack: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('slack.post', 'read', { source: 'connection', effectConfirmed: false }),
      'as_granted',
      'off',
    ],
    [
      'ceiling 4: a disabled tool is off',
      { services: { graph: { read: 'allow', write: 'off', delete: 'off' } } },
      tool('graph.find_owners', 'read', { enabled: false }),
      'as_granted',
      'off',
    ],
  ];

  it.each(cases)('%s', (_name, grants, descriptor, writePolicy, expected) => {
    expect(resolvePolicy(withGrants(grants), descriptor, writePolicy)).toBe(expected);
  });
});

describe('resolveTools', () => {
  const catalog = [
    tool('graph.find_owners', 'read'),
    tool('graph.graph_query', 'read'),
    tool('github.comment', 'write'),
  ];

  it('returns only the tools that are not off, with their policy and model name', () => {
    const { tools, warnings } = resolveTools(
      withGrants({
        services: { graph: { read: 'allow', write: 'off', delete: 'off' } },
        tools: { 'graph.graph_query': 'ask' },
      }),
      catalog,
      'as_granted',
    );
    expect(tools.map((t) => [t.id, t.policy, t.modelName])).toEqual([
      ['graph.find_owners', 'allow', 'graph__find_owners'],
      ['graph.graph_query', 'ask', 'graph__graph_query'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns about a tool grant that matches no available tool', () => {
    const { tools, warnings } = resolveTools(
      withGrants({ tools: { 'graph.removed_tool': 'allow' } }),
      catalog,
      'as_granted',
    );
    expect(tools).toEqual([]);
    expect(warnings).toEqual([
      'The grant for graph.removed_tool was ignored: no such tool is available.',
    ]);
  });
});

describe('queue and channel names', () => {
  // BullMQ 5 throws on a colon in a queue name or job id (scar
  // bullmq-5-forbids-colons-in-queue-names-and-job-ids). Redis keys follow suit.
  it('contain no colon', () => {
    for (const name of [AGENT_RUNS_QUEUE, RUN_EVENTS_CHANNEL, RUNNER_HEARTBEAT_KEY]) {
      expect(name).not.toContain(':');
    }
    expect(AGENT_RUNS_QUEUE).toBe('shipit-agent-runs');
    expect(RUNNER_HEARTBEAT_KEY).toBe('shipit-agent-runner-heartbeat');
  });
});
